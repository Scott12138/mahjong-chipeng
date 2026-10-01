/**
 * 无头验证：generateLevel 在「门槛 5 + 兜底补校验」之后的行为。
 * 纯 Node 跑（--experimental-transform-types），不需要 Cocos。
 *
 *   用法：node --experimental-transform-types verify-gen.ts [每关轮数]
 */
import { CFG } from './CFG.ts';
import { generateLevel } from './Generator.ts';

const ROUNDS = Number(process.argv[2] ?? 100);

console.log(`MIN_PICKABLE = ${CFG.STACK.MIN_PICKABLE}, MAX_RETRY = ${CFG.STACK.MAX_RETRY},`
    + ` SOLVE_TRIALS = ${CFG.STACK.SOLVE_TRIALS}, 每关轮数 = ${ROUNDS}`);
console.log('');

for (const lv of CFG.LEVELS) {
    let fallback = 0;
    let zeroRate = 0;
    let sumAttempts = 0;
    let sumRate = 0;
    let minRate = 1;
    let maxAttempts = 0;
    const hist: Record<number, number> = {};

    for (let i = 0; i < ROUNDS; i++) {
        const layout = generateLevel(lv, (1000 + i * 7919) >>> 0);
        sumAttempts += layout.attempts;
        sumRate += layout.solveRate;
        if (layout.solveRate < minRate) minRate = layout.solveRate;
        if (layout.attempts > maxAttempts) maxAttempts = layout.attempts;
        if (layout.attempts >= CFG.STACK.MAX_RETRY) fallback++;
        if (layout.solveRate <= 0) zeroRate++;
        hist[layout.attempts] = (hist[layout.attempts] ?? 0) + 1;
    }

    console.log(`L${lv.id} ${lv.name}（${lv.tileCount} 张）`);
    console.log(`   平均采样 ${(sumAttempts / ROUNDS).toFixed(2)} 次，最多 ${maxAttempts} 次`);
    console.log(`   兜底局 ${fallback}/${ROUNDS}（${(fallback / ROUNDS * 100).toFixed(1)}%）`);
    console.log(`   平均可解率 ${(sumRate / ROUNDS * 100).toFixed(1)}%，最低 ${(minRate * 100).toFixed(0)}%`);
    console.log(`   ★ 可解率 = 0 的局（真死局）${zeroRate}/${ROUNDS}`);
    const line = Object.keys(hist).map(Number).sort((a, b) => a - b)
        .map((k) => `${k}次×${hist[k]}`).join('  ');
    console.log(`   采样次数分布: ${line}`);
    console.log('');
}
