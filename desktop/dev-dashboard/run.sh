#!/usr/bin/env bash
# Boot the dev dashboard: Vite (the real renderer) behind the helper (the only
# address you open). Ctrl-C stops both, plus any dev instance the page started.
#
#   bash dev-dashboard/run.sh
#
# Ports: helper 5240, Vite 5241. Clear of the app (5173), dev instances (5223),
# the workbench (5233), question decks (5411) and live panes (5513).
set -euo pipefail

DESKTOP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER_PORT="${DEV_DASHBOARD_PORT:-5240}"
VITE_OFFSET="${DEV_DASHBOARD_VITE_OFFSET:-68}"   # 5173 + 68 = 5241
VITE_PORT=$((5173 + VITE_OFFSET))

cd "$DESKTOP"

# Refuse rather than fight for a port already held. Two helpers on one port is a
# confusing failure — one silently serves a stale tree.
if command -v ss >/dev/null 2>&1 && ss -ltn "sport = :$HELPER_PORT" 2>/dev/null | grep -q LISTEN; then
  echo "dev-dashboard: port $HELPER_PORT is already in use." >&2
  echo "  Find it with:  ss -ltnp 'sport = :$HELPER_PORT'" >&2
  echo "  Or run this one elsewhere:  DEV_DASHBOARD_PORT=5250 bash dev-dashboard/run.sh" >&2
  exit 1
fi

# VITE_NO_WATCH is deliberately NOT set: this is an interactive tool and hot
# reload is the point. If Vite dies with ENOSPC the machine is out of inotify
# watches (see the note in vite.config.ts) — close a dev instance and retry.
YOUCODED_PORT_OFFSET="$VITE_OFFSET" npm run dev:renderer -- --host 127.0.0.1 >/tmp/dev-dashboard-vite.log 2>&1 &
VITE_PID=$!
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT

# Wait for Vite before printing the URL, so the first click is never a 502.
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$VITE_PORT/" 2>/dev/null; then break; fi
  if ! kill -0 "$VITE_PID" 2>/dev/null; then
    echo "dev-dashboard: Vite exited before it started serving. Its output:" >&2
    tail -20 /tmp/dev-dashboard-vite.log >&2
    exit 1
  fi
  sleep 0.5
done

DEV_DASHBOARD_PORT="$HELPER_PORT" VITE_PORT="$VITE_PORT" node dev-dashboard/main.mjs
