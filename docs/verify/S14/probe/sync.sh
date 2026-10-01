#!/bin/bash
# ============================================================
#  S10 无头探针 · 源码同步脚本
# ------------------------------------------------------------
#  把工程里 4 个「不依赖 cc 引擎」的核心文件复制到本目录，
#  并把 import 改写成 Node 能直接跑的形态：
#    · 相对路径补 .ts 后缀
#    · **类型导入**必须走 `import type`（--experimental-transform-types 的要求）
#    · 追加 export，把内部函数暴露给探针
#  改了源码后先跑这个，再跑 probe-*.ts
#
#  【2026-10-01 改造：类型名单从"手写"改成"自动识别"】
#  原来这里是把整条 import 语句写成字面量做字符串替换。只要源码里多 import
#  一个符号（比如给 Generator 加个 parsePattern），替换就静默失配 ——
#  表现是运行时报 `does not provide an export named 'Family'`，
#  而报错指向 TileData，让人以为是数据文件坏了，实际是这份脚本没跟上。
#  现在改成：扫目标文件里所有 `export interface/type XXX`，拿到类型名单，
#  再按名单把 import 里的类型名拆到 `import type` 行。加符号不用改脚本。
# ============================================================
set -euo pipefail
SRC=/Users/consli/WorkBuddy/2026-09-30-14-03-17/game-4-mahjong/assets/scripts
DST=/tmp/s10-probe

/usr/bin/python3 - "$SRC" "$DST" <<'PY'
import pathlib, re, shutil, sys

src = pathlib.Path(sys.argv[1]); dst = pathlib.Path(sys.argv[2])
dst.mkdir(parents=True, exist_ok=True)
mapping = {'CFG.ts': 'CFG.ts', 'TileData.ts': 'TileData.ts',
           'core/Generator.ts': 'Generator.ts', 'core/MatchRule.ts': 'MatchRule.ts'}
for rel, name in mapping.items():
    shutil.copy(src / rel, dst / name)

# ---- 1) 收集每个文件里"只有类型、运行时不存在"的导出名 ----
type_names = set()
for rel, name in mapping.items():
    text = (dst / name).read_text()
    for m in re.finditer(r'^export\s+(?:interface|type)\s+([A-Za-z_$][\w$]*)', text, re.M):
        type_names.add(m.group(1))

# ---- 2) 改写 import：路径补 .ts，类型名拆到 import type ----
IMPORT_RE = re.compile(
    r"import\s*\{([^}]*)\}\s*from\s*'(\.\.?/[^']+)';",
)

def rewrite(match: re.Match) -> str:
    names = [n.strip() for n in match.group(1).split(',') if n.strip()]
    # 路径一律压平成 './<文件名>.ts'：探针目录是**平铺**的，
    # 而源码里的 '../CFG' 是相对 assets/scripts/core/ 的。只补后缀不压平的话，
    # 会被解析成 /tmp/CFG.ts（退出探针目录）→ 报 ERR_MODULE_NOT_FOUND，
    # 且报错只说"找不到模块"，看不出是层级问题。
    base = pathlib.PurePosixPath(match.group(2)).name
    path = './%s.ts' % base
    values = [n for n in names if n not in type_names]
    types = [n for n in names if n in type_names]
    out = []
    if values:
        out.append("import { %s } from '%s';" % (', '.join(values), path))
    if types:
        out.append("import type { %s } from '%s';" % (', '.join(types), path))
    return '\n'.join(out)

for name in mapping.values():
    p = dst / name
    p.write_text(IMPORT_RE.sub(rewrite, p.read_text()))

# ---- 3) 暴露内部函数（注意：本来就是 export 的不能再写一遍，否则 Duplicate export）----
gen = dst / 'Generator.ts'
already = set(re.findall(r'^export\s+(?:function|const|class)\s+([A-Za-z_$][\w$]*)',
                        gen.read_text(), re.M))
internal = ['buildGrid', 'sampleCells', 'buildBag', 'placeTiles', 'simulate',
            'pickPatterns', 'resolvePositions', 'randInt', 'this_runTrials',
            'planFloors', 'depthOfCell', 'sampleRound', 'tileSizeOf']
extra = [n for n in internal if n not in already]
if extra:
    gen.write_text(gen.read_text() + "\nexport { %s };\n" % ', '.join(extra))

print('synced:', sorted(x.name for x in dst.iterdir() if x.is_file()))
print('类型名单(%d):' % len(type_names), ', '.join(sorted(type_names)))
print('补充导出:', ', '.join(extra) if extra else '(无)')
PY
