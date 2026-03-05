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

READY=0
for _ in {1..50}; do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    break
  fi
  HEALTH_JSON="$(curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null || true)"
  if [ -n "${HEALTH_JSON}" ]; then
    HEALTH_PID="$(printf '%s' "${HEALTH_JSON}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.pid||''));}catch(e){}})" 2>/dev/null || true)"
    if [ "${HEALTH_PID}" = "${NEW_PID}" ]; then
      READY=1
      break
    fi
  fi
  sleep 0.1
done

if [ "$READY" = "1" ]; then
  echo "Started Au Jour Le Jour on port ${PORT} (PID ${NEW_PID})."
  echo "Log: ${LOG_PATH}"
  exit 0
fi

echo "Failed to start Au Jour Le Jour on port ${PORT}."
echo "Log: ${LOG_PATH}"
tail -n 60 "$LOG_PATH" || true
exit 1
