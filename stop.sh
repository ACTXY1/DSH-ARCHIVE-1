#!/usr/bin/env bash
# ============================================================
#  DSH-ARCHIVE 手机版 停止脚本（Termux + proot-distro Ubuntu）
#  用法：bash stop.sh
#  功能（等价 Windows stop.ps1，无托盘）：
#    1. 优雅停止 dsh webui（TERM -> 等待 -> KILL，保护会话日志）
#    2. 停止本项目启动的 ollama（PID 文件 + 进程名校验防误杀）
#    3. 验证端口释放
# ============================================================
set -uo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH_DIR="$INSTALL_DIR/dsh"
PORT=3081
DSH_PID_FILE="$DASH_DIR/data/dsh.pid"
OLLAMA_PID_FILE="$INSTALL_DIR/ollama/ollama.pid"

log()  { echo "[stop] $*"; }
warn() { echo "[stop] [WARN] $*" >&2; }
test_port() { (echo > "/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

echo '[stop] 停止 DSH-ARCHIVE ...'

# ---------------- 1. 停止 dsh ----------------
# PID 文件优先；校验进程命令行含 --profile archive，防止 PID 被系统复用时误杀无关进程。
if [ -f "$DSH_PID_FILE" ]; then
  pid="$(head -n1 "$DSH_PID_FILE" 2>/dev/null)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null \
    && ps -p "$pid" -o args= 2>/dev/null | grep -q -- '--profile archive'; then
    log "停止 dsh（PID $pid）..."
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then
      warn 'dsh 未在 10 秒内退出，强制结束'
      kill -9 "$pid" 2>/dev/null
    fi
  else
    warn "PID 文件中的进程（$pid）不存在或非本项目进程，跳过"
  fi
  rm -f "$DSH_PID_FILE"
fi

# ---------------- 2. 停止 ollama（仅本脚本启动的） ----------------
# 与 Windows 版一致：仅当 ollama.pid 存在（start.sh 启动时写入）且进程名匹配 ollama 才停止；
# 外部 ollama（11434 被外部占用）从不触碰。
if [ -f "$OLLAMA_PID_FILE" ]; then
  opid="$(head -n1 "$OLLAMA_PID_FILE" 2>/dev/null)"
  if [ -n "$opid" ] && kill -0 "$opid" 2>/dev/null \
    && [ "$(ps -p "$opid" -o comm= 2>/dev/null | tr -d ' ')" = 'ollama' ]; then
    log "停止 ollama（PID $opid）..."
    kill "$opid" 2>/dev/null
    for _ in $(seq 1 5); do
      kill -0 "$opid" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$opid" 2>/dev/null
  else
    warn "ollama PID（$opid）不存在或进程名不匹配（可能过期），跳过"
  fi
  rm -f "$OLLAMA_PID_FILE"
fi

# ---------------- 3. 验证端口释放 ----------------
sleep 2
if test_port "$PORT"; then
  warn "端口 $PORT 仍被监听——残留 dsh 进程："
  # 2026-09-10 独立化后命令行形如 `node …/@deepseek-ai/dsh/lib/bin.js --profile archive …`，
  # 旧模式 'dsh --profile' 不再命中——统一按 --profile archive 匹配。
  pgrep -af -- '--profile archive' 2>/dev/null | head -n5
  exit 1
fi

log "SUCCESS: 已停止（端口 $PORT 已释放）"
