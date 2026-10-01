/** 层间错开的两档对照（40 局/档，取更可信的样本） */
import { CFG } from './CFG.ts';
import type { LevelConfig } from './CFG.ts';
import { generateLevel, buildBlockGraph, pickableIds } from './Generator.ts';

const LEVELS: LevelConfig[] = CFG.LEVELS as LevelConfig[];
const N = 40;
const pairs: Array<[number, number]> = [[0.1, 0.16], [0.3, 0.48]];

for (const pair of pairs) {
    const d = pair[0];
    const ld = pair[1];
    (CFG.STACK.FLOOR as any).DRIFT = d;
    (CFG.STACK.FLOOR as any).LAYER_DRIFT = ld;
    const outs: string[] = [];
    for (const lv of [LEVELS[1], LEVELS[2], LEVELS[3]]) {
        let lo = 99;
        let hi = 0;
        let cert = 0;
        let ms = 0;
        const hist = new Map<number, number>();
        for (let i = 0; i < N; i++) {
            const t0 = Date.now();
            const layout = generateLevel(lv);
            ms += Date.now() - t0;
            const p = pickableIds(layout.tiles, buildBlockGraph(layout.tiles),
                new Array(layout.tiles.length).fill(false)).length;
            lo = Math.min(lo, p);
            hi = Math.max(hi, p);
            hist.set(p, (hist.get(p) ?? 0) + 1);
            if (layout.certified) cert++;
        }
        const h = [...hist.entries()].sort((a, b) => a[0] - b[0])
            .map((e) => `${e[0]}张x${e[1]}`).join(' ');
        outs.push(`L${lv.id} 可点 ${lo}~${hi} [${h}] 认证 ${cert}/${N} 生成 ${(ms / N).toFixed(0)}ms`);
    }
    console.log(`DRIFT=${d} LAYER_DRIFT=${ld}`);
    for (const o of outs) console.log(`   ${o}`);
}
