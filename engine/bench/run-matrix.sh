#!/usr/bin/env bash
# LazyBrain v0.4 bench matrix — 6 cells, scope-limited for tractable wall-time.
set -uo pipefail

BRAIN_PATH="${LAZYBRAIN_BRAIN_PATH:-/c/Users/username/Documents/brain}"
DAEMON_PORT="${LAZYBRAIN_PORT:-37788}"
TS="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="bench/results/$TS"
MAX_CONV="${BENCH_MAX_CONV:-2}"
MAX_Q="${BENCH_MAX_Q:-40}"
mkdir -p "$OUT_DIR"

export LAZYBRAIN_BRAIN_PATH="$BRAIN_PATH"

declare -a MATRIX=(
  "highlights:no-entities:no-haiku"
  "highlights:entities:no-haiku"
  "compact:no-entities:no-haiku"
  "compact:entities:no-haiku"
  "highlights:entities:haiku"
  "compact:entities:haiku"
)

restart_daemon() {
  local pid_file="$(dirname "$BRAIN_PATH")/_cache/daemon.pid"
  if [ -f "$pid_file" ]; then
    local PID="$(cat "$pid_file")"
    taskkill //PID "$PID" //F 2>/dev/null || true
    sleep 1
    rm -f "$(dirname "$BRAIN_PATH")/_cache/"daemon.{pid,port,lock} 2>/dev/null || true
  fi
  sleep 1
  nohup lazybrain daemon start --foreground --port "$DAEMON_PORT" > "/tmp/lb-bench-$$.log" 2>&1 &
  disown
  sleep 3
  curl -sf "http://127.0.0.1:$DAEMON_PORT/health" > /dev/null
}

purge_bench() {
  rm -f "$(dirname "$BRAIN_PATH")/_cache/capture-hashes.jsonl"
  lazybrain compress --purge-source bench:locomo 2>&1 | head -1
}

echo "Starting matrix at $TS — output $OUT_DIR"
echo "Scope: $MAX_CONV conversations, $MAX_Q questions/cell"
echo ""

for cell in "${MATRIX[@]}"; do
  IFS=":" read -r MODE ENT HAI <<< "$cell"
  CELL_ID="${MODE}-${ENT}-${HAI}"
  echo "=== Cell: $CELL_ID ==="

  purge_bench
  restart_daemon

  export LAZYBRAIN_INJECT_MODE="$MODE"
  unset LAZYBRAIN_EXTRACTOR LAZYBRAIN_DISABLE_ENTITIES
  [ "$HAI" = "haiku" ] && export LAZYBRAIN_EXTRACTOR=claude
  [ "$ENT" = "no-entities" ] && export LAZYBRAIN_DISABLE_ENTITIES=1

  EXTRA=""
  [ "$ENT" = "no-entities" ] && EXTRA="$EXTRA --no-entities"
  [ "$HAI" = "no-haiku" ] && EXTRA="$EXTRA --no-haiku"

  node --import tsx bench/locomo.ts \
    --inject-mode "$MODE" \
    --max-conv "$MAX_CONV" \
    --max-q "$MAX_Q" \
    --top 50 \
    --judge exact \
    --out "$OUT_DIR" \
    $EXTRA \
    > "$OUT_DIR/cell-$CELL_ID.log" 2>&1

  EXIT=$?
  if [ $EXIT -ne 0 ]; then
    echo "  cell errored (exit $EXIT) — see $OUT_DIR/cell-$CELL_ID.log"
  else
    tail -8 "$OUT_DIR/cell-$CELL_ID.log" | grep -E "recall|accuracy|Latency|Tokens" | head -4
  fi
  sleep 2
done

echo ""
echo "Matrix complete. Results in $OUT_DIR"
ls -lh "$OUT_DIR/" | tail -10
