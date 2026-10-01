#!/bin/bash
# ============================================================================
# 微信小游戏「真机试玩二维码」一键脚本
# ----------------------------------------------------------------------------
# 存在理由（用户约定，2026-10-01）：
#   **每一次代码更新，都要触发一次真机试玩二维码**，供用户在手机上试玩后再决定。
#   手工跑这条链路要记 6 个坑、敲 5 条命令，容易漏步 → 封装成这一条。
#
# 一条命令做完：
#   ① Cocos 无头构建微信包（复用 cocos-build.sh，坑已封装）
#   ② 核对产物真含本轮新代码（时间戳 + ASCII 标识符，防「假通过」）
#   ③ cli close 旧工程上下文  ← ★ 漏了这步，preview 会在「上一个工程」里编译，
#                                报极具误导性的 "未找到 game.json 文件"
#   ④ cli open 目标工程 → 等 IDE 编译加载
#   ⑤ cli preview 出二维码
#   ⑥ JPEG→真 PNG（--qr-output 固定输出 JPEG，哪怕文件名写 .png）
#   ⑦ 用 macOS 自带 Vision 框架解码，**验证「真的能扫」**（生成成功 ≠ 能扫）
#   ⑧ 写一份 README 说明本码有效期语义（预览码有且只有最新一张有效）
#
#   ⚠️ **`$VAR` 后面紧跟中文字符（如 `$MODE）`）会被 bash 当成变量名的一部分**
#      → 在 `set -u` 下报 `MODE\xef: unbound variable`（变量名里混进了一个 UTF-8 字节），
#      报错完全看不出是"紧跟中文"引起的。**凡是 `$VAR` 后面不是 ASCII 分隔符的，一律写 `${VAR}`。**
#
# 用法：
#   bash tools/wechat-preview.sh                          # 默认：game-4-mahjong / release / 归档到 docs/verify/S13/device
#   bash tools/wechat-preview.sh <工程目录|工程名> [debug|release] [归档目录]
#   SKIP_BUILD=1 bash tools/wechat-preview.sh             # 跳过构建，只重出码（换手机、码过期时用）
#
# 产出：
#   <归档目录>/真机预览二维码.png     ← 交给用户扫的这张
#   <归档目录>/preview-info.json      ← 包体字节数（就是 mp 后台看到的体积）
#   <归档目录>/README.md              ← 扫码须知 + 本次时间戳 + 解码内容
# ============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
APP="/Applications/wechatwebdevtools.app"

PROJ_ARG="${1:-game-4-mahjong}"
MODE="${2:-release}"
ARCHIVE="${3:-$ROOT/docs/verify/S13/device}"

PROJ="$PROJ_ARG"; [ -d "$PROJ_ARG" ] || PROJ="$ROOT/$PROJ_ARG"
[ -d "$PROJ" ] || { echo "❌ 找不到工程：$PROJ"; exit 1; }
PROJ="$(cd "$PROJ" && pwd)"                        # ★ 一律绝对路径（CLI 包装脚本里有 cd "$CWD"）

BUILD_DIR="$PROJ/build/wechatgame"
mkdir -p "$ARCHIVE"
ARCHIVE="$(cd "$ARCHIVE" && pwd)"                  # ★ 归档目录必须是「真目录」，不能是软链
                                                   #   （坑#19：/tmp 是软链 → 写 /tmp/qr.png 必失败）

echo "============================================================"
echo " 微信小游戏真机试玩码"
echo "   工程：$PROJ"
echo "   模式：$MODE    平台：wechatgame"
echo "   归档：$ARCHIVE"
echo "============================================================"

# ---------------------------------------------------------------- ① 构建
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "==> [1/7] 跳过构建（SKIP_BUILD=1）"
else
  echo "==> [1/7] 构建微信包（${MODE}）"
  bash "$SCRIPT_DIR/cocos-build.sh" wechatgame "$MODE" "$PROJ" build || exit 1
fi

# ---------------------------------------------------------------- ② 验产物真新
# 为什么要这一步：Cocos 构建若踩到 SIGTERM 会留下「目录完整但内容半成品」的产物，
# 而且 release 会剥离注释，所以只能 grep **ASCII 标识符**，不能 grep 中文 UI 文案。
ENTRY="$BUILD_DIR/game.js"
[ -f "$ENTRY" ] || { echo "❌ 产物入口缺失：$ENTRY"; exit 1; }
echo "==> [2/7] 核对产物"
echo "    入口 game.js：$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$ENTRY")"
if [ -f "$BUILD_DIR/assets/main/index.js" ]; then
  SRC_NEWEST=$(ls -t "$PROJ"/assets/scripts/*.ts "$PROJ"/assets/scripts/*/*.ts 2>/dev/null | head -1)
  echo "    最新源码文件：$(stat -f '%Sm' -t '%Y-%m-%d %H:%M:%S' "$SRC_NEWEST")  ($(basename "$SRC_NEWEST"))"
fi
if [ -n "${MARKERS:-}" ]; then
  for k in $MARKERS; do
    printf "    标识符 %-18s %s\n" "$k" "$(grep -c "$k" "$BUILD_DIR/assets/main/index.js" 2>/dev/null)"
  done
fi

# ---------------------------------------------------------------- ③⑦ 探活 + close + open
echo "==> [3/7] 探活微信开发者工具"
ide_ready() { local o; o=$("$CLI" islogin 2>&1); [[ "$o" == *'"login"'* ]]; }
READY=0
for i in $(seq 1 36); do
  if ide_ready; then echo "    IDE 已就绪（${i} 次探测）"; READY=1; break; fi
  [ "$i" = "1" ] && { echo "    冷启动工具（要 60s+）…"; open -a "$APP" 2>/dev/null; }
  sleep 5
done
[ "$READY" = "1" ] || { echo "❌ IDE 未就绪（服务端口是否已开？见 wechat-open.sh 的 --enable-service-port）"; exit 1; }

echo "==> [4/7] close 旧工程上下文（关键：否则 preview 在错的工程里编译）"
"$CLI" close --project "$BUILD_DIR" 2>&1 | grep -E '✔|✖' | tail -2
sleep 4

echo "==> [5/7] open 目标工程"
"$CLI" open --project "$BUILD_DIR" 2>&1 | grep -E '✔|✖' | tail -2

echo "    等待 IDE 编译加载…"
sleep "${IDE_WAIT:-30}"

# ---------------------------------------------------------------- ⑤ 出码
# ★ 必须重试（2026-10-01 实测）：刚做完 close+open 时，IDE 的工程上下文**看起来**好了
#   （cli open 返回 ✔ open），但内部编译服务还没挂载好 → preview 报
#       ✖ compile_start  +  { code: 10, message: '错误 undefined' }
#   隔 15 秒再试一次就成功。报错信息里**完全没有"还没加载完"的意思**，
#   所以这里不靠"等更久"，而是靠"重试到成功"。
echo "==> [6/7] 生成预览二维码"
QR_RAW="$ARCHIVE/.qr-raw.jpg"
PREV=""
OK_PREVIEW=0
for attempt in 1 2 3 4 5; do
  PREV=$("$CLI" preview --project "$BUILD_DIR" \
          --qr-format image \
          --qr-output "$QR_RAW" \
          --info-output "$ARCHIVE/preview-info.json" 2>&1)
  if grep -q "✔ preview" <<<"$PREV"; then
    [ "$attempt" -gt 1 ] && echo "    第 ${attempt} 次尝试成功（IDE 编译服务需要时间就绪）"
    OK_PREVIEW=1
    break
  fi
  echo "    第 ${attempt} 次未成功：$(grep -oE '✖ [a-z_]*' <<<"$PREV" | head -1)"
  [ "$attempt" -lt 5 ] && sleep 15
done

grep -E '✔ preview|Using AppID' <<<"$PREV" | sed 's/^/    /'
if [ "$OK_PREVIEW" != "1" ]; then
  echo "❌ 预览失败（已重试 5 次），原始输出："
  tail -20 <<<"$PREV" | sed 's/^/    /'
  echo "    排查方向：① IDE 里是否残留别的工程（close+open 已处理）"
  echo "              ② 手机端是否已登录为该项目开发者"
  exit 1
fi

# ---------------------------------------------------------------- ⑥ 转真 PNG
PNG="$ARCHIVE/真机预览二维码.png"
sips -s format png "$QR_RAW" --out "$PNG" >/dev/null 2>&1 || cp "$QR_RAW" "$PNG"
rm -f "$QR_RAW"
echo "    二维码：$PNG  （$(file -b "$PNG" | cut -c1-40)）"

# ---------------------------------------------------------------- ⑦ 解码验证
echo "==> [7/7] 解码验证（生成成功 ≠ 真的能扫）"
DECODER=/private/tmp/qr-decode.swift
if [ ! -f "$DECODER" ]; then
  cat > "$DECODER" <<'SWIFT'
import Foundation
import Vision
import AppKit
let p = CommandLine.arguments[1]
guard let img = NSImage(contentsOfFile: p),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else { print("LOAD_FAIL"); exit(2) }
let r = VNDetectBarcodesRequest(); r.symbologies = [.qr]
try! VNImageRequestHandler(cgImage: cg, options: [:]).perform([r])
for x in r.results ?? [] { print("OK \(x.payloadStringValue ?? "?")") }
SWIFT
fi
PAYLOAD="$(swift "$DECODER" "$PNG" 2>/dev/null | head -1)"
echo "    $PAYLOAD"
[[ "$PAYLOAD" == OK* ]] || { echo "⚠️  二维码解码失败，这张码可能扫不出来"; }

# ---------------------------------------------------------------- 归档 README
SIZE_BYTES=$(python3 -c "import json;print(json.load(open('$ARCHIVE/preview-info.json'))['size']['total'])" 2>/dev/null || echo "?")
SIZE_MB=$(python3 -c "print(f'{${SIZE_BYTES:-0}/1048576:.2f}')" 2>/dev/null || echo "?")
NOW=$(date '+%Y-%m-%d %H:%M:%S')
cat > "$ARCHIVE/README.md" <<EOF
# 真机试玩二维码（微信小游戏）

**本目录只保留「当前有效」的那一张码。**

| 项 | 值 |
|---|---|
| 生成时间 | $NOW |
| AppID | \`$(python3 -c "import json;print(json.load(open('$BUILD_DIR/project.config.json')).get('appid','?'))" 2>/dev/null)\` |
| 包体 | ${SIZE_BYTES} 字节（${SIZE_MB} MB，红线 4MB） |
| 构建模式 | $MODE |
| 解码内容 | \`${PAYLOAD#OK }\` |

## ★ 扫码须知
微信预览码**有且只有最新一张有效**：再跑一次 \`tools/wechat-preview.sh\`，
上一张立刻作废。所以：

- 如果你**扫码后看到的现象和最新改动对不上**，先怀疑扫的是旧码 → 重新生成一张再扫。
- 历史上作废的码不必留；要留就在本文件里写明「XX 时间的码已作废」。

## 重新出码
\`\`\`bash
SKIP_BUILD=1 bash tools/wechat-preview.sh       # 代码没变，只想换一张新码
bash tools/wechat-preview.sh                     # 代码变了：构建 + 出码
\`\`\`
EOF

echo "============================================================"
echo "✅ 真机试玩码已生成"
echo "   图片：$PNG"
echo "   包体：${SIZE_BYTES} 字节（${SIZE_MB} MB）"
echo "   用微信「扫一扫」扫描该二维码即可在手机上试玩"
echo "   ⚠️  预览码只有最新一张有效，重跑本脚本会让上一张失效"
echo "============================================================"
