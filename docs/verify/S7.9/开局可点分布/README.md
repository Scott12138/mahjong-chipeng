# 开局可点牌分布 · S7.9 决策依据

**为什么有这个归档**：S7.6 修掉 `Generator` 兜底死代码时，日志显示「L4 有大量开局走到兜底布局」。
但那条日志只说「40 次采样均未通过校验」，**没说门槛本身是否合理**。
本归档就是回答那个问题的：`CFG.STACK.MIN_PICKABLE` 到底该设成几。

**结论（2026-10-01 拍板）：门槛 6 → 5。**

---

## 一、问题根因

`generateLevel()` 的采样循环里有一条门槛：

```ts
if (pickableIds(tiles, graph, taken).length < CFG.STACK.MIN_PICKABLE) {
    if (!best) best = { tiles, rate: 0 };   // ← 兜底候选：注意 rate 记 0
    pickFail++;
    continue;
}
```

也就是说：**只要某一轮「开局可点牌 < 门槛」，这一轮就整体作废（连可解性都不校验）。**
40 轮全部作废时，就把**第一份**没过门槛的布局拿来当兜底 —— 那份布局**从没跑过可解性模拟**。

问题的关键不在实现，而在**门槛的取值**：多层堆叠的「最上面一层」天生就窄，
开局可点 3~4 张才是常态，「≥6」在数学上是罕见事件。门槛设成 6，
等于让绝大多数采样白跑，最后仍然拿到一份「可点 2~5 张、且未验证可解」的布局。

---

## 二、复现步骤

`probe.ts` 不能直接在工程目录里跑 —— 它需要 `Generator` 暴露 4 个内部函数
（`buildGrid` / `sampleCells` / `buildBag` / `placeTiles`），而工程里的 `Generator.ts`
刻意只导出对外的 API。

做法：**把 4 个纯逻辑文件复制到临时目录，在副本上改写 import 并补一行导出**，
这样工程源码一个字节都不会被碰。

```bash
PROJ=/Users/consli/WorkBuddy/2026-09-30-14-03-17/game-4-mahjong
mkdir -p /tmp/gen-probe
cp "$PROJ/assets/scripts/CFG.ts" "$PROJ/assets/scripts/TileData.ts" /tmp/gen-probe/
cp "$PROJ/assets/scripts/core/Generator.ts" "$PROJ/assets/scripts/core/MatchRule.ts" /tmp/gen-probe/
```

再用下面这段脚本改写副本（**三个坑都在这里**）：

```python
import pathlib
dst = pathlib.Path('/tmp/gen-probe')

# ① 相对路径 ../CFG → 同目录 ./CFG.ts（Node 的 TS 加载要求写全后缀）
# ② 类型名必须走 `import type`，否则运行时找不到该导出（SyntaxError）
# ③ 追加一行 export，把内部函数暴露给探针
gen = dst / 'Generator.ts'
t = gen.read_text()
t = t.replace("import { CFG, LevelConfig } from '../CFG';",
              "import { CFG } from './CFG.ts';\nimport type { LevelConfig } from './CFG.ts';")
t = t.replace("import { ALL_PATTERNS, Family, FAMILIES, PatternKey, patternKey } from '../TileData';",
              "import { ALL_PATTERNS, FAMILIES, patternKey } from './TileData.ts';\nimport type { Family, PatternKey } from './TileData.ts';")
t = t.replace("import { findMatch, wouldMatch } from './MatchRule';",
              "import { findMatch, wouldMatch } from './MatchRule.ts';")
t += "\nexport { buildGrid, sampleCells, buildBag, placeTiles };\n"
gen.write_text(t)

mr = dst / 'MatchRule.ts'
t = mr.read_text()
t = t.replace("import { Family, PatternKey, parsePattern } from '../TileData';",
              "import { parsePattern } from './TileData.ts';\nimport type { Family, PatternKey } from './TileData.ts';")
mr.write_text(t)
```

然后：

```bash
cp probe.ts /tmp/gen-probe/
cd /tmp/gen-probe
/Users/consli/.workbuddy/binaries/node/versions/22.22.2-3/bin/node \
    --experimental-transform-types probe.ts 400
```

> `--experimental-transform-types` 是 Node 22 内置的 TS 支持（**不需要装 tsc**）。
> 用 `--experimental-strip-types` 也可以，但那个不支持 enum / namespace。

---

## 三、实测数据（每关 400 次，确定性种子）

种子是 `(i+1) * 2654435761`，**不是** `Math.random()`，所以任何人任何时间跑，结果逐位一致。

| 关卡 | 牌数 / 层数 | 平均可点 | 最少~最多 | 单次 ≥6 | 单次 ≥5 | 单次 ≥4 |
|---|---|---|---|---|---|---|
| L1 试手气 | 12 / 1 层平铺 | 12.00 | 12~12 | 100% | 100% | 100% |
| L2 上道了 | 18 / 4 层 | 4.02 | 2~7 | 8.5% | 33.0% | 66.0% |
| L3 有点意思 | 21 / 5 层 | 3.83 | 2~8 | 5.3% | 24.5% | 60.5% |
| L4 就差一点 | 24 / 6 层 | 3.75 | 2~6 | **0.8%** | 16.8% | 61.8% |

可点张数分布（原始直方图，见 `实测-每关400次.txt`）：

```
L2: 2张×28   3张×108  4张×132  5张×98   6张×27  7张×7
L3: 2张×31   3张×127  4张×144  5张×77   6张×18  7张×2   8张×1
L4: 2张×15   3张×138  4张×180  5张×64   6张×3
```

**「40 次采样全部不达标」的概率**（= 会走到兜底局的比例，`1-(1-p)^40`）：

| 门槛 | L2 | L3 | L4 |
|---|---|---|---|
| ≥6（改动前） | 2.9% | 11.3% | **72.5%** |
| ≥5（改动后） | ≈0 | ≈0 | **0.06%** |
| ≥4 | ≈0 | ≈0 | ≈0 |

> 注：早前用 150 次**随机**种子测得的 L4 兜底率是 42.7%，本归档用 400 次确定性种子测得 72.5%。
> 两者都是「单次 ≥6 率约 1%」量级下的估计波动（150 样本里恰好多抽中了几次 6 张），
> **以 400 样本的确定性结果为准**。无论取哪个，结论一致：门槛 6 本身是失效的。

---

## 四、拍板与后续

- **拍板**：`MIN_PICKABLE` 6 → 5。L4 的兜底率从 72.5% 降到 0.06%，且开局可点下限从 2 张升到 5 张。
- **残留**：L4 仍有约万分之六的概率走到兜底，而那份兜底**未验证可解性**。
  后续把兜底候选从「第一份没过门槛的布局」改成「② 失败里可解通过率最高的那一份」即可根除。
