#!/usr/bin/env bash
# ============================================================
#  update.sh —— DSH-ARCHIVE 手机版 一键更新 / 一键回滚
#
#  适用环境：安卓 Termux + proot-distro Ubuntu（glibc）
#  用法：进入项目根目录后执行
#    bash update.sh                    # 更新到最新
#    bash update.sh -Rollback          # 回退到上一个发布版
#    bash update.sh -Rollback -TargetTag v2026-09-01
#  开发/测试开关：-NoFetch（跳过 git fetch） -NoStop（不停服） -NoStart（更新后不启动）
#
#  流程：校验 → git 检查 → fetch（失败不打扰服务）→ 版本比较（已最新则退出，
#        本地领先远程则中止防降级）→ 备份本地改动 → 停服 → 强制检出
#        → 路径归一化（git 检出会带回 C:/ 路径，必须重写为当前安装目录）
#        → 依赖变更检测+install → 模块同步 → preset 强制同步
#        → 平台清理（删 .cmd/.ps1，保持手机包形态）→ 摘要 → 启动
#  数据安全：dsh/data、ollama、backups 为 untracked，强制检出绝不触碰。
# ============================================================
set -uo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ROLLBACK=0
TARGET_TAG=""
NO_FETCH=0
NO_STOP=0
NO_START=0

while [ $# -gt 0 ]; do
  case "$1" in
    -Rollback)  ROLLBACK=1 ;;
    -TargetTag) TARGET_TAG="${2:-}"; shift ;;
    -NoFetch)   NO_FETCH=1 ;;
    -NoStop)    NO_STOP=1 ;;
    -NoStart)   NO_START=1 ;;
    *) echo "[update] [ERROR] 未知参数：$1"; exit 1 ;;
  esac
  shift
done

log()  { echo "[update] $*"; }
ok()   { echo "[update] [OK] $*"; }
warn() { echo "[update] [WARN] $*" >&2; }
die()  { echo "[update] [ERROR] $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }

get_version() {
  if [ -f "$INSTALL_DIR/VERSION" ]; then cat "$INSTALL_DIR/VERSION"; else git -C "$INSTALL_DIR" describe --tags --abbrev=0 2>/dev/null; fi
}

write_log() {
  mkdir -p "$INSTALL_DIR/dsh/logs" 2>/dev/null || true
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$INSTALL_DIR/dsh/logs/update.log" 2>/dev/null || true
}

echo '============================================'
echo "  DSH-ARCHIVE 手机版 $([ "$ROLLBACK" -eq 1 ] && echo '一键回滚' || echo '一键更新')"
echo "  项目根：$INSTALL_DIR"
echo '============================================'

# ---------------- 0. 校验项目根 ----------------
if [ ! -f "$INSTALL_DIR/dsh/cordis.patch.yml" ] || [ ! -f "$INSTALL_DIR/dsh/package.json" ]; then
  die "未识别为 DSH-ARCHIVE 项目根。请把 update.sh 放在项目根目录（与 dsh/ 文件夹同级）再运行。"
fi

# ---------------- 1. 校验 git 与仓库 ----------------
need git || die "未安装 git。请先安装：pkg install git（Termux 原生）/ apt-get install -y git（Ubuntu）"
[ -d "$INSTALL_DIR/.git" ] || die "缺少仓库元数据（.git 不存在）。请重新领取最新手机分发包。"
if ! git -C "$INSTALL_DIR" remote get-url origin >/dev/null 2>&1; then
  die "未配置远程仓库 origin。请重新领取分发包，或手动执行：git remote add origin <仓库地址>"
fi

OLD_VER="$(get_version)"
CUR="$(git -C "$INSTALL_DIR" rev-parse HEAD 2>/dev/null)"

# ---------------- 2. fetch（失败不打扰服务） ----------------
if [ "$NO_FETCH" -ne 1 ]; then
  log '拉取远程更新（git fetch）...'
  if ! git -C "$INSTALL_DIR" fetch origin; then
    die '拉取失败：网络不通或凭据无效。服务未受影响，可稍后重试。'
  fi
else
  log '跳过 fetch（-NoFetch，测试用：使用本地已有 origin/main 引用）'
fi

# ---------------- 3. 确定目标版本 ----------------
if [ "$ROLLBACK" -ne 1 ]; then
  NEW="$(git -C "$INSTALL_DIR" rev-parse origin/main 2>/dev/null)"
  [ -n "$NEW" ] || die '远程仓库没有 main 分支（远程为空或未推送？）。'
  if [ "$CUR" = "$NEW" ]; then
    ok "已是最新版本（$OLD_VER），无需更新。"
    exit 0
  fi
  AHEAD="$(git -C "$INSTALL_DIR" rev-list --count "$NEW..$CUR" 2>/dev/null)"
  if [ "${AHEAD:-0}" -gt 0 ]; then
    die "本地存在 $AHEAD 个远程没有的提交（可能是开发者本机忘了推送）。为避免降级，已中止更新；请先推送。"
  fi
  TARGET="origin/main"
  MODE="更新"
else
  if [ -n "$TARGET_TAG" ]; then
    git -C "$INSTALL_DIR" rev-parse "$TARGET_TAG" >/dev/null 2>&1 || die "标签不存在：$TARGET_TAG"
  else
    TAGS="$(git -C "$INSTALL_DIR" tag -l 'v*' | sort -r)"
    [ "$(echo "$TAGS" | grep -c . )" -ge 2 ] || die '没有可回退的历史版本（仅有一个发布标签）。'
    TARGET_TAG="$(echo "$TAGS" | sed -n '2p')"   # 跳过最新，取上一个发布版
  fi
  TARGET="$TARGET_TAG"
  MODE="回滚到 $TARGET_TAG"
fi
log "目标：$TARGET"

# ---------------- 4. 备份本地对共享代码的改动 ----------------
# 过滤"归一化伪差异"：分发包内容被预归一化（路径改写），与 git HEAD 内容天然不同、
# status 恒显示 modified——这类差异不是用户改动，不备份不警告。
PERL_NORM='s/\r\n/\n/g; s{[A-Za-z]:(?!//)[\\/][^":\r\n<>|`]*DSH-ARCHIVE}{<ROOT>}g;'
REAL_DIRTY=""
while IFS= read -r line; do
  [ -z "$line" ] && continue
  rel="${line:3}"
  rel="${rel#\"}"; rel="${rel%\"}"
  case "$rel" in
    *.yml|*.yaml|*.ps1|*.md|*.txt|*.json|*.js|*.cjs|*.mjs|*.cmd|*.bat|*.sh|*.html|*.css|*.ts|*.xml|*.cfg|*.conf|*.ini|*.properties|*.env|*.csv)
      if [ -f "$INSTALL_DIR/$rel" ]; then
        work_norm="$(perl -pe "$PERL_NORM" < "$INSTALL_DIR/$rel" 2>/dev/null)"
        head_norm="$(git -C "$INSTALL_DIR" show "HEAD:$rel" 2>/dev/null | perl -pe "$PERL_NORM")"
        [ "$work_norm" = "$head_norm" ] && continue   # 伪差异，跳过
      fi ;;
  esac
  REAL_DIRTY="${REAL_DIRTY}${REAL_DIRTY:+$'\n'}$line"
done < <(git -C "$INSTALL_DIR" -c core.quotepath=false status --porcelain 2>/dev/null | grep -v '^??' || true)
DIRTY="$REAL_DIRTY"
if [ -n "$DIRTY" ]; then
  BK_DIR="$INSTALL_DIR/backups/update-backup"
  mkdir -p "$BK_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  PATCH="$BK_DIR/${STAMP}-changes.patch"
  git -C "$INSTALL_DIR" diff > "$PATCH"
  warn "检测到对共享代码的本地改动，已备份：$PATCH"
  warn '强制检出将覆盖这些改动；用户数据（dsh/data、ollama、backups）不受影响。'
fi

# ---------------- 5. 停止服务 ----------------
if [ "$NO_STOP" -ne 1 ] && [ -f "$INSTALL_DIR/stop.sh" ]; then
  log '停止服务（bash stop.sh）...'
  (cd "$INSTALL_DIR" && bash stop.sh) || warn '停止未完全成功，继续尝试更新。'
fi

# ---------------- 6. 强制检出 ----------------
log "$MODE：检出 $TARGET"
git -C "$INSTALL_DIR" checkout -f -B main "$TARGET" || die "git checkout 失败（$TARGET）"

# ---------------- 7. 依赖变更检测（有变才 install） ----------------
DEP_CHANGED="$(git -C "$INSTALL_DIR" diff --name-only "$CUR" "$TARGET" -- dsh/package.json dsh/pnpm-lock.yaml)"
if [ -n "$DEP_CHANGED" ]; then
  log '依赖清单已变更，执行 pnpm install ...'
  (cd "$INSTALL_DIR/dsh" && pnpm install --config.confirmModulesPurge=false) || die 'pnpm install 失败'
fi

# ---------------- 8. 路径归一化（git 检出会带回 C:/ 路径，必须重写为当前安装目录） ----------------
# 移植自 install.sh 第 4 步：匹配「盘符: 分隔符 任意段 DSH-ARCHIVE」替换为当前安装目录。
# 两道防护：①盘符后负向前瞻 (?!//) 保护 file:// https://；②file:////+ 归一为 file:///。
export ARC_DIR="$INSTALL_DIR"
PERL_SCRIPT='
  if ($ARGV =~ /\.json$/i) { s{\\\\}{\x{E000}}g }
  s{[A-Za-z]:(?!//)[\\/][^":\r\n<>|`]*DSH-ARCHIVE}{$ENV{ARC_DIR}}g;
  if ($ARGV =~ /\.json$/i) { s{\x{E000}}{\\\\}g }
  s{file:////+}{file:///}g;
'
TEXT_EXTS='yml yaml md txt json js cjs mjs html css ts xml cfg conf ini properties env csv sh'
changed=0
log '重写项目内路径 -> 当前安装目录'
while IFS= read -r -d '' f; do
  ext="${f##*.}"
  case " $TEXT_EXTS " in *" ${ext,,} "*) ;; *) continue ;; esac
  case "$f" in
    */.git/*|*/.pnpm-store/*|*/ollama/*|*/logs/*|*/backups/*|*/node_modules/*) continue ;;
  esac
  if grep -qE '[A-Za-z]:[\\/].*DSH-ARCHIVE' "$f" 2>/dev/null; then
    perl -i -pe "$PERL_SCRIPT" "$f"
    changed=$((changed+1))
  fi
done < <(find "$INSTALL_DIR" -type f -not -path "$INSTALL_DIR/.git/*" -print0)
if [ "$changed" -eq 0 ]; then
  ok '扫描完成，无过时路径引用'
else
  log "已重写 $changed 个文件中的旧路径 -> $INSTALL_DIR"
fi

# ---------------- 9. 模块同步 + dsh-tools 链接（install.sh 6b/6c 段） ----------------
mkdir -p "$INSTALL_DIR/dsh/node_modules"
for m in "$INSTALL_DIR"/modules/*/; do
  [ -d "$m" ] || continue
  name="$(basename "$m")"
  target="$INSTALL_DIR/dsh/node_modules/dsh-archive-$name"
  rm -rf "$target"
  cp -r "$m" "$target"
done
LAUNCHER_TOOLS="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools"
mkdir -p "$INSTALL_DIR/dsh/node_modules/@deepseek-ai"
if [ ! -L "$INSTALL_DIR/dsh/node_modules/@deepseek-ai/dsh-tools" ] || \
   [ "$(readlink -f "$INSTALL_DIR/dsh/node_modules/@deepseek-ai/dsh-tools" 2>/dev/null)" != "$LAUNCHER_TOOLS" ]; then
  rm -rf "$INSTALL_DIR/dsh/node_modules/@deepseek-ai/dsh-tools"
  ln -s "$LAUNCHER_TOOLS" "$INSTALL_DIR/dsh/node_modules/@deepseek-ai/dsh-tools" 2>/dev/null \
    || warn 'dsh-tools 链接失败（Windows/无权限环境可忽略；真机 Linux 正常）'
fi
ok 'modules 已同步'

# ---------------- 10. agent preset 强制同步（install.sh 为"存在即跳过"，更新需强制覆盖） ----------------
if [ -d "$INSTALL_DIR/presets/archive-standard" ]; then
  mkdir -p "$HOME/.dsh/.agent-presets"
  rm -rf "$HOME/.dsh/.agent-presets/archive-standard"
  cp -r "$INSTALL_DIR/presets/archive-standard" "$HOME/.dsh/.agent-presets/archive-standard"
  ok 'agent preset 已同步'
fi

# ---------------- 11. 平台清理（保持手机包形态：无 Windows 平台脚本） ----------------
(cd "$INSTALL_DIR" && rm -f ./*.cmd ./*.ps1 tray.ps1) 2>/dev/null || true
ok '已清理 Windows 平台脚本（保持手机包形态）'

# ---------------- 12. 验证 + 摘要 + 日志 + 启动 ----------------
if [ "$NO_START" -ne 1 ] && need dsh; then
  log '验证 profile 可加载（dsh --profile archive --dump-config）...'
  OUT="$(dsh --profile archive --dump-config 2>&1)"
  if [ $? -ne 0 ]; then
    warn 'profile 验证失败，输出如下：'
    echo "$OUT" | head -n 20
  else
    ok 'profile 合成正常'
  fi
fi

NEW_VER="$(get_version)"
ok "新版本：$NEW_VER"
if [ "$ROLLBACK" -ne 1 ]; then
  git -C "$INSTALL_DIR" log --oneline --no-decorate "$CUR..$TARGET" 2>/dev/null | sed 's/^/    /'
fi

if [ "$NO_START" -ne 1 ] && [ -f "$INSTALL_DIR/start.sh" ]; then
  log '启动服务（bash start.sh）...'
  (cd "$INSTALL_DIR" && bash start.sh) || warn '启动未完全成功，请查看上方输出'
fi

write_log "$MODE 完成（$CUR -> $TARGET，版本 $NEW_VER）"
echo '============================================'
echo "  $MODE 完成！如需撤销：bash rollback.sh"
echo '============================================'
exit 0
