#!/bin/bash
# ============================================================================
# Cocos Creator 无头构建 + 微信开发者工具联动 脚本
# ----------------------------------------------------------------------------
# 为什么要这个脚本：直接调 CocosCreator CLI 在本机环境会踩四个坑，脚本已全部处理：
#   1) 环境里继承了 ELECTRON_RUN_AS_NODE=1 与 NODE_OPTIONS=...（WorkBuddy 注入），
#      会导致 Cocos 的 Electron 壳被当成纯 Node 运行，报 `bad option: --project`
#      → 必须 env -u 清掉这两个变量。
#   2) Chromium 内嵌沙箱在受限环境初始化失败（sandbox initialization failed → exit 133）
#      → 加 --no-sandbox --disable-gpu。
#   3) 工程必须至少有一个场景并设为启动场景，否则构建报
#      "The selected scene does not exist ... cannot be set as the Start Scene"
#   4) 【AppID 坑】--build 顶层的 appid=xxx 会被【静默忽略】，
#      构建出来仍是模板自带的 demo AppID。唯一可靠的通道是
#      --build "configPath=xxx.json"，在 JSON 里写 packages.wechatgame.appid。
#   5) 【SIGTERM 假阳性坑，2026-10-01 踩】
#      日志里出现 `Error: Exit process with code:null, signal:SIGTERM in task
#      build-script` 是**常态噪音**（构建子进程回收）—— 它**同时**出现在
#      成功的构建里。别被它吓到、也别被"目录存在"骗过：唯一可靠的判据是
#      **产物根目录的入口文件在不在**（web 系 = application.js；微信 = game.js），
#      它是构建**最后一步**才落盘的。脚本已按这条改过（原先只看目录存在）。
#
# 用法：
#   bash tools/cocos-build.sh [平台] [debug|release] [工程] [动作]
#     平台  默认 wechatgame（可选 web-desktop / wechatgame / ...）
#     模式  默认 release（可选 debug / release）
#     工程  默认 game-4-mahjong，可传工程名或绝对路径
#     动作  默认 build（可选 build / open / both）
#           open = 构建完立刻用微信开发者工具打开（仅 wechatgame 有效）
#
# 示例：
#   bash tools/cocos-build.sh                                   # 构建 game-4-mahjong(微信 release)
#   bash tools/cocos-build.sh wechatgame debug                  # 构建 debug 版
#   bash tools/cocos-build.sh wechatgame release game-4-mahjong both   # 构建并自动打开工具
#   bash tools/cocos-build.sh web-desktop release _toolchain-verify/hello-world
# ============================================================================
set -uo pipefail

ROOT="/Users/consli/WorkBuddy/2026-09-30-14-03-17"
BIN="/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/MacOS/CocosCreator"

PLATFORM="${1:-wechatgame}"
MODE="${2:-release}"                        # debug | release
PROJ_ARG="${3:-game-4-mahjong}"
ACTION="${4:-build}"                        # build | open | both

PROJ="$PROJ_ARG"; [ -d "$PROJ_ARG" ] || PROJ="$ROOT/$PROJ_ARG"

[ -x "$BIN" ]  || { echo "❌ 找不到 Creator：$BIN"; exit 1; }
[ -d "$PROJ" ] || { echo "❌ 找不到工程：$PROJ"; exit 1; }

case "$MODE" in
  debug)   DEBUG_FLAG="true"  ;;
  release) DEBUG_FLAG="false" ;;
  *) echo "❌ 第二参数只能是 debug 或 release"; exit 1 ;;
esac

# ---- 输出目录名固定，这样微信开发者工具的项目路径不用每次改 ----------------
OUT="$PLATFORM"
LOG="/tmp/cocos-build-${OUT}-$(date +%H%M%S).log"

# ---- 构建参数：优先用工程内的 build-config/<平台>.json（含 AppID 等） --------
CFG_SRC="$PROJ/build-config/${PLATFORM}.json"
MERGED="/tmp/cocos-buildcfg-${PLATFORM}.json"
if [ -f "$CFG_SRC" ]; then
  # 用 Python 合并，保证 debug 开关按命令行参数覆盖配置文件
  python3 - "$CFG_SRC" "$MERGED" "$DEBUG_FLAG" "$OUT" <<'PY'
import json, sys
src, dst, dbg, out = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
d = json.load(open(src, encoding="utf-8"))
d.pop("_说明", None)
d["debug"] = (dbg == "true")
d["outputName"] = out
json.dump(d, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
  echo "==> 构建配置：${CFG_SRC}（已合并 debug=${DEBUG_FLAG}）"
  grep -o '"appid"[^,]*' "$MERGED" | head -1 | sed 's/^/    /'
  BUILD_ARG="configPath=$MERGED"
else
  echo "==> 未找到 ${CFG_SRC}，使用内联参数（注意：AppID 无法这样传入）"
  BUILD_ARG="platform=${PLATFORM};debug=${DEBUG_FLAG};outputName=${OUT}"
fi

echo "==> 工程：$PROJ"
echo "==> 平台：$PLATFORM   模式：$MODE   输出：build/$OUT"
echo "==> 日志：$LOG"

env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS \
  "$BIN" --no-sandbox --disable-gpu \
  --project "$PROJ" \
  --build "$BUILD_ARG" > "$LOG" 2>&1
CODE=$?

grep -v -E "crash_report_database|gpu_process_host|network_service_instance|sandbox initialization|Failed to initialize sandbox|trackTimeEnd|^$" "$LOG" \
  | grep -E "Finished in|build task\(|error|Error|warn: Build" | tail -15

# ⚠️ 不能只看"产物目录存在"就报成功 —— Cocos 的构建子进程会被 SIGTERM 掐断，
#    此时它只写出了半套产物（实测 2026-10-01：web-desktop 缺 src/application.js，
#    目录存在、体积看着也对，但页面白屏、控制台一行日志都没有）。
#    必须核对**入口文件**：它是构建最后一步才落盘的，它在 = 真的跑完了。
# ⚠️ 入口文件在**产物根目录**（不是 src/ 下）：
#    web 系 = application.js ／ wechatgame = game.js。两者都由最后一步落盘。
case "$PLATFORM" in
  wechatgame) ENTRY="$PROJ/build/$OUT/game.js" ;;
  web-*)      ENTRY="$PROJ/build/$OUT/application.js" ;;
  *)          ENTRY="" ;;
esac

if [ ! -d "$PROJ/build/$OUT" ] || { [ -n "$ENTRY" ] && [ ! -f "$ENTRY" ]; }; then
  echo "❌ 构建失败（退出码 ${CODE}）：产物不完整（目录存在但入口文件缺失）"
  [ -n "$ENTRY" ] && echo "   缺失入口：$ENTRY"
  echo "   日志里的关键行："
  [ -f "$LOG" ] && grep -E "SIGTERM|error|Error" "$LOG" | tail -6 | sed 's/^/     /'
  echo "   完整日志：$LOG"
  exit 1
fi

echo "✅ 构建成功：$PROJ/build/$OUT"
echo "   体积：$(du -sh "$PROJ/build/$OUT" | cut -f1)  （微信首包红线 4MB）"
du -sh "$PROJ/build/$OUT"/* 2>/dev/null | sort -rh | head -5

if [ "$PLATFORM" = "wechatgame" ] && [ -f "$PROJ/build/$OUT/project.config.json" ]; then
  echo -n "   产物 AppID："
  python3 -c "import json;print(json.load(open('$PROJ/build/$OUT/project.config.json')).get('appid'))" 2>/dev/null
fi

# ---- 构建完直接拉起微信开发者工具 -----------------------------------------
if [ "$ACTION" = "open" ] || [ "$ACTION" = "both" ]; then
  if [ "$PLATFORM" = "wechatgame" ]; then
    echo "==> 打开微信开发者工具…"
    bash "$ROOT/tools/wechat-open.sh" "$PROJ/build/$OUT"
  else
    echo "⚠️  只有 wechatgame 平台能打开微信开发者工具，跳过"
  fi
fi
