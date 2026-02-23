#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/data/server.pid"

if [ ! -f "$PID_FILE" ]; then
  echo "No PID file found."
  exit 0
fi

PID="$(cat "$PID_FILE" 2>/dev/null || true)"
if [ -n "${PID}" ] && kill -0 "${PID}" 2>/dev/null; then
  kill "${PID}"
  echo "Stopped Au Jour Le Jour (PID ${PID})."
else
  echo "No running server found."
fi

rm -f "$PID_FILE"
