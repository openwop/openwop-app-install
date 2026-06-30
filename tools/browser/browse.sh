#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
STATE_FILE="$PROJECT_ROOT/.browser-state.json"
SERVER_SCRIPT="$SCRIPT_DIR/server.mjs"
LOG_FILE="$PROJECT_ROOT/.browser-server.log"

CMD="$*"
if [ -z "$CMD" ]; then
  echo "Usage: browse.sh <command> [args...]"
  echo ""
  echo "Navigation:  goto <url> | back | forward | reload"
  echo "Reading:     snapshot [-i] | text [@ref] | html [@ref] | title | url | links"
  echo "             eval <js> | evalFile <path> | console"
  echo "Interaction: click @ref | fill @ref <text> | select @ref <val> | hover @ref"
  echo "             clickByTestId <id> | fillByTestId <id> <text>"
  echo "             type <text> | press <key> | check @ref | uncheck @ref"
  echo "             scroll [dir] [px] | wait <ms|selector> | waitUrl <sub|/re/> [ms]"
  echo "Meta:        screenshot [path] [--full] | pdf [path] | viewport <w> <h>"
  echo "Tabs:        tabs | tab <id> | newtab [url] | closetab"
  echo "Server:      status | stop"
  exit 0
fi

read_state() {
  node -p "JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).$1" 2>/dev/null
}

is_running() {
  [ -f "$STATE_FILE" ] || return 1
  local port
  port=$(read_state port) || return 1
  [ -n "$port" ] && curl -sf "http://127.0.0.1:$port/health" >/dev/null 2>&1
}

send_cmd() {
  local port token
  port=$(read_state port)
  token=$(read_state token)
  curl -sf --max-time 120 -X POST "http://127.0.0.1:$port/command" \
    -H "Authorization: Bearer $token" \
    -H "Content-Type: text/plain" \
    -d "$CMD"
}

# Fast path: server already running
if is_running; then
  send_cmd
  exit $?
fi

# Cold start: ensure Playwright browsers are available
if ! node -e "require('playwright').chromium.name()" 2>/dev/null; then
  echo "Installing Playwright Chromium..." >&2
  npx playwright install chromium >&2
fi

echo "Starting browser server..." >&2
BROWSE_PROJECT_ROOT="$PROJECT_ROOT" nohup node "$SERVER_SCRIPT" > "$LOG_FILE" 2>&1 &

# Wait up to 15s for server
for _ in $(seq 1 30); do
  if is_running; then
    send_cmd
    exit $?
  fi
  sleep 0.5
done

echo "Error: Server failed to start. See $LOG_FILE" >&2
cat "$LOG_FILE" >&2
exit 1
