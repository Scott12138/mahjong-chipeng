/**
 * ============================================================
 *  TileRenderer.ts · 牌面矢量渲染器（27 张真牌）
 * ============================================================
 *  把 `docs/design/guochao-tiles.html` 里的 SVG 画法逐条翻成 Cocos 的
 *  Graphics 与 Label 调用。**零贴图** —— 27 种牌面全靠代码画，
 *  assets 目录因此只有两百多 KB，而且永远不会糊。
 *
 *  ------------------------------------------------------------
 *  【坐标系：两套坐标 + 一处翻转】
 *    · 设计坐标（TileData / 设计稿）：132×176，原点左上，y 向下（沿用 SVG）
 *    · 引擎坐标（本文件输出）：节点中心为原点，y 向上
 *  翻转只发生在本文件的两个小函数里（XS / YS），别在别处再翻一次，
 *  翻了两次的 bug 极难看出来（图能出来，只是全镜像了）。
 *
 *  【为什么不用节点旋转来画斜竹节】
 *  8 条的竹节有 ±12°/±32° 的斜度。如果每根竹节都建一个子节点再旋转，
 *  单张牌就会有 10 个节点、90 张牌 900 个节点 —— 顶点没多少，节点开销先炸了。
 *  所以这里**在数学上把角点算好**，用多边形一次画完。
 *
 *  【万子为什么必须用 Label】
 *  Graphics 画不了汉字（它只有路径图元）。所以万子 = 图形牌体 + 两个
 *  Label（数字深蓝、萬朱红）。这也正好还原了真牌「蓝数字 + 红萬」的字形。
 * ============================================================
 */

import { Color, Graphics, Label, Layers, Node, UIOpacity, UITransform, Vec3 } from 'cc';
import { CFG } from '../CFG';
import {
    BambooSpec, DiscSpec, Family, InkKey, PatternKey, SOU_LAYOUT, TILE_DEEP, TILE_DIM,
    TILE_GEO, TILE_INK, TILE_LIGHT, TON_LAYOUT, WAN_NUM, deep, parsePattern, tint,
} from '../TileData';

// ============================================================
//  颜色
// ============================================================

/** hex 字符串 → cc.Color */
export function hex2color(hex: string, alpha = 255): Color {
    const c = new Color();
    c.fromHEX(hex.startsWith('#') ? hex : '#' + hex);
    c.a = alpha;
    return c;
}

// ============================================================
//  坐标翻转（全工程唯一的一处）
// ============================================================

const G = TILE_GEO;
/** 设计坐标 x → 节点内 x（× 缩放） */
const XS = (x: number, k: number) => (x - G.CX) * k;
/** 设计坐标 y → 节点内 y（翻 y 轴 + × 缩放） */
const YS = (y: number, k: number) => (G.CY - y) * k;

/** 牌面状态 */
export type TileState = 'normal' | 'dim' | 'pick' | 'clear';

// ============================================================
//  绘制基元（都在设计坐标系里描述，内部自动翻转）
// ============================================================

/** 圆角矩形：入参为设计坐标下的左上角 + 宽高 + 圆角 */
function rr(
    g: Graphics, x: number, y: number, w: number, h: number, r: number, k: number,
    fill: string | null, stroke?: string, lineWidth?: number, alpha = 255,
): void {
    // 设计坐标左上角 → 引擎坐标左下角（y 翻转过来了）
    const bx = XS(x, k);
    const by = YS(y + h, k);
    const bw = w * k;
    const bh = h * k;
    if (fill) {
        g.fillColor = hex2color(fill, alpha);
        g.roundRect(bx, by, bw, bh, Math.max(0, r * k));
        g.fill();
    }
    if (stroke) {
        g.lineWidth = Math.max(0.6, (lineWidth ?? 1) * k);
        g.strokeColor = hex2color(stroke, alpha);
        g.roundRect(bx, by, bw, bh, Math.max(0, r * k));
        g.stroke();
    }
}

/** 实心圆 */
function dot(g: Graphics, cx: number, cy: number, r: number, fill: string, k: number): void {
    g.fillColor = hex2color(fill);
    g.circle(XS(cx, k), YS(cy, k), Math.max(0.3, r * k));
    g.fill();
}

/** 折线段（只描边） */
function polyline(
    g: Graphics, pts: Array<[number, number]>, color: string, lineWidth: number, k: number,
): void {
    if (pts.length < 2) return;
    g.lineWidth = Math.max(0.6, lineWidth * k);
    g.strokeColor = hex2color(color);
    g.lineCap = Graphics.LineCap.ROUND;
    g.lineJoin = Graphics.LineJoin.ROUND;
    g.moveTo(XS(pts[0][0], k), YS(pts[0][1], k));
    for (let i = 1; i < pts.length; i++) g.lineTo(XS(pts[i][0], k), YS(pts[i][1], k));
    g.stroke();
}

/**
 * 绕任意中心旋转的矩形（设计坐标）。
 * SVG 的 rotate(deg, cx, cy) 在「y 向下」的坐标系里表现为顺时针，
 * 所以这里直接在**设计坐标系**里把角点算好，再交给翻转函数 ——
 * 这样旋转方向天然和设计稿一致，不需要额外取负，也就不会再翻错一次。
 */
function rotRect(
    cx: number, cy: number, w: number, h: number, deg: number,
): Array<[number, number]> {
    const rad = (deg * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const corners: Array<[number, number]> = [
        [cx - w / 2, cy - h / 2],
        [cx + w / 2, cy - h / 2],
        [cx + w / 2, cy + h / 2],
        [cx - w / 2, cy + h / 2],
    ];
    return corners.map(([px, py]) => {
        const dx = px - cx;
        const dy = py - cy;
        return [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos] as [number, number];
    });
}

/** 填充多边形（设计坐标） */
function fillPoly(g: Graphics, pts: Array<[number, number]>, fill: string, k: number): void {
    if (pts.length < 3) return;
    g.fillColor = hex2color(fill);
    g.moveTo(XS(pts[0][0], k), YS(pts[0][1], k));
    for (let i = 1; i < pts.length; i++) g.lineTo(XS(pts[i][0], k), YS(pts[i][1], k));
    g.close();
    g.fill();
}

type Cmd =
    | ['M', number, number]
    | ['L', number, number]
    | ['Q', number, number, number, number]
    | ['C', number, number, number, number, number, number];

/** 按 SVG path 的语义填充一条闭合路径（支持 M / L / Q / C） */
function fillPath(g: Graphics, cmds: Cmd[], fill: string, k: number): void {
    g.fillColor = hex2color(fill);
    for (const c of cmds) {
        switch (c[0]) {
            case 'M': g.moveTo(XS(c[1], k), YS(c[2], k)); break;
            case 'L': g.lineTo(XS(c[1], k), YS(c[2], k)); break;
            case 'Q': g.quadraticCurveTo(XS(c[1], k), YS(c[2], k), XS(c[3], k), YS(c[4], k)); break;
            case 'C':
                g.bezierCurveTo(
                    XS(c[1], k), YS(c[2], k), XS(c[3], k), YS(c[4], k), XS(c[5], k), YS(c[6], k),
                );
                break;
        }
    }
    g.close();
    g.fill();
}

// ============================================================
//  图案：三族
// ============================================================

/** 取色：常态用真牌三色，被压住用降饱和替身 */
function pickInk(key: InkKey, isDim: boolean): string {
    return isDim ? TILE_DIM[key] : TILE_INK[key];
}
function pickLight(key: InkKey, isDim: boolean): string {
    return isDim ? tint(TILE_DIM[key], 0.40) : TILE_LIGHT[key];
}
function pickDeep(key: InkKey, isDim: boolean): string {
    return isDim ? deep(TILE_DIM[key], 0.18) : TILE_DEEP[key];
}

/**
 * 竹节（条族）。
 * ⚠️ 两条硬约束，改参数前必读：
 *   1. 中央竖向高光**必须贯通**；
 *   2. 侧缺口宽必须 < (1 - 高光宽) / 2。
 * 一旦高光 + 左右缺口接起来把整根切满，竹子就变成「绷带」——这个坑踩过两次。
 */
function drawBamboo(
    g: Graphics, sp: BambooSpec, isDim: boolean, face: string, k: number,
): void {
    const [x, y, w, h, rot, inkKey] = sp;
    const col = pickInk(inkKey, isDim);
    const light = isDim ? tint(TILE_DIM[inkKey], 0.30) : tint(TILE_INK[inkKey], 0.38);

    const hw = w * G.BAMBOO_HL;                    // 高光宽
    const hl = h * G.BAMBOO_HL_LEN;                // 高光长
    const nx = w * G.BAMBOO_NOTCH;                 // 侧缺口宽
    const nh = Math.max(1.6, h * G.BAMBOO_NOTCH_H);// 侧缺口厚
    const off = h * G.BAMBOO_NOTCH_OFF;

    const straight = Math.abs(rot) < 0.01;

    if (straight) {
        rr(g, x - w / 2, y - h / 2, w, h, w / 2, k, col);
        rr(g, x - hw / 2, y - hl / 2, hw, hl, hw / 2, k, light);
        rr(g, x - w / 2, y - off - nh / 2, nx, nh, 0, k, face);
        rr(g, x + w / 2 - nx, y - off - nh / 2, nx, nh, 0, k, face);
        rr(g, x - w / 2, y + off - nh / 2, nx, nh, 0, k, face);
        rr(g, x + w / 2 - nx, y + off - nh / 2, nx, nh, 0, k, face);
        return;
    }

    // 斜竹节（8 条）：绕竹节中心旋转后按多边形填充
    fillPoly(g, rotRect(x, y, w, h, rot), col, k);
    fillPoly(g, rotRect(x, y, hw, hl, rot), light, k);
    const notches: Array<[number, number]> = [
        [x - w / 2 + nx / 2, y - off], [x + w / 2 - nx / 2, y - off],
        [x - w / 2 + nx / 2, y + off], [x + w / 2 - nx / 2, y + off],
    ];
    for (const [ncx, ncy] of notches) {
        fillPoly(g, rotRect(ncx, ncy, nx, nh, rot), face, k);
    }
}

/**
 * 圆饼（筒族）：**四层同心**，自外向内
 *   最深外环 → 同色浅调 → 族色 → 浅调心
 * ⚠️ 方向不能反，也不能用白心 —— 真牌的中间那一环是「同色提亮」，不是白点。
 *    （层次方向是过圆心做水平扫描线量出来的，不是从缩略图猜的。）
 */
function drawDisc(
    g: Graphics, sp: DiscSpec, isDim: boolean, k: number,
): void {
    const [x, y, r, inkKey] = sp;
    if (inkKey === 'special') return;   // 1 筒单独画
    const col = pickInk(inkKey, isDim);
    const lit = pickLight(inkKey, isDim);
    const dp = pickDeep(inkKey, isDim);

    dot(g, x, y, r * G.DISC[0], dp, k);
    dot(g, x, y, r * G.DISC[1], lit, k);
    dot(g, x, y, r * G.DISC[2], col, k);
    dot(g, x, y, r * G.DISC[3], lit, k);
}

/** 1 筒特例：深蓝外环 → 蓝 → 绿 → 红 → 白心（参考图实测的四层异色大盘） */
function drawDiscOne(g: Graphics, isDim: boolean, face: string, k: number): void {
    const b = pickInk('blue', isDim);
    const gr = pickInk('green', isDim);
    const rd = pickInk('red', isDim);
    const dp = pickDeep('blue', isDim);
    dot(g, G.CX, G.CY, 42, dp, k);
    dot(g, G.CX, G.CY, 36, b, k);
    dot(g, G.CX, G.CY, 26.5, gr, k);
    dot(g, G.CX, G.CY, 18, rd, k);
    dot(g, G.CX, G.CY, 10.5, face, k);
}

/**
 * 1 条（幺鸡）：照参考图配色与姿态 ——
 * 红棕羽冠（向上飘）、白脸、深蓝大眼、蓝喙朝右、蓝翅上扬、绿身、
 * 红棕长尾向左下收尖、蓝爪。
 *
 * 画法要点（这两条决定了它能不能被一眼读成鸟）：
 *   · 尾羽必须「长而尖」且朝左下 —— 短了就像个球；
 *   · 羽冠必须「飘」而不是「竖着扎」—— 竖着像天线。
 */
function drawBird(g: Graphics, isDim: boolean, face: string, k: number): void {
    const RB = isDim ? TILE_DIM.red : '#8E3A2A';       // 红棕（冠 / 尾羽）
    const BL = isDim ? TILE_DIM.blue : TILE_INK.blue;  // 蓝（眼 / 喙 / 翅 / 爪）
    const GR = isDim ? TILE_DIM.green : TILE_INK.green;// 绿（身体）

    // ① 长尾羽（三片，斜向左下收尖）
    fillPath(g, [['M', 70, 108], ['Q', 44, 126, 18, 152], ['Q', 44, 138, 78, 114]], RB, k);
    fillPath(g, [['M', 76, 112], ['Q', 58, 138, 40, 160], ['Q', 62, 148, 86, 118]], RB, k);
    fillPath(g, [['M', 88, 112], ['Q', 86, 138, 78, 161], ['Q', 94, 142, 98, 116]], RB, k);

    // ② 身体（绿，水滴形，左下沉）
    fillPath(g, [
        ['M', 80, 70],
        ['C', 96, 84, 97, 108, 81, 122],
        ['C', 65, 134, 45, 128, 39, 110],
        ['C', 33, 89, 49, 69, 66, 65],
    ], GR, k);

    // ③ 翅（蓝，右侧上扬的羽片）
    fillPath(g, [['M', 83, 74], ['C', 99, 82, 107, 100, 104, 118], ['C', 98, 102, 90, 92, 80, 86]], BL, k);

    // ④ 头（白脸 + 蓝细描边）
    g.fillColor = hex2color(face);
    g.circle(XS(74, k), YS(56, k), 16 * k);
    g.fill();
    g.lineWidth = Math.max(0.6, 1.4 * k);
    g.strokeColor = hex2color(BL);
    g.ellipse(XS(74, k), YS(56, k), 16 * k, 17 * k);
    g.stroke();

    // ⑤ 眼（蓝底 + 白高光）
    dot(g, 78, 54, 7, BL, k);
    dot(g, 80.5, 51.5, 2.4, face, k);

    // ⑥ 喙（蓝，朝右）
    fillPath(g, [['M', 88, 52], ['L', 107, 59], ['L', 88, 67]], BL, k);

    // ⑦ 羽冠（红棕，三缕细而弯，向左上 / 右上「飘」）
    fillPath(g, [['M', 63, 45], ['Q', 57, 28, 62, 12], ['Q', 71, 28, 73, 45]], RB, k);
    fillPath(g, [['M', 76, 42], ['Q', 80, 26, 90, 12], ['Q', 88, 30, 82, 44]], RB, k);
    fillPath(g, [['M', 86, 46], ['Q', 96, 36, 108, 30], ['Q', 99, 42, 90, 52]], RB, k);

    // ⑧ 腿与爪（蓝）
    polyline(g, [[63, 118], [58, 137]], BL, 4, k);
    polyline(g, [[80, 116], [85, 135]], BL, 4, k);
    polyline(g, [[49, 139], [67, 139]], BL, 3.6, k);
    polyline(g, [[77, 137], [95, 137]], BL, 3.6, k);
}

// ============================================================
//  牌体框架（国潮：宣纸底 + 墨线双框 + 朱红角花 + 硬直角）
// ============================================================

/**
 * ★ S14.1：把一张牌画成**厚牌** —— 投影 → 厚度壁 → 顶面（顺序不能变）。
 *
 * 【为什么不是"描两圈边"】
 * 立体感的来源只有一条：**同一个轮廓在不同高度上出现两次**。
 * 下移的那一份是"牌的另一端"，两份之间的那条带子就是"厚"。
 * 所以厚度不是描边粗细的问题，是**位移**的问题 —— 这也是最容易做错的地方：
 * 只要把厚度壁画在顶面**之外**（比如四周均匀外扩），立刻变成"描边变粗"。
 *
 * 【为什么投影要画多层】
 * Graphics 只有硬边填充，没有模糊。硬边投影在牌堆里会变成一堆黑杠
 * （尤其牌挨得近时），所以用 N 层同心矩形、每层 1/N 不透明度叠出渐变边缘。
 * 从**最大最外**开始画、逐层收小 —— 叠出来就是"中间浓、边缘淡"。
 *
 * ⚠️ 所有几何量都按设计坐标（132 宽）描述，由 k 统一缩放。
 *    这样"牌越小、厚度越薄"是自动的，不需要每关单独配。
 */
function drawSolid(g: Graphics, isDim: boolean, k: number): void {
    const S = CFG.TILE.SOLID;
    const B = G.BODY;

    // ① 投影：从最大（最外）逐层收到最小
    const layers = Math.max(1, S.SHADOW_LAYERS);
    for (let i = layers - 1; i >= 0; i--) {
        const sp = S.SHADOW_SPREAD * i;
        rr(
            g, B.x + S.SHADOW_DX - sp, B.y + S.SHADOW_DY - sp,
            B.w + sp * 2, B.h + sp * 2, B.r + sp, k,
            CFG.COLOR.SHADOW, undefined, 0, S.SHADOW_ALPHA,
        );
    }

    // ② 厚度壁：牌体轮廓整体下移 DEPTH、右移 SIDE_DX
    rr(
        g, B.x + S.SIDE_DX, B.y + S.DEPTH, B.w, B.h, B.r, k,
        isDim ? S.SIDE_DIM : S.SIDE, S.SIDE_EDGE, B.line * 0.7,
    );
}

function drawFrame(g: Graphics, isDim: boolean, k: number): void {
    const face = isDim ? CFG.COLOR.FACE_DIM : CFG.COLOR.FACE;
    const frameCol = isDim ? CFG.COLOR.LOCK : CFG.COLOR.INK;
    const B = G.BODY;

    // ① 牌体
    rr(g, B.x, B.y, B.w, B.h, B.r, k, face, frameCol, B.line);

    // ② 内墨线（中式装帧的内细框）
    g.lineWidth = Math.max(0.5, G.INNER.line * k);
    g.strokeColor = hex2color(frameCol, isDim ? 90 : 160);
    g.roundRect(
        XS(G.INNER.x, k), YS(G.INNER.y + G.INNER.h, k),
        G.INNER.w * k, G.INNER.h * k, G.INNER.r * k,
    );
    g.stroke();

    // ③ 四角朱红角花（8 条短线段，成本极低、国潮味最重）
    //    ⚠️ 被压住的牌不画角花 —— 角花是有「神气」的装饰，压在底下就不该有
    if (!isDim) {
        const c = G.CORNER;
        const i0 = G.INNER.x;
        const i1 = G.INNER.x + G.INNER.w;
        const j0 = G.INNER.y;
        const j1 = G.INNER.y + G.INNER.h;
        polyline(g, [[i0, j0 + c], [i0, j0], [i0 + c, j0]], CFG.COLOR.VERMILION, G.CORNER_LINE, k);
        polyline(g, [[i1 - c, j0], [i1, j0], [i1, j0 + c]], CFG.COLOR.VERMILION, G.CORNER_LINE, k);
        polyline(g, [[i1, j1 - c], [i1, j1], [i1 - c, j1]], CFG.COLOR.VERMILION, G.CORNER_LINE, k);
        polyline(g, [[i0 + c, j1], [i0, j1], [i0, j1 - c]], CFG.COLOR.VERMILION, G.CORNER_LINE, k);
    }
}

// ============================================================
//  TileView：一张牌的节点封装
// ============================================================

export class TileView {

    public readonly node: Node;
    private readonly _g: Graphics;
    private readonly _fam: Family;
    private readonly _num: number;
    private readonly _key: PatternKey;
    private readonly _w: number;
    private _state: TileState = 'normal';

    /** 万子的两个字（数字 / 萬），其它族为 null */
    private _numLabel: Label | null = null;
    private _wanLabel: Label | null = null;

    constructor(parent: Node, key: PatternKey, w: number) {
        const p = parsePattern(key);
        this._key = key;
        this._fam = p.fam;
        this._num = p.num;
        this._w = w;

        const h = w * (G.H / G.W);
        this.node = new Node(`Tile_${key}`);
        this.node.layer = Layers.Enum.UI_2D;
        parent.addChild(this.node);
        const ui = this.node.addComponent(UITransform);
        ui.setAnchorPoint(0.5, 0.5);
        ui.setContentSize(w, h);

        this._g = this.node.addComponent(Graphics);
        this.node.addComponent(UIOpacity);

        if (this._fam === 'wan') this._buildWanLabels(w, h);
        this.redraw();
    }

    public get key(): PatternKey { return this._key; }

    /** 牌面宽度（槽位里会用更小的尺寸重建，所以对外暴露一手） */
    public get width(): number { return this._w; }

    /**
     * 万子文字。
     *
     * 【为什么位置要这样算】
     * SVG 的 text 是以**基线**定位的，而 Label 是以**字框**（含升降部留白）居中定位的。
     * 设计稿给的 72 / 144 是基线；实测宋体汉字的墨迹中心大约在基线往上 0.30em，
     * 所以这里先把基线换算成「墨迹中心」，再乘以缩放交给 Label 居中 ——
     * 直接用基线的原始值会让整块字明显偏下（这个坑在设计稿阶段踩过一次）。
     */
    private _buildWanLabels(w: number, h: number): void {
        const k = w / G.W;
        const serif = CFG.FONT.SERIF ? `${CFG.FONT.SERIF}, STSong, SimSun, serif` : '';

        // 墨迹中心（设计坐标）≈ 基线 - 0.30 × 字号
        const numCenter = G.WAN_NUM_Y - G.WAN_NUM_SIZE * 0.30;
        const wanCenter = G.WAN_CHAR_Y - G.WAN_CHAR_SIZE * 0.30;

        const mk = (text: string, fontSize: number, centerY: number, color: string): Label => {
            const n = new Node('Glyph');
            n.layer = Layers.Enum.UI_2D;
            this.node.addChild(n);
            const ui = n.addComponent(UITransform);
            ui.setAnchorPoint(0.5, 0.5);
            const lb = n.addComponent(Label);
            lb.string = text;
            lb.fontSize = fontSize * k;
            lb.lineHeight = fontSize * k * 1.05;
            lb.isBold = true;
            lb.color = hex2color(color);
            lb.horizontalAlign = Label.HorizontalAlign.CENTER;
            lb.verticalAlign = Label.VerticalAlign.CENTER;
            lb.overflow = Label.Overflow.NONE;
            lb.useSystemFont = true;
            if (serif) lb.fontFamily = serif;
            n.setPosition(0, YS(centerY, k), 0);
            return lb;
        };

        this._numLabel = mk(WAN_NUM[this._num - 1], G.WAN_NUM_SIZE, numCenter, TILE_INK.blue);
        this._wanLabel = mk('萬', G.WAN_CHAR_SIZE, wanCenter, TILE_INK.red);
    }

    /** 切换状态（只在真正变化时重绘，避免每帧无谓的顶点重建） */
    public setState(state: TileState): void {
        if (this._state === state) return;
        this._state = state;
        this.redraw();
    }

    public get state(): TileState { return this._state; }

    /** 被压住 = 降饱和 + 降透明度（降透明度单独用会「发飘」，配降饱和才像被压住） */
    private _applyDimTint(isDim: boolean): void {
        const col = isDim ? TILE_DIM.blue : TILE_INK.blue;
        const col2 = isDim ? TILE_DIM.red : TILE_INK.red;
        if (this._numLabel) this._numLabel.color = hex2color(col);
        if (this._wanLabel) this._wanLabel.color = hex2color(col2);
        const op = this.node.getComponent(UIOpacity);
        if (op) op.opacity = isDim ? 174 : 255;
    }

    /** 完整重绘 */
    public redraw(): void {
        const k = this._w / G.W;
        const isDim = this._state === 'dim';
        const g = this._g;
        g.clear();

        // ★ S14.1：先铺投影与厚度壁，牌面压在上面 —— 这就是"厚"的全部秘密
        drawSolid(g, isDim, k);
        drawFrame(g, isDim, k);

        const face = isDim ? CFG.COLOR.FACE_DIM : CFG.COLOR.FACE;
        if (this._fam === 'wan') {
            // 万子只有文字，没有图形图案
        } else if (this._fam === 'sou') {
            const layout = SOU_LAYOUT[this._num];
            if (layout === null || layout === undefined) {
                drawBird(g, isDim, face, k);
            } else {
                for (const sp of layout) drawBamboo(g, sp, isDim, face, k);
            }
        } else {
            if (this._num === 1) drawDiscOne(g, isDim, face, k);
            else for (const sp of TON_LAYOUT[this._num]) drawDisc(g, sp, isDim, k);
        }

        // 选中态：牌体外围再套一圈朱红（不遮牌面，一眼能看出"我点的是这张"）
        // ⚠️ 线宽取自 CFG.MOTION.PICK_OUTLINE 而不是 TILE_GEO.PICK_LINE：
        //    选中描边是**手感参数**（S7 会按"看一眼能不能立刻找到它"来调），
        //    不该混在牌面几何资产里。
        if (this._state === 'pick') {
            const o = G.PICK_OFFSET;
            g.lineWidth = CFG.MOTION.PICK_OUTLINE * k;
            g.strokeColor = hex2color(CFG.COLOR.VERMILION);
            g.roundRect(
                XS(G.BODY.x - o, k), YS(G.BODY.y + G.BODY.h + o, k),
                (G.BODY.w + o * 2) * k, (G.BODY.h + o * 2) * k, 10 * k,
            );
            g.stroke();
        } else if (this._state === 'clear') {
            const o = G.PICK_OFFSET;
            g.lineWidth = G.PICK_LINE * k;
            g.strokeColor = hex2color(CFG.COLOR.GOLD);
            g.roundRect(
                XS(G.BODY.x - o, k), YS(G.BODY.y + G.BODY.h + o, k),
                (G.BODY.w + o * 2) * k, (G.BODY.h + o * 2) * k, 10 * k,
            );
            g.stroke();
        }

        this._applyDimTint(isDim);
    }

    public destroy(): void {
        if (this.node && this.node.isValid) this.node.destroy();
    }
}

// ============================================================
//  小工具：给外部（比如结算页）单独画一张牌当装饰
// ============================================================

/** 快速创建一个独立展示用的牌节点（菜单页的三张展示牌、关卡页卡片里的小牌） */
export function createShowcaseTile(
    parent: Node, key: PatternKey, w: number, state: TileState = 'normal',
): TileView {
    const v = new TileView(parent, key, w);
    v.setState(state);
    return v;
}

/** 把节点摆到指定位置（避免各处重复写 Vec3） */
export function placeAt(node: Node, x: number, y: number): void {
    node.setPosition(new Vec3(x, y, 0));
}
