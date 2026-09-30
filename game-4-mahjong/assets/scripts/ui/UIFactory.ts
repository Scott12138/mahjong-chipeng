/**
 * ============================================================
 *  UIFactory.ts · 代码建 UI 工具箱
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
 * ============================================================
 */

import {
    Color, Graphics, Label, LabelOutline, Layers, Node, UIOpacity, UITransform, view,
    tween, Tween, v3,
} from 'cc';

import { CFG } from '../CFG';

// ============================================================
//  颜色工具
// ============================================================

/**
 * 把 CFG 里的 hex 字符串转成 cc.Color。
 * @param hex  形如 '#1B5E3A' 或 '1B5E3A'
 * @param alpha 透明度 0–255，默认 255
 */
export function hex2color(hex: string, alpha = 255): Color {
    const c = new Color();
    c.fromHEX(hex.startsWith('#') ? hex : '#' + hex);
    c.a = alpha;
    return c;
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
    // （Canvas 下的渲染节点统一用 UI_2D，这是 Cocos 的 2D 渲染约定；
    //   不设的话在部分平台会出现节点不渲染/批次错乱）。
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
//  绘制
// ============================================================

export interface RectStyle {
    /** 描边颜色与线宽；不传则无描边 */
    stroke?: string;
    lineWidth?: number;
}

/**
 * 绘制（或重绘）一个以节点中心为原点的圆角矩形。
 * 注意：Graphics 不支持渐变填充，本工程用「多层同心圆角矩形」叠出层次感。
 */
export function drawRoundRect(
    g: Graphics, w: number, h: number, radius: number, fill: string, style: RectStyle = {},
): void {
    g.clear();
    // 填充
    g.fillColor = hex2color(fill);
    g.roundRect(-w / 2, -h / 2, w, h, radius);
    g.fill();

    // 描边（若有）
    if (style.stroke) {
        g.lineWidth = style.lineWidth ?? 3;
        g.strokeColor = hex2color(style.stroke);
        g.roundRect(-w / 2, -h / 2, w, h, radius);
        g.stroke();
    }
}

/** 创建一块圆角矩形面板 */
export function createPanel(
    parent: Node, name: string, w: number, h: number, radius: number,
    fill: string, opts: NodeOpts = {}, style: RectStyle = {},
): Node {
    const node = createNode(name, parent, { w, h, ...opts });
    const g = node.addComponent(Graphics);
    drawRoundRect(g, w, h, radius, fill, style);
    return node;
}

// ============================================================
//  文字
// ============================================================

export interface LabelOpts extends NodeOpts {
    fontSize?: number;
    color?: string;
    bold?: boolean;
    /** 是否启用描边（深底浅字时提升可读性） */
    outline?: string;
    outlineWidth?: number;
    lineHeightRatio?: number;
}

/** 创建一段文字 */
export function createLabel(parent: Node, text: string, opts: LabelOpts = {}): Label {
    const node = createNode('Label', parent, opts);
    const label = node.addComponent(Label);

    label.string = text;
    label.fontSize = opts.fontSize ?? CFG.FONT.SIZE_BODY;
    label.lineHeight = (opts.fontSize ?? CFG.FONT.SIZE_BODY) * (opts.lineHeightRatio ?? CFG.FONT.LINE_HEIGHT_RATIO);
    label.color = hex2color(opts.color ?? CFG.COLOR.TEXT_LIGHT);
    label.isBold = opts.bold ?? false;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    label.overflow = Label.Overflow.NONE;   // 文字自适应，不裁切

    // 系统字体：FAMILY 为空时用引擎默认字体，由平台做中文回退
    if (CFG.FONT.FAMILY) {
        label.fontFamily = CFG.FONT.FAMILY;
    }
    label.useSystemFont = true;

    // 描边
    if (opts.outline) {
        const ol = node.addComponent(LabelOutline);
        ol.color = hex2color(opts.outline);
        ol.width = opts.outlineWidth ?? 3;
    }
    return label;
}

// ============================================================
//  按钮
// ============================================================

export interface ButtonOpts extends NodeOpts {
    w: number;
    h: number;
    radius?: number;
    fill?: string;
    stroke?: string;
    lineWidth?: number;
    /** 立体厚度：底部深色层向下偏移的像素数，0 表示扁平 */
    depth?: number;
    depthColor?: string;

    text: string;
    fontSize?: number;
    textColor?: string;

    enabled?: boolean;
    enabledFill?: string;
    enabledTextColor?: string;

    onClick?: () => void;
}

/**
 * 创建一个按钮（纯代码：圆角矩形 + 文字 + 点击回弹手感）。
 *
 * 手感细节（DESIGN §8「手感加分」）：
 *  · 按下  : 缩到 0.94 + 向下压 3px（模拟被按进去）
 *  · 抬起  : 回弹到 1.0，用 back 缓动做出"弹回来"的轻微过冲
 *  · 禁用  : 变灰、不响应
 */
export function createButton(parent: Node, name: string, opts: ButtonOpts): Node {
    const enabled = opts.enabled ?? true;
    const radius = opts.radius ?? 18;
    const depth = opts.depth ?? 6;

    // ---- 根节点（承担触摸与缩放，锚点中心）----
    const btn = createNode(name, parent, { w: opts.w, h: opts.h, x: opts.x, y: opts.y });
    btn.addComponent(UIOpacity);   // 供转场淡入淡出使用

    // ---- 立体厚度层（在下方）----
    if (depth > 0) {
        const base = createNode('Depth', btn, { w: opts.w, h: opts.h, y: -depth });
        const gb = base.addComponent(Graphics);
        drawRoundRect(gb, opts.w, opts.h, radius, opts.depthColor ?? CFG.COLOR.BTN_PRIMARY_EDGE);
    }

    // ---- 主面层 ----
    const face = createNode('Face', btn, { w: opts.w, h: opts.h });
    const gf = face.addComponent(Graphics);
    drawRoundRect(
        gf, opts.w, opts.h, radius,
        enabled ? (opts.fill ?? CFG.COLOR.BTN_PRIMARY) : (opts.enabledFill ?? CFG.COLOR.LOCKED),
        opts.stroke ? { stroke: opts.stroke, lineWidth: opts.lineWidth ?? 3 } : {},
    );

    // ---- 文字 ----
    createLabel(face, opts.text, {
        fontSize: opts.fontSize ?? CFG.FONT.SIZE_BUTTON,
        color: enabled ? (opts.textColor ?? CFG.COLOR.TEXT_LIGHT) : (opts.enabledTextColor ?? CFG.COLOR.LOCKED_TEXT),
        bold: true,
        w: opts.w - 40,
        h: opts.h,
    });

    // ---- 交互 ----
    if (!enabled) {
        btn.setScale(v3(1, 1, 1));
        return btn;
    }

    const press = () => {
        Tween.stopAllByTarget(btn);
        tween(btn).to(0.06, { scale: v3(0.94, 0.94, 1) }).start();
    };
    const release = () => {
        Tween.stopAllByTarget(btn);
        // back 缓动 → 回弹时轻微过冲，手感更"活"
        tween(btn).to(0.14, { scale: v3(1, 1, 1) }, { easing: 'backOut' }).start();
    };

    btn.on(Node.EventType.TOUCH_START, press, btn);
    btn.on(Node.EventType.TOUCH_END, () => {
        release();
        // 选项里的显式点击音效 / 回调在此触发
        opts.onClick?.();
    }, btn);
    btn.on(Node.EventType.TOUCH_CANCEL, release, btn);

    return btn;
}

// ============================================================
//  整屏背景
// ============================================================

/**
 * 创建整屏麻将桌布背景。
 * 做法：三层同心圆角矩形（外围深 → 主桌布 → 中心亮），
 * 做出"中央被灯光照亮"的绒布感，且不需要任何贴图。
 */
export function createTableBackground(parent: Node): Node {
    // 用「当前适配策略下的真实可视尺寸」，而不是写死设计分辨率 ——
    // 20:9 之类的超长屏上可视高度大于设计高度，写死就会在上/下露白边。
    const vs = view.getVisibleSize();
    const W = vs.width;
    const H = vs.height;

    const root = createNode('Background', parent, { w: W, h: H });
    const g = root.addComponent(Graphics);

    // 三层同心矩形叠出"中央被灯光照亮"的绒布感。
    // 说明：Graphics 不支持渐变填充，用同心叠层替代是零贴图方案里最省的画法。
    // ① 最外层：深绿（压暗边缘），画得比可视区大一圈，保证任何比例都不留白
    const BW = W * 1.6;
    const BH = H * 1.6;
    g.fillColor = hex2color(CFG.COLOR.TABLE_DARK);
    g.rect(-BW / 2, -BH / 2, BW, BH);
    g.fill();
    // ② 中层：主桌布
    g.fillColor = hex2color(CFG.COLOR.TABLE);
    g.roundRect(-W / 2 + 24, -H / 2 + 24, W - 48, H - 48, 40);
    g.fill();
    // ③ 中心：提亮（模拟顶灯照在桌面中央）
    const cw = W * 0.86;
    const ch = H * 0.62;
    g.fillColor = hex2color(CFG.COLOR.TABLE_LIGHT);
    g.roundRect(-cw / 2, -ch / 2, cw, ch, 34);
    g.fill();

    return root;
}

// ============================================================
//  轻提示（Toast）
// ============================================================

/**
 * 屏幕中下方弹一条会自动消失的提示。
 * 用于 S1 阶段占位（例如点击尚未实现的关卡），S7 会换成正式的表现。
 */
export function toast(parent: Node, text: string, duration = 1.4): void {
    const node = createNode('Toast', parent, { x: 0, y: -160 });
    const opacity = node.addComponent(UIOpacity);
    opacity.opacity = 0;

    // 深色药丸底
    const label = createLabel(node, text, {
        fontSize: CFG.FONT.SIZE_BODY,
        color: CFG.COLOR.TEXT_LIGHT,
        bold: true,
    });
    const w = Math.max(220, text.length * (CFG.FONT.SIZE_BODY + 6) + 60);
    const h = 76;
    const g = node.addComponent(Graphics);
    g.fillColor = hex2color(CFG.COLOR.MASK, 190);
    g.roundRect(-w / 2, -h / 2, w, h, h / 2);
    g.fill();
    label.node.setSiblingIndex(1);   // 文字盖在药丸底之上

    // 淡入 → 停留 → 淡出 → 销毁
    tween(opacity)
        .to(0.16, { opacity: 255 })
        .delay(duration)
        .to(0.24, { opacity: 0 })
        .call(() => node.destroy())
        .start();
}
