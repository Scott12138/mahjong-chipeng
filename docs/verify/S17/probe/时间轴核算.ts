// S17 方案 B：核算各关的束数与入场时间轴
// ⚠️ 本文件里的分束算法与 GamePage.playSproutMotion 逐行同构（那里 import cc，Node 跑不了）
import { CFG } from './CFG.ts';
import { generateLevel } from './Generator.ts';

const LV = CFG.LEVELS as any[];
const M = CFG.MOTION as any;

console.log('参数：BURST_SIZE=' + M.SPROUT_BURST_SIZE + ' MIN=' + M.SPROUT_BURST_MIN
  + ' MAX=' + M.SPROUT_BURST_MAX + ' GAP=' + M.SPROUT_BURST_GAP
  + ' JITTER=' + M.SPROUT_BURST_JITTER + ' RING=' + M.SPROUT_BURST_RING
  + ' TOTAL_MAX=' + M.SPROUT_TOTAL_MAX);
console.log('      IN=' + M.SPROUT_IN + ' SQUASH=' + M.SPROUT_SQUASH
  + ' SCALE_FROM=' + M.SPROUT_SCALE_FROM + ' BOUNCE=' + M.SPROUT_BOUNCE
  + ' FROM_RATIO=' + M.SPROUT_FROM_RATIO);
console.log('');

for (let i = 0; i < LV.length; i++) {
  const layout = generateLevel(LV[i], 1000 + i);
  const tiles = layout.tiles as any[];
  const n = tiles.length;

  const bursts = Math.max(1, Math.min(M.SPROUT_BURST_MAX,
    Math.max(M.SPROUT_BURST_MIN, Math.ceil(n / M.SPROUT_BURST_SIZE))));
  const gapBudget = Math.max(0, M.SPROUT_TOTAL_MAX
    - M.SPROUT_IN - M.SPROUT_SQUASH - M.SPROUT_BURST_JITTER - M.SPROUT_BURST_RING);
  const gap = bursts > 1 ? Math.min(M.SPROUT_BURST_GAP, gapBudget / (bursts - 1)) : 0;
  const lastDelay = (bursts - 1) * gap + M.SPROUT_BURST_RING + M.SPROUT_BURST_JITTER;
  const total = lastDelay + M.SPROUT_IN + M.SPROUT_SQUASH;

  const h = tiles[0].h;
  console.log('L' + (i + 1)
    + '  张数=' + n
    + '  束数=' + bursts
    + '  每束≈' + (n / bursts).toFixed(1) + '张'
    + '  束间距=' + (gap * 1000).toFixed(0) + 'ms'
    + (gap < M.SPROUT_BURST_GAP ? '(压缩)' : '')
    + '  末束起跳=' + (lastDelay * 1000).toFixed(0) + 'ms'
    + '  **总时长=' + (total * 1000).toFixed(0) + 'ms**'
    + '  上升距离=' + (h * M.SPROUT_FROM_RATIO).toFixed(0) + 'px');
}
