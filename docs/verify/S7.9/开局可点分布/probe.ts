/**
 * ============================================================
 *  probe.ts · 开局可点牌分布探针（S7.9 决策依据）
 * ============================================================
 *  只复现 Generator 的采样流程（不跑可解性模拟），因此可以跑很大的样本量。
 *  用途：量化「CFG.STACK.MIN_PICKABLE 的门槛设成几才合理」。
 *
 *  它不能直接在工程目录里跑，因为需要 Generator 暴露 4 个内部函数
 *  （buildGrid / sampleCells / buildBag / placeTiles）。
 *  复现步骤见同目录 README.md。
 *
 *  随机种子是**确定性**的（seed = (i+1) * 2654435761），
 *  所以任何人任何时间跑，结果都逐位一致 —— 这是结论可回溯的前提。
 *
 *  用法：node --experimental-transform-types probe.ts 400
 * ============================================================
 */
import { CFG } from './CFG.ts';
import {
    buildBag, buildBlockGraph, buildGrid, makeRng, pickableIds, placeTiles, sampleCells,
} from './Generator.ts';

const N = Number(process.argv[2] ?? '400');

console.log(`每关采样 ${N} 次（确定性种子，等价于玩家每次进关随机开局）`);
console.log(`当前 CFG.STACK.MIN_PICKABLE = ${CFG.STACK.MIN_PICKABLE}`);
console.log(`CFG.STACK.MAX_RETRY = ${CFG.STACK.MAX_RETRY}（"全不达标"一列就是它的幂）\n`);

for (const lid of [1, 2, 3, 4]) {
    const level = CFG.LEVELS.find((l) => l.id === lid)!;
    const hist = new Map<number, number>();
    let sum = 0;
    let min = 999;
    let max = 0;

    for (let i = 0; i < N; i++) {
        const rng = makeRng(((i + 1) * 2654435761) >>> 0);
        const grid = buildGrid(level);
        const bag = buildBag(level, rng);
        const cells = sampleCells(grid, bag.length, rng);
        const tiles = placeTiles(bag, cells, grid, rng, level);
        const graph = buildBlockGraph(tiles);
        const taken: boolean[] = new Array(tiles.length).fill(false);
        const p = pickableIds(tiles, graph, taken).length;
        hist.set(p, (hist.get(p) ?? 0) + 1);
        sum += p;
        if (p < min) min = p;
        if (p > max) max = p;
    }

    const ge = (t: number): string => {
        let c = 0;
        hist.forEach((v, k) => { if (k >= t) c += v; });
        return `${(c / N * 100).toFixed(1)}%`;
    };

    console.log(`L${lid} ${level.name}  tileCount=${level.tileCount} layers=${level.layers}`
        + ` patterns=${level.patterns} flat=${level.flat}`);
    console.log(`  平均可点 ${(sum / N).toFixed(2)} 张   最少 ${min}   最多 ${max}`);
    console.log(`  可点张数分布: ${[...hist.entries()].sort((a, b) => a[0] - b[0])
        .map(([k, v]) => `${k}张×${v}`).join('  ')}`);
    console.log(`  单次采样达标率  ≥6: ${ge(6)}   ≥5: ${ge(5)}   ≥4: ${ge(4)}   ≥3: ${ge(3)}`);
    console.log(`  → ${CFG.STACK.MAX_RETRY} 次全不达标的概率`
        + `  ≥6: ${Math.pow(1 - parseFloat(ge(6)) / 100, CFG.STACK.MAX_RETRY).toFixed(4)}`
        + `   ≥5: ${Math.pow(1 - parseFloat(ge(5)) / 100, CFG.STACK.MAX_RETRY).toFixed(4)}`
        + `   ≥4: ${Math.pow(1 - parseFloat(ge(4)) / 100, CFG.STACK.MAX_RETRY).toFixed(4)}`);
    console.log('');
}
