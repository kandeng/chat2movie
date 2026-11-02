#!/usr/bin/env bash
# ACT: 聊天转视频原型的「本地一键启动」脚本（Task 7）。仅在本机运行，不涉及 Caddy / systemd / 任何远程部署。
# 依次拉起：本地 Synapse homeserver -> chat2movie 服务端（内含聊天转视频机器人）-> 前端 Vite 开发服务器。
# 说明：根 package.json 的 dev 脚本使用 `bun run --filter`，在 Linux 上不可用，故此处一律用 `bun run --cwd`。
# 日志统一写到 /tmp/chat2movie-dev，避免污染仓库工作区。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SYNAPSE_VENV="/home/robot/synapse-venv"
SYNAPSE_CONF="/home/robot/synapse-data/homeserver.yaml"
SYNAPSE_URL="http://127.0.0.1:8008"
LOG_DIR="/tmp/chat2movie-dev"
mkdir -p "$LOG_DIR"

SERVER_PID=""
WEB_PID=""
SYNAPSE_PID=""

cleanup() {
  echo
  echo "[dev-local] 正在停止子进程..."
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  # ACT: 只停止本脚本启动的 Synapse；若复用已在运行的实例则不动它。
  [ -n "$SYNAPSE_PID" ] && kill "$SYNAPSE_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

# 1) Synapse homeserver（已在运行则复用，不重复启动）
if curl -sf -o /dev/null "$SYNAPSE_URL/_matrix/client/versions"; then
  echo "[synapse] 已在运行：$SYNAPSE_URL"
else
  echo "[synapse] 启动中...（日志：$LOG_DIR/synapse.log）"
  "$SYNAPSE_VENV/bin/python" -m synapse.app.homeserver -c "$SYNAPSE_CONF" > "$LOG_DIR/synapse.log" 2>&1 &
  SYNAPSE_PID=$!
  for _ in $(seq 1 30); do
    curl -sf -o /dev/null "$SYNAPSE_URL/_matrix/client/versions" && break
    sleep 1
  done
  if curl -sf -o /dev/null "$SYNAPSE_URL/_matrix/client/versions"; then
    echo "[synapse] 就绪：$SYNAPSE_URL"
  else
    echo "[synapse] 启动失败，请查看 $LOG_DIR/synapse.log" >&2
  fi
fi

# 2) chat2movie 服务端（含聊天转视频机器人，监听 !video 指令）
echo "[server] 启动中...（日志：$LOG_DIR/server.log）"
( cd "$ROOT/apps/server" && NODE_ENV=dev bun run dev > "$LOG_DIR/server.log" 2>&1 ) &
SERVER_PID=$!

# 3) 前端 Vite 开发服务器（通过 /_matrix 与 /api 代理同源访问 Synapse 与服务端）
echo "[web] 启动中...（日志：$LOG_DIR/web.log）"
( cd "$ROOT/apps/web" && bun run dev > "$LOG_DIR/web.log" 2>&1 ) &
WEB_PID=$!

echo
echo "[dev-local] 全部启动命令已发出："
echo "  - Synapse : $SYNAPSE_URL"
echo "  - 服务端  : http://localhost:${TOONFLOW_SERVER_PORT:-3000}"
echo "  - 前端    : http://localhost:5173/#/chat"
echo "  日志目录  : $LOG_DIR"
echo "  按 Ctrl+C 停止本脚本启动的进程。"

wait
