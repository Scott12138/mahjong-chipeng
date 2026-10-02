/**
 * ============================================================
 *  S15 探针 · 牌面任意角度的定量验收
 * ============================================================
 *  【它回答四个问题】
 *  ① 角度分布长什么样？                        → 档位直方图
 *  ② 歪着的牌会不会捅出牌堆区？                 → 视觉框越界量（必须为 0）
 *  ③ 遮挡判定换成 OBB 之后，玩法有没有退化？     → 开局可点 / 认证可解 / 遮挡边数
 *  ④ "同行相邻不互相压"这条硬约束破到什么程度？   → 同行相交对数
 *
 *  ------------------------------------------------------------
 *  【为什么要跑"多套档位"而不是只量当前配置】
 *  用户要的是"各种角度"，但**角度是要拿玩法去换的**：
 *    · 45° 的牌占位是正立的 1.65 倍，横向还会压到同行的邻居；
 *    · 越乱 → 遮挡越多 → 开局可点越少 → 越像死局。
 *  所以这里把三套档位放在**同一批 seed** 上跑，直接比出"多要一点乱"的代价。
 *  没有这组对照，"权重调猛了"这件事只会在玩家手上暴露。
 *
 *  ⚠️ `rollAngleParts` 里刻意让随机数的**消耗次数与档位无关**（符号永远抽一次），
 *     否则 A/B 两批牌局从第一张起就不同，对比里混着"换了布局"的噪声。
 *
 *  【运行】
 *    bash docs/verify/S15/probe/sync.sh
 *    cp docs/verify/S15/probe/probe-s15.ts /tmp/s10-probe/
 *    cd /tmp/s10-probe && node --experimental-transform-types --no-warnings probe-s15.ts
 * ============================================================
 */
import { CFG, rotatedVisualBox } from './CFG.ts';
import type { LevelConfig } from './CFG.ts';
import {
    buildBlockGraph, buildGrid, generateLevel, obbOverlap, pickableIds,
} from './Generator.ts';

const LEVELS: LevelConfig[] = CFG.LEVELS as LevelConfig[];
const TRIALS = 12;

// ============================================================
//  要对比的四套朝向档位
// ============================================================

interface Policy { name: string; base: number[]; skew: Array<[number, number]> }

const POLICIES: Policy[] = [
    { name: 'P0 纯正立', base: [0], skew: [[0, 1]] },
    { name: 'P1 四向(旧)', base: [0, 90, 180, 270], skew: [[0, 1]] },
    {
        name: 'P2 当前档',
        base: [0, 90, 180, 270],
        skew: [[0, 55], [5, 12], [10, 9], [16, 7], [24, 6], [33, 6], [45, 5]],
    },
    {
        name: 'P3 收敛档',
        base: [0, 90, 180, 270],
        skew: [[0, 66], [5, 12], [10, 9], [16, 7], [24, 4], [33, 2]],
    },
];

function setPolicy(p: Policy): void {
    const R = CFG.STACK.ROTATION as { BASE: number[]; SKEW: Array<[number, number]> };
    R.BASE = p.base;
    R.SKEW = p.skew;
}

// ============================================================
//  单次测量
// ============================================================

/** 角度去掉整圈之后剩下的偏斜绝对值（0~45） */
function skewAbs(deg: number): number {
    const base = Math.round(deg / 90) * 90;
    return Math.abs(deg - base);
}

const SKEW_BUCKETS: Array<[string, (v: number) => boolean]> = [
    ['0°', (v) => v < 0.5],
    ['1~8°', (v) => v >= 0.5 && v <= 8],
    ['9~20°', (v) => v > 8 && v <= 20],
    ['21~35°', (v) => v > 20 && v <= 35],
    ['36~45°', (v) => v > 35],
];

interface Row {
    pickMin: number; pickMax: number; pickSum: number;
    certified: number; rateSum: number; attemptSum: number;
    edges: number; cross: number;
    outTiles: number; outMax: number;
    buckets: number[];
    total: number;
}

function measure(level: LevelConfig, seed: number, acc: Row): void {
    const layout = generateLevel(level, seed);
    const tiles = layout.tiles;

    const graph = buildBlockGraph(tiles);
    const taken: boolean[] = new Array(tiles.length).fill(false);
    const pick = pickableIds(tiles, graph, taken).length;

    acc.pickSum += pick;
    if (pick < acc.pickMin) acc.pickMin = pick;
    if (pick > acc.pickMax) acc.pickMax = pick;
    if (layout.certified) acc.certified++;
    acc.rateSum += layout.solveRate;
    acc.attemptSum += layout.attempts;

    let edges = 0;
    for (const a of graph.above) edges += a.length;
    acc.edges += edges;

    for (let i = 0; i < tiles.length; i++) {
        const t = tiles[i];
        acc.total++;

        // ---- 角度分布 ----
        const v = skewAbs(t.angle);
        for (let b = 0; b < SKEW_BUCKETS.length; b++) {
            if (SKEW_BUCKETS[b][1](v)) { acc.buckets[b]++; break; }
        }

        // ---- 视觉框（含立体侧壁与投影）是否捅出牌堆区 ----
        const vb = rotatedVisualBox(t.w, t.h, t.angle);
        const l = t.x + vb.dx - vb.hw;
        const r = t.x + vb.dx + vb.hw;
        const btm = t.y + vb.dy - vb.hh;
        const tp = t.y + vb.dy + vb.hh;
        const over = Math.max(
            CFG.STACK.X_MIN - l, r - CFG.STACK.X_MAX,
            CFG.STACK.Y_MIN - btm, tp - CFG.STACK.Y_MAX,
        );
        if (over > 0.5) acc.outTiles++;
        if (over > acc.outMax) acc.outMax = over;

        // ---- 同行相邻牌是否相交（"同行不互相压"这条硬约束的破口） ----
        for (let j = i + 1; j < tiles.length; j++) {
            const o = tiles[j];
            if (o.floor !== t.floor || o.row !== t.row) continue;
            if (obbOverlap(t, o)) acc.cross++;
        }
    }
}

// ============================================================
//  跑
// ============================================================

console.log('S15 探针 · 牌面任意角度');
console.log(`每个「关卡 × 档位」跑 ${TRIALS} 局；牌堆区 x∈[${CFG.STACK.X_MIN}, ${CFG.STACK.X_MAX}]`
    + ` y∈[${CFG.STACK.Y_MIN}, ${CFG.STACK.Y_MAX}]`);

// ---- 网格容量（只由关卡决定，与档位无关）----
console.log('\n=== ① 网格容量（按正立牌算，与朝向档位无关）===');
console.log('关卡         牌宽    格宽    格高    列×行   格点');
for (const lv of LEVELS) {
    const g = buildGrid(lv) as { cols: number; rows: number; cellW: number; cellH: number; tileW: number };
    console.log(
        `${lv.name.padEnd(10)} ${g.tileW.toFixed(1).padStart(6)} ${g.cellW.toFixed(1).padStart(7)} `
        + `${g.cellH.toFixed(1).padStart(7)}  ${String(g.cols).padStart(2)}×${String(g.rows).padStart(2)}  `
        + `${String(g.cols * g.rows).padStart(5)}`,
    );
}

// ---- 各档位对比 ----
for (const p of POLICIES) {
    setPolicy(p);
    console.log(`\n=== ② 档位：${p.name} ===`);
    console.log('关卡        开局可点(均/最小~最大)  认证可解  可解率  重采样  遮挡边数  同行相交  越界张  最大越界  偏斜分布 0/1-8/9-20/21-35/36-45');

    for (const lv of LEVELS) {
        const acc: Row = {
            pickMin: Infinity, pickMax: -Infinity, pickSum: 0,
            certified: 0, rateSum: 0, attemptSum: 0,
            edges: 0, cross: 0, outTiles: 0, outMax: 0,
            buckets: [0, 0, 0, 0, 0], total: 0,
        };
        for (let i = 0; i < TRIALS; i++) {
            measure(lv, (0x5157515 + lv.id * 100003 + i * 7919) >>> 0, acc);
        }
        const pct = acc.buckets.map((v) => Math.round((v / acc.total) * 100));
        console.log(
            `${lv.name.padEnd(10)} ${(acc.pickSum / TRIALS).toFixed(1).padStart(6)}`
            + ` (${String(acc.pickMin).padStart(2)}~${String(acc.pickMax).padStart(2)})`.padEnd(9)
            + `  ${String(acc.certified).padStart(3)}/${TRIALS}`.padEnd(10)
            + ` ${((acc.rateSum / TRIALS) * 100).toFixed(0).padStart(5)}%`
            + ` ${(acc.attemptSum / TRIALS).toFixed(1).padStart(7)}`
            + ` ${(acc.edges / TRIALS).toFixed(0).padStart(9)}`
            + ` ${(acc.cross / TRIALS).toFixed(0).padStart(9)}`
            + ` ${String(acc.outTiles).padStart(7)}`
            + ` ${acc.outMax.toFixed(1).padStart(9)}`
            + `   ${pct.map((v) => String(v).padStart(2)).join('/')}`,
        );
    }
}

setPolicy(POLICIES[2]);   // 还原成 CFG 里的当前配置
console.log('\n（完）已把 CFG 还原成 P2 当前档');
