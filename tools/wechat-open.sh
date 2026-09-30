#!/bin/bash
# ============================================================================
# 微信开发者工具 · 工程打开脚本
# ----------------------------------------------------------------------------
# 作用：把 Cocos 构建出来的微信小游戏产物目录，直接塞进微信开发者工具打开。
#       （等价于在工具里「导入项目」，但不用手点）
#
# ── 本机环境实测确认的四个事实（都是踩坑换来的） ──────────────────────────
#   1) 工具 CLI 在 /Applications/wechatwebdevtools.app/Contents/MacOS/cli，
#      自带 ELECTRON_RUN_AS_NODE 包装，不会踩 Cocos 那个环境变量坑。
#
#   2) 想用 CLI 必须先在工具里开「设置 → 安全设置 → 服务端口」。
#      未开时报 "IDE service port disabled ... please enter y"，且非交互环境
#      （管道/脚本）喂 y 无效——CLI 需要真 TTY，直接失败。
#      开关位置：~/Library/Application Support/微信开发者工具/<profile>/WeappLocalData/
#                 localstorage_<hash>.json 与 ls_<hash>.json
#                字段 security.enableServicePort / security.port
#      本脚本可自动改（先备份），但【改动前必须先退出工具】，否则被覆盖。
#
#   3) 服务端口是工具自选的随机端口（如 24496），不要用 --port 硬指定，
#      去掉 --port 让 CLI 自动发现最稳。
#
#   4) 【最大的坑】工具冷启动要 60 秒以上。启动后马上敲 cli open 必然失败：
#         a) ✖ IDE may already started at port xxx, trying to connect / wait IDE port timeout
#            —— 上一轮的端口还没释放
#         b) ✖ preparing + openProject 异常 —— 工具内部还没准备完
#      两者都会自愈，但必须【等够时间】。所以本脚本先轮询 islogin 探活，
#      确认工具真的就绪了再执行 open。
#
#   5) 【最隐蔽的坑】CLI 包装脚本里有 `cd "$CWD"`（切到自己的资源目录），
#      所以 --project 传【相对路径】会被解析到错误位置，报的却是
#      ✖ preparing / openProject 异常——完全看不出是路径问题。
#      → 本脚本统一把路径转成绝对路径再传。
#
# 用法：
#   bash tools/wechat-open.sh <构建产物目录>
#   bash tools/wechat-open.sh game-4-mahjong/build/wechatgame
#   bash tools/wechat-open.sh --enable-service-port    # 只开服务端口（自动重启工具）
# ============================================================================
set -uo pipefail

CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
APP="/Applications/wechatwebdevtools.app"

[ -x "$CLI" ] || { echo "❌ 找不到微信开发者工具 CLI：$CLI"; exit 1; }

# ---------------------------------------------------------------- 工具探活
# 能拿到 "login" 字样说明 IDE 的 HTTP 服务已经起来并应答了
ide_ready() {
  local out
  out=$("$CLI" islogin 2>&1)
  [[ "$out" == *'"login"'* ]]
}

wait_ide_ready() {
  local max="${1:-24}" i
  for i in $(seq 1 "$max"); do
    if ide_ready; then
      [ "$i" -gt 1 ] && echo "    工具已就绪（等待 $(( (i-1) * 5 )) 秒）"
      return 0
    fi
    [ "$i" = "1" ] && open -a "$APP" 2>/dev/null   # 冷启动
    sleep 5
  done
  echo "    ⚠️ 等待工具就绪超时（$(( max * 5 )) 秒）"
  return 1
}

# ---------------------------------------------------------------- 开服务端口
enable_service_port() {
  echo "==> 尝试开启服务端口"
  if pgrep -f "wechatwebdevtools" >/dev/null 2>&1; then
    echo "    工具正在运行，先退出（否则设置会被覆盖）"
    "$CLI" quit >/dev/null 2>&1
    sleep 6
  fi
  python3 - <<'PY'
import json, os, glob, shutil
base = os.path.expanduser("~/Library/Application Support/微信开发者工具")
patched = 0
for p in glob.glob(os.path.join(base, "*", "WeappLocalData", "*.json")):
    try:
        d = json.load(open(p, encoding="utf-8"))
    except Exception:
        continue
    if not isinstance(d, dict) or "security" not in d:
        continue
    shutil.copy(p, p + ".bak")
    d["security"]["enableServicePort"] = True
    d["security"]["port"] = None      # null = 让工具自选随机端口
    json.dump(d, open(p, "w", encoding="utf-8"), ensure_ascii=False)
    patched += 1
    print(f"    已写入：{os.path.basename(p)}（备份为 .bak）")
if not patched:
    print("    ⚠️ 没找到含 security 字段的配置文件，请在工具里手动开启")
PY
  echo "==> 重启工具并等待就绪"
  open -a "$APP"
  wait_ide_ready 24
}

# ------------------------------------------------------------------ 主流程
if [ "${1:-}" = "--enable-service-port" ]; then
  enable_service_port
  exit $?
fi

PROJ="${1:-}"
[ -n "$PROJ" ] || { echo "用法：bash tools/wechat-open.sh <构建产物目录>"; exit 1; }
[ -d "$PROJ" ] || { echo "❌ 目录不存在：$PROJ"; exit 1; }
[ -f "$PROJ/project.config.json" ] || echo "⚠️ 该目录没有 project.config.json，可能不是微信小游戏构建产物"

# 【第 5 个坑，必须转绝对路径】CLI 包装脚本里有 `cd "$CWD"`（切到自己的资源目录），
# 传相对路径会被解析到错误位置，表现为 ✖ preparing / openProject 异常——
# 而这个报错完全看不出是路径问题，极难排查。这里统一转成绝对路径。
PROJ="$(cd "$PROJ" && pwd)"

echo "==> 目标工程：$PROJ"

# 1) 先确认服务端口开着、工具就绪
if ! ide_ready; then
  echo "==> 工具未就绪，启动并等待"
  wait_ide_ready 24
fi

# 2) 打开工程（少量重试兜底瞬时抖动）。注意用 here-string 而不是 echo|grep，
#    避免 grep -q 提前退出触发 SIGPIPE，在 pipefail 下被误判为失败。
OK=0
for attempt in 1 2 3 4; do
  OUT=$("$CLI" open --project "$PROJ" 2>&1)

  if grep -q "service port disabled" <<<"$OUT"; then
    echo "==> 服务端口未开启，自动处理后重试"
    enable_service_port
    continue
  fi

  if grep -q "✔ open" <<<"$OUT"; then
    OK=1
    grep -E "IDE server|✔ open" <<<"$OUT" | sed 's/^/    /'
    break
  fi

  echo "    第 ${attempt} 次未成功：$(grep -oE '✖ [^\\]*' <<<"$OUT" | head -1)"
  [ "$attempt" -lt 4 ] && sleep 8
done

if [ "$OK" = "1" ]; then
  echo "✅ 已在微信开发者工具中打开"
  echo -n "   登录状态："; "$CLI" islogin 2>/dev/null | grep -o '{"login":[a-z]*}'
else
  echo "❌ 打开失败，请手动在工具里「导入项目」并指向：$PROJ"
  exit 1
fi
