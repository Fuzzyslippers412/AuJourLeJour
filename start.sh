#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

PORT="${PORT:-6709}"
export PORT
export LLM_PROVIDER="${LLM_PROVIDER:-qwen-oauth}"
KILL_EXISTING="${KILL_EXISTING:-1}"

LOG_PATH="${LOG_PATH:-$DIR/data/server.log}"
PID_FILE="$DIR/data/server.pid"

mkdir -p "$DIR/data"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it from https://nodejs.org and re-run."
  exit 1
fi

if [ ! -d "$DIR/node_modules" ]; then
  echo "Installing dependencies..."
  npm install
fi

if [ "$KILL_EXISTING" = "1" ]; then
  PORT="$PORT" "$DIR/stop.sh" >/dev/null 2>&1 || true
fi

if [ -f "$PID_FILE" ]; then
  OLD_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID}" ] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "Server already running (PID ${OLD_PID})."
    exit 0
  fi
fi

nohup node server.js > "$LOG_PATH" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "Started Au Jour Le Jour on port ${PORT} (PID ${NEW_PID})."
echo "Log: ${LOG_PATH}"
