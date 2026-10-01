/**
 * ============================================================
 *  S14 探针 · 立体牌堆（真分层）的定量验收
 * ============================================================
 *  【它回答三个问题】
 *  ① 层高到底是不是「牌厚 × GAP_MUL」？             → 差分回归
 *  ② 牌堆长高后，纵向还装得下吗？                    → 溢出量实测
 *  ③ 玩法有没有被搞坏（开局可点 / 认证可解）？        → 12 局统计
 *
 *  ------------------------------------------------------------
 *  【① 为什么要用"差分回归"，而不是直接量层间距】
 *  第一版探针量的是「各层 y 均值之差」。那个数**永远是错的**，因为它把
 *  层内的两个混淆项一起量进去了：
 *    y = yOf(row) + 抖动 + (层号 − 中位层) × 层高 + 同格叠号 × LAYER_OFFSET
 *                          ↑ 我要量的          ↑ 行不同就不同   ↑ 叠号不同就不同
 *  每一层的「行分布」和「叠号分布」都不一样，所以"均值之差"混着行距与叠距，
 *  实测出来 31.9 / 18.7 / 21.1 对理论 21.7 —— 有高有低，看着像改造没生效。
 *
 *  正确做法是**对消**：
 *    同一 seed、同一份 cells，只把 GAP_MUL 从 0 改成 m，跑两次。
 *    两边的 row / 抖动 / 叠号 / 逐行错位**逐位相同**，于是
 *      y(m) − y(0) = (层号 − 中位层) × 牌厚 × m + 常数(两次整体平移之差)
 *    行、抖动、叠号**全部相消**，只剩纯层高项。
 *    把它对「层号」做最小二乘，斜率就是**有效层高**（平移被截距吸收）。
 *  斜率是精确值而不是统计量 → 可以直接和 depthPx × m 比大小。
 *
 *  ------------------------------------------------------------
 *  【② 为什么溢出量是关键】
 *  S14.1 画出真实厚度后（L2+ 牌厚 21.7px），层高从旧的 13.7px 涨到 21.7px。
 *  L4 有 6 层 → 层跨 5 × 21.7 = 108px，而牌堆区的纵向预算里
 *  7 行 × 68.4px = 479px 已经被行距吃掉，加上 ±14 抖动，
 *  牌堆的**自然总高超过可用高度**，只能靠 translate 塞进去 ——
 *  塞不下的部分就会探出牌堆区（下边是暂存架、上边是提示语）。
 *  这是"编译运行都不报错、只是牌压在暂存架上"的那类问题，只能量。
 *
 *  【运行】
 *    bash docs/verify/S14/probe/sync.sh
 *    cp docs/verify/S14/probe/probe-solid.ts /tmp/s10-probe/
 *    cd /tmp/s10-probe && node --experimental-transform-types --no-warnings probe-solid.ts
 * ============================================================
 */
import { CFG, SOLID_OVERHANG } from './CFG.ts';
import type { LevelConfig } from './CFG.ts';
import {
    buildBlockGraph, buildGrid, generateLevel, makeRng, pickableIds,
    resolvePositions, tileSizeOf,
} from './Generator.ts';
import type { CellPick, Layout, TileInst } from './Generator.ts';

const LEVELS: LevelConfig[] = CFG.LEVELS as LevelConfig[];
const TRIALS = 12;

/** 要对比的 mul。0 = 关掉层高（差分基准）；0.63 ≈ 旧的"格高 × 0.20"；1.00 = 几何真值 */
const MUL_BASE = 0;
const MULS = [0.63, 1.0];

/** 改 GAP_MUL（CFG 是 as const，字段推断成字面量类型，得绕一下） */
function setMul(mul: number): void {
    (CFG.STACK.FLOOR as { GAP_MUL: number }).GAP_MUL = mul;
}

/**
 * 本关相关几何。**必须与 Generator.resolvePositions 内部逐项一致** ——
 * 探针一旦自己另算一套口径，就会报出不存在的溢出（或漏报真的溢出）。
 * 曾经就踩过：探针拿"含牌边的跨度"去比"牌中心的范围"，凭空多算一个牌高。
 */
function geomOf(level: LevelConfig) {
    const T = tileSizeOf(level);
    const S = CFG.STACK;
    const scale = T.w / 132;
    const depthPx = CFG.TILE.SOLID.DEPTH * scale;
    const halfMax = Math.max(T.w, T.h) / 2;
    const cellH = T.h * (level.flat ? S.CELL_H_RATIO_FLAT : S.CELL_H_RATIO_STACK);
    const overDown = SOLID_OVERHANG.DOWN * scale;
    const overUp = SOLID_OVERHANG.UP * scale;
    return {
        T, depthPx, halfMax, cellH, overDown, overUp,
        /** 牌中心的允许范围（与 Generator 的 limB/limT 同一把尺子） */
        limB: S.Y_MIN + halfMax + overDown,
        limT: S.Y_MAX - halfMax - overUp,
        avail: (S.Y_MAX - halfMax - overUp) - (S.Y_MIN + halfMax + overDown),
        /** 牌堆区的绝对上下界（牌的**视觉**边允许到达的位置，含立体装饰） */
        zoneB: S.Y_MIN,
        zoneT: S.Y_MAX,
    };
}

/** 生成一局的"结构指纹"，用来确认差分两边的布局逐位相同 */
function fingerprint(tiles: TileInst[]): string {
    return tiles.map((t) => `${t.floor}|${t.row}|${t.col}|${t.key}`).join(',');
}

/**
 * ★ 差分回归：同一份格子跑 mul=0 与 mul=m，把 y 之差对层号做最小二乘。
 * 斜率 = 有效层高（精确，非统计量）。
 *
 * 【为什么直接调 resolvePositions，而不是跑两条 generateLevel】
 * 第一版就是跑 generateLevel（同 seed、只改 mul）。看起来更"端到端"，其实**不成立**：
 * generateLevel 内部有"采样 → 认证 → 不合格就重采样"的循环，而认证看的是
 * 遮挡图（buildBlockGraph 用得到 x/y），y 一变，认证结果就可能变 →
 * **重采样次数不同** → 两次跑出来的根本不是同一局，差分毫无意义。
 * 表现是"指纹一致"那一列大面积 ❌，局数掉到 0，看起来像"层高没生效"。
 * 改成直接喂同一份 cells 给 resolvePositions：重采样这一层被绕开，
 * 输入逐位相同，只有 floorGapY 在变 → 差分是干净的。
 *
 * 抖动临时置 0：不然 jy 会给斜率加上随机噪声（虽然统计上无偏，
 * 但这里能做成精确值就没必要留噪声）。用完还原。
 */
function layerStep(level: LevelConfig, seed: number, mul: number): {
    ok: boolean; slope: number; expect: number; n: number;
} {
    const g = geomOf(level);
    const S = CFG.STACK as { JITTER_X: number; JITTER_Y: number; JITTER_FLAT: number };
    const jx = S.JITTER_X; const jy = S.JITTER_Y; const jf = S.JITTER_FLAT;
    S.JITTER_X = 0; S.JITTER_Y = 0; S.JITTER_FLAT = 0;

    const grid = buildGrid(level);
    const r = Math.min(3, grid.rows - 1);
    const c = Math.min(2, grid.cols - 1);
    const n = 6;
    const cells: CellPick[] = [];
    for (let f = 0; f < n; f++) cells.push({ r, c, floor: f, layer: 0 });

    setMul(MUL_BASE);
    const p0 = resolvePositions(cells, grid, makeRng(seed), level);
    setMul(mul);
    const p1 = resolvePositions(cells, grid, makeRng(seed), level);
    setMul(1.0);
    S.JITTER_X = jx; S.JITTER_Y = jy; S.JITTER_FLAT = jf;

    let sf = 0; let sd = 0;
    for (let i = 0; i < n; i++) { sf += cells[i].floor; sd += p1[i].y - p0[i].y; }
    const mf = sf / n; const md = sd / n;
    let num = 0; let den = 0;
    for (let i = 0; i < n; i++) {
        const df = cells[i].floor - mf;
        num += df * ((p1[i].y - p0[i].y) - md);
        den += df * df;
    }
    // 只有一层（L1 平铺关）时 den = 0，斜率无定义
    return {
        ok: den > 0,
        slope: den > 0 ? num / den : NaN,
        expect: g.depthPx * mul,
        n,
    };
}

/** 单关 12 局的实测统计（mul = 1.0，即当前生效的口径） */
function realRuns(level: LevelConfig, mul: number): {
    floors: number[]; pickMin: number; pickMax: number; certified: number;
    outCenter: number; badRuns: number; span: number; avail: number;
    low: number; high: number; overLow: number; overHigh: number;
} {
    setMul(mul);
    const g = geomOf(level);
    let pickMin = Infinity; let pickMax = -Infinity;
    let certified = 0; let outCenter = 0; let badRuns = 0;
    let spanSum = 0; let lowSum = 0; let highSum = 0;
    let floorStr = '';
    for (let i = 0; i < TRIALS; i++) {
        const layout: Layout = generateLevel(level, 1000 + i * 7);
        const tiles = layout.tiles;
        const graph = buildBlockGraph(tiles);
        const taken = tiles.map(() => false);
        const pick = pickableIds(tiles, graph, taken);
        pickMin = Math.min(pickMin, pick.length);
        pickMax = Math.max(pickMax, pick.length);
        if (layout.certified) certified++;

        // 牌的**视觉**上下沿：牌心 ± 半边长，再让出立体装饰（侧壁 / 投影）。
        // 这才是"玩家眼里牌的边界"，也是 Y_MIN / Y_MAX 该管的范围。
        let vLow = Infinity; let vHigh = -Infinity;
        for (const t of tiles) {
            const b = t.y - g.halfMax - g.overDown;
            const tp = t.y + g.halfMax + g.overUp;
            if (b < vLow) vLow = b;
            if (tp > vHigh) vHigh = tp;
            if (t.y < g.limB - 0.01 || t.y > g.limT + 0.01) outCenter++;
        }
        spanSum += vHigh - vLow;
        if (vLow < g.zoneB - 0.5 || vHigh > g.zoneT + 0.5) badRuns++;
        lowSum += vLow;
        highSum += vHigh;
        if (i === 0) {
            const byFloor = new Map<number, number>();
            for (const t of tiles) byFloor.set(t.floor, (byFloor.get(t.floor) ?? 0) + 1);
            floorStr = [...byFloor.entries()].sort((a, b) => a[0] - b[0])
                .map(([, v]) => v).join(':');
        }
    }
    setMul(1.0);
    return {
        floors: floorStr.split(':').map(Number),
        pickMin, pickMax, certified, outCenter, badRuns,
        span: spanSum / TRIALS, avail: g.avail,
        low: lowSum / TRIALS, high: highSum / TRIALS,
        overLow: Math.max(0, g.zoneB - lowSum / TRIALS),
        overHigh: Math.max(0, highSum / TRIALS - g.zoneT),
    };
}

// ============================================================
console.log('=== 几何 ===');
console.log('关卡        牌宽×牌高       牌厚px   格高   可落范围 y        可用高');
for (const lv of LEVELS) {
    const g = geomOf(lv);
    console.log(
        `${lv.name.padEnd(10)}  ${g.T.w.toFixed(1)}×${g.T.h.toFixed(1)}`.padEnd(30)
        + `${g.depthPx.toFixed(1).padStart(6)}`.padEnd(9)
        + `${g.cellH.toFixed(1).padStart(6)}`.padEnd(7)
        + `[${g.limB.toFixed(0)}, ${g.limT.toFixed(0)}]`.padEnd(18)
        + `${g.avail.toFixed(0)}`,
    );
}

console.log('\n=== ① 有效层高（差分回归 · 精确值）===');
console.log('关卡        mul    实测层高   理论层高   偏差      可测种子数');
const SEEDS = [1000, 1007, 1014];
for (const mul of MULS) {
    for (const lv of LEVELS) {
        let sum = 0; let exp = 0; let n = 0; let ok = true;
        for (const s of SEEDS) {
            const r = layerStep(lv, s, mul);
            if (!r.ok) { ok = false; continue; }
            sum += r.slope; exp += r.expect; n++;
        }
        const got = n ? sum / n : NaN;
        const want = n ? exp / n : NaN;
        const dev = n ? (got - want) : NaN;
        console.log(
            `${lv.name.padEnd(10)}  ${mul.toFixed(2)}   `
            + `${got.toFixed(2).padStart(8)}   ${want.toFixed(2).padStart(8)}   `
            + `${dev.toFixed(2).padStart(6)}   ${String(n).padStart(4)}/${SEEDS.length}   `
            + (ok ? '✅' : '— 单层关，层高无定义'),
        );
    }
}

{
    const S = CFG.STACK;
    console.log('\n=== ② 纵向溢出实测（mul = 1.0，12 局均值）===');
    console.log(`牌堆区 牌**视觉**边允许 y ∈ [${S.Y_MIN}, ${S.Y_MAX}]`
        + `（高 ${S.Y_MAX - S.Y_MIN}）；暂存架中心 y = ${CFG.GAME_LAYOUT.TEMP_RACK_Y}`);
    console.log('关卡        层结构                   视觉跨度  可用  下溢  上溢  越界局数  最低视觉边  最高视觉边');
    for (const lv of LEVELS) {
        const r = realRuns(lv, 1.0);
        console.log(
            `${lv.name.padEnd(10)}  ${r.floors.join(':').padEnd(24)}  `
            + `${r.span.toFixed(0).padStart(7)}  ${r.avail.toFixed(0).padStart(5)}  `
            + `${r.overLow.toFixed(1).padStart(5)}  ${r.overHigh.toFixed(1).padStart(5)}  `
            + `${String(r.badRuns).padStart(5)}/${TRIALS}   `
            + `${r.low.toFixed(0).padStart(9)}  ${r.high.toFixed(0).padStart(9)}`,
        );
    }
}

console.log('\n=== ③ 玩法指标（12 局）===');
console.log('关卡        mul    开局可点   认证可解');
for (const mul of MULS) {
    for (const lv of LEVELS) {
        const r = realRuns(lv, mul);
        console.log(
            `${lv.name.padEnd(10)}  ${mul.toFixed(2)}   `
            + `${String(r.pickMin).padStart(3)}~${String(r.pickMax).padEnd(3)}   `
            + `${String(r.certified).padStart(2)}/${TRIALS}`,
        );
    }
}

setMul(1.0);
