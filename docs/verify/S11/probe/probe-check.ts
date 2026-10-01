/**
 * S11 探针：越界校验 + 聚集度(TIGHT)对照
 */
import { CFG } from './CFG.ts';
import type { LevelConfig } from './CFG.ts';
import { generateLevel, buildBlockGraph, pickableIds } from './Generator.ts';

const LEVELS: LevelConfig[] = CFG.LEVELS as LevelConfig[];
const S = CFG.STACK;

function bounds(layout: ReturnType<typeof generateLevel>) {
    let out = 0;
    let worstX = 0;
    let worstY = 0;
    for (const t of layout.tiles) {
        const rot = t.angle === 90 || t.angle === 270;
        const hw = rot ? t.h / 2 : t.w / 2;
        const hh = rot ? t.w / 2 : t.h / 2;
        const dx = Math.max(S.X_MIN - (t.x - hw), (t.x + hw) - S.X_MAX);
        const dy = Math.max(S.Y_MIN - (t.y - hh), (t.y + hh) - S.Y_MAX);
        if (dx > 0.5 || dy > 0.5) out++;
        worstX = Math.max(worstX, dx);
        worstY = Math.max(worstY, dy);
    }
    return { out, worstX, worstY };
}

console.log('=== 越界校验（各单位 px，>0 即出区）===');
for (const lv of LEVELS) {
    let bad = 0;
    let wx = 0;
    let wy = 0;
    const N = 20;
    for (let i = 0; i < N; i++) {
        const r = bounds(generateLevel(lv));
        bad += r.out;
        wx = Math.max(wx, r.worstX);
        wy = Math.max(wy, r.worstY);
    }
    console.log(`L${lv.id}: ${N} 局里越界牌 ${bad} 张 | 最大越界 x=${wx.toFixed(1)} y=${wy.toFixed(1)}`);
}

console.log('\n=== 聚集度 TIGHT 对照（每档 16 局）===');
const origTight = CFG.STACK.FLOOR.TIGHT;
for (const tight of [0.6, 0.7, 0.75, 0.85, 0.95]) {
    (CFG.STACK.FLOOR as any).TIGHT = tight;
    const line: string[] = [];
    for (const lv of LEVELS) {
        if (lv.flat) { line.push(`L${lv.id}: -`); continue; }
        let lo = 99;
        let hi = 0;
        let cert = 0;
        for (let i = 0; i < 16; i++) {
            const layout = generateLevel(lv);
            const p = pickableIds(layout.tiles, buildBlockGraph(layout.tiles),
                new Array(layout.tiles.length).fill(false)).length;
            lo = Math.min(lo, p); hi = Math.max(hi, p);
            if (layout.certified) cert++;
        }
        line.push(`L${lv.id}: 可点 ${lo}~${hi} 认证 ${cert}/16`);
    }
    console.log(`TIGHT=${tight}  ${line.join(' | ')}`);
}
(CFG.STACK.FLOOR as any).TIGHT = origTight;

console.log('\n=== DRIFT / LAYER_DRIFT 对照（L4，仅看可点与认证）===');
for (const d of [0.0, 0.10, 0.20, 0.30]) {
    (CFG.STACK.FLOOR as any).DRIFT = d;
    (CFG.STACK.FLOOR as any).LAYER_DRIFT = d * 1.6;
    let lo = 99; let hi = 0; let cert = 0;
    for (let i = 0; i < 16; i++) {
        const lv = LEVELS[3];
        const layout = generateLevel(lv);
        const p = pickableIds(layout.tiles, buildBlockGraph(layout.tiles),
            new Array(layout.tiles.length).fill(false)).length;
        lo = Math.min(lo, p); hi = Math.max(hi, p);
        if (layout.certified) cert++;
    }
    console.log(`DRIFT=${d.toFixed(2)} LAYER_DRIFT=${(d * 1.6).toFixed(2)}`
        + ` → L4 可点 ${lo}~${hi} 认证 ${cert}/16`);
}
