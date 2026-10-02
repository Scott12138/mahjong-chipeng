// S17 方案 B：把「随机成束」的编排还原成数据（x = 冒出时刻，y = 牌在牌堆里的高度）
// ⚠️ 分束算法与 GamePage.playSproutMotion 逐行同构；Math.random 换成固定种子 LCG 以便复现
import { CFG } from './CFG.ts';
import { generateLevel } from './Generator.ts';

let seed = 20261001;
function rnd(): number {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
}

const M = CFG.MOTION as any;
const LV = CFG.LEVELS as any[];

const out: any = { levels: [] };

for (let li = 0; li < LV.length; li++) {
  const layout = generateLevel(LV[li], 1000 + li);
  const tiles = layout.tiles as any[];
  const n = tiles.length;

  const bursts = Math.max(1, Math.min(M.SPROUT_BURST_MAX,
    Math.max(M.SPROUT_BURST_MIN, Math.ceil(n / M.SPROUT_BURST_SIZE))));
  const pickIdx: number[] = [];
  for (let i = 0; i < n; i++) pickIdx.push(i);
  const pick = Math.min(bursts, n);
  for (let i = 0; i < pick; i++) {
    const j = i + Math.floor(rnd() * (n - i));
    const tmp = pickIdx[i]; pickIdx[i] = pickIdx[j]; pickIdx[j] = tmp;
  }
  const centers: Array<{ x: number; y: number }> = [];
  for (let b = 0; b < pick; b++) centers.push({ x: tiles[pickIdx[b]].x, y: tiles[pickIdx[b]].y });

  const burstOf: number[] = new Array(n);
  const ringOf: number[] = new Array(n);
  let ringMax = 0;
  for (let i = 0; i < n; i++) {
    let best = 0; let bd = Infinity;
    for (let b = 0; b < centers.length; b++) {
      const dx = tiles[i].x - centers[b].x;
      const dy = tiles[i].y - centers[b].y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = b; }
    }
    burstOf[i] = best;
    const dist = Math.sqrt(Math.max(0, bd));
    ringOf[i] = dist;
    if (dist > ringMax) ringMax = dist;
  }
  if (ringMax > 0) for (let i = 0; i < n; i++) ringOf[i] /= ringMax;

  const burstRank: number[] = new Array(centers.length);
  const seq: number[] = [];
  for (let b = 0; b < centers.length; b++) seq.push(b);
  seq.sort((a, b) => centers[a].y - centers[b].y);
  for (let i = 0; i < seq.length; i++) burstRank[seq[i]] = i;

  const gapBudget = Math.max(0, M.SPROUT_TOTAL_MAX
    - M.SPROUT_IN - M.SPROUT_SQUASH - M.SPROUT_BURST_JITTER - M.SPROUT_BURST_RING);
  const burstGap = centers.length > 1
    ? Math.min(M.SPROUT_BURST_GAP, gapBudget / (centers.length - 1)) : 0;

  const pts: any[] = [];
  for (let i = 0; i < n; i++) {
    const delay = Math.max(0, burstRank[burstOf[i]] * burstGap
      + ringOf[i] * M.SPROUT_BURST_RING
      + (rnd() * 2 - 1) * M.SPROUT_BURST_JITTER);
    pts.push({
      x: tiles[i].x, y: tiles[i].y,
      delay: delay * 1000,
      burst: burstRank[burstOf[i]],
      centerX: centers[burstOf[i]].x,
      centerY: centers[burstOf[i]].y,
    });
  }

  // ---- 旧版（S16「田垄」）的 delay，用于对照：按屏幕 y 分带 + 垄内按 x 扫风 ----
  const OLD_GAP = 0.075; const OLD_SWEEP = 0.06; const OLD_MAX = 6;
  let yMin = Infinity; let yMax = -Infinity; let xMin = Infinity; let xMax = -Infinity;
  for (const t of tiles) {
    if (t.y < yMin) yMin = t.y; if (t.y > yMax) yMax = t.y;
    if (t.x < xMin) xMin = t.x; if (t.x > xMax) xMax = t.x;
  }
  const bandH = tiles[0].h;
  const ySpan = Math.max(bandH, yMax - yMin);
  const xSpan = xMax - xMin;
  const oldBands = Math.max(1, Math.min(OLD_MAX, Math.ceil(ySpan / bandH)));
  const oldPts: any[] = [];
  for (const t of tiles) {
    const band = Math.min(oldBands - 1, Math.floor(((t.y - yMin) / ySpan) * oldBands));
    const sweep = xSpan > 0 ? ((t.x - xMin) / xSpan) * OLD_SWEEP : 0;
    oldPts.push({ x: t.x, y: t.y, delay: (band * OLD_GAP + sweep) * 1000, band });
  }

  out.levels.push({
    level: li + 1, n, bursts, burstGap: burstGap * 1000,
    inMs: M.SPROUT_IN * 1000, squashMs: M.SPROUT_SQUASH * 1000,
    totalMs: ((centers.length - 1) * burstGap + M.SPROUT_BURST_RING
      + M.SPROUT_BURST_JITTER + M.SPROUT_IN + M.SPROUT_SQUASH) * 1000,
    pts, oldPts, oldBands,
  });
}

console.log(JSON.stringify(out));
