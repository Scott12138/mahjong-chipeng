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

import { CFG, LevelConfig } from '../CFG';
import { ALL_PATTERNS, Family, FAMILIES, PatternKey, patternKey } from '../TileData';
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
     */
    depth: number;
    /** 来源格点（调试用，便于对着 CFG 的格距验算坐标） */
    row: number;
    col: number;
}

/** 一关的完整牌局 */
export interface Layout {
    tiles: TileInst[];
    /** 实际使用的种子（想复现这一局就把它传回 generateLevel） */
    seed: number;
    /** 重新采样了几次才得到可解布局（0 = 一次就过） */
    attempts: number;
    /** 可解性校验的通过率（0..1）。数值越接近 0，解路径越窄 → 越难 */
    solveRate: number;
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
function buildBag(level: LevelConfig, rng: Rng): PatternKey[] {
    const total = level.tileCount;
    if (total % 3 !== 0) {
        // 配置写错时的兜底：向下取到 3 的倍数，绝不静默产生无法整除的牌局
        console.warn(`[Generator] 第 ${level.id} 关 tileCount=${total} 不是 3 的倍数，已向下对齐`);
    }
    const groups = Math.floor(total / 3);
    const pool = pickPatterns(level.patterns, rng);

    const bag: PatternKey[] = [];
    for (let g = 0; g < groups; g++) {
        // 轮转分配：保证每种牌面的张数尽量平均（差异不超过一组）
        const p = pool[g % pool.length];
        bag.push(p, p, p);
    }
    return bag;
}

// ============================================================
//  二、格点与采样
// ============================================================

interface Grid {
    cols: number;
    rows: number;
    cellW: number;
    cellH: number;
    /** 第 c 列的 x */
    xOf: (c: number) => number;
    /** 第 r 行的 y（r=0 是最上面一行） */
    yOf: (r: number) => number;
}

function buildGrid(level: LevelConfig): Grid {
    const S = CFG.STACK;
    const T = CFG.TILE;

    const cellW = S.CELL_W;
    const cellH = T.H * (level.flat ? S.CELL_H_RATIO_FLAT : S.CELL_H_RATIO_STACK);

    // 可用的格点中心范围：堆叠区四边各内缩半张牌
    const spanX = (S.X_MAX - T.W / 2) - (S.X_MIN + T.W / 2);
    const spanY = (S.Y_MAX - T.H / 2) - (S.Y_MIN + T.H / 2);

    const cols = Math.max(1, Math.floor(spanX / cellW) + 1);
    const rows = Math.max(1, Math.floor(spanY / cellH) + 1);

    // 居中：把格点阵列摆到区域正中，两侧留白均等
    const padX = (spanX - (cols - 1) * cellW) / 2;
    const padY = (spanY - (rows - 1) * cellH) / 2;
    const x0 = S.X_MIN + T.W / 2 + padX;
    const yTop = S.Y_MAX - T.H / 2 - padY;

    return {
        cols, rows, cellW, cellH,
        xOf: (c: number) => x0 + c * cellW,
        yOf: (r: number) => yTop - r * cellH,
    };
}

/**
 * 加权无放回采样：从 cols×rows 个格点里挑 count 个。
 * 权重 = 横向中心度 × 纵向底部度，制造"中下密、边缘疏"的牌山轮廓。
 * 权重是**软约束**（不是排序），所以每次结果的轮廓都不一样 —— 这正是要的随机感。
 */
function sampleCells(grid: Grid, count: number, rng: Rng): Array<{ r: number; c: number }> {
    const S = CFG.STACK;
    const total = grid.cols * grid.rows;
    const idx: number[] = [];
    const w: number[] = [];

    const cx = (grid.cols - 1) / 2;
    const maxDx = Math.max(1, cx);

    for (let r = 0; r < grid.rows; r++) {
        for (let c = 0; c < grid.cols; c++) {
            const dx = Math.abs(c - cx) / maxDx;
            const wx = 1 - S.WEIGHT_X * dx;
            // r=0 在最上面 → 权重最低；r 越大越靠下 → 权重越高
            const dy = grid.rows > 1 ? r / (grid.rows - 1) : 1;
            const wy = 1 - S.WEIGHT_Y * (1 - dy);
            idx.push(r * grid.cols + c);
            w.push(Math.max(0.02, wx * wy));
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

    const W = CFG.TILE.W;
    const H = CFG.TILE.H;

    for (let i = 0; i < n; i++) {
        if (skip && skip[i]) continue;
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            if (skip && skip[j]) continue;
            if (tiles[j].depth <= tiles[i].depth) continue;   // 只有更深（更靠上）的才可能压住
            if (Math.abs(tiles[i].x - tiles[j].x) >= W) continue;
            if (Math.abs(tiles[i].y - tiles[j].y) >= H) continue;
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

    // ⚠️ 必须是「场上清空 **且** 槽里也清空」才算通关。
    // 只看 left===0 会漏掉一种情况：最后几张全进了槽但一张都没凑成型，
    // 此时场上确实空了，玩家却卡死在槽上 —— 那是败局，不是胜局。
    return left === 0 && slots.length === 0;
}

// ============================================================
//  五、落位（★ 「堆叠更乱」的三刀都在这里）
// ============================================================

/**
 * 把一组「格点」换算成实际坐标。
 *
 * 三层随机叠加，专治"看起来像网格"：
 *   ① **逐行整体错位**：每一行抽一个独立的横向偏移。这是最大的一刀 ——
 *      上下的牌不再竖直对齐，一眼看过去是"砖墙错缝"而不是"棋盘"。
 *      偏移量不是拍脑袋来的：先算出该行**实际用到的最左/最右列**
 *      还能移动多少，再在这个区间里随机，保证怎么错都不会捅出牌堆区。
 *   ② **X / Y 分离抖动**：横向只有 (CELL_W − TILE.W) = 12px 余量，
 *      抖 ±5 就到顶了（再大同行相邻牌会互相压，"谁压谁"立刻读不清）；
 *      纵向本来重叠 89px，抖 ±14 完全安全，而且纵向抖动对"乱"的贡献最大。
 *      平铺关例外，用单独的 JITTER_FLAT（见 CFG 里的说明）。
 *   ③ 最后再夹一次边界，作为兜底。
 *
 * @param jitterY 纵向抖动幅度。平铺关必须传小值，否则相邻行会互相压上。
 */
function resolvePositions(
    cells: Array<{ r: number; c: number }>, grid: Grid, rng: Rng, jitterY: number,
): Array<{ x: number; y: number }> {
    const S = CFG.STACK;
    const T = CFG.TILE;

    // 牌中心允许到达的范围（再往外牌就出区了）
    const limL = S.X_MIN + T.W / 2;
    const limR = S.X_MAX - T.W / 2;
    // 算偏移量时先把抖动的额度扣掉，抖动就不会把自己顶出边界
    const safeL = limL + S.JITTER_X;
    const safeR = limR - S.JITTER_X;

    // ---- ① 逐行错位：先按行归拢，再为每行抽一个偏移 ----
    const byRow = new Map<number, number[]>();
    for (const cell of cells) {
        const arr = byRow.get(cell.r);
        if (arr) arr.push(cell.c);
        else byRow.set(cell.r, [cell.c]);
    }

    const nominal = S.CELL_W * S.STAGGER;
    const offX = new Map<number, number>();
    byRow.forEach((cs: number[], r: number) => {
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
        offX.set(r, lo <= hi ? lo + rng() * (hi - lo) : 0);
    });

    // ---- ② 抖动 + ③ 边界兜底 ----
    return cells.map((cell) => {
        const off = offX.get(cell.r) ?? 0;
        const jx = (rng() * 2 - 1) * S.JITTER_X;
        const jy = (rng() * 2 - 1) * jitterY;
        let x = grid.xOf(cell.c) + off + jx;
        if (x < limL) x = limL;
        if (x > limR) x = limR;
        return { x, y: grid.yOf(cell.r) + jy };
    });
}

/** 该关的纵向抖动幅度 */
function jitterYOf(level: LevelConfig): number {
    return level.flat ? CFG.STACK.JITTER_FLAT : CFG.STACK.JITTER_Y;
}

/** 把牌袋随机分配到给定的格点上 */
function placeTiles(
    bag: PatternKey[], cells: Array<{ r: number; c: number }>,
    grid: Grid, rng: Rng, level: LevelConfig,
): TileInst[] {
    // 打乱牌袋（Fisher-Yates），让"哪种牌落在哪个格点"完全随机
    for (let i = bag.length - 1; i > 0; i--) {
        const j = randInt(rng, i + 1);
        const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
    }

    const pos = resolvePositions(cells, grid, rng, jitterYOf(level));
    return bag.map((key, i) => {
        const cell = cells[i];
        return {
            id: i,
            key,
            x: pos[i].x,
            y: pos[i].y,
            // 深度与行号反序：最上面一行（r=0）深度最大 → 它压住下面所有相交的牌
            depth: grid.rows - 1 - cell.r,
            row: cell.r,
            col: cell.c,
        };
    });
}

/**
 * 生成一关的牌局。
 * @param level 关卡配置
 * @param seed  指定随机种子（想复现某一局就带上；不传则按时间随机）
 */
export function generateLevel(level: LevelConfig, seed?: number): Layout {
    const baseSeed = seed ?? ((Date.now() ^ (level.id * 2654435761)) >>> 0);
    const gangOn = level.gang;
    const trials = CFG.STACK.SOLVE_TRIALS;

    let best: { tiles: TileInst[]; rate: number } | null = null;
    let attempts = 0;

    for (let attempt = 0; attempt < CFG.STACK.MAX_RETRY; attempt++) {
        attempts = attempt + 1;
        const rng = makeRng((baseSeed + attempt * 7919) >>> 0);

        const grid = buildGrid(level);
        const bag = buildBag(level, rng);
        const cells = sampleCells(grid, bag.length, rng);
        const tiles = placeTiles(bag, cells, grid, rng, level);
        const graph = buildBlockGraph(tiles);

        // ① 开局可点牌太少 → 玩家一上来就没得选，直接重采样
        const taken: boolean[] = new Array(tiles.length).fill(false);
        if (pickableIds(tiles, graph, taken).length < CFG.STACK.MIN_PICKABLE) continue;

        // ② 可解性：跑若干局随机模拟
        let ok = 0;
        for (let t = 0; t < trials; t++) {
            const r = makeRng((baseSeed + attempt * 104729 + t * 15485863) >>> 0);
            if (simulate(tiles, graph, gangOn, r)) ok++;
        }
        const rate = ok / trials;

        if (ok > 0) {
            // 只要存在通关路径就采用。通过率一并回传，
            // S5 做难度标定时就用这个数（越接近 0 → 解路径越窄 → 越难）
            return { tiles, seed: baseSeed + attempt * 7919, attempts, solveRate: rate };
        }

        // 全部失败的极端情况：留一份作兜底（宁可给一局偏难的，也不白屏）
        if (!best) best = { tiles, rate };
    }

    console.warn(`[Generator] 第 ${level.id} 关 ${attempts} 次采样均未通过可解性校验，已采用兜底布局`);
    return {
        tiles: best!.tiles,
        seed: baseSeed,
        attempts,
        solveRate: best!.rate,
    };
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
     * ⚠️ 不能直接套用 CFG.STACK.MIN_PICKABLE(6)。那个 6 是为"满局开局"
     * 设计的（开局要有足够选择），而洗牌多半发生在残局：只剩 5~8 张牌时，
     * 要满足"6 张可点"几乎等于要求这些牌互不遮挡 —— 24 次随机尝试可能全部落空。
     * 正确口径是按剩余张数的比例给，后半段更是放宽到 1 ——
     * 因为"可解"这个条件本身就已经蕴含了"至少有一张可点"。
     */
    const minPick = Math.max(2, Math.min(CFG.STACK.MIN_PICKABLE, Math.ceil(ids.length / 3)));

    // 影子副本：在副本上试排，成功后才把坐标交出去。
    // 这样"算不出方案"时调用方的牌局**一个字节都没被动过**。
    const shadow: TileInst[] = tiles.map((t) => ({ ...t }));
    // 参与重排的牌在影子局里一律视为"还在场上"
    const shadowTaken: boolean[] = taken.map((v, i) => (ids.indexOf(i) >= 0 ? false : v));

    for (let attempt = 0; attempt < CFG.STACK.RESHUFFLE_RETRY; attempt++) {
        const rng = makeRng((baseSeed + attempt * 15485863) >>> 0);
        const grid = buildGrid(level);
        const cells = sampleCells(grid, ids.length, rng);
        if (cells.length < ids.length) continue;   // 格点不够（不该发生，防御）

        const pos = resolvePositions(cells, grid, rng, jitterYOf(level));
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
            // 深度只由行号决定，与被压住的旧值无关
            tile.depth = grid.rows - 1 - cells[k].r;
        }

        const graph = buildBlockGraph(shadow, shadowTaken);

        // ② 可点牌太少 → 换一版。后半段放宽到 1
        const need = attempt < CFG.STACK.RESHUFFLE_RETRY / 2 ? minPick : 1;
        if (pickableIds(shadow, graph, shadowTaken).length < need) continue;

        // ③ 带着玩家当前的槽位状态验证可解性
        let ok = 0;
        for (let t = 0; t < trials; t++) {
            const r = makeRng((baseSeed + attempt * 104729 + t * 15485863) >>> 0);
            if (simulate(shadow, graph, gangOn, r, { taken: shadowTaken, slots, slotCapacity })) ok++;
        }
        if (ok > 0) {
            return {
                moves: order.map((id, k) => ({
                    id,
                    x: pos[k].x, y: pos[k].y,
                    depth: shadow[id].depth, row: shadow[id].row, col: shadow[id].col,
                })),
                solveRate: ok / trials,
                attempts: attempt + 1,
            };
        }
    }
    return null;
}
