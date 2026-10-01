/**
 * S11 探针：多层随机堆叠（需求 #4）的定量 + 图形验收。
 *
 * 做三件事：
 *  ① 打印每关的几何（牌面尺寸、格点阵列）与分词统计（每层几张、层心在哪）
 *  ② 打印开局可点牌数、认证状态、生成耗时（跑 12 局看分布）
 *  ③ 把若干局布局画成 SVG（按真实深度序绘制，颜色按"层"区分），
 *     用于肉眼判断是否达到「多层随机堆叠」的观感
 *
 * 运行：
 *   node --experimental-transform-types /tmp/s10-probe/probe-floor.ts
 */
import { CFG } from './CFG.ts';
import type { LevelConfig } from './CFG.ts';
import {
    buildBag, buildGrid, generateLevel, pickableIds, buildBlockGraph, tileSizeOf,
} from './Generator.ts';
import type { Layout, TileInst } from './Generator.ts';

/** 关卡表（CFG 里是字面量数组，这里补上类型） */
const LEVELS: LevelConfig[] = CFG.LEVELS as LevelConfig[];

const outDir = '/tmp/s11-shots';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync(outDir, { recursive: true });

// ---------- 牌面颜色（按族上色，方便一眼看出分布是否均匀）----------
const FAM_COLOR: Record<string, string> = {
    wan: '#c0392b', tiao: '#1e8449', tong: '#2471a3', honor: '#6c3483',
};
function famOf(key: string): string {
    return key.split('-')[0];
}

// ---------- SVG 渲染 ----------
/** 设计坐标 → SVG 坐标（y 翻转、平移） */
function svgOf(files: { name: string; layout: Layout; note: string }[]): string {
    const S = CFG.STACK;
    const W = S.X_MAX - S.X_MIN + 40;
    const H = S.Y_MAX - S.Y_MIN + 40;
    const gx = (x: number) => x - S.X_MIN + 20;
    const gy = (y: number) => S.Y_MAX - y + 20;

    const parts: string[] = [];
    let px = 0;
    for (const f of files) {
        const tiles = f.layout.tiles;
        // 按深度升序绘制 = 后画的盖住先画的（与游戏一致）
        const ordered = tiles.slice().sort((a, b) => a.depth - b.depth);

        const body: string[] = [];
        for (const t of ordered) {
            const x = gx(t.x);
            const y = gy(t.y);
            const w = t.w;
            const h = t.h;
            const col = FAM_COLOR[famOf(t.key)] ?? '#555';
            body.push(
                `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)}) rotate(${t.angle})">`
                + `<rect x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="${w}" height="${h}"`
                + ` rx="8" fill="#fdf6e3" stroke="${col}" stroke-width="2.5"/>`
                + `<text x="0" y="4" font-size="${Math.max(9, w * 0.16).toFixed(0)}" text-anchor="middle"`
                + ` fill="${col}" font-family="monospace">${t.key.replace('-', '')}</text>`
                + `<text x="${(-w / 2 + 5).toFixed(0)}" y="${(h / 2 - 4).toFixed(0)}" font-size="10"`
                + ` fill="#8a7f70" font-family="monospace">f${t.floor}</text>`
                + `</g>`,
            );
        }
        parts.push(
            `<g transform="translate(${px},0)">`
            + `<rect x="0" y="0" width="${W}" height="${H}" fill="#efe9dd" stroke="#bbb"/>`
            + body.join('')
            + `<text x="12" y="24" font-size="17" fill="#222" font-family="sans-serif">`
            + `${f.name}</text>`
            + `<text x="12" y="44" font-size="13" fill="#555" font-family="sans-serif">`
            + `${f.note}</text>`
            + `</g>`,
        );
        px += W + 16;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${H}"`
        + ` viewBox="0 0 ${px} ${H}">${parts.join('')}</svg>`;
}

// ---------- 主流程 ----------
console.log('=== 几何 ===');
for (const lv of LEVELS) {
    const g = buildGrid(lv) as any;
    const t = tileSizeOf(lv);
    console.log(`L${lv.id} ${lv.name}: 牌 ${t.w.toFixed(1)}×${t.h.toFixed(1)}`
        + ` | 格点 ${g.cols}×${g.rows} = ${g.cols * g.rows}`
        + ` | 格距 ${g.cellW.toFixed(1)}×${g.cellH.toFixed(1)}`
        + ` | 张数 ${lv.tileCount}`
        + ` | 每格点平均 ${(lv.tileCount / (g.cols * g.rows)).toFixed(2)} 张`);
}

console.log('\n=== 每一局的层结构 + 开局可点（12 局）===');
const shots: { name: string; layout: Layout; note: string }[] = [];
for (const lv of LEVELS) {
    const floorHist = new Map<number, number>();
    let pickMin = 99; let pickMax = 0; let msSum = 0; let cert = 0;
    let sample: Layout | null = null;
    const N = 12;
    for (let i = 0; i < N; i++) {
        const t0 = Date.now();
        const layout = generateLevel(lv);
        msSum += Date.now() - t0;
        const graph = buildBlockGraph(layout.tiles);
        const taken = new Array(layout.tiles.length).fill(false);
        const pick = pickableIds(layout.tiles, graph, taken).length;
        pickMin = Math.min(pickMin, pick); pickMax = Math.max(pickMax, pick);
        if (layout.certified) cert++;
        const cnt = new Map<number, number>();
        for (const t of layout.tiles) cnt.set(t.floor, (cnt.get(t.floor) ?? 0) + 1);
        for (const [f, c] of cnt) floorHist.set(f, (floorHist.get(f) ?? 0) + c / N);
        if (i === 0) sample = layout;
    }
    const fl = [...floorHist.entries()].sort((a, b) => a[0] - b[0])
        .map(([f, c]) => `第${f}层 ${c.toFixed(1)}张`).join(' / ');
    console.log(`L${lv.id} ${lv.name}: ${fl}`);
    console.log(`     开局可点 ${pickMin}~${pickMax} | 认证可解 ${cert}/${N}`
        + ` | 平均生成 ${(msSum / N).toFixed(0)}ms`);
    if (sample) {
        shots.push({
            name: `L${lv.id} ${lv.name}（${lv.tileCount} 张）`,
            layout: sample,
            note: `开局可点 ${pickMin}~${pickMax}`,
        });
    }
}

writeFileSync(`${outDir}/floors.html`,
    `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#fff">`
    + svgOf(shots) + `</body>`);
console.log(`\nSVG 已写出：${outDir}/floors.html`);
