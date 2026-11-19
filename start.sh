#!/usr/bin/env bash
# Quantum Games AI — one-command launcher.
#
# Starts your AI server AND an ngrok tunnel in the background, waits until
# both are fully online, prints the public URL to copy to the organizer,
# then tails the AI log so you can watch incoming requests.
#
# Press Ctrl+C ONCE in this terminal to stop both the AI and the tunnel
# cleanly. No orphan processes.
#
# Usage:
#   ./start.sh                  # uses port 8081
#   PORT=9000 ./start.sh        # uses a different port
#
# Requires: node (>=18), ngrok (configured with your authtoken), curl, lsof.

set -u

PORT="${PORT:-8081}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_LOG="/tmp/quantum-ai-${PORT}.log"
NGROK_LOG="/tmp/quantum-ngrok-${PORT}.log"
BOT_PID=""
NGROK_PID=""

color() { printf '\033[%sm%s\033[0m' "$1" "$2"; }
ok()    { color '32' "$1"; }
warn()  { color '33' "$1"; }
err()   { color '31' "$1"; }

cleanup() {
    echo ""
    echo "$(warn 'Shutting down...')"
    [ -n "$BOT_PID" ]   && kill "$BOT_PID"   2>/dev/null
    [ -n "$NGROK_PID" ] && kill "$NGROK_PID" 2>/dev/null
    sleep 0.5
    [ -n "$BOT_PID" ]   && kill -9 "$BOT_PID"   2>/dev/null
    [ -n "$NGROK_PID" ] && kill -9 "$NGROK_PID" 2>/dev/null
    echo "$(ok 'Done.')"
    exit 0
}
trap cleanup INT TERM EXIT

require() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "$(err "Missing required command: $1")"
        echo "  See README.md for installation instructions."
        exit 1
    fi
}
require node
require ngrok
require curl
require lsof

if lsof -ti ":$PORT" >/dev/null 2>&1; then
    echo "$(warn "Port $PORT in use; killing the prior process(es).")"
    lsof -ti ":$PORT" | xargs kill 2>/dev/null || true
    sleep 1
fi

if pgrep -x ngrok >/dev/null 2>&1; then
    echo "$(warn 'Existing ngrok agent found; stopping it.')"
    pkill -x ngrok 2>/dev/null || true
    sleep 1
fi

echo "Starting ai-server.js on port $PORT ..."
node "$HERE/ai-server.js" > "$BOT_LOG" 2>&1 &
BOT_PID=$!

for _ in $(seq 1 30); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
    sleep 0.2
done
if ! curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    echo "$(err 'AI failed to start. Last 20 log lines:')"
    tail -n 20 "$BOT_LOG"
    exit 1
fi
echo "$(ok '  AI is responding locally.')"

echo "Starting ngrok tunnel on port $PORT ..."
ngrok http "$PORT" --log=stdout > "$NGROK_LOG" 2>&1 &
NGROK_PID=$!

PUBLIC_URL=""
for _ in $(seq 1 50); do
    JSON=$(curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null || true)
    if [ -n "$JSON" ]; then
        PUBLIC_URL=$(echo "$JSON" | grep -o '"public_url":"https:[^"]*"' | head -n 1 | sed 's/"public_url":"//;s/"$//')
        if [ -n "$PUBLIC_URL" ]; then break; fi
    fi
    sleep 0.2
done
if [ -z "$PUBLIC_URL" ]; then
    echo "$(err 'Could not determine ngrok URL. Last 20 lines of ngrok log:')"
    tail -n 20 "$NGROK_LOG"
    echo ""
    echo "Most likely cause: ngrok authtoken not configured."
    echo "Fix:   1) sign up free at https://dashboard.ngrok.com/signup"
    echo "       2) copy your token from https://dashboard.ngrok.com/get-started/your-authtoken"
    echo "       3) run:  ngrok config add-authtoken <your-token>"
    echo "       4) re-run this script."
    exit 1
fi
echo "$(ok '  tunnel is live.')"

if HEALTH=$(curl -fsS "$PUBLIC_URL/health" 2>/dev/null) && echo "$HEALTH" | grep -q '"status":"ok"'; then
    echo "$(ok '  end-to-end health probe OK.')"
else
    echo "$(warn 'End-to-end health probe failed. Open http://127.0.0.1:4040 to inspect.')"
    echo "  Got: ${HEALTH:-<no body>}"
fi

cat <<EOF

$(ok '============================================================')
  Your AI is online. Send this URL to the organizer:

      $(ok "$PUBLIC_URL/move")

  ngrok request inspector (live request/response of every call):
      http://127.0.0.1:4040

  Logs:
      ai:      $BOT_LOG
      ngrok:   $NGROK_LOG

  Press Ctrl+C in THIS terminal to stop the AI and the tunnel.
$(ok '============================================================')

Live AI log (waiting for the website to make its first request):
EOF

tail -F "$BOT_LOG"
