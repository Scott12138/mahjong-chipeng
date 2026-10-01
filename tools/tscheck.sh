#!/usr/bin/env bash
# ============================================================
#  tscheck.sh · 秒级 TypeScript 类型检查（不产物、不开 Cocos）
# ============================================================
#  【为什么要它】
#  GamePage / Generator 这类文件动辄两三千行，改完想知道"有没有写错"，
#  走一次完整的 Cocos 构建要一两分钟。而 90% 的低级错误（拼错属性名、
#  漏传参数、用了没 import 的符号）用 tsc 一秒就能抓出来。
#  所以：**写代码的循环用本脚本，验证链路才用 cocos-build.sh。**
#
#  【为什么不用项目自带的 tsconfig.json】
#  它 extends 的 temp/tsconfig.cocos.json 里 `types` 是按"相对 temp/"写的，
#  只在编辑器进程里成立；命令行 tsc 直接用会报找不到 'cc'。
#  这里改用工程根的 tsconfig.typecheck.json（把 declare 文件当普通输入 include）。
#
#  【为什么用 Cocos 自带的 typescript】
#  本机没有全局 typescript，也不该为一个检查去全局装。Cocos 3.8.8 安装目录里
#  自带一份完整的 typescript，版本与编辑器保持一致，反而更准。
#
#  用法： bash tools/tscheck.sh [工程目录]
#  退出码：0 = 通过；非 0 = 有类型错误（错误清单已打印）
# ============================================================
set -uo pipefail

PROJ="${1:-game-4-mahjong}"
TSC="/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/Resources/app.asar.unpacked/node_modules/typescript/bin/tsc"

if [ ! -f "$TSC" ]; then
    echo "✖ 找不到 Cocos 自带的 tsc：$TSC" >&2
    echo "  请确认 Cocos Creator 3.8.8 仍装在默认路径。" >&2
    exit 2
fi

if [ ! -f "$PROJ/tsconfig.typecheck.json" ]; then
    echo "✖ 工程里缺少 tsconfig.typecheck.json：$PROJ" >&2
    exit 2
fi

NODE="/Users/consli/.workbuddy/binaries/node/versions/22.22.2-3/bin/node"
[ -x "$NODE" ] || NODE="$(command -v node)"

# ⚠️ tsc 必须在工程根下跑：tsconfig 里的 include 是相对配置文件自身解析的，
#    但 cc.d.ts 里的 /// <reference path="..."> 用的是绝对路径，两边都稳。
( cd "$PROJ" && "$NODE" "$TSC" -p tsconfig.typecheck.json )

code=$?
# ⚠️ 变量一律写成 ${x} 带花括号：紧跟着全角标点时（如 `（${code}）：`），
#    bash 会把全角字符的首字节当成变量名的一部分，报 `code…: unbound variable`。
#    这个坑只在中文文案里出现，英文环境测不出来。
if [ $code -eq 0 ]; then
    echo "✅ 类型检查通过（${PROJ}）"
else
    echo "✖ 类型检查失败（exit=${code}）：${PROJ}" >&2
fi
exit $code
