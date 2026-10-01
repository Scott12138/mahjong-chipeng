import { CFG } from './CFG.ts';
import { generateLevel, __stats } from './Generator.ts';

const N = Number(process.argv[2] ?? '150');
console.log(`每关采样 ${N} 次（每次用随机种子，模拟真实开局）\n`);
for (const lid of [1, 2, 3, 4]) {
    const level = CFG.LEVELS.find((l) => l.id === lid)!;
    const b = { ...__stats };
    let crash = 0, ok = 0, rateSum = 0;
    const hist = new Map<number, number>();
    for (let i = 0; i < N; i++) {
        const seed = (Math.random() * 4294967296) >>> 0;
        try {
            const L = generateLevel(level, seed);
            ok++; rateSum += L.solveRate;
            hist.set(L.attempts, (hist.get(L.attempts) ?? 0) + 1);
        } catch { crash++; }
    }
    const d = (k) => __stats[k] - b[k];
    console.log(`L${lid} ${level.name}  tileCount=${level.tileCount} layers=${level.layers} patterns=${level.patterns} gang=${level.gang}`);
    console.log(`   成功=${ok}/${N}   硬崩(best 为 null)=${crash}`);
    console.log(`   ①「开局可点牌 < ${CFG.STACK.MIN_PICKABLE}」被跳过次数=${d('failPickable')}   走到兜底次数=${d('fallback')}`);
    if (ok) console.log(`   成功局的平均可解通过率=${(rateSum / ok * 100).toFixed(1)}%   平均命中所需采样=${([...hist.entries()].reduce((a, [k, v]) => a + k * v, 0) / ok).toFixed(1)} 次`);
    console.log('   命中所需采样次数分布:', [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}次×${v}`).join('  ') || '(无)');
    console.log('');
}
