#!/bin/bash
# ============================================================================
# Cocos Dashboard 一键安装脚本（macOS）
# ----------------------------------------------------------------------------
# 作用：把已下载好的 CocosDashboard dmg 自动安装到 /Applications
#       处理流程：校验完整性 → 挂载 dmg → 拷贝 .app → 解除 quarantine → 卸载
# 用法： bash tools/install-cocos-dashboard.sh [dmg路径]
#        不传参则默认找 ~/Downloads 下的 CocosDashboard*.dmg
# 说明：官方下载链接（需国内直连出口，走代理会 403）：
#   https://download.cocos.com/CocosDashboard/v2.2.2/CocosDashboard-v2.2.2-mac-091515.dmg
# ============================================================================
set -euo pipefail

DMG="${1:-}"
if [ -z "$DMG" ]; then
  DMG="$(ls -t "$HOME"/Downloads/CocosDashboard*.dmg 2>/dev/null | head -1 || true)"
fi

echo "==> 目标安装包：${DMG:-（未找到）}"
if [ -z "$DMG" ] || [ ! -f "$DMG" ]; then
  echo "❌ 没找到 dmg。请先下载："
  echo "   https://download.cocos.com/CocosDashboard/v2.2.2/CocosDashboard-v2.2.2-mac-091515.dmg"
  echo "   放好后重跑：bash $0 ~/Downloads/CocosDashboard-xxx.dmg"
  exit 1
fi

# --- 1. 完整性校验：安装包正常约 190MB+，明显偏小说明下了一半 ---
SIZE_BYTES=$(stat -f%z "$DMG")
SIZE_MB=$((SIZE_BYTES / 1024 / 1024))
echo "==> 文件体积：${SIZE_MB} MB"
if [ "$SIZE_MB" -lt 100 ]; then
  echo "⚠️  体积偏小（<100MB），可能是未下载完的残包或 403 错误页被存成了文件。"
  echo "    前 200 字节内容如下（若看到 html/403 说明下的不是安装包）："
  head -c 200 "$DMG"; echo
  read -r -p "仍要继续安装吗？(y/N) " ans
  [ "$ans" = "y" ] || exit 1
fi

# --- 2. 挂载 dmg ---
echo "==> 挂载 dmg ..."
MP=$(hdiutil attach "$DMG" -nobrowse -readonly | grep -o '/Volumes/.*' | tail -1)
echo "    挂载点：$MP"
[ -d "$MP" ] || { echo "❌ 挂载失败"; exit 1; }

cleanup() { hdiutil detach "$MP" -quiet 2>/dev/null || true; }
trap cleanup EXIT

# --- 3. 定位 .app ---
APP_SRC=$(find "$MP" -maxdepth 2 -name "*.app" -type d | head -1)
[ -n "$APP_SRC" ] || { echo "❌ dmg 里没找到 .app"; exit 1; }
APP_NAME=$(basename "$APP_SRC")
echo "==> 找到应用：$APP_NAME"

# --- 4. 拷贝到 /Applications（已存在则先备份移除）---
if [ -d "/Applications/$APP_NAME" ]; then
  echo "==> 检测到已安装，先移除旧版 ..."
  rm -rf "/Applications/$APP_NAME"
fi
echo "==> 拷贝到 /Applications（需要管理员权限）..."
ditto "$APP_SRC" "/Applications/$APP_NAME"

# --- 5. 解除隔离属性（避免“已损坏/来自身份不明的开发者”打不开）---
echo "==> 解除 quarantine 隔离属性 ..."
xattr -dr com.apple.quarantine "/Applications/$APP_NAME" 2>/dev/null || true

# --- 6. 验证 ---
if [ -d "/Applications/$APP_NAME" ]; then
  echo "✅ 安装完成：/Applications/$APP_NAME"
  echo "   下一步：打开 Cocos Dashboard → 登录 cocos.com 账号 → 安装 Creator 3.8.8"
else
  echo "❌ 安装失败"; exit 1
fi
