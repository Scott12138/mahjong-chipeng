#!/usr/bin/env python3
"""
============================================================
 anim-sheet.py · 动效连拍拼图
============================================================
【它解决什么问题】
验收动效时最大的痛点是"看不到中间帧"：
  · 一次消除动画不到 1 秒，而冒烟测试默认只截首尾两张图；
  · 就算用 `d:<x>,<y>@<ms>` / `wait:<ms>` / `auto:...!<ms,...>` 连拍出
    十几张帧，它们各自是全屏 720×1280 —— 而画面里真正在动的只有槽位条
    那一小块（约 700×180）。逐张打开去比对，眼睛和上下文都吃不消。
  · 更糟的是：引擎自带的性能面板（FPS / Draw call）固定画在左下角，
    正好压在槽位条上，把整段消除动画盖住。见 CFG.DEBUG.STATS。

【它怎么解决】
把同一个目标区域内的一串帧，按**设计坐标**裁出来，放大后纵向拼成一张
接触印相图（contact sheet），每格左侧标注帧序号与时间偏移。
于是"三张牌聚拢 → 撞在一起 → 释放消失"这个过程，一张图看完。

【用法】
  python3 tools/anim-sheet.py <输出.png> "<dx0,dy0,dx1,dy1>" <帧1> [帧2 ...]
  python3 tools/anim-sheet.py /tmp/sheet.png "-360,-520,360,-330" /tmp/shot/*-clash-5-*ms.png

  · 区域用**设计坐标**（原点=屏幕中心，y 向上、与 Cocos 一致），
    与 CFG 里的布局常量是同一套坐标，可以直接抄 CFG 的值；
  · ⚠️ 区域字符串以 "-" 开头时会被 argparse 当成选项，**必须加 `--` 分隔符**：
      python3 tools/anim-sheet.py /tmp/sheet.png -- "-360,-520,360,-330" /tmp/shot/*.png
  · 帧的顺序就是命令行给的顺序，所以用 glob 时记得文件名里的数字要能正确排序
    （连拍文件名形如 03-clash-5-520ms.png，字典序恰好等于数值序）。
  · 可加 --scale 2 放大（默认 2 倍）、--cols 4 控制列数（默认单列）。
============================================================
"""

import argparse
import glob
import os
import re
import sys

from PIL import Image, ImageDraw, ImageFont

# ------------------------------------------------------------
#  参数预处理：让区域字符串可以以 "-" 开头（设计坐标的 x/y 常为负）
# ------------------------------------------------------------
#  argparse 会把 "-360,-540,360,-330" 识别成未知选项直接报错，
#  标准解法是让用户加 `--`；但一旦加了 `--`，**后面所有选项也变成位置参数**了
#  （实测报错：No such file or directory: '--scale'）。
#  所以这里先把 argv 拆成"选项"与"位置参数"两组，再在位置参数前插 `--`。
#  好处：命令行怎么写都行，区域里的负数不再需要任何转义。
VALUE_FLAGS = {'--scale', '--cols', '--label-w'}
BOOL_FLAGS = {'-h', '--help'}


def _normalize_argv(argv):
    opts, pos = [], []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in VALUE_FLAGS:
            opts += [a, argv[i + 1]]
            i += 2
            continue
        if a in BOOL_FLAGS or (a.startswith('--') and '=' in a):
            opts.append(a)
            i += 1
            continue
        pos.append(a)
        i += 1
    return opts + (['--'] + pos if pos else [])

# 设计分辨率：必须与 game-4-mahjong/settings/v2/packages/project.json 一致
DESIGN_W = 720
DESIGN_H = 1280

FONT_CANDIDATES = [
    '/System/Library/Fonts/PingFang.ttc',
    '/System/Library/Fonts/Helvetica.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
]


def load_font(size: int):
    """尽量找个能显示中文的字体；找不到就退回 PIL 内置位图字体"""
    for p in FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def design_to_pixel_rect(rect, img_w, img_h):
    """
    设计坐标矩形 → 像素矩形。
    截图尺寸应当正好是设计分辨率（冒烟脚本会自检 visible == 720×1280，
    并把视口锁定在 720×1280），所以这里直接按比例换算即可。
    """
    sx = img_w / DESIGN_W
    sy = img_h / DESIGN_H
    dx0, dy0, dx1, dy1 = rect

    def px_x(dx):
        return (dx + DESIGN_W / 2) * sx

    def px_y(dy):
        # 设计坐标 y 向上，图像坐标 y 向下 → 需要翻转
        return (DESIGN_H / 2 - dy) * sy

    left = max(0, min(px_x(dx0), px_x(dx1)))
    right = min(img_w, max(px_x(dx0), px_x(dx1)))
    top = max(0, min(px_y(dy0), px_y(dy1)))
    bottom = min(img_h, max(px_y(dy0), px_y(dy1)))
    return (int(round(left)), int(round(top)), int(round(right)), int(round(bottom)))


def frame_label(path: str) -> str:
    """
    从文件名里提炼一个短标签：优先取 `-<ms>ms` 的时间偏移，
    它是验收动效时唯一真正关心的信息。
    """
    base = os.path.basename(path)
    m = re.search(r'-(\d+)ms\b', base)
    if m:
        return f'{m.group(1)}ms'
    m = re.search(r'-(\d+)(?=\D*$)', base)
    return m.group(1) if m else base


def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument('out')
    ap.add_argument('region', help='设计坐标 "dx0,dy0,dx1,dy1"')
    ap.add_argument('frames', nargs='+')
    ap.add_argument('--scale', type=float, default=2.0)
    ap.add_argument('--cols', type=int, default=1)
    ap.add_argument('--label-w', type=int, default=110, help='左侧标签栏宽度（像素）')
    args = ap.parse_args(_normalize_argv(sys.argv[1:]))

    # 允许 shell 没展开 glob 时（例如脚本内部调用）自己展开
    files = []
    for f in args.frames:
        hit = sorted(glob.glob(f))
        files.extend(hit if hit else [f])
    if not files:
        print('没有可用的帧文件', file=sys.stderr)
        return 1

    try:
        rect = tuple(float(v) for v in args.region.split(','))
        assert len(rect) == 4
    except Exception:
        print('区域格式应为 "dx0,dy0,dx1,dy1"', file=sys.stderr)
        return 1

    crops = []
    for f in files:
        with Image.open(f) as im:
            im = im.convert('RGB')
            box = design_to_pixel_rect(rect, im.width, im.height)
            crop = im.crop(box)
            if args.scale != 1:
                crop = crop.resize(
                    (int(crop.width * args.scale), int(crop.height * args.scale)),
                    Image.LANCZOS,
                )
            crops.append((frame_label(f), crop))

    cw = max(c.width for _, c in crops)
    ch = max(c.height for _, c in crops)
    cols = max(1, args.cols)
    rows = (len(crops) + cols - 1) // cols

    pad = 8
    cell_w = args.label_w + cw + pad * 2
    cell_h = ch + pad * 2
    sheet = Image.new('RGB', (cell_w * cols, cell_h * rows), (250, 246, 238))
    draw = ImageDraw.Draw(sheet)
    font = load_font(max(16, int(22)))

    for i, (label, crop) in enumerate(crops):
        r, c = divmod(i, cols)
        ox = c * cell_w
        oy = r * cell_h
        draw.rectangle(
            [ox + pad, oy + pad, ox + pad + cw, oy + pad + ch],
            outline=(214, 202, 184),
        )
        sheet.paste(crop, (ox + pad, oy + pad))
        draw.text(
            (ox + 10, oy + pad + ch // 2 - 12),
            label,
            fill=(140, 40, 36),
            font=font,
        )

    sheet.save(args.out)
    print(f'✅ 拼图已生成：{args.out}')
    print(f'   共 {len(crops)} 帧，裁切区域 设计{args.region}，放大 {args.scale}x，'
          f'{cols} 列 × {rows} 行，单格 {cw}×{ch}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
