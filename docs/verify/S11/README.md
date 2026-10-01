# S11 验收归档 · 四条体验改动（v3.1）

> 日期：2026-10-01　｜　对应设计稿：`docs/game-4-DESIGN.md` **v3.1**
> 本轮改动（用户 5 条需求里的 #1~#4，代码侧）：
> ① 入槽后**竖着正放**（不再保留牌堆里的随机朝向）
> ② 复活从「退回牌堆」改为「**槽内最后 4 张直接消除**」
> ③ L2–L4 牌面尺寸 **×1.25**（85×114 → 106.25×142.5，格点 6×11 → **5×8**）
> ④ 堆叠从「同格往上摞」改为**多层随机堆叠**（羊了个羊式）

---

## 1. 验收结论（一句话）

**四项全部通过。** 分层堆叠的几何、分词、开局可点、越界、认证率全部量化达标；
复活链路在日志里逐行可见；四关冒烟回归全绿，性能与包体积仍在红线内。

| 项 | 结果 | 判定 |
|---|---|---|
| ① 槽内竖放 | 入槽最短转向（≤180°），槽里 8 张全正立 | ✅ |
| ② 复活新规则 | 实测「槽内消除 4 张（wan-8,wan-8,wan-3,wan-3），保留 4 张」 | ✅ |
| ③ 牌面 ×1.25 | 106.25×142.5，格点 5×8=40（L1 保持 128，格点 4×3=12） | ✅ |
| ④ 多层随机堆叠 | 层数 3/5/6，张数由下往上递减，层间明显错开 | ✅ |
| 越界校验 | 四关各 20 局，**出区牌 0 张** | ✅ |
| 开局可点牌 | L2 5–9 / L3 5–9 / L4 5–8（`MIN_PICKABLE=5` 成立） | ✅ |
| 引擎可见尺寸自检 | `720×1280` = 设计分辨率（坐标 1:1 可信） | ✅ |
| 性能（L4 96 张） | 峰值 **162** draw call / 平均帧 **16.18ms** → 60 FPS | ✅ |
| 二级类型检查 | `bash tools/tscheck.sh` 通过 | ✅ |

> 对照 S10：同样 96 张牌，L4 峰值 draw call 从 **186 → 162**。
> 原因：分层后重叠的牌少了一部分（同格摞牌时全覆盖，分层后片与片之间露出更多），
> 反而是**优化**。

---

## 2. 逐关证据

### L1「试手气」· 12 张 · 平铺教学关（`upright: true`）

```
[GamePage] 第 1 关「试手气」：12 张牌 / 1 次采样 / 已认证可解（可解率 100%）/ 生成耗时 12ms / seed=1805993211
[GamePage] 消除 牌型=peng(碰) ｜ wan-8 wan-8 wan-8
[GamePage] 消除 牌型=peng(碰) ｜ wan-5 wan-5 wan-5
[GamePage] 消除 牌型=chi(吃)  ｜ wan-1 wan-2 wan-3
[GamePage] 消除 牌型=chi(吃)  ｜ wan-1 wan-2 wan-3
[GamePage] 第 1 关 通关，已清 12/12
```

- L1 是**唯一** `upright` 的教学关，牌堆里也不旋转 —— 让新手一眼看清牌面。
- 2 碰 + 2 吃，通关路径唯一：先把两组「碰」消掉，剩下 1万×2 / 2万×2 / 3万×3，
  「碰」再也凑不成，**只能靠两次「吃」通关**。
- 「碰」和「吃」两条动效链路都在这一关跑通（撞击 / 流水汇合）。

### L2「上道了」· 36 张 · **3 层**

```
[GamePage] 第 2 关「上道了」：36 张牌 / 3 次采样 / 已认证可解（可解率 5%）/ 生成耗时 18ms / seed=3388878709
```

分词（由下往上）：**16 / 11 / 9** = 36　✅

### L3「有点意思」· 63 张 · **5 层**

```
[GamePage] 第 3 关「有点意思」：63 张牌 / 1 次采样 / 已认证可解（可解率 3%）/ 生成耗时 29ms / seed=791824087
```

分词：**21 / 16 / 11 / 9 / 6** = 63　✅

### L4「就差一点」· 96 张 · **6 层**

```
[Generator] 第 4 关 96 张：11 次采样（仅认证「开局不卡」），可解率 0.0%，
            止步统计「可点牌不足 1 / 开局凑不成组 3」
[GamePage] 第 4 关「就差一点」：96 张牌 / 11 次采样 / 仅认证开局不卡（可解率 0%）/ 生成耗时 139ms / seed=2370342138
```

分词：**30 / 22 / 16 / 12 / 9 / 7** = 96　✅

---

## 3. 多层随机堆叠（需求 #4）的量化验收

### 3.1 分层模型

旧模型的「层」是**副产品**：先铺满格点，装不下才在同批格点上再摞一层，层与层位置**完全重合**，
depth 由**行号**决定，再叠一个「下密上疏」权重（`WEIGHT_Y=0.7`）—— 三者合起来必然把牌堆
压成一坨贴下缘的小土丘（就是用户截图里的样子）。

新模型把「层」（floor）变成**一等公民**：

```
先定层数 F = clamp(ceil(count / FLOOR.PER), 1, FLOOR.MAX)
每层张数 ∝ DECAY^k（由下往上递减），用最大余数法分配，和恰为 count
每层是一个「片」：中心 = 整堆落点 + 每层独立随机偏移（LAYER_DRIFT）
片内按到层中心的切比雪夫距离加权采样（TIGHT 控制聚集度）
深度 = 层号 × 100000 + 层内叠号 × 1000 + 行号反序
```

**开局可点是物理结果，不是运气**：顶层张数最少 → 顶层的片最小 → 盖不住下一层 →
下层的牌从缝里露出来。

### 3.2 深度公式唯一口径

```ts
depthOfCell(grid, cell) = cell.floor * 100000 + cell.layer * 1000 + (grid.rows - 1 - cell.r)
```

**首次铺牌与洗牌重排共用同一个函数**。（历史上这两处各写一遍，写错过一次。）

### 3.3 几何

| 关 | 牌面尺寸 | 格点数 | 格距 |
|---|---|---|---|
| L1 | 128 × 171.7 | 4 × 3 = 12 | 140 × 82.4 |
| L2–L4 | 106.25 × 142.5 | **5 × 8 = 40** | 116.3 × 68.4 |

> 牌放大 1/4 后格点从 6×11=66 掉到 5×8=40 —— 所以**需求 ③ 与 ④ 必须一起做**，
> 单独放大而不改堆叠模型，96 张牌会直接溢出牌堆区。

### 3.4 认证（40 局，不是 16 局）

| 档 | `DRIFT` | L4 认证率 |
|---|---|---|
| 密集 | 0.00 | 26/40 |
| **落地（采用）** | **0.30** | **30/40** |

- 两档的**开局可点中位数都是 7**，本质差别只在观感（0.30 更"散开"，像羊了个羊）。
- ⚠️ **别用小样本定这件事**：16 局的小样本给出与 40 局**相反**的结论（详见 CFG 注释）。

### 3.5 越界校验

四关各 20 局，逐张比对牌堆区矩形 —— **出区牌 0 张**。

### 3.6 生成耗时

L4 约 **88–139ms**（`certified` 档命中时 ~88ms，退到 `opening-ok` 档要试满
`SOLVE_SEARCH_RETRY` 才 ~139ms）。仍是四关里唯一"进关卡时肉眼可能察觉"的耗时，
**真机试玩时留意**。

---

## 4. 槽内竖放（需求 #1）

- `CFG.STACK.SLOT_KEEP_ANGLE: true → **false**`。
- 语义切分：**牌堆 = 挑战区，该乱；槽位 = 信息区，该清楚**。
- 代价（刻意保留）：飞行途中要从牌堆朝向**旋转到 0°**，这是"牌被收编"的因果反馈，不是浪费。
- 实现要点：**入槽走最短转向**（把差值归一化到 (-180°,180°]），否则 270° → 0° 会逆时针空转 270°。
  已正立的牌**不建空 tween**（L1 平铺关省掉 12 条）。

---

## 5. 复活新规则（需求 #2）

```
[GamePage] 牌局 已清=0 槽=8/8 槽内=[wan-5,wan-5,wan-2,wan-2,wan-8,wan-8,wan-3,wan-3]
[GamePage] 第 1 关 失败，已清 0/12，道具 消除0/移出0/洗牌0/加槽0，复活0
[GamePage] 失败面板已开 原因=槽位满了 可复活=true
[RewardGate] 渠道面板选择=ad → 模拟广告完成 ok=true → 渠道=ad 放行 ok=true
[GamePage] 复活 第 1 次
[GamePage] 复活重排：第 1 次尝试，可解率 100%（槽内保留 4 张参与校验）
[GamePage] 牌局 已清=4 槽=4/8 槽内=[wan-5,wan-5,wan-2,wan-2]
[GamePage] 复活生效：槽内消除 4 张（wan-8,wan-8,wan-3,wan-3），槽内保留 4 张，牌堆已重排
```

- 口径：`clearN = ceil(slotCapacity × CFG.REWARD.REVIVE_CLEAR_RATIO)` = `ceil(8 × 0.5)` = **4**。
- 被消掉的是**槽里最后 4 张**（数组尾部），保留前 4 张继续玩；暂存架不动。
- 重排时**把保留的槽位牌一并交给求解校验**（`planReshuffle(..., this._slots.map(e => e.key))`），
  避免"重排后仍无解"。
- 按钮文案改成**从参数算**：`` `看广告复活（消 ${reviveClear} 张 + 重排）` ``，
  以后调 `REVIVE_CLEAR_RATIO` 不会出现文案与行为不一致。
- ⚠️ **已知不变量破坏**：原始设计里"牌面张数 ≡ 0 (mod 3)"是消除的整除前提，
  首次复活必然破坏它（消 4 张不是 3 的倍数）→ 终局会剩下 1–2 张消不掉的牌。
  **已接受**（理由写进 `CFG.REWARD.REVIVE_CLEAR_RATIO` 注释）：
  ① 复活本身就是兜底，不是正式通路；② 观感上"少几张"远好于"退回牌堆"；
  ③ 真要收口，只需把比例改成 `1/4`（=2 张）或 `3/4`（=6 张）即可重新对齐 mod 3。

---

## 6. 性能

| 关 | 张数 | 峰值 draw call | 平均帧耗时 | 推算 FPS |
|---|---|---|---|---|
| L1 | 12 | 61 | 15.95 ms | 63 |
| L2 | 36 | 92 | 16.73 ms | 60 |
| L3 | 63 | 140 | 16.88 ms | 59 |
| L4 | 96 | **162** | **16.18 ms** | 62 |

> 采样方法：跑到目标关后连读 6 次 `director.root.device.numDrawCalls` 取**峰值**
> （⚠️ `numDrawCalls` 每帧清零，只读一次可能撞上清屏后的帧）。

---

## 6.5 真机包与预览码

```bash
cd /Users/consli/WorkBuddy/2026-09-30-14-03-17
bash tools/cocos-build.sh wechatgame release game-4-mahjong
```

| 项 | 实测 |
|---|---|
| `build/wechatgame` 目录 | **3.2 MB**（`du -sh`） |
| CLI 自报总字节 | **3 165 307 B ≈ 3.0 MB**（`preview` 输出的表） |
| 红线 | 4 MB → **余量 0.8 MB** ✅ |
| 主要构成 | cocos-js 2.5M / assets 476K / web-adapter 100K / src 44K / engine-adapter 24K |
| 产物 AppID | `wxfaa19afc583badd9`（= game-3 在用的测试号，**上线前必须换**） |

**预览码**：`device/真机预览二维码-S11.png`（470×470 灰度 PNG）

- ✅ 已用 macOS Vision 解出真实 URL 验证**能扫**：
  `https://mp.weixin.qq.com/a/~~ffgrIRAJbw0~Sj4H-EsPNG3kZbCpHypxvg~~`
  （**"命令没报错"与"码能扫"是两件事**，每次都要解一次）。
- ⚠️ **预览码约 25 分钟失效**（微信开发者工具的机制，不是本工程的问题）。
  过期需按下面的命令重跑；**再跑一次预览，上一张（含 S10 那张）立刻作废**。
- ⚠️ `--qr-output` **实际写出的是 JPEG**，哪怕文件名是 `.png` —— 已用 `sips` 转成真 PNG。
- ⚠️ 输出路径的**父目录不能是软链接**（macOS `/tmp` 就是软链）→ 先 `mkdir -p /tmp/s11-preview`。

```bash
CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli
PROJ="$PWD/game-4-mahjong/build/wechatgame"

# ① 探活（工具冷启动 60 秒+，起来后立刻调用必失败）
until "$CLI" islogin 2>&1 | grep -q '"login"' ; do sleep 3; done

# ② ⚠️ 必须 close → open。IDE 里残留着上一次打开的项目时，
#    preview 会在**错误的工程上下文**里编译，报「未找到 game.json」（报错完全指错方向）
"$CLI" close  --project "$PROJ"
"$CLI" open   --project "$PROJ"

# ③ 出码（父目录必须是真目录）
mkdir -p /tmp/s11-preview
"$CLI" preview --project "$PROJ" --qr-output /tmp/s11-preview/preview.png
sips -s format png /tmp/s11-preview/preview.png --out /tmp/s11-preview/preview-real.png

# ④ 解一次码，确认能扫（macOS 自带 Vision，零依赖）
swift /tmp/qr-decode.swift /tmp/s11-preview/preview-real.png
```

> 想要**长期有效**的码，得走体验版上传：
> `cli upload --project <build/wechatgame> -v <版本号> -d <备注>` ——
> 这会占用一次上传版本号，**需用户明确授权后再执行**。

---

## 7. 复现命令

```bash
cd /Users/consli/WorkBuddy/2026-09-30-14-03-17

# 0) 构建
bash tools/cocos-build.sh web-desktop debug game-4-mahjong

# 1) 类型检查
bash tools/tscheck.sh

# 2) 逐关冒烟（一条命令内含 起服务器→无头点击→收服务器）
bash tools/smoke-run.sh web-desktop /tmp/s11-l1        "d:0,-118" "d:0,275" wait:1400 "auto:20"
bash tools/smoke-run.sh web-desktop /tmp/s11-l2 unlock:1 "d:0,-118" "d:0,85"  wait:1600 "auto:30@420"
bash tools/smoke-run.sh web-desktop /tmp/s11-l3 unlock:2 "d:0,-118" "d:0,-105" wait:1800 "auto:45@420"
bash tools/smoke-run.sh web-desktop /tmp/s11-l4 unlock:3 "d:0,-118" "d:0,-295" wait:2000 "auto:60@420"

# 3) 复活链路（fill:8 = 精准塞满槽位、绝不触发消除 → 逼出「槽位满了」）
bash tools/smoke-run.sh web-desktop /tmp/s11-revive "d:0,-118" "d:0,275" wait:1400 \
     "fill:8" wait:1500 "d:0,60" wait:2000 "d:0,112" wait:2600
```

`d:<x>,<y>` 是**设计坐标**（原点 = 屏幕中心、y 向上），与 `CFG` 布局常量一一对应。
关卡卡片 y：L1 `275` / L2 `85` / L3 `-105` / L4 `-295`。

### `fill:<n>` 是这一轮新增的冒烟动作

旧的 `dirty` 动作**允许撞上「吃」**，槽内凑出连号就消 → **槽永远到不了 8 张**，
逼不出「槽位满了」。`fill:<n>` 用完整的碰/杠/吃预判筛掉任何会触发消除的候选，
专用于"把槽塞满"这一件事。复活链路没有它就测不了。

---

## 8. 无头探针（`probe/`）

游戏画面是 canvas，**无法用 DOM 选择器定位按钮**；但分层几何是纯数据，可以直接在 Node 里算。

| 脚本 | 用途 |
|---|---|
| `sync.sh` | 把 `CFG/Generator/MatchRule/TileData` 压平成可 `import` 的 `./X.ts`（自动识别 `export interface/type`，追加内部函数导出） |
| `probe-floor.ts` | 几何 + 分词统计 + 开局可点 + 认证率 + 生成耗时 → `/tmp/s11-shots/floors.html` |
| `probe-shot.ts` | 单关 SVG（牌堆区/槽位条边框、**按层上色**、开局可点标橙框），支持 CLI 覆盖 `DRIFT` 做 A/B |
| `probe-check.ts` | 越界校验 + `TIGHT` / `DRIFT` 多档对照 |
| `probe-ab.ts` | 两档 40 局对照（小样本会骗人，所以固定 40 局） |

运行方式：`bash probe/sync.sh && node --experimental-transform-types probe/probe-floor.ts`
（需要 Node 22）。

> ⚠️ 归档进来的 `sync.sh` 里 `SRC` / `DST` 是**当时写死的绝对路径**
> （`<工程>/assets/scripts` → `/tmp/s10-probe`），换机器/换目录要先改这两行。
> `internal` 导出白名单里，本轮新增的是 `planFloors / depthOfCell / sampleRound / tileSizeOf`。
> ⚠️ 白名单机制：`sync.sh` 会先扫一遍 `export function/const/class`，
> **已在源码里导出的函数不要再写进白名单**，否则会 `Duplicate export`。

---

## 9. 本轮踩到并已修掉的问题

| 问题 | 现象 | 修法 |
|---|---|---|
| **注释里出现 `*/` 会提前闭合块注释** | `TS1005/TS1109/TS1127` 一片，**报错行号指向注释之后很远的地方**（完全误导） | 注释里别写 `**30**/40` 这类字样；改成文字描述「认证 40、40、30 局」 |
| `TileView.isValid` 不存在 | 复活清理时 `Property 'isValid' does not exist on type 'TileView'` | 牌上的是 `node.isValid` |
| `dirty` 逼不出槽满 | 槽只涨到 4/8 就不再涨 | 新增 `fill:<n>` 动作（见 §7） |
| 探针 `does not provide an export named 'LEVELS'` | `CFG.ts` 只导出 `CFG` 与 `LevelConfig` | `const LEVELS = CFG.LEVELS as LevelConfig[]` |
| 小样本结论相反 | 16 局判 `DRIFT` 得出与 40 局相反的结论 | 固定 40 局，并把这条写进 CFG 注释 |

---

## 10. 待真机试玩后决定（**未定项，不要当成已完成**）

1. **`REVIVE_CLEAR_RATIO` 是否破坏 mod 3 的代价可接受** —— 见 §5 的 ⚠️。
2. **L4 的 139ms 生成耗时** —— 若真机可感知顿挫，调小 `SOLVE_SEARCH_RETRY`。
3. **`FLOOR` 五个旋钮的手感** —— `PER / DECAY / TIGHT / DRIFT / LAYER_DRIFT`，
   目前是按几何与认证率定的，**没有真人手感数据**。
4. **L4 牌堆密度** —— 96 张现在是"一团云"（见 `04-L4-六层随机堆叠-96张.png`）。
5. **S5 难度重标定** —— 按 v3.1 新口径重跑。

---

## 11. 图片索引

| 文件 | 说明 |
|---|---|
| `01-L1-平铺教学关-牌面正立竖放.png` | L1 平铺、`upright` 不旋转、槽位空 |
| `02-L2-三层随机堆叠.png` | L2 三层，层间明显错开 |
| `03-L3-五层随机堆叠.png` | L3 五层 |
| `04-L4-六层随机堆叠-96张.png` | L4 六层，96 张的终局观感 |
| `05-槽满判负-槽内牌已转正与新复活文案.png` | **需求 #1 + #2 的证据**：槽里 8 张全正立 + 按钮「看广告复活（消 4 张 + 重排）」 |
| `06-复活成功-槽内消除4张并重排.png` | **需求 #2 的结果帧**：toast「复活成功 · 槽内消除 4 张 + 牌堆重排」+ 槽内保留 4 张 |
| `07-复活前-广告放行后黑幕.png` | 广告放行 → 重排黑幕过渡 |
| `08-分层配色总览-L1平铺vsL2三层.png` | 无头 SVG：L1 平铺 12 张 vs L2 三层 36 张（按层上色） |
| `09-布局对照-L4-DRIFT0.png` | A/B：`DRIFT=0`（密集） |
| `10-布局对照-L4-DRIFT30.png` | A/B：`DRIFT=0.30`（**采用**） |
| `device/真机预览二维码-S11.png` | 真机预览码（**约 25 分钟失效**；已解码验证可扫，URL 见 §6.5） |

> 注意：`09` / `10` 这两张是 **A/B 对照**，最终采用的是 **`10`（`DRIFT=0.30`）**
> —— 不是因为 0 那档差，而是因为 0.30 的层与层错开更明显、**一眼能看出"一层一层"**。
> 两档的开局可点中位数完全相同（都是 7），所以这是**观感决策，不是数值决策**。
