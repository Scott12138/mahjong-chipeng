/**
 * ============================================================
 *  UIFactory.ts · 代码建 UI 工具箱（国潮形层）
 * ============================================================
 *  【为什么不用编辑器拖拽】
 *  本工程 UI 全部由代码动态创建（DESIGN §8）。好处：
 *  ① 所有界面都能被完整维护 / 审查 / diff，不依赖二进制场景文件；
 *  ② 改版只改代码，git diff 干净、可回溯；
 *  ③ 位置参数集中在 CFG，调布局不碰逻辑。
 *
 *  【坐标系约定】
 *  Cocos 的 UI 节点以自身锚点为原点。本工具箱统一使用
 *  「中心锚点(0.5, 0.5)」，因此所有绘制都以节点中心为原点，
 *  便于按「相对屏幕中心的偏移」来摆位置（与 CFG 布局表一致）。
 *
 *  【国潮四要素】（视觉依据：docs/design/guochao-tiles.html §1）
 *   ① 宣纸底   —— 不用纯白，一律米黄暖灰
 *   ② 墨线双框 —— 外粗内细两道，「描边」二字的来源
 *   ③ 朱红角花 —— 内框四角各一段折线，成本极低、国潮味最重
 *   ④ 硬直角   —— 圆角压到 3–7px，把「玩具感」换成「器物感」
 * ============================================================
 */

import {
    Color, Graphics, Label, LabelOutline, Layers, Node, UIOpacity, UITransform, view,
    tween, Tween, v3,
} from 'cc';

import { CFG } from '../CFG';
import { hex2color } from './TileRenderer';

export { hex2color };

// ============================================================
//  绘制基元（全部以「节点中心」为原点）
// ============================================================

/** 填充圆角矩形（中心定位） */
export function fillBox(
    g: Graphics, cx: number, cy: number, w: number, h: number, r: number,
    fill: string, alpha = 255,
): void {
    g.fillColor = hex2color(fill, alpha);
    g.roundRect(cx - w / 2, cy - h / 2, w, h, r);
    g.fill();
}

/** 描边圆角矩形（中心定位） */
export function strokeBox(
    g: Graphics, cx: number, cy: number, w: number, h: number, r: number,
    color: string, lineWidth: number, alpha = 255,
): void {
    g.lineWidth = lineWidth;
    g.strokeColor = hex2color(color, alpha);
    g.roundRect(cx - w / 2, cy - h / 2, w, h, r);
    g.stroke();
}

/**
 * 段折线（用于国潮角花）。
 * 8 条短线段撑起「回纹极简版」，是整套视觉里性价比最高的一笔。
 */
export function strokePath(
    g: Graphics, pts: Array<[number, number]>, color: string, lineWidth: number,
): void {
    if (pts.length < 2) return;
    g.lineWidth = lineWidth;
    g.strokeColor = hex2color(color);
    g.lineCap = Graphics.LineCap.SQUARE;
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.stroke();
}

/**
 * 在矩形四角画朱红角花（朝内折）。
 * 用于卡片、按钮、面板 —— 国潮这套视觉里，角花＝「这块东西是件器物」的信号。
 */
export function drawCorners(
    g: Graphics, cx: number, cy: number, w: number, h: number,
    len: number, color: string, lineWidth: number,
): void {
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const y0 = cy - h / 2;
    const y1 = cy + h / 2;
    strokePath(g, [[x0, y1 - len], [x0, y1], [x0 + len, y1]], color, lineWidth);
    strokePath(g, [[x1 - len, y1], [x1, y1], [x1, y1 - len]], color, lineWidth);
    strokePath(g, [[x1, y0 + len], [x1, y0], [x1 - len, y0]], color, lineWidth);
    strokePath(g, [[x0 + len, y0], [x0, y0], [x0, y0 + len]], color, lineWidth);
}

// ============================================================
//  节点创建
// ============================================================

export interface NodeOpts {
    /** 内容宽高；不传则不设置（保持默认 100×100） */
    w?: number;
    h?: number;
    /** 相对父节点中心的偏移（父节点为中心锚点时，等价于相对屏幕中心的偏移） */
    x?: number;
    y?: number;
}

/** 创建一个带 UITransform 的空节点（UI 一切的基础） */
export function createNode(name: string, parent: Node, opts: NodeOpts = {}): Node {
    const node = new Node(name);
    parent.addChild(node);

    // ⚠️ 关键：代码创建的节点默认在 DEFAULT 层，而 2D UI 必须归属 UI_2D 层
    // （不设的话在部分平台会出现节点不渲染 / 批次错乱）。
    node.layer = Layers.Enum.UI_2D;

    const ui = node.addComponent(UITransform);
    ui.setAnchorPoint(0.5, 0.5);
    if (opts.w !== undefined && opts.h !== undefined) {
        ui.setContentSize(opts.w, opts.h);
    }
    node.setPosition(opts.x ?? 0, opts.y ?? 0, 0);
    return node;
}

// ============================================================
//  文字
// ============================================================

export interface LabelOpts extends NodeOpts {
    fontSize?: number;
    color?: string;
    bold?: boolean;
    /** 是否启用描边（墨字浅底时用来压住边缘） */
    outline?: string;
    outlineWidth?: number;
    lineHeightRatio?: number;
    /** 左侧对齐（默认居中）。对齐时 x 视为「左边界」 */
    alignLeft?: boolean;
    /** 衬线体（牌面、标题用；界面小字不用） */
    serif?: boolean;
}

/** 创建一段文字 */
export function createLabel(parent: Node, text: string, opts: LabelOpts = {}): Label {
    const node = createNode('Label', parent, opts);
    const label = node.addComponent(Label);

    const fontSize = opts.fontSize ?? CFG.FONT.SIZE_BODY;

    // 左对齐时，节点的位置语义是「左边界」——把锚点移到左边，
    // 布局就变成"给个左边距、文字自己往右长"，比每次手算宽度稳得多。
    if (opts.alignLeft && opts.w !== undefined) {
        const ui = node.getComponent(UITransform)!;
        ui.setAnchorPoint(0, 0.5);
        node.setPosition(opts.x ?? 0, opts.y ?? 0, 0);
    }

    label.string = text;
    label.fontSize = fontSize;
    label.lineHeight = fontSize * (opts.lineHeightRatio ?? CFG.FONT.LINE_HEIGHT_RATIO);
    label.color = hex2color(opts.color ?? CFG.COLOR.INK);
    label.isBold = opts.bold ?? false;
    label.horizontalAlign = opts.alignLeft ? Label.HorizontalAlign.LEFT : Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.overflow = Label.Overflow.NONE;   // 文字自适应，不裁切

    if (opts.serif) {
        // 牌面与标题用衬线体：这是「萬」字的真实字形（明朝体骨架），
        // 换成黑体立刻就没有器物感了。引擎不打包字体，靠平台回退。
        label.fontFamily = CFG.FONT.SERIF ? `${CFG.FONT.SERIF}, STSong, SimSun, serif` : '';
        label.useSystemFont = true;
    } else if (CFG.FONT.FAMILY) {
        label.fontFamily = CFG.FONT.FAMILY;
        label.useSystemFont = true;
    } else {
        label.useSystemFont = true;
    }

    // 描边
    if (opts.outline) {
        const ol = node.addComponent(LabelOutline);
        ol.color = hex2color(opts.outline);
        ol.width = opts.outlineWidth ?? 3;
    }
    return label;
}

// ============================================================
//  页面骨架（宣纸底 + 墨线双框 + 朱红角花）
// ============================================================

/**
 * 铺满整屏的宣纸底。
 * 用「当前适配策略下的真实可视尺寸」而不是写死设计分辨率 ——
 * 20:9 之类的超长屏上可视高度大于设计高度，写死就会在上下露白边。
 */
export function createPaperBackground(parent: Node): Node {
    const vs = view.getVisibleSize();
    const W = vs.width * 1.6;
    const H = vs.height * 1.6;

    const root = createNode('PaperBackground', parent, { w: vs.width, h: vs.height });
    const g = root.addComponent(Graphics);
    // 单色宣纸底。刻意**不做**渐变/纹理：本作视觉的重心在牌面，
    // 背景一花，27 种牌面的辨识度立刻下降。
    g.fillColor = hex2color(CFG.COLOR.PAPER);
    g.rect(-W / 2, -H / 2, W, H);
    g.fill();
    return root;
}

/**
 * 页面内容框：外框（朱红细线）+ 内框（墨线）+ 四角朱红角花。
 * 设计稿里这套边框出现在每一页上，是"国潮描边"最直接的载体。
 */
export function createPageFrame(parent: Node): Node {
    const S = CFG.SCREEN;
    const SH = CFG.SHAPE;

    const x0 = -S.W / 2 + S.FRAME_INSET;
    const y1 = S.H / 2 - S.FRAME_TOP;
    const y0 = S.H / 2 - S.FRAME_BOTTOM;
    const w = S.FRAME_INSET * -2 + S.W;
    const h = y1 - y0;
    const cx = x0 + w / 2;
    const cy = (y0 + y1) / 2;

    const root = createNode('PageFrame', parent, { w: S.W, h: S.H });
    const g = root.addComponent(Graphics);
    const pad = 20;   // 外框比内框大一圈（设计稿 46 vs 66）

    // ① 外框：宣纸白底 + 朱红细边
    fillBox(g, cx, cy, w + pad * 2, h + pad * 2, 10, CFG.COLOR.FACE);
    strokeBox(g, cx, cy, w + pad * 2, h + pad * 2, 10, CFG.COLOR.VERMILION, SH.LINE_OUTER);

    // ② 内框：墨线（细、半透明，是"装帧"而不是"分割"）
    strokeBox(g, cx, cy, w, h, 4, CFG.COLOR.INK, SH.LINE_INNER, SH.LINE_INNER_ALPHA * 255);

    // ③ 四角朱红角花
    drawCorners(g, cx, cy, w, h, SH.CORNER_LEN, CFG.COLOR.VERMILION, SH.LINE_CORNER);

    return root;
}

/** 页面内容框的可用范围（各页面排布局时以它为基准） */
export function frameRect(): { x0: number; x1: number; y0: number; y1: number; w: number; h: number } {
    const S = CFG.SCREEN;
    const x0 = -S.W / 2 + S.FRAME_INSET;
    const x1 = S.W / 2 - S.FRAME_INSET;
    const y1 = S.H / 2 - S.FRAME_TOP;
    const y0 = S.H / 2 - S.FRAME_BOTTOM;
    return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
}

// ============================================================
//  通用件
// ============================================================

export interface PanelOpts extends NodeOpts {
    radius?: number;
    fill?: string;
    /** 是否画四角朱红角花 */
    corners?: boolean;
    stroke?: string;
    lineWidth?: number;
}

/** 宣纸面板（可选角花） */
export function createPanel(
    parent: Node, name: string, w: number, h: number, opts: PanelOpts = {},
): Node {
    const node = createNode(name, parent, { w, h, x: opts.x, y: opts.y });
    const g = node.addComponent(Graphics);
    const radius = opts.radius ?? CFG.SHAPE.RADIUS_PANEL;
    const fill = opts.fill ?? CFG.COLOR.FACE;
    fillBox(g, 0, 0, w, h, radius, fill);
    if (opts.stroke) strokeBox(g, 0, 0, w, h, radius, opts.stroke, opts.lineWidth ?? 3);
    if (opts.corners) {
        drawCorners(g, 0, 0, w, h, CFG.SHAPE.CORNER_LEN * 0.8, CFG.COLOR.VERMILION, CFG.SHAPE.LINE_CORNER);
    }
    return node;
}

export interface ProgressBarOpts extends NodeOpts {
    w: number;
    h: number;
    /** 0..1 */
    value: number;
}

/** 进度条（墨色槽 + 朱红填充，两端硬直角） */
export function createProgressBar(parent: Node, name: string, opts: ProgressBarOpts): Node {
    const node = createNode(name, parent, { w: opts.w, h: opts.h, x: opts.x, y: opts.y });
    const g = node.addComponent(Graphics);
    const v = Math.max(0, Math.min(1, opts.value));
    fillBox(g, 0, 0, opts.w, opts.h, 0, CFG.COLOR.INK, 30);
    if (v > 0) {
        // 左端对齐：填充从左边长出来
        const fw = opts.w * v;
        g.fillColor = hex2color(CFG.COLOR.VERMILION);
        g.rect(-opts.w / 2, -opts.h / 2, fw, opts.h);
        g.fill();
    }
    return node;
}

// ============================================================
//  按钮
// ============================================================

export interface ButtonOpts extends NodeOpts {
    w: number;
    h: number;
    radius?: number;
    /** 面层底色 */
    fill?: string;
    /** 面层描边（国潮按钮是"墨线描边 + 朱红面"） */
    stroke?: string;
    lineWidth?: number;
    /** 立体厚度：底部深色层向下偏移的像素数 */
    depth?: number;
    depthColor?: string;
    /** 是否画角花 */
    corners?: boolean;

    text: string;
    fontSize?: number;
    textColor?: string;
    /** 衬线体（主按钮用，标题感更强） */
    serif?: boolean;

    enabled?: boolean;
    enabledFill?: string;
    enabledTextColor?: string;

    onClick?: () => void;
}

/**
 * 国潮按钮。
 *
 * 形制来自设计稿 §9：**墨色厚度层 + 朱红面层 + 墨线描边 + 硬直角**。
 * 手感细节：
 *  · 按下：缩到 0.94（模拟被按进去）
 *  · 抬起：backOut 缓动回弹，带回一点过冲，手感更「活」
 *  · 禁用：变纸灰、不响应，且**不画角花**（角花是"可用"的信号）
 */
export function createButton(parent: Node, name: string, opts: ButtonOpts): Node {
    const enabled = opts.enabled ?? true;
    const radius = opts.radius ?? CFG.SHAPE.RADIUS_BTN;
    const depth = opts.depth ?? CFG.SHAPE.BTN_DEPTH;

    const btn = createNode(name, parent, { w: opts.w, h: opts.h, x: opts.x, y: opts.y });
    btn.addComponent(UIOpacity);   // 供转场淡入淡出使用

    // ---- 立体厚度层（在下方）----
    if (depth > 0) {
        const base = createNode('Depth', btn, { w: opts.w, h: opts.h, y: -depth });
        const gb = base.addComponent(Graphics);
        fillBox(gb, 0, 0, opts.w, opts.h, radius,
            opts.depthColor ?? CFG.COLOR.INK, enabled ? 255 : 60);
    }

    // ---- 主面层 ----
    const face = createNode('Face', btn, { w: opts.w, h: opts.h });
    const gf = face.addComponent(Graphics);
    const fill = enabled ? (opts.fill ?? CFG.COLOR.VERMILION) : (opts.enabledFill ?? CFG.COLOR.LOCK_BG);
    fillBox(gf, 0, 0, opts.w, opts.h, radius, fill);
    if (enabled) {
        strokeBox(gf, 0, 0, opts.w, opts.h, radius,
            opts.stroke ?? CFG.COLOR.INK, opts.lineWidth ?? 3);
        if (opts.corners !== false) {
            drawCorners(gf, 0, 0, opts.w, opts.h, CFG.SHAPE.CORNER_LEN * 0.7,
                CFG.COLOR.FACE, 1.8);
        }
    } else {
        strokeBox(gf, 0, 0, opts.w, opts.h, radius, CFG.COLOR.LOCK, 2);
    }

    // ---- 文字 ----
    createLabel(face, opts.text, {
        fontSize: opts.fontSize ?? CFG.FONT.SIZE_BUTTON,
        color: enabled
            ? (opts.textColor ?? CFG.COLOR.FACE)
            : (opts.enabledTextColor ?? CFG.COLOR.INK_SOFT),
        bold: true,
        serif: opts.serif,
        w: opts.w - 40,
        h: opts.h,
    });

    // ---- 交互 ----
    if (!enabled) {
        return btn;
    }

    const press = () => {
        Tween.stopAllByTarget(btn);
        tween(btn).to(0.06, { scale: v3(0.94, 0.94, 1) }).start();
    };
    const release = () => {
        Tween.stopAllByTarget(btn);
        tween(btn).to(0.14, { scale: v3(1, 1, 1) }, { easing: 'backOut' }).start();
    };

    btn.on(Node.EventType.TOUCH_START, press, btn);
    btn.on(Node.EventType.TOUCH_END, () => {
        release();
        opts.onClick?.();
    }, btn);
    btn.on(Node.EventType.TOUCH_CANCEL, release, btn);

    return btn;
}

// ============================================================
//  轻提示（Toast）
// ============================================================

/**
 * 屏幕中下方弹一条会自动消失的提示。
 * 形制：墨色药丸 + 硬直角边 + 宣纸色文字（与整页的"器物感"统一）。
 */
export function toast(parent: Node, text: string, duration = 1.4): void {
    const node = createNode('Toast', parent, { x: 0, y: -80 });
    const opacity = node.addComponent(UIOpacity);
    opacity.opacity = 0;

    const fontSize = CFG.FONT.SIZE_BODY;
    const w = Math.max(240, text.length * (fontSize + 6) + 64);
    const h = 74;

    const g = node.addComponent(Graphics);
    g.fillColor = hex2color(CFG.COLOR.INK, 235);
    g.roundRect(-w / 2, -h / 2, w, h, 4);
    g.fill();

    const label = createLabel(node, text, {
        fontSize,
        color: CFG.COLOR.FACE,
        bold: true,
    });
    label.node.setSiblingIndex(1);   // 文字盖在底之上

    tween(opacity)
        .to(0.16, { opacity: 255 })
        .delay(duration)
        .to(0.24, { opacity: 0 })
        .call(() => node.destroy())
        .start();
}

// ============================================================
//  过渡：旧工程残留名的兼容入口
// ============================================================

/**
 * @deprecated 旧名（S1 的「麻将桌布」）。国潮定稿已改为单色宣纸底。
 * 保留这个别名只是为了让老代码能编译过，新代码请用 createPaperBackground。
 */
export function createTableBackground(parent: Node): Node {
    return createPaperBackground(parent);
}
