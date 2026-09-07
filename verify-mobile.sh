#!/usr/bin/env bash
# ============================================================
#  DSH-ARCHIVE 手机版 自检脚本（Termux + proot-distro Ubuntu）
#  用法：bash verify-mobile.sh
#  用途：每次项目改动同步到手机分发包后，在手机端快速确认
#        本包是否完整、能否使用（对应"检查改动在手机分发包能否使用"）。
#  检查项：Node / dsh / profile 链接 / 路径归一化 / 依赖 / 模块同步 /
#          mobile-ui 注册 / dsh-tools 链接 / ollama / 数据目录
# ============================================================
set -uo pipefail

INSTALL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
pass=0
fail=0

ok() { echo "[自检] [OK]   $*"; pass=$((pass+1)); }
no() { echo "[自检] [FAIL] $*"; fail=$((fail+1)); }
need() { command -v "$1" >/dev/null 2>&1; }

echo '==== DSH-ARCHIVE 手机版自检 ===='
echo "安装目录：$INSTALL_DIR"

# 1. Node 版本
if need node && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' 2>/dev/null; then
  ok "Node.js $(node -v)"
else
  no 'Node.js >= 22.5（当前缺失或过低）'
fi

# 2. dsh CLI
need dsh && ok "dsh CLI $(dsh --version 2>/dev/null | head -n1)" || no 'dsh CLI（请先运行 install.sh）'

# 3. profile 符号链接
if [ -L "$HOME/.dsh/profiles/archive" ] && [ "$(readlink -f "$HOME/.dsh/profiles/archive")" = "$INSTALL_DIR/dsh" ]; then
  ok 'profile 符号链接正确'
else
  no 'profile 符号链接缺失或指向错误（请重跑 install.sh）'
fi

# 4. 路径归一化（无 Windows 路径残留）
LEFT="$(grep -rlE 'C:/DSH-ARCHIVE|C:/DSH-ARCHIVE' "$INSTALL_DIR" \
  --include='*.yml' --include='*.yaml' --include='*.json' --include='*.js' \
  --include='*.md' --include='*.txt' 2>/dev/null | grep -v node_modules | wc -l)"
if [ "$LEFT" -eq 0 ]; then ok '无 Windows 绝对路径残留'; else no "路径残留 $LEFT 个文件（请重跑 install.sh 完成路径重写）"; fi

# 5. pnpm 依赖
if [ -f "$INSTALL_DIR/dsh/node_modules/.modules.yaml" ]; then ok 'pnpm 依赖已安装'; else no 'pnpm 依赖未安装（请重跑 install.sh）'; fi

# 6. 模块同步（含 mobile-ui）
cnt=0
total=0
for m in "$INSTALL_DIR"/modules/*/; do
  [ -d "$m" ] || continue
  total=$((total+1))
  [ -d "$INSTALL_DIR/dsh/node_modules/dsh-archive-$(basename "$m")" ] && cnt=$((cnt+1))
done
if [ "$cnt" -eq "$total" ] && [ "$total" -gt 0 ]; then ok "模块同步 $cnt/$total"; else no "模块同步 $cnt/$total"; fi

# 7. mobile-ui 注册
if grep -q 'archive-mobile-ui' "$INSTALL_DIR/dsh/cordis.patch.yml" 2>/dev/null \
  && [ -d "$INSTALL_DIR/modules/mobile-ui" ]; then
  ok 'mobile-ui（手机 UI 适配）已注册'
else
  no 'mobile-ui 未注册或缺失'
fi

# 8. dsh-tools 链接
if [ -L "$INSTALL_DIR/dsh/node_modules/@deepseek-ai/dsh-tools" ]; then ok 'dsh-tools 链接就绪'; else no 'dsh-tools 链接缺失（请重跑 install.sh）'; fi

# 9. ollama 二进制（存在即补执行位；Windows 打包的 tar 不带 Unix 权限位）
if [ -f "$INSTALL_DIR/ollama/bin/ollama" ]; then
  chmod +x "$INSTALL_DIR/ollama/bin/ollama" 2>/dev/null || true
fi
if [ -x "$INSTALL_DIR/ollama/bin/ollama" ]; then ok 'ollama 二进制就绪'; else no 'ollama 二进制缺失或不可执行（install.sh 未完成或打包异常）'; fi

# 10. 数据目录
if [ -d "$INSTALL_DIR/dsh/data" ]; then ok '数据目录就绪'; else no '数据目录缺失'; fi

# 11. 凭据/设置权限（dsh-credentials-local 安全策略要求 600，否则拒绝启动）
for f in "$INSTALL_DIR/dsh/data/credentials.yaml" "$INSTALL_DIR/dsh/data/settings.yaml"; do
  if [ -f "$f" ]; then
    if [ "$(stat -c%a "$f" 2>/dev/null)" = "600" ]; then ok "$(basename "$f") 权限 600"; else no "$(basename "$f") 权限非 600（请重跑 install.sh 或 chmod 600）"; fi
  fi
done

echo "==== 自检结果：$pass 通过 / $fail 失败 ===="
[ "$fail" -eq 0 ]
