/**
 * S11 探针：单关 SVG 渲染（带牌堆区边框参照）
 * 用法：node --experimental-transform-types probe-shot.ts <关卡号> [seed]
 */
import { CFG } from './CFG.ts';
import type { LevelConfig } from './CFG.ts';
import { generateLevel, buildBlockGraph, pickableIds } from './Generator.ts';
import { mkdirSync, writeFileSync } from 'node:fs';

const LEVELS: LevelConfig[] = CFG.LEVELS as LevelConfig[];
const id = Number(process.argv[2] ?? 2);
const seedArg = process.argv[3] ? Number(process.argv[3]) : undefined;
// 可选：命令行覆盖层间错开（用于 A/B 观感对照）
const driftArg = process.argv[4] ? Number(process.argv[4]) : undefined;
const tag = process.argv[5] ?? '';
if (driftArg !== undefined) {
    (CFG.STACK.FLOOR as any).DRIFT = driftArg;
    (CFG.STACK.FLOOR as any).LAYER_DRIFT = driftArg * 1.6;
}
const lv = LEVELS.find((l) => l.id === id)!;

const outDir = '/tmp/s11-shots';
mkdirSync(outDir, { recursive: true });

const FAM_COLOR: Record<string, string> = {
    wan: '#c0392b', tiao: '#1e8449', tong: '#2471a3', honor: '#6c3483',
};
const FLOOR_ALPHA = ['#fdf6e3', '#f6ead2', '#efe0c1', '#e8d6b0', '#e0cc9e', '#d8c28c'];

const layout = generateLevel(lv, seedArg);
const graph = buildBlockGraph(layout.tiles);
const taken = new Array(layout.tiles.length).fill(false);
const picks = pickableIds(layout.tiles, graph, taken);

const S = CFG.STACK;
// 画布范围比牌堆区再多留一圈，便于看清边界
const PAD = 26;
const X0 = S.X_MIN - PAD;
const X1 = S.X_MAX + PAD;
const Y0 = S.Y_MIN - PAD - 150;   // 下方多留 150，画出暂存架的位置关系
const Y1 = S.Y_MAX + PAD;
const W = X1 - X0;
const H = Y1 - Y0;
const gx = (x: number) => x - X0;
const gy = (y: number) => Y1 - y;

const parts: string[] = [];
// 牌堆区边框
parts.push(`<rect x="${gx(S.X_MIN)}" y="${gy(S.Y_MAX)}" width="${S.X_MAX - S.X_MIN}"`
    + ` height="${S.Y_MAX - S.Y_MIN}" fill="#f7f4ec" stroke="#c9c2b4" stroke-dasharray="6 5"/>`);
// 暂存槽条位置（GAME_LAYOUT）
const L = CFG.GAME_LAYOUT as any;
parts.push(`<rect x="${gx(-(L.SLOT_BAR_W / 2))}" y="${gy(L.SLOT_BAR_Y + L.SLOT_BAR_H / 2)}"`
    + ` width="${L.SLOT_BAR_W}" height="${L.SLOT_BAR_H}" fill="#e6ded0" stroke="#b9b0a0"/>`);

const ordered = layout.tiles.slice().sort((a, b) => a.depth - b.depth);
for (const t of ordered) {
    const w = t.w;
    const h = t.h;
    const col = FAM_COLOR[t.key.split('-')[0]] ?? '#555';
    const isPick = picks.indexOf(t.id) >= 0;
    parts.push(
        `<g transform="translate(${gx(t.x).toFixed(1)},${gy(t.y).toFixed(1)}) rotate(${t.angle})">`
        + `<rect x="${(-w / 2).toFixed(1)}" y="${(-h / 2).toFixed(1)}" width="${w}" height="${h}"`
        + ` rx="9" fill="${FLOOR_ALPHA[t.floor % 6]}" stroke="${isPick ? '#e67e22' : col}"`
        + ` stroke-width="${isPick ? 4 : 2}"/>`
        + `<text x="0" y="6" font-size="${(w * 0.19).toFixed(0)}" text-anchor="middle"`
        + ` fill="${col}" font-family="monospace" font-weight="bold">${t.key.replace('-', '')}</text>`
        + `<text x="${(-w / 2 + 6).toFixed(0)}" y="${(h / 2 - 7).toFixed(0)}" font-size="12"`
        + ` fill="#7a7160" font-family="monospace">f${t.floor}</text>`
        + `</g>`,
    );
}

const title = `第 ${lv.id} 关 ${lv.name} | ${layout.tiles.length} 张 | `
    + `${Math.max(...layout.tiles.map((t) => t.floor)) + 1} 层 | `
    + `开局可点 ${picks.length}（橙框）| ${layout.certified ? '已认证可解' : '仅认证开局不卡'}`;
parts.push(`<text x="14" y="22" font-size="16" font-family="sans-serif" fill="#222">${title}</text>`);
parts.push(`<text x="14" y="${(H - 12)}" font-size="13" font-family="monospace" fill="#777">`
    + `牌堆区 x[${S.X_MIN},${S.X_MAX}] y[${S.Y_MIN},${S.Y_MAX}]</text>`);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"`
    + ` viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/>`
    + parts.join('') + `</svg>`;

writeFileSync(`${outDir}/L${id}${tag}.html`,
    `<!doctype html><meta charset="utf-8"><body style="margin:0">${svg}</body>`);
console.log(`L${id}: ${layout.tiles.length} 张 / ${Math.max(...layout.tiles.map((t) => t.floor)) + 1} 层`
    + ` / 开局可点 ${picks.length} / seed=${layout.seed} / ${layout.certified ? '认证可解' : '仅开局不卡'}`);
console.log(`尺寸 ${W.toFixed(0)}×${H.toFixed(0)}`);
