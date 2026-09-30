#!/usr/bin/env bash
# ============================================================
#  smoke-run.sh · 一条命令跑完「起服务器 → 无头冒烟 → 收服务器」
# ============================================================
#  【为什么必须封装成一整条命令，而不是"先起服务器再跑测试"】
#  Bash 工具的后台进程**在工具调用结束时就会失去权限/被回收**：
#    第一轮：起服务器 → curl 返回 200 ✅
#    第二轮：curl 返回 502 ❌（后台的 http.server 已经没了）
#  表现极具误导性 —— 冒烟脚本报的是
#    "canvas: null / Cannot read properties of null (reading 'left')"，
#  看起来像"游戏白屏"，实际是"静态服务器死了"。
#  所以：服务器必须与测试处在**同一次前台调用**的生命周期内。
#
#  【用法】
#    bash tools/smoke-run.sh <产物目录名> <输出目录> "<动作1>" "<动作2>" ...
#  例：
#    bash tools/smoke-run.sh web-desktop /tmp/t4 "d:0,-118" "d:0,275" "dirty:6"
#  默认产物目录 web-desktop（= build/web-desktop）。
# ============================================================
set -euo pipefail

BUILD_DIR="${1:-web-desktop}"
OUT_DIR="${2:?用法: smoke-run.sh <产物目录> <输出目录> <动作...>}"
shift 2

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT=8123
NODE=/Users/consli/.workbuddy/binaries/node/versions/22.22.2-3/bin/node

# 清掉上一轮可能残留的 Chrome 与服务器（否则 CDP 会连到旧实例上，
# 旧实例里的页面早已失效，报错同样是误导性的 "canvas: null"）
pkill -f 'remote-debugging-port=9333' 2>/dev/null || true
pkill -f "http.server ${PORT}" 2>/dev/null || true
sleep 1

/usr/bin/python3 -m http.server "$PORT" --directory "$ROOT/game-4-mahjong/build/$BUILD_DIR" \
    > "/tmp/http${PORT}.log" 2>&1 &
SRV=$!
trap 'kill "$SRV" 2>/dev/null || true' EXIT

# 等服务器真的能应答再往下走（--noproxy：避免本机代理把 127.0.0.1 也劫走）
for _ in 1 2 3 4 5 6 7 8 9 10; do
    code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/index.html" || true)
    [ "$code" = "200" ] && break
    sleep 0.5
done
if [ "$code" != "200" ]; then
    echo "❌ 静态服务器未就绪（HTTP $code），产物目录是否构建过？$ROOT/game-4-mahjong/build/$BUILD_DIR"
    exit 1
fi
echo "==> 静态服务器就绪（HTTP 200）"

rm -rf "$OUT_DIR"
"$NODE" "$ROOT/tools/web-smoke.mjs" "http://127.0.0.1:${PORT}/index.html" "$OUT_DIR" "$@"
