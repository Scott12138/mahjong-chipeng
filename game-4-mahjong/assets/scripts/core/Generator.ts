/**
 * ============================================================
 *  Generator.ts · 牌堆生成器 + 可解性求解器
 * ============================================================
 *  纯逻辑，**不 import 'cc'** —— S4 的无头测试脚本要能在纯 Node 里
 *  成百上千次地跑它（"千次生成零死局"就是靠这个验收的）。
 *
 *  ------------------------------------------------------------
 *  【堆叠规则 · 2026-09-30 两次调整】
 *
 *  最初：固定金字塔（底宽顶窄、居中对称收窄）→ 每局长得一样，太规整。
 *
 *  第一次改为 **格点加权随机采样**：
 *    ① 横格距 ≥ 牌宽 → 同一行相邻牌互不遮挡（读得清"谁压谁"）；
 *    ② 纵格距 ≈ 牌高一半 → 上一行自然压住下一行，多层立体感涌现；
 *    ③ 按权重采点 + 小抖动 → 轮廓不规则、每局不同。
 *
 *  第二次（用户反馈"还是太有序"）再加三刀，见 `resolvePositions()`：
 *    ④ **逐行整体错位** —— 最大的那一刀，破掉"上下竖直对齐"；
 *    ⑤ **X/Y 抖动分离** —— 横向余量只有 12px(±5)，纵向能抖 ±14；
 *    ⑥ 采样权重上调 —— 轮廓从方板收成小山。
 *  ------------------------------------------------------------
 *
 *  【保证有解】（DESIGN §6.1 旋钮一）
 *  按「组」构造牌（每组 3 张相同），落位后跑随机化贪心模拟，
 *  能通关才采用；否则重新采样（上限见 CFG.STACK.MAX_RETRY）。
 *  → 从算法上根除天生死局。难度靠"解的稀薄"，不靠"无解"。
 * ============================================================
 */

import { CFG, LevelConfig, SOLID_OVERHANG } from '../CFG';
import {
    ALL_PATTERNS, Family, FAMILIES, PatternKey, TILE_GEO, parsePattern, patternKey,
} from '../TileData';
import { findMatch, wouldMatch } from './MatchRule';

// ============================================================
//  随机数：可种子化，保证同一关能复现（排障与难度标定都要靠它）
// ============================================================

export type Rng = () => number;

/** mulberry32：32 位小、快、够用，不需要引第三方库 */
export function makeRng(seed: number): Rng {
    let a = seed >>> 0;
    return function (): number {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** [0, n) 的整数 */
function randInt(rng: Rng, n: number): number {
    return Math.floor(rng() * n);
}

// ============================================================
//  数据结构
// ============================================================

/** 一张已经落位的牌 */
export interface TileInst {
    /** 稳定 id，用于节点查找与动画（= 数组下标） */
    id: number;
    /** 牌面标识，如 'wan-5' */
    key: PatternKey;
    /** 中心坐标（相对 Canvas 中心，y 向上为正） */
    x: number;
    y: number;
    /**
     * 深度：越大越靠上。
     * 渲染按深度升序（后画的盖住先画的），遮挡判定也只看深度更大的那些牌。
     * 数值 = **层号 × 100000 + 层内叠号 × 1000 + 行号反序**（见 depthOfCell）：
     * 上一层**无条件**压住下一层，层内再按"同格叠号 → 行号"分先后。
     */
    depth: number;
    /**
     * 这张牌在第几层（0 = 最底）。2026-10-01 需求 #4 新增，多层随机堆叠的直接产物。
     *
     * 它**不只是调试信息**：深度公式的第一项就是它，`resolvePositions` 靠它算
     * "这一层整体往上挪多少"（牌堆的厚度）。挂在 TileInst 上而不是每次回格点数组里
     * 查，是因为洗牌会重算整份格点、而 `TileInst` 会跟着一起换 —— 两处都改才叫改对，
     * 只改一处就会"洗完牌层号还留着旧的"，表现为牌堆的厚度突然变了。
     */
    floor: number;
    /** 来源格点（调试用，便于对着 CFG 的格距验算坐标） */
    row: number;
    col: number;
    /** 牌面显示宽（各关可能不同：L1 = 128，L2 起 = 基准 × tileScale） */
    w: number;
    /** 牌面显示高（= w × 176/132，保持牌面内部比例） */
    h: number;
    /**
     * 摆放朝向（度）：0 / 90 / 180 / 270。
     * L1（教学关）恒为 0；L2 起四向随机。
     *
     * ⚠️ 旋转到 90 / 270 时**视觉宽高互换**，所以所有跟矩形有关的计算
     * （遮挡判定、命中测试）**必须走 `boxOf()`**，
     * 不能再像旧版那样直接拿 `CFG.TILE.W/H` 去比 —— 那样横躺的牌会判错。
     */
    angle: number;
}

/**
 * 一张牌的**视觉**包围盒半宽 / 半高。
 * 90 / 270 度时宽高互换。
 */
export function boxOf(t: TileInst): { hw: number; hh: number } {
    const rotated = t.angle === 90 || t.angle === 270;
    return rotated ? { hw: t.h / 2, hh: t.w / 2 } : { hw: t.w / 2, hh: t.h / 2 };
}

/** 一关的完整牌局 */
export interface Layout {
    tiles: TileInst[];
    /** 实际使用的种子（想复现这一局就把它传回 generateLevel） */
    seed: number;
    /** 重新采样了几次才得到可解布局（0 = 一次就过） */
    attempts: number;
    /**
     * 可解性校验的通过率（0..1）。数值越接近 0，解路径越窄 → 越难。
     *
     * ⚠️ 2026-10-01 起语义变了：牌数放大到 63/96 之后这个数**会稳定是 0**
     * （8 个槽位在数学上装不下那么长的解法链，见 CFG.STACK.MAX_RETRY 注释）。
     * 所以它不再是"这局能不能通"的判据，而是**难度指标的读数**：
     * 0 表示"已经超出随机贪心求解器的能力"，不代表这局必输 ——
     * 真人手上有 4 个道具 + 复活，等效手牌容量远大于 8。
     */
    solveRate: number;
    /**
     * 这份布局是否**通过了完整可解性校验**（存在一条纯靠手牌走通的路径）。
     *
     * true  → 不用任何道具也必定能通。
     * false → 只保证「开局不卡」（可点牌够多 + 开局就有能成组的牌），
     *         中后段需要道具/复活。大牌数关卡常态如此，不是异常。
     *
     * 【为什么要把它显式带出来】
     * 以前"兜底局"和"认证局"混在同一个返回值里，调用方（和日志）分不清拿到的是
     * 哪一种，于是排查时会把"这局本来就没想认证"误判成"生成器坏了"。
     */
    certified: boolean;
}

// ============================================================
//  一、牌组构造
// ============================================================

/**
 * 选取本关使用的牌面。
 * 刻意让三族均衡、且**同族内取连号** ——
 * 连号是「吃」的前提，一条连号都不给的话，「吃」这个牌型就形同虚设。
 */
function pickPatterns(count: number, rng: Rng): PatternKey[] {
    const n = Math.max(3, Math.min(9, count));
    // 三族均衡分配（9 → 3/3/3；8 → 3/3/2；6 → 2/2/2；4 → 2/1/1）
    const per: number[] = [Math.floor(n / 3), Math.floor(n / 3), Math.floor(n / 3)];
    for (let i = 0; i < n % 3; i++) per[i] += 1;

    const out: PatternKey[] = [];
    FAMILIES.forEach((fam: Family, fi: number) => {
        const k = per[fi];
        if (k <= 0) return;
        // 该族的连号起点：保证 start..start+k-1 落在 1..9 内
        const start = 1 + randInt(rng, 10 - k);
        for (let i = 0; i < k; i++) out.push(patternKey(fam, start + i));
    });
    return out;
}

/**
 * 构造牌袋（多重集）。
 * ⚠️ 每个牌面的张数都是 **3 的倍数** —— 这样玩家"一路碰到底"必然能清空。
 *    若掺进 4 张的「杠组」，玩家一旦用 3 张碰掉、剩下那张就永远凑不成型，
 *    会凭空造出死局。「杠」只作为**玩家自己凑出来的额外机会**存在（槽里
 *    出现 4 张相同就消 4 张），不写进牌组。
 */
function buildBagGroups(level: LevelConfig, rng: Rng): PatternKey[][] {
    // ① 固定牌组（教学关）：原样返回一份**深拷贝**。
    //    ⚠️ 必须深拷贝：下游 `placeTiles` 会对牌袋做原地 Fisher-Yates 洗牌。
    //       直接把配置里的数组交出去，每开一局就会把 CFG 里那份"设计好的牌组"
    //       打乱一次 —— 而 CFG 是全局单例，于是"固定牌组"实际上只固定第一局。
    //       这个 bug 不报错、只在第二次进关时表现为"牌组变了"，排查成本极高。
    if (level.fixedBagGroups && level.fixedBagGroups.length > 0) {
        const groups = level.fixedBagGroups.map((g) => g.slice());
        const n = groups.reduce((a, g) => a + g.length, 0);
        if (n !== level.tileCount) {
            // 不静默：张数不符时以固定牌组为准，并把差异喊出来。
            // 静默按 tileCount 截断/补齐会让"教学关的设计"和"实际发牌"悄悄分家。
            console.warn(`[Generator] 第 ${level.id} 关 fixedBagGroups 共 ${n} 张，`
                + `与 tileCount=${level.tileCount} 不一致，已按 fixedBagGroups 为准`);
        }
        return groups;
    }

    const total = level.tileCount;
    if (total % 3 !== 0) {
        // 配置写错时的兜底：向下取到 3 的倍数，绝不静默产生无法整除的牌局
        console.warn(`[Generator] 第 ${level.id} 关 tileCount=${total} 不是 3 的倍数，已向下对齐`);
    }
    const groupCount = Math.floor(total / 3);
    const pool = pickPatterns(level.patterns, rng);

    const out: PatternKey[][] = [];

    // ② 「吃」组（顺子）：先按"同族三连号"放进去。
    //
    // 【为什么不能只靠 pickPatterns 的连号】
    // 牌袋原本是「每种牌面各 3 张」——这种结构下玩家**一路碰到底必然通关**，
    // 于是「吃」虽然数学上存在（把 2万2万2万 拆成一个 2万 去和 3万4万 组），
    // 但在玩家的直觉里它是"多余的、用了反而麻烦"的操作，没人会用。
    // 想让它成为真正的牌型，牌袋里就必须出现**只有连号才能消掉**的牌。
    //
    // 【为什么是"先放吃、后补碰"】
    // 反过来（先算好 3 的倍数再改造）会破坏"每种牌面张数是 3 的倍数"这条
    // 保证碰得通的底线。先固定吃组的形状，剩下的组数再用完整的三张补齐，
    // 于是最终牌袋一定是"若干吃组 + 若干碰组"的并集 ——
    // **结构上必然可解**（照着自己的组消即可），不依赖概率。
    //
    // 【起点为什么是 1..7】
    // start+2 必须 ≤ 9，也就是 start ≤ 7。取 `randInt(rng, 7)` 得到 0..6，
    // 加 1 即 1..7。写成 `randInt(rng, 9)` 会在 start=8 时产出 'wan-10' 这种
    // 不存在的牌面 —— 它不会报错，只会在渲染时画出一张空白牌。
    const chiN = Math.max(0, Math.min(groupCount, level.chiGroups ?? 0));
    for (let g = 0; g < chiN; g++) {
        const fam = FAMILIES[randInt(rng, FAMILIES.length)];
        const start = 1 + randInt(rng, 7);
        out.push([patternKey(fam, start), patternKey(fam, start + 1), patternKey(fam, start + 2)]);
    }

    // ③ 剩下的组按「碰」组轮转分配：保证每种牌面的张数尽量平均（差异不超过一组）
    for (let g = chiN; g < groupCount; g++) {
        const p = pool[(g - chiN) % pool.length];
        out.push([p, p, p]);
    }
    return out;
}

/**
 * 构造牌袋（**打平的**多重集）。
 *
 * 【为什么它是 export】
 * 业务链路（generateLevel）走的是 `buildBagGroups` —— 它需要分组信息来铺顺滑区。
 * 这个打平版本是给**无头探针 / 回归测试**用的：那些场景只关心"一共发了哪些牌、
 * 各几张"，逐组看反而碍事。`export` 标记的是"这是被测试依赖的接口"，
 * 不是"谁都可以随便调"。
 */
export function buildBag(level: LevelConfig, rng: Rng): PatternKey[] {
    const out: PatternKey[] = [];
    for (const g of buildBagGroups(level, rng)) out.push(...g);
    return out;
}

// ============================================================
//  二、格点与采样
// ============================================================

interface Grid {
    cols: number;
    rows: number;
    cellW: number;
    cellH: number;
    /** 本关的牌面显示宽高（L1 与 L2+ 不同，所以跟着 Grid 一起走） */
    tileW: number;
    tileH: number;
    /** 第 c 列的 x */
    xOf: (c: number) => number;
    /** 第 r 行的 y（r=0 是最上面一行） */
    yOf: (r: number) => number;
}

/**
 * 本关实际的牌面尺寸（宽高保持 132:176 的内部比例）。
 *
 * 取值优先级：`tileW`（绝对宽度，只有 L1 用）> `CFG.TILE.W × tileScale`（相对倍数）
 * > `CFG.TILE.W`（基准）。
 *
 * ⚠️ **导出**给 `GamePage.slotFootprint` 用。槽位那边的占位必须跟牌堆是同一个尺寸，
 *    否则牌一放大，槽里的牌就会按旧尺寸算缩放、直接顶出格子 ——
 *    而那是"看起来只是有点挤"的表现，最难被发现。口径只留这一处。
 */
export function tileSizeOf(level: LevelConfig): { w: number; h: number } {
    const w = level.tileW ?? CFG.TILE.W * (level.tileScale ?? 1);
    return { w, h: w * (CFG.TILE.H / CFG.TILE.W) };
}

function buildGrid(level: LevelConfig): Grid {
    const S = CFG.STACK;
    const T = tileSizeOf(level);
    // 格距随牌面等比缩放：L1 的牌是基准的 1.506 倍，格距也跟着放大——
    // 这样"横向格距 > 牌宽"这条硬约束在任何关卡都自动成立，不必逐年调参。
    const scale = T.w / CFG.TILE.W;

    const cellW = S.CELL_W * scale;
    const cellH = T.h * (level.flat ? S.CELL_H_RATIO_FLAT : S.CELL_H_RATIO_STACK);

    // 可用的格点中心范围：堆叠区四边各内缩半张牌
    const spanX = (S.X_MAX - T.w / 2) - (S.X_MIN + T.w / 2);
    const spanY = (S.Y_MAX - T.h / 2) - (S.Y_MIN + T.h / 2);

    const cols = Math.max(1, Math.floor(spanX / cellW) + 1);

    // ------------------------------------------------------------
    //  ★ S14.2b 纵向行数：从"能塞几行塞几行"改成"整堆装得下反推"
    // ------------------------------------------------------------
    //  【旧写法错在哪 —— 它会把扩容的收益全吃掉】
    //  旧版是 `rows = floor(spanY / cellH) + 1`，也就是**网格永远把纵向
    //  填满**。S14.2b 把牌堆区从 664 扩到 762（+98）本意是给牌堆让位，
    //  结果 spanY 跟着涨 98 → 行数从 8 涨到 10 → 行跨从 479 涨到 616，
    //  **净结果反而多溢出 22px**（实测：下溢 29 → 51）。
    //  这就是"扩区不解决问题"的根因：网格是自适应填满的，不是固定的。
    //
    //  【新写法】先把"层"和"抖动"的纵向开销扣掉，剩下的才是行的预算：
    //     整堆纵向跨度 = 行跨 + 层跨 + 2×抖动 (+ 同格叠号的错开)
    //     可用的牌心跨度 = 区高 − 牌高 − 立体上下溢（见 SOLID_OVERHANG）
    //  于是  行跨 ≤ 可用 − 层跨 − 2×抖动 − 叠号余量
    //  反推行数。这样"层高 = 牌厚"这条几何关系才不会被行数膨胀顶穿。
    //
    //  ⚠️ 层数必须用**关卡张数**现算，不能读 level.layers：
    //     那个字段是设计意图，真正生效的是 planFloors 里的
    //     `min(FLOOR.MAX, ceil(count / FLOOR.PER))`（L3 的 layers 写 5、实际也是 5，
    //     但 L4 写 6、实际被 FLOOR.MAX 卡在 6 —— 一旦两者不同步，预算就算错）。
    const F = S.FLOOR;
    const solidScale = T.w / TILE_GEO.W;
    const depthPx = CFG.TILE.SOLID.DEPTH * solidScale;
    const nFloors = level.flat
        ? 1
        : Math.max(1, Math.min(F.MAX, Math.ceil(level.tileCount / F.PER)));
    const layerSpan = (nFloors - 1) * depthPx * F.GAP_MUL;
    const jitterY = level.flat ? S.JITTER_FLAT : S.JITTER_Y;
    // 同格叠号的错开量：正常配置下同格很少超过 2 张，留 1 档就够（LAYER_MAX = 0 不设上限，
    // 但真叠起来也不会叠到十几张 —— 那是采样异常，不该由行数预算兜着）
    const stackSpan = cellH * S.LAYER_OFFSET;
    const availY = (S.Y_MAX - T.h / 2 - SOLID_OVERHANG.UP * solidScale)
        - (S.Y_MIN + T.h / 2 + SOLID_OVERHANG.DOWN * solidScale);
    const rowBudget = availY - layerSpan - 2 * jitterY - stackSpan;

    const rows = Math.max(1, Math.floor(rowBudget / cellH) + 1);

    // 居中：把格点阵列摆到区域正中，两侧留白均等
    const padX = (spanX - (cols - 1) * cellW) / 2;
    const padY = (spanY - (rows - 1) * cellH) / 2;
    const x0 = S.X_MIN + T.w / 2 + padX;
    const yTop = S.Y_MAX - T.h / 2 - padY;

    return {
        cols, rows, cellW, cellH, tileW: T.w, tileH: T.h,
        xOf: (c: number) => x0 + c * cellW,
        yOf: (r: number) => yTop - r * cellH,
    };
}

/**
 * 采样结果：一个被选中的格点，以及它属于哪一层、层内的同格叠号。
 */
export interface CellPick {
    r: number;
    c: number;
    /** 层号：0 = 最底下那层；层号越大越靠上（深度也越大） */
    floor: number;
    /** 层内的同格叠号：同一层里落在**同一个格点**上的第几张（0 = 第一张） */
    layer: number;
}

/**
 * 一层的规划：这一层放几张、以哪个位置为中心。
 *
 * 中心用**小数格点坐标**表示，可以落在四个格点正中间 ——
 * 那是常态而不是异常：层的中心本来就该是任意位置，量化到格点反而会让
 * "随机错开"退化成"固定几个位置之间跳"。
 */
interface FloorPlan {
    /** 层号，0 = 最底 */
    idx: number;
    /** 这一层放几张 */
    need: number;
    /** 该层的中心列坐标（小数） */
    cc: number;
    /** 该层的中心行坐标（小数） */
    cr: number;
}

/**
 * 把总张数分到若干层上，并给每层抽一个随机中心。
 *
 * ------------------------------------------------------------
 *  【两条规则，分别解决两个问题】
 *  ① **张数由下往上递减**（第 k 层 ∝ DECAY^k）→ 决定"堆"的形状。
 *     底层最厚、顶层最薄。这不只是好看：顶层薄 ⟹ 顶层的"片"小 ⟹
 *     它盖不住下面那一层 ⟹ **下一层的牌会从缝里露出来**，
 *     这就是开局有牌可点的物理来源（见 CFG.STACK.FLOOR 的长注释）。
 *  ② **每层的中心独立随机**（只在"整堆落点"上共享一个小偏移）→ 决定"乱"。
 *     如果各层中心重合，堆出来是标准的金字塔（每层同心、边界整齐），
 *     一眼就能数出层数、反而显得规整；中心各自随机才会层层错开。
 *
 *  【为什么要共享一个"整堆落点"】
 *  若每层的中心完全独立，可能出现"底层偏左、顶层偏右"——牌堆散成两坨。
 *  先抽一个整堆落点、再在它附近抽每层的中心，才能在"错开"与"成堆"之间取中。
 * ------------------------------------------------------------
 */
function planFloors(grid: Grid, count: number, level: LevelConfig, rng: Rng): FloorPlan[] {
    const F = CFG.STACK.FLOOR;
    // 平铺关（L1）永远只有一层、且不偏移：教学关要的就是一块整齐的方格
    const n = level.flat ? 1 : Math.max(1, Math.min(F.MAX, Math.ceil(count / F.PER)));

    // ---- 张数配比（最大余数法，保证每层 ≥1 张且总和恰好 = count）----
    // 先给每层留 1 张，余下的按 DECAY^k 的权重分 ——
    // 直接按权重取整会在"某层算出 0.x 张"时把它抹掉，堆就缺了一层。
    const w: number[] = [];
    let wsum = 0;
    for (let k = 0; k < n; k++) { const x = Math.pow(F.DECAY, k); w.push(x); wsum += x; }
    const rest = Math.max(0, count - n);
    const add: number[] = new Array(n).fill(0);
    let asum = 0;
    for (let k = 0; k < n; k++) { add[k] = Math.floor(rest * w[k] / wsum); asum += add[k]; }
    const rank: number[] = [];
    for (let k = 0; k < n; k++) rank.push(k);
    // 按"被抹掉的小数部分"从大到小补回余数（下同：越大余数越该优先补）
    rank.sort((a, b) => (rest * w[b] / wsum - add[b]) - (rest * w[a] / wsum - add[a]));
    for (let j = 0; j < rest - asum; j++) add[rank[j % n]]++;

    // ---- 各层的中心 ----
    // 半幅用 max(0.5, ...) 兜底：格点只有 1 列时 (cols-1)/2 = 0，
    // 后面要拿它做乘数，0 会让 LAYER_DRIFT 整个失效。
    const halfC = Math.max(0.5, (grid.cols - 1) / 2);
    const halfR = Math.max(0.5, (grid.rows - 1) / 2);
    // 平铺关不偏移（否则 L1 那块整齐的 4×3 会被推出区外）
    const drift = level.flat ? 0 : F.DRIFT;
    const layerDrift = level.flat ? 0 : F.LAYER_DRIFT;

    const bc = halfC + (rng() * 2 - 1) * drift * halfC;
    const br = halfR + (rng() * 2 - 1) * drift * halfR;

    const plans: FloorPlan[] = [];
    for (let k = 0; k < n; k++) {
        plans.push({
            idx: k, need: 1 + add[k],
            cc: bc + (rng() * 2 - 1) * layerDrift * halfC,
            cr: br + (rng() * 2 - 1) * layerDrift * halfR,
        });
    }
    return plans;
}

/**
 * 单轮加权无放回采样：从 cols×rows 个格点里挑 count 个，每个格点最多出现一次。
 *
 * 权重 = **离本层中心有多近**：`1 − tight × d`，d 是切比雪夫距离（横纵取大者）。
 * 用切比雪夫而不是欧氏距离，是因为片要是**方的** ——
 * 欧氏距离会得出菱形片，四个斜角最先掉权重，堆的边界会显得松散、空白变多。
 *
 * `tight = 0` 时所有格点等权，退化为"均匀铺满"（教学关平铺用）。
 *
 * 【为什么权重是软约束而不是硬排序】
 * 排序会给出唯一的"由近到远"序列，每次结果的轮廓完全一样；
 * 加权随机则每次都不一样 —— 这正是要的随机感，也是"每局长得不一样"的根。
 */
function sampleRound(
    grid: Grid, count: number, rng: Rng, cc: number, cr: number, tight: number,
): Array<{ r: number; c: number }> {
    const total = grid.cols * grid.rows;
    const idx: number[] = [];
    const w: number[] = [];

    // 归一化基准：中心到最远边界的距离，保证最远的那个角恰好 = 1
    const dc = Math.max(1, Math.max(cc, grid.cols - 1 - cc));
    const dr = Math.max(1, Math.max(cr, grid.rows - 1 - cr));

    for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
            const d = Math.max(Math.abs(c - cc) / dc, Math.abs(r - cr) / dr);
            idx.push(r * grid.cols + c);
            // 下限 0.02 而不是 0：完全排除外围会让片变成硬边界，
            // 一堆牌整齐地"填满一个矩形"，反而显得方正
            w.push(Math.max(0.02, 1 - tight * d));
        }
    }

    const picked: Array<{ r: number; c: number }> = [];
    const n = Math.min(count, total);
    for (let k = 0; k < n; k++) {
        let sum = 0;
        for (let i = 0; i < w.length; i++) sum += w[i];
        let t = rng() * sum;
        let hit = w.length - 1;
        for (let i = 0; i < w.length; i++) {
            t -= w[i];
            if (t <= 0) { hit = i; break; }
        }
        const flat = idx[hit];
        picked.push({ r: Math.floor(flat / grid.cols), c: flat % grid.cols });
        // 移除已选中的格点
        idx.splice(hit, 1);
        w.splice(hit, 1);
    }
    return picked;
}

/**
 * 采样 count 个落位点，**按层采样**（多层随机堆叠的主体）。
 *
 * 【2026-10-01 需求 #4：为什么从"同格叠放"改成"分层"】
 * 旧实现是"先铺满一层，装不下就再摞一轮，且每轮的位置完全相同"——
 * 层与层重合，视觉上只读得出"行"、读不出"层"，用户看到的就是
 * "简单地从下往上堆叠"。现在每一层是**位置各自随机的一个片**，
 * 层与层必然错开，堆起来才有多层叠加的观感。
 *
 * 【层内还保留一轮"同格叠放"作兜底】
 * 若某一层要放的数量超过格点总数（比如某关张数暴涨），
 * 就在这一层里再摞一轮（`layer` +1）—— 但正常配置下（96 张 / 6 层 ≈ 16 张）
 * 这一支永远不会走到，见 CFG.STACK.LAYER_MAX 的注释。
 */
function sampleCells(grid: Grid, count: number, level: LevelConfig, rng: Rng): CellPick[] {
    const F = CFG.STACK.FLOOR;
    // 教学关平铺：不聚集（tight = 0），否则 12 张会挤成一小团而不是整齐的 4×3
    const tight = level.flat ? 0 : F.TIGHT;
    const plans = planFloors(grid, count, level, rng);

    const picked: CellPick[] = [];
    for (const p of plans) {
        // 本层每个格点已经摞了几张（key = r * cols + c）
        const inCell = new Map<number, number>();
        let got = 0;
        while (got < p.need) {
            const want = Math.min(p.need - got, grid.cols * grid.rows);
            const round = sampleRound(grid, want, rng, p.cc, p.cr, tight);
            if (round.length === 0) break;   // 防御：不该发生
            for (const cell of round) {
                const key = cell.r * grid.cols + cell.c;
                const lv = inCell.get(key) ?? 0;
                inCell.set(key, lv + 1);
                picked.push({ r: cell.r, c: cell.c, floor: p.idx, layer: lv });
                got++;
            }
        }
    }
    return picked;
}

// ============================================================
//  三、遮挡关系图
// ============================================================

/**
 * 遮挡关系：一张牌被压住 ⟺ 存在一张**深度更大且矩形与它相交**的牌。
 * 用矩形相交而不是"是否全被盖住"，因为这是最容易理解、也最符合直觉的规则。
 *
 * @param skip 需要排除在遮挡计算之外的牌（true = 已从场上拿走）。
 *             「洗牌」道具要重排"剩余牌"，如果已拿走的牌仍参与遮挡，
 *             它们会用幽灵一样的位置压住新布局 —— 必须排除。
 */
export interface BlockGraph {
    /** below[i] = 拿掉 i 之后可以解锁的牌 */
    below: number[][];
    /** above[i] = 压住 i 的牌 */
    above: number[][];
}

export function buildBlockGraph(tiles: TileInst[], skip?: boolean[]): BlockGraph {
    const n = tiles.length;
    const below: number[][] = [];
    const above: number[][] = [];
    for (let i = 0; i < n; i++) { below.push([]); above.push([]); }

    // ⚠️ 必须用**每张牌自己的**旋转后包围盒，不能用全局的 CFG.TILE.W/H：
    //    牌有四种朝向、且各关尺寸不同（L1 = 128、L2 起 = 85）。
    //    矩形相交的判据：|dx| ≥ hw1+hw2 或 |dy| ≥ hh1+hh2 ⟺ 两矩形分离。
    const box = tiles.map(boxOf);

    for (let i = 0; i < n; i++) {
        if (skip && skip[i]) continue;
        const bi = box[i];
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            if (skip && skip[j]) continue;
            if (tiles[j].depth <= tiles[i].depth) continue;   // 只有更深（更靠上）的才可能压住
            const bj = box[j];
            if (Math.abs(tiles[i].x - tiles[j].x) >= bi.hw + bj.hw) continue;
            if (Math.abs(tiles[i].y - tiles[j].y) >= bi.hh + bj.hh) continue;
            above[i].push(j);
            below[j].push(i);
        }
    }
    return { below, above };
}

/** 当前牌面上所有"可点"的牌（未被任何更深层的牌压住） */
export function pickableIds(tiles: TileInst[], graph: BlockGraph, taken: boolean[]): number[] {
    const out: number[] = [];
    for (let i = 0; i < tiles.length; i++) {
        if (taken[i]) continue;
        let blocked = false;
        for (const j of graph.above[i]) {
            if (!taken[j]) { blocked = true; break; }
        }
        if (!blocked) out.push(i);
    }
    return out;
}

/**
 * 这批牌里**是否已经存在一个能立刻凑成的组**（碰 / 吃 / 杠）。
 *
 * 【它是"开局不卡"这条承诺的落点】
 * 牌数放大到 96 之后，生成器已经无法保证"整局可解"（见 CFG.STACK.MAX_RETRY）。
 * 契约降级后，唯一还能**结构性保证**的东西就是开局：
 *   · 可点牌够多（MIN_PICKABLE）—— 有得选；
 *   · 可点牌里已有完整一组    —— 第一手就有回报。
 * 两条合起来，"开局不能卡住玩家"才是可验证的，而不是一句感觉。
 *
 * 【为什么这是"可点牌"集合的性质，而不是"全牌堆"的性质】
 * 可点牌是玩家此刻真正能碰到的牌。若完整的那一组里有牌被压着，
 * 玩家照样点不到它 —— 那种"看得见吃不着"比没有更难忍。
 *
 * 【为什么只查 3 张就够，不必枚举组合】
 * 组只有三种形状，都能用"计数"直接判出来，不需要 C(n,3) 枚举：
 *   · 碰 / 杠 = 同一个牌面出现 ≥3 次；
 *   · 吃      = 同族里存在连续三个数字。
 * 判据是**必要条件也是充分条件**：这 3 张都在可点集合里，
 * 就一定存在一条"连点三张、立刻消除"的开局操作。
 * （补一句为什么不会因为"先点的那张把后两张压住了"而失效：
 *   可点牌的定义是"头上没有未取走的牌"，取走一张牌只会让更多牌变可点，
 *   永远不会让另一张可点牌变回被压住。所以顺序无关紧要。）
 */
export function hasOpeningGroup(keys: PatternKey[]): boolean {
    // ① 碰 / 杠：同一牌面 ≥ 3 张
    //    （出现 4 张时自然也算 —— 杠也是一种立刻可消的组）
    const cnt = new Map<PatternKey, number>();
    for (const k of keys) {
        const n = (cnt.get(k) ?? 0) + 1;
        if (n >= 3) return true;
        cnt.set(k, n);
    }

    // ② 吃：同族里存在连续的 n, n+1, n+2
    const famNums = new Map<Family, number[]>();
    for (const k of keys) {
        const p = parsePattern(k);
        const arr = famNums.get(p.fam);
        if (arr) arr.push(p.num);
        else famNums.set(p.fam, [p.num]);
    }
    // 每个族最多 9 个数字，去重后直接两两查最快，不必建 Set（3 张牌时数组更省）
    for (const arr of famNums.values()) {
        const set = new Set(arr);
        for (let n = 1; n <= 7; n++) {
            if (set.has(n) && set.has(n + 1) && set.has(n + 2)) return true;
        }
    }
    return false;
}

// ============================================================
//  四、求解器：随机化贪心模拟
// ============================================================
/**
 * 模拟的起始状态。
 * 空 = 满局开局。带值 = 从"牌局进行到一半"的状态接着算 ——
 * 「洗牌」道具必须验证"**在玩家当前的槽位状态下**，重排后的局面还能不能通"，
 * 否则洗完可能反而更死，道具就成了负体验。
 */
export interface SimStart {
    /** 已经不在场上的牌 */
    taken?: boolean[];
    /** 槽里已经有的牌 */
    slots?: PatternKey[];
    /** 槽位容量（「加槽」之后可能不是 CFG 的默认值） */
    slotCapacity?: number;
}

/**
 * 跑一局完整模拟，返回是否能把牌全部清空。
 *
 * 为什么不穷举：状态空间是阶乘级的，穷举在第一关就炸了。
 * 但"能不能通"并不需要最优解 —— 只要**存在一条**通关路径即可，
 * 而随机化贪心跑几十上百局足以把一个"天生能通的牌局"找出来；
 * 反过来，真死局几乎不可能被随机通过。这个近似在本场景足够可靠。
 */
function simulate(
    tiles: TileInst[], graph: BlockGraph, gangOn: boolean, rng: Rng, start?: SimStart,
): boolean {
    const n = tiles.length;
    const capacity = start?.slotCapacity ?? CFG.GAMEPLAY.SLOT_CAPACITY;

    const taken: boolean[] = new Array(n).fill(false);
    if (start?.taken) {
        for (let i = 0; i < n; i++) taken[i] = !!start.taken[i];
    }
    const slots: PatternKey[] = (start?.slots ?? []).slice();

    let left = 0;
    for (let i = 0; i < n; i++) if (!taken[i]) left++;
    // 起始状态就已经满槽 → 玩家已经输了，这一局不可能通
    if (slots.length >= capacity) return false;

    // 每张牌当前被几张**未拿走**的牌压住
    const blockedCount: number[] = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
        let c = 0;
        for (const j of graph.above[i]) if (!taken[j]) c++;
        blockedCount[i] = c;
    }

    let guard = 0;
    const guardMax = n * 4 + 64;   // 防御性上限，避免任何意外导致死循环

    while (left > 0 && guard++ < guardMax) {
        // ① 收集可点牌
        const avail: number[] = [];
        for (let i = 0; i < n; i++) {
            if (!taken[i] && blockedCount[i] === 0) avail.push(i);
        }
        if (avail.length === 0) return false;

        // ② 分类：能立刻消的 / 不能的
        const killers: number[] = [];
        const others: number[] = [];
        for (const i of avail) {
            if (wouldMatch(slots, tiles[i].key, gangOn)) killers.push(i);
            else others.push(i);
        }

        // ③ 选择：优先能消；槽快满时**必须**能消，否则本局已败
        let chosen: number;
        if (killers.length > 0) {
            chosen = killers[randInt(rng, killers.length)];
        } else {
            if (slots.length + 1 >= capacity) return false;   // 放进去就满且消不掉
            chosen = others[randInt(rng, others.length)];
        }

        // ④ 入槽
        taken[chosen] = true;
        left--;
        for (const j of graph.below[chosen]) blockedCount[j]--;
        slots.push(tiles[chosen].key);

        // ⑤ 判定消除（可能连续消，例如槽里两组都齐了）
        let cleared = true;
        while (cleared) {
            cleared = false;
            const m = findMatch(slots, gangOn, slots.length - 1);
            if (m) {
                // 下标大的先删，避免前删导致后删错位
                const idx = m.indices.slice().sort((a, b) => b - a);
                for (const k of idx) slots.splice(k, 1);
                cleared = true;
            }
        }

        // ⑥ 槽满即败
        if (slots.length >= capacity) return false;
    }

    // ⚠️ 通关判定必须与游戏**逐字一致**，否则"保证有解"这个承诺本身是错的：
    //    模拟器判死的局、玩家其实能通 → 生成器白扔采样；
    //    模拟器判活的局、玩家却通不了 → 真正的天生死局漏到玩家手上。
    //
    //  【S7.9 起】游戏口径 = **场上清空即通关**（槽里剩什么、暂存架有没有牌
    //  都不管，见 GamePage.isFieldCleared）。所以这里就是 `left === 0`。
    //  改之前是 `left === 0 && slots.length === 0`（更严）—— 那会把一批
    //  "其实能通关"的布局误判成死局，白白报废采样。
    //
    //  中途"槽满"依然判败：入槽前（③）与入槽后（⑥）各有一道 `>= capacity`
    //  检查，玩家不能靠一路硬塞进槽蒙混过关。
    return left === 0;
}

// ============================================================
//  五、落位（★ 「堆叠更乱」的四刀都在这里）
// ============================================================

/**
 * 深度公式（**唯一口径**，首次铺牌与洗牌重排共用）。
 *
 * ```
 * depth = 层号 × 100000 + 层内叠号 × 1000 + 行号反序
 *          └─ 主序：上一层无条件压住下一层
 *                       └─ 次序：同格叠放时后摞的在上
 *                                  └─ 末序：同一层内，上面的行压住下面的行
 * ```
 *
 * 【为什么必须抽成一个函数（2026-10-01）】
 * 以前这行公式在 `placeTiles` 和 `planReshuffle` 里各写了一遍（还各写错了一次）。
 * 深度公式一错，表现是"遮挡关系偶尔不对劲"——不报错、不崩、只是有些牌
 * 莫名点不动，是最难查的一类问题。口径只留一处。
 *
 * 【为什么 100000 / 1000 这两个量级是安全的】
 *   层内叠号 < 1000：正常配置下同层同格最多 2~3 张（见 CFG.STACK.LAYER_MAX）；
 *   行号反序 < 1000：格点行数最多十几行。
 * 两者都不会越界，所以三段可以拼成一个可比较的标量，下游排序接口不用改。
 */
function depthOfCell(grid: Grid, cell: CellPick): number {
    return cell.floor * 100000 + cell.layer * 1000 + (grid.rows - 1 - cell.r);
}

/**
 * 把一组「格点」换算成实际坐标。
 *
 * 四层随机叠加，专治"看起来像网格 / 像土丘"：
 *   ① **逐行整体错位**：每一行抽一个独立的横向偏移。这是最大的一刀 ——
 *      上下的牌不再竖直对齐，一眼看过去是"砖墙错缝"而不是"棋盘"。
 *      偏移量不是拍脑袋来的：先算出该行**实际用到的最左/最右列**
 *      还能移动多少，再在这个区间里随机，保证怎么错都不会捅出牌堆区。
 *      ⚠️ 行号按 **(层号, 行号)** 配对，不是只看行号 ——
 *         两层如果共用同一个行偏移，它们的缝会整齐地叠在一起，
 *         反而给出一组"跨层的竖直线条"，那是比"网格感"更糟的观感。
 *   ② **X / Y 分离抖动**：横向只有 (格距 − 牌宽) 的余量，抖 ±4 到顶
 *      （再大同行相邻牌会互相压，"谁压谁"立刻读不清）；
 *      纵向本来重叠约 74px，抖 ±14 完全安全，而且纵向抖动对"乱"的贡献最大。
 *      平铺关例外，用单独的 JITTER_FLAT（见 CFG 里的说明）。
 *   ③ **层间纵向错开**：每一层整体往上挪（层号 − 中间层）× 格高 × GAP，
 *      做出"摞起来的厚度"。
 *      ⚠️ 位移**以上下对称的方式**算，不是"只往上挪"：
 *         只往上挪会让整堆随层数一起升高（层数越多、牌堆越靠上），
 *         只往下挪会顶穿下边界的暂存架。对称则两头都不跑偏。
 *   ④ **纵向整体平移适配**：算出整堆的自然上下界后，给所有牌加**同一个位移**。
 *      不是逐张夹取 —— 那样会把贴边处的层间错位抹平（详见函数内 ④ 的长注释）。
 */
function resolvePositions(
    cells: CellPick[], grid: Grid, rng: Rng, level: LevelConfig,
): Array<{ x: number; y: number }> {
    const S = CFG.STACK;

    // 三种"手感参数"都从 grid / level 现算，不接受外部传入 ——
    // 首次铺牌与洗牌重排共用同一处口径，不会出现"洗牌前后厚度不一样"的漂移。
    const jitterY = level.flat ? S.JITTER_FLAT : S.JITTER_Y;

    // ★ S14.2 真分层：层高 = **牌厚**(px) × GAP_MUL。
    // 牌厚是设计坐标单位（以 132 宽为基准），所以要按本关的牌宽换算成 px ——
    // 这样"牌小的关层就薄"，四关的堆叠比例一致，不必每关单独配。
    // 与 GamePage/TileRenderer 里的 thickness 是**同一个来源**（CFG.TILE.SOLID.DEPTH），
    // 一旦两边各写一份，就会出现"牌比层厚/层比牌厚"的穿模与浮空（见 CFG 里的长注释）。
    // 设计坐标 → 本关像素的换算系数。牌厚与立体外扩**共用这一个**，
    // 分成两处写迟早会出现"牌厚按牌宽缩了、外扩没缩"的不一致。
    const scale = grid.tileW / TILE_GEO.W;
    const depthPx = CFG.TILE.SOLID.DEPTH * scale;
    const floorGapY = depthPx * S.FLOOR.GAP_MUL;
    const layerGapY = grid.cellH * S.LAYER_OFFSET;

    // ★ S14.2c：立体装饰是画在牌体盒子**之外**的，边界必须一起让出来。
    // 厚度侧壁往下画 DEPTH、投影往右下再扩，两者都不在 CFG.TILE.W×H 里
    // （见 CFG.SOLID_OVERHANG 的长注释）。不让的话，贴边的牌会出现
    // "牌面体在区内、侧壁和阴影糊在暂存架/提示语上"—— 不报错，只是难看。
    //
    // 牌中心允许到达的范围（再往外牌就出区了）。
    // ⚠️ 半径取 **max(牌宽, 牌高) / 2**，不能只按牌宽算：
    //    牌会横躺（90° / 270°），此时视觉宽度反而更大，
    //    按牌宽留边会让横躺的牌探出牌堆区（实测每局 5~7 张越界）。
    //    立体外扩则相反 —— 它是**屏幕方向**的（永远朝下、朝右），
    //    不随牌旋转，所以直接加，不与 max() 混。
    const halfMax = Math.max(grid.tileW, grid.tileH) / 2;
    const limL = S.X_MIN + halfMax + SOLID_OVERHANG.LEFT * scale;
    const limR = S.X_MAX - halfMax - SOLID_OVERHANG.RIGHT * scale;
    const limT = S.Y_MAX - halfMax - SOLID_OVERHANG.UP * scale;
    const limB = S.Y_MIN + halfMax + SOLID_OVERHANG.DOWN * scale;
    // 算偏移量时先把抖动的额度扣掉，抖动就不会把自己顶出边界
    const safeL = limL + S.JITTER_X;
    const safeR = limR - S.JITTER_X;

    // ---- ① 逐行错位：先按 (层, 行) 归拢，再为每一组抽一个偏移 ----
    // key = 层号 × 1000 + 行号（层号与行号都远小于 1000，不会撞键）
    const byRow = new Map<number, number[]>();
    let maxFloor = 0;
    for (const cell of cells) {
        if (cell.floor > maxFloor) maxFloor = cell.floor;
        const k = cell.floor * 1000 + cell.r;
        const arr = byRow.get(k);
        if (arr) arr.push(cell.c);
        else byRow.set(k, [cell.c]);
    }

    // ⚠️ 名义幅度必须用**本关的实际格距** grid.cellW，不能用配置里的基准 CELL_W：
    //    L1 的格距是基准的 1.2 倍、L2 起也有 tileScale 的放大，
    //    用基准值会把错位幅度算小，越大的牌越"对齐得整齐"。
    const nominal = grid.cellW * S.STAGGER;
    const offX = new Map<number, number>();
    byRow.forEach((cs: number[], k: number) => {
        let minC = Infinity;
        let maxC = -Infinity;
        for (const c of cs) {
            if (c < minC) minC = c;
            if (c > maxC) maxC = c;
        }
        // 左边界由最右那列决定、右边界由最左那列决定（xOf 随 c 单调增）
        const lo = Math.max(-nominal, safeL - grid.xOf(maxC));
        const hi = Math.min(nominal, safeR - grid.xOf(minC));
        // lo ≤ 0 ≤ hi 恒成立（基础格点本身就在区内），这里只是防御
        offX.set(k, lo <= hi ? lo + rng() * (hi - lo) : 0);
    });

    // ---- ② 抖动 + ③ 层间厚度：先算"自然位置"，边界问题留到第 ④ 步整体解决 ----
    const raw = cells.map((cell) => {
        const off = offX.get(cell.floor * 1000 + cell.r) ?? 0;
        const jx = (rng() * 2 - 1) * S.JITTER_X;
        const jy = (rng() * 2 - 1) * jitterY;
        let x = grid.xOf(cell.c) + off + jx;
        if (x < limL) x = limL;
        if (x > limR) x = limR;

        // ③ 厚度位移（居中，见上方说明）+ 同层同格的叠放错开
        const dyFloor = (cell.floor - maxFloor / 2) * floorGapY;
        const y = grid.yOf(cell.r) + jy + dyFloor + cell.layer * layerGapY;
        return { x, y };
    });

    // ---- ④ 纵向**整体平移**适配（★ S14.2 改：不再是逐张夹取）----
    //  【旧写法错在哪 —— 它把"分层"吃掉了】
    //  旧版对每一张牌单独 `if (y > limT) y = limT;`。牌堆长高之后（层高从
    //  13.6px 涨到 21.7px），上下两端的牌会成批撞到边界，**全部被夹到同一个 y 上** ——
    //  于是那些牌看上去变成了同一层：层与层之间的错位被边界抹平，
    //  侧壁互相穿透。而且夹取量各不相同，牌堆的纵向间距被**不均匀**地压缩，
    //  "层高 = 牌厚"这条几何关系在贴边处直接失效。
    //  这是"不报错、不崩、只是看起来不对"的典型，只能靠探针量（见
    //  docs/verify/S14/probe 的"贴边张数"）：旧口径下 L4 的 12 局里就有 62 张·次贴边。
    //
    //  【新写法】先算出整堆的自然上下界，再给**所有牌加同一个位移**。
    //  位移不改变任何两张牌的相对关系 → 分层错位永远完整。
    //   · 堆得下  → 取一个不超过边界的位移；0 在合法区间内就取 0（保持既有观感）
    //   · 堆不下  → 上下各让一半（居中），宁可整体占满也不局部压扁
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const p of raw) {
        if (p.y < yMin) yMin = p.y;
        if (p.y > yMax) yMax = p.y;
    }
    const lo = limB - yMin;          // 位移下限（再小下边就出界）
    const hi = limT - yMax;          // 位移上限（再大上边就出界）
    const shift = lo <= hi ? Math.min(Math.max(0, lo), hi) : (lo + hi) / 2;

    return raw.map((p) => ({ x: p.x, y: p.y + shift }));
}

/**
 * 把牌袋随机分配到给定的落位点上（分层堆叠 + 开局顺滑区）。
 *
 * @param bag    打平的牌袋（会被原地洗牌，调用方若还要用请先自行拷贝）
 * @param cells  落位点（含层号），与 `bag` 等长
 * @param groups 牌袋的**分组结构**（每组 3 张，碰或吃）。传了它才会铺"顺滑区"；
 *               不传 = 全随机（旧行为，对照实验用）。
 */
function placeTiles(
    bag: PatternKey[], cells: CellPick[],
    grid: Grid, rng: Rng, level: LevelConfig, groups?: PatternKey[][],
): TileInst[] {
    const S = CFG.STACK;

    // 打乱牌袋（Fisher-Yates），让"哪种牌落在哪个格点"完全随机
    for (let i = bag.length - 1; i > 0; i--) {
        const j = randInt(rng, i + 1);
        const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
    }

    // ---------- 开局顺滑区（软卡点的"软"那一半）----------
    // 【深度序 = 玩家够到这些牌的大致先后】
    // depth 越大越靠上、越早被够到（现在是"层号为主"，见 depthOfCell）。
    // 按它降序排一遍，数组前段 ≈"开局那 1/3"，后段 ≈"挖到后面才碰得到的 2/3"。
    //
    // ⚠️ 这里排的是**格子**，不是牌 —— 牌还没分配下去。所以下一步要
    //    产出一份"按深度序排列的牌面序列"，再照序发下去。
    // ⚠️ 排序口径必须与 `depthOfCell` 完全一致：差一点点（比如漏掉层号）
    //    就会出现"顺滑区铺在了最底层"——开局不卡这个承诺直接失效，
    //    而现象只是"这关开局莫名有点闷"，很难联想到排序键写错了。
    const depthOf = (c: CellPick) => depthOfCell(grid, c);
    const order: number[] = [];
    for (let i = 0; i < cells.length; i++) order.push(i);
    order.sort((a, b) => depthOf(cells[b]) - depthOf(cells[a]));

    const seq: PatternKey[] | null = buildEasyZoneSequence(bag, order.length, groups, rng, S.OPENING_EASY_RATIO);
    // seq 为 null = 关掉了顺滑区（或没给分组）→ 用洗过的那份牌袋原序
    const keyAt = (k: number) => (seq ? seq[k] : bag[k]);

    const pos = resolvePositions(cells, grid, rng, level);
    // 朝向：教学关（upright）一律正立 —— 新手第一次玩，牌面倒着或横着会直接劝退；
    //      L2 起四向随机（用户 2026-10-01 拍板："可以横着摆，或者倒着摆"）。
    const ANGLES = [0, 90, 180, 270];

    const out: TileInst[] = new Array(cells.length);
    for (let k = 0; k < order.length; k++) {
        const i = order[k];
        const cell = cells[i];
        out[i] = {
            id: i,
            key: keyAt(k),
            x: pos[i].x,
            y: pos[i].y,
            depth: depthOfCell(grid, cell),
            floor: cell.floor,
            row: cell.r,
            col: cell.c,
            w: grid.tileW,
            h: grid.tileH,
            angle: level.upright ? 0 : ANGLES[randInt(rng, ANGLES.length)],
        };
    }
    return out;
}

/**
 * 产出"按深度序排列的牌面序列"，其中**前 ratio 段是成组的**。
 *
 * ------------------------------------------------------------
 *  【它解决的是什么问题】
 *  用户要的「软卡点」= 开局 1/3 顺、之后卡。牌堆本身的随机性只会给出
 *  "从头均匀地难"，两头都够不到。要让**前 1/3 结构性变顺**，就得让那一段
 *  的牌按组挨在一起 —— 玩家挖出来三张就是一组，不用去翻后面的牌。
 *
 *  【为什么只重排前半段，而不是全排成组】
 *  全排成组会让整关变成"照着顺序点三下"的机械操作（组与组之间没有交错，
 *  槽位永远不超过 3 张），难度直接归零。只排前半段，后半段保持随机，
 *  才能在"学会"与"卡住"之间形成那道落差 —— 落差本身就是设计。
 *
 *  【返回 null 的两种情形】
 *  ① `OPENING_EASY_RATIO <= 0`：显式关闭（对照实验）；
 *  ② 没给 `groups`：无从得知哪三张是一组，只能退回全随机。
 *  两者都**不是错误**，所以不打 warn。
 * ------------------------------------------------------------
 *
 * @param bag   已经洗过牌的牌袋（本函数**只读**它，不修改）
 * @param n     牌数
 * @param groups 分组结构（每组 3 张）
 * @param rng   随机源（用来打乱"组的先后顺序"，避免组按原始次序出现）
 * @param ratio 顺滑区占比（0~1）
 */
function buildEasyZoneSequence(
    bag: PatternKey[], n: number, groups: PatternKey[][] | undefined,
    rng: Rng, ratio: number,
): PatternKey[] | null {
    if (!groups || groups.length === 0 || ratio <= 0) return null;

    // 逐组累加，直到凑够顺滑区长度。**允许最后一组略微超出**：
    // 硬截断会把一组拆成两半，那恰好是最不该进顺滑区的形状（半组 = 卡）。
    //
    // ⚠️ 取之前必须**先把组序打乱**。`buildBagGroups` 是按"先吃后碰"的顺序
    //    产出的，直接取前几组会让顺滑区**永远全是「吃」**：
    //    · 同一关每次开局都是清一色的连号，前 1/3 玩起来像同一个模板；
    //    · 后果更隐蔽的是后半段 —— 剩下的清一色是「碰」，两种牌型被
    //      "按进度分区"而不是"按局面混合"，整关的节奏会变得很单调。
    //    打乱组序之后，顺滑区与后半段都自然混合两种牌型。
    const orderGroups = groups.slice();
    for (let i = orderGroups.length - 1; i > 0; i--) {
        const j = randInt(rng, i + 1);
        const t = orderGroups[i]; orderGroups[i] = orderGroups[j]; orderGroups[j] = t;
    }

    const want = Math.round(n * Math.min(1, ratio));
    const picked: PatternKey[][] = [];
    let got = 0;
    for (const g of orderGroups) {
        if (got >= want) break;
        picked.push(g);
        got += g.length;
    }
    if (picked.length === 0) return null;

    // ① 顺滑区：把组依次展开成牌面序列。
    //    只展开、不再打乱 —— 组序在上面（orderGroups）已经洗过一次了，
    //    这里再洗一遍是多余动作，反而让人误以为上面那次没起作用。
    //    组内那三张必须**挨着**，否则就不成组了（那是本函数存在的理由）。
    const head: PatternKey[] = [];
    for (const g of picked) head.push(...g);

    // ② 后半段：把顺滑区用掉的那些张数，从洗过的牌袋里**按规定数量扣除**。
    //    ⚠️ 不能简单地"剩下的全给后半段"—— 那会让后半段张数对不上
    //       （顺滑区可能因"整组不拆"而多拿了几张）。这里按多重集做减法，
    //       保证「head + tail 恰好 = 原牌袋」，一张不多一张不少。
    const need = new Map<PatternKey, number>();
    for (const k of head) need.set(k, (need.get(k) ?? 0) + 1);
    const tail: PatternKey[] = [];
    for (const k of bag) {
        const c = need.get(k) ?? 0;
        if (c > 0) need.set(k, c - 1);
        else tail.push(k);
    }
    // 防御：账对不上时（配置写错导致分组与牌袋不一致）宁可退回全随机，
    // 也不要交出一份"少牌/多牌"的布局 —— 那会直接表现为场上牌数不对。
    if (head.length + tail.length !== n) {
        console.warn(`[Generator] 顺滑区张数对不上（head ${head.length} + tail ${tail.length} ≠ ${n}），已退回全随机`);
        return null;
    }
    return head.concat(tail);
}

/**
 * 生成一关的牌局。
 *
 * ============================================================
 *  【契约（2026-10-01 降级，用户拍板）】
 * ------------------------------------------------------------
 *  牌数放大到 36 / 63 / 96 之后，"每局都能纯靠手牌通关"在数学上做不到：
 *  8 个槽位装不下那么长的解法链（实测 8 槽下 63 张 5%、96 张 0%；
 *  96 张要通，槽位得给到 12~14 个）。用户选择了「羊了个羊」模式：
 *  **牌数照放、槽位不加**，改用"开局不卡 + 中后段靠看广告用道具/复活"。
 *
 *  于是本函数的承诺分三档，**从高到低依次尝试**：
 *    ① 认证可解   —— 存在一条纯手牌的通关路径（certified = true）
 *    ② 开局不卡   —— 可点牌达标 + 可点牌里已有能立刻成组的牌（certified = false）
 *    ③ 至少能玩   —— 连 ② 都没采到时，取"可点牌最多"的一份，保证不白屏
 *
 *  ⚠️ **绝不允许返回 null / 抛异常**。这条路径上任何一次中断都是
 *     "点了关卡没反应、还停在选关页"，而玩家完全无从判断发生了什么。
 *     所以最后那档哪怕局面再差，也一定要把牌发出去。
 * ============================================================
 *
 * @param level 关卡配置
 * @param seed  指定随机种子（想复现某一局就带上；不传则按时间随机）
 */
export function generateLevel(level: LevelConfig, seed?: number): Layout {
    const baseSeed = seed ?? ((Date.now() ^ (level.id * 2654435761)) >>> 0);
    const gangOn = level.gang;
    const trials = CFG.STACK.SOLVE_TRIALS;
    const need = CFG.STACK.MIN_PICKABLE;

    /** 一档候选：过了某个门槛、但还没（或无法）认证可解 */
    interface Cand { tiles: TileInst[]; seed: number; pick: number; rate: number }
    /** ② 档：第一份"开局不卡"的布局（优先用它，因为它是"能玩"的最强保证） */
    let okPick: Cand | null = null;
    /** ③ 档：可点牌最多的一份（只在 ② 也全军覆没时才用） */
    let bestPick: Cand | null = null;

    let attempts = 0;
    let rejectOpen = 0;   // 止步于"可点牌不足"的次数
    let rejectGroup = 0;  // 止步于"开局凑不成组"的次数

    for (let attempt = 0; attempt < CFG.STACK.MAX_RETRY; attempt++) {
        attempts = attempt + 1;
        const rng = makeRng((baseSeed + attempt * 7919) >>> 0);
        const atSeed = baseSeed + attempt * 7919;

        const grid = buildGrid(level);
        // 用「分组版」牌袋：`placeTiles` 需要知道哪三张是一组，才能铺开局顺滑区。
        // 这里再把组打平成一份独立数组交给它洗 —— 洗的是副本，`groups` 不受影响。
        const groups = buildBagGroups(level, rng);
        const bag: PatternKey[] = [];
        for (const g of groups) bag.push(...g);
        const cells = sampleCells(grid, bag.length, level, rng);
        const tiles = placeTiles(bag, cells, grid, rng, level, groups);
        const graph = buildBlockGraph(tiles);

        // ---------- 门槛 ①：开局可点牌够多 ----------
        const taken: boolean[] = new Array(tiles.length).fill(false);
        const pickIds = pickableIds(tiles, graph, taken);
        // ③ 档同时在这里维护：不管过不过门槛，都留着"可点牌最多"的那份。
        //    ⚠️ 必须在 continue **之前**更新，否则 ② ③ 两档都会是空的，
        //       走到函数末尾的 `!` 断言就会抛 —— 那正是"关卡打不开"的成因。
        if (!bestPick || pickIds.length > bestPick.pick) {
            bestPick = { tiles, seed: atSeed, pick: pickIds.length, rate: -1 };
        }
        if (pickIds.length < need) { rejectOpen++; continue; }

        // ---------- 门槛 ②：开局就有能立刻成组的牌 ----------
        // 见 hasOpeningGroup 的注释：这是契约降级后唯一还能结构性保证的"开局不卡"。
        const keys = pickIds.map((i) => tiles[i].key);
        if (!hasOpeningGroup(keys)) { rejectGroup++; continue; }

        if (!okPick) okPick = { tiles, seed: atSeed, pick: pickIds.length, rate: -1 };

        // 只给"找认证局"这点事留一个小预算，试不到就不再消耗时间了 ——
        // 老实现会死磕 40 次 × 60 局模拟（实测 229ms/局），
        // 而大牌数下这个预算**必然**全部落空，等于白等。
        if (attempt + 1 > CFG.STACK.SOLVE_SEARCH_RETRY) break;

        // ---------- 门槛 ③：完整可解性（尽力而为，不达标不阻塞） ----------
        const ok = this_runTrials(tiles, graph, gangOn, trials, baseSeed + attempt * 104729);
        const rate = ok / trials;
        if (okPick.rate < 0) okPick.rate = rate;
        if (ok > 0) {
            // 找到了真正能纯手牌通关的一局 —— 最高档，立刻用它
            return {
                tiles, seed: atSeed, attempts, solveRate: rate, certified: true,
            };
        }
    }

    // ---------- 落到 ② 档 ----------
    if (okPick) {
        if (okPick.rate < 0) {
            // 没跑过模拟（预算用完之前就 break 了）。补一次只为把指标填准，
            // 不改变"用这一份"的决定 —— 所以它失败与否都不影响返回值。
            okPick.rate = this_runTrials(
                okPick.tiles, buildBlockGraph(okPick.tiles), gangOn,
                trials, baseSeed + 0x7f4a7c15) / trials;
        }
        logGen(level, attempts, rejectOpen, rejectGroup, okPick.rate, false);
        return {
            tiles: okPick.tiles, seed: okPick.seed, attempts,
            solveRate: okPick.rate, certified: false,
        };
    }

    // ---------- 落到 ③ 档：连"开局不卡"都没采到 ----------
    // 这在大牌数关卡是**可能发生**的（可点牌天生就少），必须能兜住。
    console.warn(`[Generator] 第 ${level.id} 关：${attempts} 次采样都没采到「开局不卡」的布局`
        + `（${rejectOpen} 次可点牌 < ${need}，${rejectGroup} 次开局凑不成组）。`
        + `已改用可点牌最多的一份（${bestPick!.pick} 张可点）—— 局面会偏闷，请关注玩家反馈。`);
    return {
        tiles: bestPick!.tiles, seed: bestPick!.seed, attempts,
        solveRate: bestPick!.rate < 0 ? 0 : bestPick!.rate, certified: false,
    };
}

/**
 * 跑 `trials` 局随机模拟，返回通关局数。
 * 抽出来只为让 `generateLevel` 里那三处调用读起来是一件事，别各写一遍循环。
 */
function this_runTrials(
    tiles: TileInst[], graph: BlockGraph, gangOn: boolean, trials: number, seedBase: number,
): number {
    let ok = 0;
    for (let t = 0; t < trials; t++) {
        const r = makeRng((seedBase + t * 15485863) >>> 0);
        if (simulate(tiles, graph, gangOn, r)) ok++;
    }
    return ok;
}

/** 生成结果的分级日志。认证局走 log（正常），非认证局走 warn（需要被看见） */
function logGen(
    level: LevelConfig, attempts: number, rejectOpen: number, rejectGroup: number,
    rate: number, certified: boolean,
): void {
    const msg = `[Generator] 第 ${level.id} 关 ${level.tileCount} 张：${attempts} 次采样`
        + `${certified ? '（已认证可解）' : '（仅认证「开局不卡」）'}`
        + `，可解率 ${(rate * 100).toFixed(1)}%`
        + `，止步统计「可点牌不足 ${rejectOpen} / 开局凑不成组 ${rejectGroup}」`;
    if (certified) console.log(msg);
    else console.log(msg + '  ← 大牌数关卡的常态，玩家需用道具/复活续命');
}

// ============================================================
//  六、「洗牌」道具：重排场上剩余牌
// ============================================================

/** 一张牌要挪到哪儿去 */
export interface TileMove {
    id: number;
    x: number;
    y: number;
    depth: number;
    /** 新的层号。必须跟着 depth 一起带出来 —— 只更新 depth 会让"牌堆厚度"仍按旧层号算 */
    floor: number;
    row: number;
    col: number;
}

export interface ReshufflePlan {
    /** 只含"参与重排的牌"（场上剩余的 + 暂存架里的），其余牌不动 */
    moves: TileMove[];
    /** 方案算出来的可解通过率（用于日志与难度标定） */
    solveRate: number;
    attempts: number;
}

/**
 * 为「洗牌」道具**算一个可行方案**（纯计算，不改任何状态）。
 *
 * ------------------------------------------------------------
 *  【为什么不直接改坐标，而是先出方案】
 *  洗牌要走「看广告」门禁。如果先改坐标再弹广告，玩家取消时状态已经变了，
 *  必须回滚；如果先弹广告再算，一旦算不出方案，玩家就**白看了一条广告**。
 *  所以顺序必须是：**先算 → 再要权限 → 最后提交**。这也让"取消"变成零成本。
 *
 *  ------------------------------------------------------------
 *  【三条硬约束，缺一条这个道具就成了坑】
 *   ① 已拿走的牌不参与遮挡（否则它们会像幽灵一样压住新布局）；
 *   ② 重排后要有足够的可点牌（下限按剩余张数比例给，见下方 minPick）；
 *   ③ **必须在玩家当前的槽位状态下仍然可解** —— 这条是洗牌的价值所在：
 *      把一个"看得见的烂局面"换成一个"还能救的局面"。
 *
 *  ------------------------------------------------------------
 *  【为什么把暂存架里的牌也一起撒回场上】
 *  暂存牌是"玩家随时能取回"的牌。如果只重排场上的牌，
 *  会出现"场上 7 张、缺的那 2 张在暂存架里 → 场上这批天生无解"的局面，
 *  洗牌就只能拒绝服务（首次实装就是这样：玩家看完广告什么都没发生）。
 *  把它们一起撒回场上，既保证有解，也让暂存取回这件事自动完成。
 *
 * @returns 可行方案；连续 RESHUFFLE_RETRY 次都算不出则返回 null
 *          （调用方应当**在要权限之前**就处理掉这个分支）
 */
export function planReshuffle(
    level: LevelConfig, tiles: TileInst[], taken: boolean[], slots: PatternKey[],
    slotCapacity: number, extraIds: number[] = [], seed?: number,
): ReshufflePlan | null {
    // 参与重排的牌 = 场上还没拿走的 + 暂存架里的
    const ids: number[] = [];
    for (let i = 0; i < tiles.length; i++) if (!taken[i]) ids.push(i);
    for (const id of extraIds) {
        if (id >= 0 && id < tiles.length && taken[id] && ids.indexOf(id) < 0) ids.push(id);
    }
    if (ids.length < 1) return null;

    const gangOn = level.gang;
    const trials = CFG.STACK.SOLVE_TRIALS;
    const baseSeed = seed ?? ((Date.now() ^ 0x5bf03635) >>> 0);

    /**
     * 重排后的「可点牌下限」。
     *
     * ⚠️ 不能直接套用 CFG.STACK.MIN_PICKABLE。它（现为 5）是为"满局开局"
     * 设计的（开局要有足够选择），而洗牌多半发生在残局：只剩 5~8 张牌时，
     * 要满足"5 张可点"几乎等于要求这些牌互不遮挡 —— 24 次随机尝试可能全部落空。
     * 正确口径是按剩余张数的比例给，后半段更是放宽到 1 ——
     * 因为"可解"这个条件本身就已经蕴含了"至少有一张可点"。
     */
    const minPick = Math.max(2, Math.min(CFG.STACK.MIN_PICKABLE, Math.ceil(ids.length / 3)));
    const requireSolvable = CFG.STACK.RESHUFFLE_REQUIRE_SOLVABLE;

    // 影子副本：在副本上试排，成功后才把坐标交出去。
    // 这样"算不出方案"时调用方的牌局**一个字节都没被动过**。
    const shadow: TileInst[] = tiles.map((t) => ({ ...t }));
    // 参与重排的牌在影子局里一律视为"还在场上"
    const shadowTaken: boolean[] = taken.map((v, i) => (ids.indexOf(i) >= 0 ? false : v));

    /**
     * 退而求其次用的候选：RESHUFFLE_RETRY 次里**可解率最高**的那一版。
     *
     * 只在 `RESHUFFLE_REQUIRE_SOLVABLE = false` 时才会被用到 —— 那时本函数
     * 的承诺退化为"给你一个可点牌更多、更整齐的局面"，而不是"保证可解"
     * （大牌数下后者不存在，原因见该开关的注释）。
     */
    let fallback: ReshufflePlan | null = null;

    for (let attempt = 0; attempt < CFG.STACK.RESHUFFLE_RETRY; attempt++) {
        const rng = makeRng((baseSeed + attempt * 15485863) >>> 0);
        const grid = buildGrid(level);
        const cells = sampleCells(grid, ids.length, level, rng);
        if (cells.length < ids.length) continue;   // 格点不够（不该发生，防御）

        const pos = resolvePositions(cells, grid, rng, level);
        // ids 也打乱一次：否则"哪些牌留在原位"会带上规律
        const order = ids.slice();
        for (let i = order.length - 1; i > 0; i--) {
            const j = randInt(rng, i + 1);
            const t = order[i]; order[i] = order[j]; order[j] = t;
        }
        for (let k = 0; k < order.length; k++) {
            const tile = shadow[order[k]];
            tile.x = pos[k].x;
            tile.y = pos[k].y;
            tile.row = cells[k].r;
            tile.col = cells[k].c;
            // 深度/层号只由新格点决定，与被压住的旧值无关。
            // ⚠️ 两行必须一起写：只改 depth 不改 floor，牌堆的"厚度"位移
            //    还会按旧的层号算 —— 表现是洗完牌层与层贴在一起（或散开）。
            tile.depth = depthOfCell(grid, cells[k]);
            tile.floor = cells[k].floor;
        }

        const graph = buildBlockGraph(shadow, shadowTaken);

        // ② 可点牌太少 → 换一版。后半段放宽到 1
        const need = attempt < CFG.STACK.RESHUFFLE_RETRY / 2 ? minPick : 1;
        if (pickableIds(shadow, graph, shadowTaken).length < need) continue;

        // ③ 带着玩家当前的槽位状态验证可解性
        //    ⚠️ 这里**不能**复用 generateLevel 用的 `this_runTrials`：
        //       那个是"满局开局"口径（不传 start）。洗牌必须从**玩家此刻的
        //       槽位**接着算，否则会把它判成"能通"，而实际玩家槽里已经躺着
        //       2 张万、3 张条 —— 洗完还是通不了，道具就成了纯坑。
        let ok = 0;
        for (let t = 0; t < trials; t++) {
            const r = makeRng((baseSeed + attempt * 104729 + t * 15485863) >>> 0);
            if (simulate(shadow, graph, gangOn, r, { taken: shadowTaken, slots, slotCapacity })) ok++;
        }
        const plan: ReshufflePlan = {
            moves: order.map((id, k) => ({
                id,
                x: pos[k].x, y: pos[k].y,
                depth: shadow[id].depth, floor: shadow[id].floor,
                row: shadow[id].row, col: shadow[id].col,
            })),
            solveRate: ok / trials,
            attempts: attempt + 1,
        };

        if (ok > 0) return plan;
        // 记下最好的一版。可解率相同时保持先到的（越早的尝试，可点牌门槛越严）
        if (!fallback || plan.solveRate > fallback.solveRate) fallback = plan;
    }

    // 一版"可解"的重排都没找到。
    if (!requireSolvable && fallback) {
        // 允许退化：把最好的一版交出去。
        // ⚠️ 为什么不能在这里 return null —— 玩家此刻**已经看完广告了**。
        //    返回 null 的表现是"看完广告、什么都没发生"，那比给他一个
        //    "更整齐但依旧要动脑"的局面糟糕得多。
        return fallback;
    }
    return null;
}
