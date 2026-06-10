#!/usr/bin/env bash
set -euo pipefail

SESSION="${SESSION:-refresh-k2}"
SERVER_PORT="${SERVER_PORT:-13001}"
WEB_PORT="${WEB_PORT:-13002}"
PUBLIC_URL="${PUBLIC_URL:-https://refresh-k2.woodgear.me}"
PUBLIC_HOST="${PUBLIC_URL#https://}"
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

common='
if [ -f ~/.env/.all.env ]; then set -a; source ~/.env/.all.env; set +a; fi
uid=$(id -u)
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -d "/run/user/$uid" ]; then export XDG_RUNTIME_DIR="/run/user/$uid"; fi
if [ -z "${WAYLAND_DISPLAY:-}" ] && [ -S "${XDG_RUNTIME_DIR:-}/wayland-0" ]; then export WAYLAND_DISPLAY=wayland-0; fi
if [ -z "${DISPLAY:-}" ]; then export DISPLAY=:0; fi
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && [ -S "${XDG_RUNTIME_DIR:-}/bus" ]; then export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"; fi
'

tmux new-session -d -s "$SESSION" -n server -c "$ROOT" \
  "$common; PORT=$SERVER_PORT RADAR_BASE_URL=$PUBLIC_URL bun server/index.ts 2>&1 | tee -a data/logs/refresh-k2-server.log"

tmux new-window -t "$SESSION" -n web -c "$ROOT" \
  "$common; REFRESH_API_TARGET=http://127.0.0.1:$SERVER_PORT REFRESH_ALLOWED_HOSTS=$PUBLIC_HOST bunx vite --host 127.0.0.1 --port $WEB_PORT 2>&1 | tee -a data/logs/refresh-k2-web.log"

tmux list-windows -t "$SESSION"
