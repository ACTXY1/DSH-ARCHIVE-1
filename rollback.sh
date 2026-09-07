#!/usr/bin/env bash
# ============================================================
#  rollback.sh —— DSH-ARCHIVE 手机版 一键回滚到上一发布版
#  用法：进入项目根目录后执行  bash rollback.sh
#  等价：bash update.sh -Rollback
# ============================================================
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
exec bash update.sh -Rollback "$@"
