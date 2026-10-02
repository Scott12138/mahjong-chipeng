#!/usr/bin/env python3
# ============================================================
#  probe-bloom.py · 开场「四层墨晕」的像素级取证
# ============================================================
#  【为什么要它】S18 的开场墨晕曾经整块变成"纯黑实心圆"。
#  肉眼只能看出"不对"，看不出"哪一层没生效"。本脚本把截图沿
#  一条过圆心的直线做径向采样，把每个半径处的**实际墨浓度**算出来，
#  再与 CFG 里设计的四层 alpha 对照 —— 一眼就能看出是"四层叠对了"
#  还是"被拉平成一层"。
#
#  【墨浓度的算法】墨色 INK 半透明叠在纸色 PAPER 上：
#      observed = INK * k + PAPER * (1 - k)
#  所以 k = (PAPER - observed) / (PAPER - INK)，用亮度通道算即可
#  （INK 与 PAPER 都是暖灰调，RGB 三通道同向变化，取 R 通道最稳）。
#
#  用法： python3 tools/probe-bloom.py <png...> [--cx 360 --cy 380]
# ============================================================
import sys

from PIL import Image

# CFG.COLOR.INK / CFG.COLOR.PAPER（改 CFG 时这里要跟着改）
INK = (0x22, 0x20, 0x1C)
PAPER = (0xF2, 0xEA, 0xDA)

# 设计的四层半径（CFG.MOTION.INTRO.RING_R）
RINGS = [34, 76, 126, 200]


def ink_frac(px) -> float:
    """这一个像素里"墨"占的比例（0=纯纸，1=纯墨）"""
    num = PAPER[0] - px[0]
    den = PAPER[0] - INK[0]
    return max(0.0, min(1.2, num / den))


def main() -> int:
    args = [a for a in sys.argv[1:]]
    cx, cy = 360, 380
    if '--cx' in args:
        i = args.index('--cx')
        cx = int(args[i + 1])
        del args[i:i + 2]
    if '--cy' in args:
        i = args.index('--cy')
        cy = int(args[i + 1])
        del args[i:i + 2]

    for path in args:
        im = Image.open(path).convert('RGB')
        print(f'\n===== {path}  ({im.width}×{im.height}) =====')
        print(f'圆心 (cx,cy) = ({cx},{cy})；沿"向右"扫描（可避开居中文字）')
        print(f'{"r":>4} {"px":>22} {"墨浓度":>8}  {"落在哪一层":<18}')
        samples = []
        for r in list(range(0, 215, 5)):
            x = cx + r
            if x >= im.width:
                break
            px = im.getpixel((x, cy))
            k = ink_frac(px)
            samples.append((r, k))
            # 判断这个半径落在哪一层（重叠段的理论值另算）
            lay = [i for i, rr in enumerate(RINGS) if r < rr]
            tag = f'层{"+".join(str(i) for i in lay)}' if lay else '纸'
            print(f'{r:>4} {str(px):>22} {k:>8.3f}  {tag:<18}')

        # 找"台阶"：浓度变化超过 0.02 的位置就是一层晕的边界
        print(f'  --- 台阶检测（相邻采样差 > 0.02）---')
        for i in range(1, len(samples)):
            d = samples[i][1] - samples[i - 1][1]
            if abs(d) > 0.02:
                print(f'    r≈{samples[i][0]:>4}  '
                      f'{samples[i - 1][1]:.3f} → {samples[i][1]:.3f}  (Δ{d:+.3f})')
        plateaus = sorted({round(k, 3) for _, k in samples if k > 0.005})
        print(f'  --- 出现的墨浓度档位（去重）: {plateaus}')
        print(f'  --- 结论: {"✅ 有分层" if len(plateaus) >= 3 else "❌ 被拉平/没有分层"}'
              f'（共 {len(plateaus)} 档）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
