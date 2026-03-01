#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/data/server.pid"
LOCK_FILE="${AJL_LOCK_FILE:-$DIR/data/server.lock}"
PORT="${PORT:-6709}"

kill_pid_if_running() {
  local pid="$1"
  if [ -z "${pid}" ]; then
    return 0
  fi
  if kill -0 "${pid}" 2>/dev/null; then
    kill "${pid}" 2>/dev/null || true
    sleep 0.1
    if kill -0 "${pid}" 2>/dev/null; then
      kill -9 "${pid}" 2>/dev/null || true
    fi
    echo "Stopped Au Jour Le Jour (PID ${pid})."
  fi
}

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  kill_pid_if_running "${PID}"
fi

if [ -f "$LOCK_FILE" ]; then
  LOCK_PID="$(node -e "const fs=require('fs');try{const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(d&&d.pid)process.stdout.write(String(d.pid));}catch(e){}" "$LOCK_FILE" 2>/dev/null || true)"
  kill_pid_if_running "${LOCK_PID}"
fi

rm -f "$PID_FILE"
rm -f "$LOCK_FILE"

if command -v lsof >/dev/null 2>&1; then
  PORT_PIDS="$(lsof -tiTCP:${PORT} -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "${PORT_PIDS}" ]; then
    echo "${PORT_PIDS}" | while IFS= read -r p; do
      if [ -n "${p}" ]; then
        CMDLINE="$(ps -p "${p}" -o command= 2>/dev/null || true)"
        if echo "${CMDLINE}" | grep -qi "node" && echo "${CMDLINE}" | grep -qi "server.js"; then
          kill_pid_if_running "${p}"
        fi
      fi
    done
  fi
fi

echo "Stop complete."
