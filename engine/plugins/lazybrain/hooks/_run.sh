#!/usr/bin/env bash
# LazyBrain hook dispatcher (claude-mem style: bash + curl only, no Node spawn).
# Usage: _run.sh <event-name>
# Reads stdin (Claude Code payload), POSTs to the LazyBrain daemon, prints
# hookSpecificOutput JSON if a context is returned.

EVENT="${1:-}"
PORT="${LAZYBRAIN_PORT:-37788}"
TIMEOUT="${LAZYBRAIN_HTTP_TIMEOUT:-4}"

# Make sure user's PATH is reachable (Claude Code's hook shell starts minimal).
export PATH="$($SHELL -lc 'echo $PATH' 2>/dev/null):$PATH"

URL="http://127.0.0.1:${PORT}"

# Resolve the LazyBrain repo root (two levels up from this hook script).
HOOK_DIR="$(cd "$(dirname "$0")" && pwd)"
LB_REPO="$(cd "$HOOK_DIR/../../.." && pwd)"

# Auto-build if dist is missing (first run or after git pull).
if [ ! -f "$LB_REPO/dist/bin/lazybrain.js" ]; then
  ( cd "$LB_REPO" && npm run build >/dev/null 2>&1 ) || true
fi

# Auto-link if lazybrain is not on PATH.
if ! command -v lazybrain >/dev/null 2>&1; then
  ( cd "$LB_REPO" && npm link >/dev/null 2>&1 ) || true
fi

# Health check; if down, spawn the daemon detached and wait briefly.
if ! curl -sf -m 1 "$URL/health" >/dev/null 2>&1; then
  ( nohup lazybrain daemon start --foreground --port "$PORT" >/dev/null 2>&1 & ) &>/dev/null
  for _ in 1 2 3 4 5 6; do
    sleep 1
    curl -sf -m 1 "$URL/health" >/dev/null 2>&1 && break
  done
fi

# Read stdin payload (Claude Code JSON).
PAYLOAD="$(cat 2>/dev/null || true)"

# Helper: JSON-escape a string via node (always available with Claude Code).
json_escape() {
  printf '%s' "$1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.stringify(d)))'
}

# Helper: extract a string field from PAYLOAD using node.
json_field() {
  printf '%s' "$PAYLOAD" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const j=JSON.parse(d);process.stdout.write(j['$1']||'')}catch(e){process.stdout.write('')}})" 2>/dev/null
}

CWD="$(json_field cwd)"
[ -z "$CWD" ] && CWD="$(pwd)"
SESSION_ID="$(json_field session_id)"
[ -z "$SESSION_ID" ] && SESSION_ID="unknown"

case "$EVENT" in
  session-start)
    # Auto-start the wiki serve (port 4242) — only on session-start, not every hook.
    SERVE_PORT="${LAZYBRAIN_SERVE_PORT:-4242}"
    if ! curl -sf -m 1 "http://127.0.0.1:${SERVE_PORT}/" >/dev/null 2>&1; then
      ( nohup lazybrain serve --port "$SERVE_PORT" >/dev/null 2>&1 & ) &>/dev/null
    fi
    # Warm-up embedding model (non-blocking) to avoid cold-start latency on first query.
    curl -s "http://127.0.0.1:${PORT}/_api/search?q=warmup&top=1" > /dev/null 2>&1 &
    # LAZYBRAIN_INJECT_MODE: highlights (default, ~300t) | marker (~25t) | compact (~2000t) | full (~3000t)
    MODE="${LAZYBRAIN_INJECT_MODE:-highlights}"
    case "$MODE" in
      marker)     BODY="{\"mode\":\"marker\",\"cwd\":$(json_escape "$CWD")}" ;;
      compact)    BODY="{\"mode\":\"session\",\"format\":\"compact\",\"max_tokens\":2000,\"cwd\":$(json_escape "$CWD")}" ;;
      full)       BODY="{\"mode\":\"session\",\"format\":\"full\",\"max_tokens\":3000,\"cwd\":$(json_escape "$CWD")}" ;;
      *)          BODY="{\"mode\":\"highlights\",\"cwd\":$(json_escape "$CWD")}" ;;
    esac
    CTX="$(curl -sf -m "$TIMEOUT" -X POST "$URL/inject-context" \
      -H 'content-type: application/json' --data-binary "$BODY" 2>/dev/null)"
    if [ -n "$CTX" ]; then
      printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":%s}}' \
        "$(json_escape "$CTX")"
    fi
    ;;
  user-prompt-submit)
    PROMPT="$(json_field prompt)"
    [ -z "$PROMPT" ] && PROMPT="$(json_field user_prompt)"
    [ -z "$PROMPT" ] && exit 0
    # Q3: pass session_id so the daemon filters out notes already shown this session.
    BODY="{\"mode\":\"turn\",\"query\":$(json_escape "$PROMPT"),\"max_tokens\":500,\"min_score\":0.5,\"cwd\":$(json_escape "$CWD"),\"session_id\":$(json_escape "$SESSION_ID")}"
    CTX="$(curl -sf -m "$TIMEOUT" -X POST "$URL/inject-context" \
      -H 'content-type: application/json' --data-binary "$BODY" 2>/dev/null)"
    if [ -n "$CTX" ]; then
      printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":%s}}' \
        "$(json_escape "$CTX")"
    fi
    ;;
  post-tool-use)
    # Send the full payload; daemon decides whether to queue.
    BODY="{\"raw\":$(json_escape "$PAYLOAD"),\"session\":$(json_escape "$SESSION_ID"),\"async\":true}"
    curl -sf -m 2 -X POST "$URL/capture" \
      -H 'content-type: application/json' --data-binary "$BODY" >/dev/null 2>&1 || true
    ;;
  pre-compact)
    curl -sf -m 15 -X POST "$URL/capture" \
      -H 'content-type: application/json' --data-binary '{"flush_sync":true}' >/dev/null 2>&1 || true
    ;;
  stop)
    # FAST PATH ONLY: persist the captured conversation so nothing is lost.
    # Bounded timeout so the end of a turn is never delayed.
    curl -sf -m 8 -X POST "$URL/capture" \
      -H 'content-type: application/json' --data-binary '{"flush_sync":true}' >/dev/null 2>&1 || true

    # Heavy work (graph rebuild + wiki synthesize + compress) must NEVER run
    # inline here — it would block the end of EVERY turn for minutes
    # ("Rebuilding brain index..."). It is DEBOUNCED via a marker file and run
    # fully DETACHED in the background, so a turn ends instantly.
    if [ -n "${LAZYBRAIN_BRAIN_PATH:-}" ]; then
      CACHE_DIR="$(dirname "$LAZYBRAIN_BRAIN_PATH")/_cache"
      mkdir -p "$CACHE_DIR" 2>/dev/null || true
      NOW_EPOCH=$(date +%s)

      # Light incremental refresh: at most once per LAZYBRAIN_REFRESH_SECONDS
      # (default 900 = 15min). Runs in background; never blocks the turn.
      REFRESH_MARK="$CACHE_DIR/last-refresh.txt"
      LAST_REFRESH=$(cat "$REFRESH_MARK" 2>/dev/null || echo 0)
      REFRESH_INTERVAL="${LAZYBRAIN_REFRESH_SECONDS:-900}"
      if [ $((NOW_EPOCH - LAST_REFRESH)) -ge "$REFRESH_INTERVAL" ]; then
        echo "$NOW_EPOCH" > "$REFRESH_MARK"
        ( nohup curl -sf -m 180 -X POST "$URL/graph" \
            -H 'content-type: application/json' --data-binary '{}' >/dev/null 2>&1 & ) &>/dev/null
      fi

      # Weekly deep maintenance (purge-noise + synthesize + compress) in one
      # daemon call, gated to fire at most once per ~7 days, also detached.
      MARKER="$CACHE_DIR/last-maintenance.txt"
      LAST_EPOCH=$(cat "$MARKER" 2>/dev/null || echo 0)
      if [ $((NOW_EPOCH - LAST_EPOCH)) -ge $((7 * 86400)) ]; then
        echo "$NOW_EPOCH" > "$MARKER"
        ( nohup curl -sf -m 300 -X POST "$URL/maintenance" \
            -H 'content-type: application/json' --data-binary '{}' >/dev/null 2>&1 & ) &>/dev/null
      fi
    fi

    # Optional Haiku batch extraction (opt-in), also fully detached.
    if [ "${LAZYBRAIN_EXTRACTOR:-}" = "haiku" ]; then
      ( nohup curl -sf -m 30 -X POST "$URL/extract" \
          -H 'content-type: application/json' --data-binary '{"batch_size":10}' >/dev/null 2>&1 & ) &>/dev/null
    fi
    ;;
  *)
    exit 0
    ;;
esac
