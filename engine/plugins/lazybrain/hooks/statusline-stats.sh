#!/usr/bin/env bash
# LazyBrain statusline — brain stats from disk (no daemon needed)

BRAIN="${LAZYBRAIN_BRAIN_PATH:-}"

if [ -z "$BRAIN" ] || [ ! -d "$BRAIN" ]; then
  printf "LazyBrain: no brain"
  exit 0
fi

# Total notes
TOTAL=0
if [ -d "$BRAIN/notes" ]; then
  TOTAL=$(find "$BRAIN/notes" -name "*.html" -type f 2>/dev/null | wc -l | tr -d ' ')
fi

# Project notes: read cwd from stdin JSON, extract project slug
PROJECT_COUNT=""
CWD=""
if read -t 0.1 INPUT 2>/dev/null; then
  CWD=$(printf '%s' "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).workspace?.current_dir||"")}catch{}})' 2>/dev/null)
fi
[ -z "$CWD" ] && CWD="${CLAUDE_CWD:-}"

if [ -n "$CWD" ] && [ "$TOTAL" -gt 0 ]; then
  # Extract project slug from cwd (last meaningful segment)
  SLUG=$(basename "$CWD" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g' | sed 's/-\+/-/g')
  # Count notes with topic matching this project (grep data-cerveau-topic in HTML files)
  PROJECT_COUNT=$(grep -rl "data-cerveau-topic=\"$SLUG" "$BRAIN/notes" 2>/dev/null | wc -l | tr -d ' ')
fi

# Format output
if [ "$TOTAL" -gt 0 ]; then
  if [ -n "$PROJECT_COUNT" ] && [ "$PROJECT_COUNT" -gt 0 ]; then
    printf "LazyBrain: %s notes · %s here" "$TOTAL" "$PROJECT_COUNT"
  else
    printf "LazyBrain: %s notes" "$TOTAL"
  fi
else
  printf "LazyBrain: empty"
fi
