#!/usr/bin/env bash
# ============================================================
#  DSH-ARCHIVE 手机版 启动脚本（Termux + proot-distro Ubuntu）
#  用法：bash start.sh
#  功能（等价 Windows start.ps1，无托盘）：
#    1. 环境检查（dsh 命令 / profile 挂载）
#    2. 单实例守卫（PID 文件 + 端口探测，防双开损坏数据）
#    3. 日志轮转（archive.log > 10MB -> .old）
#    4. ollama 启动或复用 11434；首次拉取向量模型
#    5. termux-wake-lock（防息屏暂停；proot 内不可用时仅提示）
#    6. 启动 dsh webui（3081）
#    7. 等待就绪
#  注意：首次使用前先运行 install.sh
# ============================================================
set -uo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DASH_DIR="$INSTALL_DIR/dsh"
LOG_DIR="$DASH_DIR/logs"
LOG="$LOG_DIR/archive.log"
OLLAMA_LOG="$LOG_DIR/ollama.log"
PORT=3081
OLLAMA_PORT=11434
OLLAMA_EXE="$INSTALL_DIR/ollama/bin/ollama"
OLLAMA_PID_FILE="$INSTALL_DIR/ollama/ollama.pid"
DSH_PID_FILE="$DASH_DIR/data/dsh.pid"

log()  { echo "[start] $*"; }
warn() { echo "[start] [WARN] $*" >&2; }
die()  { echo "[start] [ERROR] $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }
test_port() { (echo > "/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

mkdir -p "$LOG_DIR"

echo '============================================'
echo '  DSH-ARCHIVE 手机版启动'
echo '============================================'

# ---------------- 1. 环境检查 ----------------
need dsh || die '未找到 dsh 命令（请先运行 install.sh）'
PROFILE_LINK="$HOME/.dsh/profiles/archive"
if [ ! -e "$PROFILE_LINK" ]; then
  die 'archive profile 未挂载（请先运行 install.sh）'
fi
# 2026-09-05 防御：profile 必须指向【本副本】的 dsh。手机重装/复制到新目录后链接若仍指旧目录，
# 启动会读到旧(或另一份空白)副本的 dsh/data——对话记录与模型提供商配置会显示"被重置"，
# 真实数据其实在别的副本里（勿删任何副本）。此处不一致即拒绝启动。
PROFILE_TARGET="$(readlink -f "$PROFILE_LINK" 2>/dev/null || true)"
DASH_REAL="$(cd "$DASH_DIR" && pwd)"
if [ -n "$PROFILE_TARGET" ] && [ "$PROFILE_TARGET" != "$DASH_REAL" ]; then
  die "archive profile 指向 $PROFILE_TARGET，而非本副本 $DASH_REAL；请在本目录重跑 install.sh 后启动"
fi
# 数据根自检：一键更新用 git checkout -f 拉回仓库标准路径 C:/DSH-ARCHIVE，随后必须重跑路径归一化；
# 若该步被中断/跳过，服务会把数据读写到错误位置。检测 patch 内残留即拒绝启动。
if grep -qE '^[[:space:]]*(root|path|dbPath|dataPath|dataRoot|personaPath|ledgerPath|skillsDir|notificationsPath|trajectoryPath|dshHome):[[:space:]]*C:/DSH-ARCHIVE' "$DASH_DIR/cordis.patch.yml" 2>/dev/null; then
  die 'dsh/cordis.patch.yml 仍含仓库标准路径 C:/DSH-ARCHIVE（未归一化）；请重跑 install.sh 或 update.sh'
fi

# ---------------- 2. 单实例守卫 ----------------
running=0
if [ -f "$DSH_PID_FILE" ]; then
  old_pid="$(head -n1 "$DSH_PID_FILE" 2>/dev/null)"
  if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null \
    && ps -p "$old_pid" -o args= 2>/dev/null | grep -q -- '--profile archive'; then
    running=1
  fi
fi
for p in "$PORT" 3111 3113; do
  if test_port "$p"; then running=1; fi
done
if [ "$running" -eq 1 ]; then
  warn 'DSH-ARCHIVE 已在运行——请勿重复启动（多实例共享数据会损坏会话/记忆）'
  warn '如需重启：先运行 bash stop.sh'
  exit 0
fi

# ---------------- 3. 日志轮转 ----------------
if [ -f "$LOG" ]; then
  size="$(stat -c%s "$LOG" 2>/dev/null || echo 0)"
  if [ "$size" -gt 10485760 ]; then
    mv -f "$LOG" "$LOG.old" 2>/dev/null && log 'archive.log 已轮转（>10MB -> archive.log.old）'
  fi
fi

# ---------------- 4. ollama（启动或复用 11434） ----------------
# 2026-09-04 fix: verify the 11434 listener is really an ollama before reusing it -
# an unrelated service on that port must not suppress the bundled ollama start
# (embedding would silently stay broken).
export OLLAMA_MODELS="$INSTALL_DIR/ollama/home/models"
if [ -x "$OLLAMA_EXE" ]; then
  if test_port "$OLLAMA_PORT"; then
    if "$OLLAMA_EXE" list >/dev/null 2>&1; then
      log '外部 ollama 已在 11434 监听（复用）'
    else
      warn "11434 端口被非 ollama 进程占用——嵌入将不可用；bundled ollama 因端口冲突不启动，请释放端口后重启"
    fi
  else
    log '启动 ollama ...'
    nohup "$OLLAMA_EXE" serve >> "$OLLAMA_LOG" 2>&1 &
    echo $! > "$OLLAMA_PID_FILE"
    ready=0
    for _ in $(seq 1 30); do
      sleep 1
      if test_port "$OLLAMA_PORT"; then ready=1; break; fi
    done
    if [ "$ready" -eq 1 ]; then
      log 'ollama 就绪 (11434)'
      if ! "$OLLAMA_EXE" list 2>/dev/null | grep -q 'dmeta-embedding-zh'; then
        log '首次拉取向量模型 shaw/dmeta-embedding-zh（需网络，约数百 MB，请耐心等待）...'
        "$OLLAMA_EXE" pull shaw/dmeta-embedding-zh 2>&1 | tail -n5
      fi
    else
      warn 'ollama 30 秒内未就绪（记忆的向量检索将不可用，可稍后重试）'
    fi
  fi
else
  warn "未找到 ollama 二进制（$OLLAMA_EXE）——请先运行 install.sh 完成下载"
fi

# ---------------- 5. termux-wake-lock ----------------
if need termux-wake-lock; then
  termux-wake-lock && log 'termux-wake-lock 已启用（息屏不暂停）'
else
  warn '未找到 termux-wake-lock——请在 Termux 原生环境执行 termux-wake-lock，并在系统设置中允许 Termux 后台运行、关闭电池优化'
fi

# ---------------- 6. 启动 dsh webui ----------------
log "启动控制界面 http://127.0.0.1:$PORT（日志: $LOG）"
cd "$DASH_DIR" || die '无法进入 dsh 目录'
nohup dsh --profile archive --port "$PORT" --no-open >> "$LOG" 2>&1 &
DSH_PID=$!
echo "$DSH_PID" > "$DSH_PID_FILE"
log "dsh 已启动（PID $DSH_PID）"

# ---------------- 7. 等待就绪 ----------------
ready=0
for _ in $(seq 1 30); do
  sleep 2
  if test_port "$PORT"; then ready=1; break; fi
done
if [ "$ready" -eq 1 ]; then
  log "SUCCESS: http://127.0.0.1:$PORT"
else
  warn '60 秒内未就绪，日志末尾：'
  tail -n 20 "$LOG" 2>/dev/null
fi
