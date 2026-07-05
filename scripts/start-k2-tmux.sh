#!/usr/bin/env bash
set -euo pipefail

SESSION="${SESSION:-refresh-k2}"
SERVER_PORT="${SERVER_PORT:-13001}"
WEB_PORT="${WEB_PORT:-13002}"

if [ -f ~/.env/.all.env ]; then
  set -a
  source ~/.env/.all.env
  set +a
fi

: "${REFRESH_PUBLIC_URL:?Set REFRESH_PUBLIC_URL to the public site URL, for example https://refresh.example.com}"
PUBLIC_HOST="${REFRESH_PUBLIC_URL#https://}"
PUBLIC_HOST="${PUBLIC_HOST#http://}"
PUBLIC_HOST="${PUBLIC_HOST%%/*}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT"
mkdir -p data/logs

if [ ! -d node_modules ]; then
  bun install
fi

if tmux has-session -t "$SESSION" 2>/dev/null; then
  tmux kill-session -t "$SESSION"
fi

kill_port() {
  local port=$1
  local pids
  pids=$(ss -tlnp "sport = :$port" 2>/dev/null | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u)
  if [ -n "$pids" ]; then
    echo "Killing processes on port $port: $pids"
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 0.5
  fi
}

kill_port "$SERVER_PORT"
kill_port "$WEB_PORT"

common='
if [ -f ~/.env/.all.env ]; then set -a; source ~/.env/.all.env; set +a; fi
uid=$(id -u)
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$uid" ]; then export XDG_RUNTIME_DIR="/run/user/$uid"; fi
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR:-}/wayland-0" ]; then export WAYLAND_DISPLAY=wayland-0; fi
if [ -z "${DISPLAY:-}" ]; then export DISPLAY=:0; fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-}/bus" ]; then export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; fi
'

tmux new-session -d -s "$SESSION" -n server -c "$ROOT" \
  "$common; PORT=$SERVER_PORT RADAR_BASE_URL=$REFRESH_PUBLIC_URL bun server/index.ts 2>&1 | tee -a data/logs/refresh-k2-server.log"

tmux new-window -t "$SESSION" -n web -c "$ROOT" \
  "$common; REFRESH_API_TARGET=http://127.0.0.1:$SERVER_PORT REFRESH_ALLOWED_HOSTS=$PUBLIC_HOST bunx vite build && REFRESH_API_TARGET=http://127.0.0.1:$SERVER_PORT REFRESH_ALLOWED_HOSTS=$PUBLIC_HOST bunx vite preview --host 127.0.0.1 --port $WEB_PORT 2>&1 | tee -a data/logs/refresh-k2-web.log"

tmux list-windows -t "$SESSION"
