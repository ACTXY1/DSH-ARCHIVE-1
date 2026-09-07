#!/usr/bin/env bash
# ============================================================
#  DSH-ARCHIVE 手机版 首次安装 / 移动项目位置 一键修复
#
#  适用环境：安卓 Termux + proot-distro Ubuntu（glibc）
#  用法：进入项目根目录后执行  bash install.sh
#
#  功能（与 Windows 版 fix-project-location.ps1 等价）：
#    0. 校验项目根
#    1. 环境检测：node / npm / pnpm / dsh CLI
#    2. dsh 家目录初始化（生成 launcher 的 dsh-tools 副本）
#    3. ~/.dsh/profiles/archive 符号链接指向本项目 dsh 目录
#    4. 重写项目内旧 Windows 绝对路径 -> 当前安装目录
#    5. 装入 agent preset archive-standard
#    6. pnpm install + 模块源码同步 + dsh-tools 链接
#    7. 数据目录就绪
#    8. 下载 ollama linux-arm64 二进制（模型由 start.sh 按需拉取）
#    9. 验证 profile 可加载
#
#  设计：脚本位置即项目根，不硬编码任何绝对路径；可重复执行（幂等）。
# ============================================================
set -uo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_VER="0.1.1-rc.2"
export ARC_DIR="$INSTALL_DIR"   # 供 perl 路径重写使用

log()  { echo "[install] $*"; }
ok()   { echo "[install] [OK] $*"; }
warn() { echo "[install] [WARN] $*" >&2; }
die()  { echo "[install] [ERROR] $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1; }

echo '============================================'
echo '  DSH-ARCHIVE 手机版 首次安装/位置修复'
echo "  安装目录：$INSTALL_DIR"
echo '============================================'

# ---------------- 0. 校验项目根 ----------------
if [ ! -f "$INSTALL_DIR/dsh/cordis.patch.yml" ] || [ ! -f "$INSTALL_DIR/dsh/package.json" ]; then
  die "未找到 dsh/cordis.patch.yml 或 dsh/package.json，请确认脚本位于 DSH-ARCHIVE 项目根目录"
fi
ok '识别为 DSH-ARCHIVE 项目'

# ---------------- 1. 环境检测 ----------------
need node || die "未找到 node。请先安装 Node.js（>= 22.5），例如：curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs"
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' \
  || die "Node 版本需 >= 22.5（当前 $(node -v)），请升级后重跑"
ok "Node.js $(node -v)"
need npm || die '未找到 npm（Node.js 应自带）'
need pnpm || { log '未找到 pnpm，正在安装...'; npm install -g pnpm >/dev/null 2>&1 || die 'pnpm 安装失败'; }
ok "pnpm $(pnpm --version 2>/dev/null)"
if need dsh; then
  ok "dsh CLI $(dsh --version 2>/dev/null | head -n1)"
else
  log "安装全局 dsh CLI @deepseek-ai/dsh@$DSH_VER ..."
  npm install -g "@deepseek-ai/dsh@$DSH_VER" >/dev/null 2>&1 || die 'dsh CLI 安装失败'
fi
# git：更新检测/一键更新（updater.check / update.sh）依赖；部分环境（proot Ubuntu 最小安装）未预装
if ! need git; then
  log '未找到 git，正在安装（更新检测/一键更新需要）...'
  if apt-get install -y git >/dev/null 2>&1; then
    ok 'git 已安装'
  else
    warn 'git 安装失败——更新检测/一键更新将不可用（可稍后执行 apt-get install -y git）'
  fi
fi

# ---------------- 2. dsh 家目录初始化（launcher dsh-tools 副本） ----------------
LAUNCHER_TOOLS="$HOME/.dsh/profiles/node_modules/@deepseek-ai/dsh-tools"
if [ ! -d "$LAUNCHER_TOOLS" ]; then
  log '初始化 dsh 家目录（生成 launcher 副本）...'
  dsh --profile web --dump-config >/dev/null 2>&1 || true
  [ -d "$LAUNCHER_TOOLS" ] || die 'dsh 初始化未生成 launcher dsh-tools，请手动运行：dsh --profile web --dump-config'
fi
ok 'launcher dsh-tools 就绪'

# ---------------- 3. profile 符号链接 ----------------
mkdir -p "$HOME/.dsh/profiles"
LINK="$HOME/.dsh/profiles/archive"
if [ -L "$LINK" ] && [ "$(readlink -f "$LINK")" = "$INSTALL_DIR/dsh" ]; then
  ok 'profile 已挂载'
else
  rm -rf "$LINK"
  ln -s "$INSTALL_DIR/dsh" "$LINK" || die '创建 profile 符号链接失败'
  ok "profile 已挂载 -> $LINK"
fi

# ---------------- 4. 重写旧 Windows 绝对路径 ----------------
# 等价 fix-project-location.ps1 第 5 步：匹配「盘符: 分隔符 任意段 DSH-ARCHIVE」，
# 替换为当前安装目录（正斜杠形式，Linux/Node/YAML 均合法）。两道防护：
#  ① 盘符后负向前瞻 (?!//) —— 真路径盘符后是单斜杠（C:/...），而 file://、https://
#     的 e:/s: 后是双斜杠；否则重复运行 install.sh 会吞掉 https 链接或损坏 file://
#     （Windows 版替换目标带盘符无此问题，Linux 版必须加）；
#  ② file:////+ 归一为 file:/// —— 替换会把 file:///C:/... 变成 file:////root/...，
#     归一回标准 3 斜杠 file URL（幂等：正确结果不再被改动）。
# JSON 内双反斜杠转义用私有区占位符保护；perl -i 按字节处理，BOM 不受影响。
PERL_SCRIPT='
  if ($ARGV =~ /\.json$/i) { s{\\\\}{\x{E000}}g }
  s{[A-Za-z]:(?!//)[\\/][^":\r\n<>|`]*DSH-ARCHIVE}{$ENV{ARC_DIR}}g;
  if ($ARGV =~ /\.json$/i) { s{\x{E000}}{\\\\}g }
  s{file:////+}{file:///}g;
'
TEXT_EXTS='yml yaml md txt json js cjs mjs html css ts xml cfg conf ini properties env csv'
changed=0
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
done < <(find "$INSTALL_DIR" -type f -print0)
if [ "$changed" -eq 0 ]; then
  ok '扫描完成，无过时路径引用'
else
  log "已重写 $changed 个文件中的旧路径 -> $INSTALL_DIR"
fi

# ---------------- 5. agent preset 装入 ----------------
if [ -d "$INSTALL_DIR/presets/archive-standard" ]; then
  mkdir -p "$HOME/.dsh/.agent-presets"
  if [ ! -d "$HOME/.dsh/.agent-presets/archive-standard" ]; then
    cp -r "$INSTALL_DIR/presets/archive-standard" "$HOME/.dsh/.agent-presets/archive-standard"
    ok '已装入 agent preset archive-standard'
  else
    ok 'agent preset archive-standard 已存在'
  fi
fi

# ---------------- 6. 依赖安装 + 插件同步 ----------------
cd "$INSTALL_DIR/dsh" || die '无法进入 dsh 目录'
if [ ! -f node_modules/.modules.yaml ] || [ ! -f node_modules/dsh-archive-memory/package.json ]; then
  need pnpm || die '缺少 pnpm'
  log 'pnpm install（首次需要网络）...'
  pnpm install --config.confirmModulesPurge=false || die 'pnpm install 失败'
fi
ok 'profile 依赖完整'
# 6b. 模块源码同步（等价 Windows sync-plugins.ps1）
for m in "$INSTALL_DIR"/modules/*/; do
  [ -d "$m" ] || continue
  name="$(basename "$m")"
  target="node_modules/dsh-archive-$name"
  rm -rf "$target"
  cp -r "$m" "$target"
done
ok 'modules 已同步到 node_modules'
# 6c. dsh-tools 链接指向 launcher 副本（同一模块实例，Symbol 一致）
mkdir -p node_modules/@deepseek-ai
if [ ! -L node_modules/@deepseek-ai/dsh-tools ] || [ "$(readlink -f node_modules/@deepseek-ai/dsh-tools)" != "$LAUNCHER_TOOLS" ]; then
  rm -rf node_modules/@deepseek-ai/dsh-tools
  ln -s "$LAUNCHER_TOOLS" node_modules/@deepseek-ai/dsh-tools || die 'dsh-tools 链接失败'
fi
ok 'dsh-tools 链接就绪'

# ---------------- 7. 数据目录 ----------------
mkdir -p "$INSTALL_DIR/dsh/data/sessions" "$INSTALL_DIR/dsh/data/skills" "$INSTALL_DIR/dsh/data/storages"
# 敏感配置仅属主可读写：dsh-credentials-local 安全策略要求 600，否则拒绝加载。
# Windows 打包的 tar 不带 Unix 权限位（解压默认 644），必须显式收紧（幂等）。
for f in "$INSTALL_DIR/dsh/data/credentials.yaml" "$INSTALL_DIR/dsh/data/settings.yaml"; do
  if [ -f "$f" ]; then chmod 600 "$f" 2>/dev/null || true; fi
done
ok '数据目录就绪（敏感配置已收紧为 600）'

# ---------------- 8. ollama linux-arm64 二进制 ----------------
# 内置二进制可能因打包/传输丢失 Unix 执行位（Windows 打包的 tar 不带权限位），统一补上
if [ -f "$INSTALL_DIR/ollama/bin/ollama" ]; then
  chmod +x "$INSTALL_DIR/ollama/bin/ollama" 2>/dev/null || true
fi
if [ ! -x "$INSTALL_DIR/ollama/bin/ollama" ]; then
  OLLAMA_VERSION="v0.33.2"
  OLLAMA_ASSET="ollama-linux-arm64.tar.zst"
  # 下载工具：wget 或 curl 皆可
  DL=""
  need wget && DL="wget -q --show-progress -O"
  if [ -z "$DL" ] && need curl; then DL="curl -fSL --retry 3 -o"; fi
  if [ -z "$DL" ]; then
    warn "未找到 wget/curl——请先 apt-get install -y curl wget 后重跑本脚本；或手动放置 ollama（见下方提示）"
  else
    need zstd || warn "未找到 zstd——请先 apt-get install -y zstd 后重跑本脚本（新版 ollama 包为 .tar.zst 压缩）"
    log "下载 ollama $OLLAMA_VERSION（linux-arm64，约 1.4GB，需网络与耐心）..."
    mkdir -p "$INSTALL_DIR/ollama"
    TMP_FILE="$(mktemp /tmp/ollama-XXXXXX.tar.zst)"
    ok_dl=0
    for url in \
      "https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION/$OLLAMA_ASSET" \
      "https://gh-proxy.com/https://github.com/ollama/ollama/releases/download/$OLLAMA_VERSION/$OLLAMA_ASSET" \
      "https://ollama.com/download/ollama-linux-arm64.tgz"; do
      log "尝试下载：$url"
      if $DL "$TMP_FILE" "$url" 2>/dev/null; then ok_dl=1; break; fi
      rm -f "$TMP_FILE"
    done
    if [ "$ok_dl" -eq 1 ]; then
      if tar --zstd -xf "$TMP_FILE" -C "$INSTALL_DIR/ollama" 2>/dev/null || tar -xf "$TMP_FILE" -C "$INSTALL_DIR/ollama" 2>/dev/null; then
        chmod +x "$INSTALL_DIR/ollama/bin/ollama" 2>/dev/null || true
        if [ -x "$INSTALL_DIR/ollama/bin/ollama" ]; then
          ok "ollama 就绪 $("$INSTALL_DIR/ollama/bin/ollama" --version 2>/dev/null | head -n1)"
        else
          warn 'ollama 解压后未找到 bin/ollama，请手动检查'
        fi
      else
        warn 'ollama 解压失败（缺少 zstd？）'
      fi
      rm -f "$TMP_FILE"
    else
      warn "ollama 全部下载源失败（网络受限？）。可手动放置：在能联网的设备下载 $OLLAMA_ASSET，解压出 bin/ 与 lib/ 放进本目录 ollama/ 下，再重跑本脚本（详见《手机版说明.md》）"
    fi
  fi
else
  ok 'ollama 已存在'
fi

# ---------------- 9. 验证 ----------------
log '验证 profile 可加载（dsh --profile archive --dump-config）...'
OUT="$(dsh --profile archive --dump-config 2>&1)"
RC=$?
if [ $RC -eq 0 ]; then
  ok 'profile 合成正常！'
else
  warn 'profile 验证失败，输出如下：'
  echo "$OUT" | head -n 40
  exit 1
fi

echo '============================================'
echo '  安装完成！接下来运行：bash start.sh'
echo '============================================'
