/**
 * ============================================================
 *  UIFactory.ts · 代码建 UI 工具箱（S19 · 位图底图 + 3D 厚描边控件）
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
 * ============================================================
 *  ★ S19 改版（2026-10-02）：从「扁平矢量国潮」升级为「Q版3D 糖果质感」
 * ============================================================
 *  【分工彻底变了，改之前先读这一段】
 *     · **贴图层**（位图）：宣纸纸纹 / 朱红双线页框 / 四角回纹角花 / 首页的全部装饰
 *     · **控件层**（本文件用 Graphics + Label 画）：按钮 / 进度条 / 牌堆 / 槽位条 /
 *       道具栏 / 面板 / 所有文字
 *  ⚠️ 所以 `createPageFrame` 已经**不再画任何东西**（页框在贴图里了）；
 *     再画一遍就是**重影** —— 这是这次改版最容易踩的坑。
 *
 *  【3D 控件的画法：设计稿的 CSS 逐条搬过来】
 *  控件形制来自 `docs/design/game4-3d-refit/*-优化后-1x.html` 的 CSS。
 *  CSS 里的 `box-shadow: 0 Npx 0 深色, 0 Npx 0 4px 墨` 翻译成三层绘制：
 *      ① 墨色外圈（比面层大 2×border，向下偏 N）
 *      ② 厚度色块（同尺寸，向下偏 N）
 *      ③ 面层（墨线描边 + 竖向渐变 + 顶部高光带）
 *  绘制顺序不能反 —— 反了就是"厚度压在面层上"。
 *
 *  【Graphics 没有渐变，所以渐变是"分段 + 每段各自颜色"】
 *  与 `drawSlit` / `PEDESTAL_ALPHA` 同一套思路，只是这里要**同时**照顾圆角：
 *  每一段是一条**梯形**，两条腰按圆角矩形的真实轮廓收进去
 *  （见 `halfWidthAt`）。直接填直角矩形的话，圆角会被切成方角。
 *  分段数按控件高度自适应（`max(GRAD_SEGS, h/5)`）——
 *  大圆角控件（胶囊 155 高）用固定 6 段会看出明显的多边形状缺口。
 * ============================================================
 */

import {
    Color, Graphics, Label, LabelOutline, Layers, Node, Rect, Size, Sprite, SpriteFrame,
    UIOpacity, UITransform, resources, view, tween, Tween, v3, warn,
} from 'cc';

import { CFG } from '../CFG';
import { hex2color } from './TileRenderer';

export { hex2color };

// ============================================================
//  绘制基元（全部以「节点中心」为原点）
// ============================================================

/**
 * ⚠️⚠️ **圆角必须先自己夹到 `min(w,h)/2` 再交给引擎**（S22 踩过，全站胶囊都受影响）。
 *
 * 【为什么】Cocos `Graphics.roundRect(x,y,w,h,r)` 内部是把两个方向的半径**分别**夹的：
 *     ```js
 *     var rx = min(r, abs(w) * 0.5) * sign(w);
 *     var ry = min(r, abs(h) * 0.5) * sign(h);
 *     ```
 *   于是传 `r = RADIUS_PILL = 999` 时，rx 被夹成 `w/2`、ry 被夹成 `h/2` —— **rx ≠ ry**，
 *   四个角变成**椭圆弧**，整块读成**椭圆**而不是胶囊。
 *   实测（`局内-优化后-1x.png` 返回键，180×56）：
 *     · 设计稿 y1093（脸顶描边）横带跨 x 233~365（胶囊的平顶）；
 *     · 当时渲染出来只跨 x 257~343（椭圆的顶），左右各少了 24px。
 *   外圈更夸张：188×64 传 1003 → rx=94 / ry=32，鼓成一个**杏仁形**，
 *   在按钮两端"突出"出来 —— 用户 2026-10-02 反馈的"边缘突出"就是这个。
 *
 * 【注意】同一个 `draw3dFace` 里，渐变面层走的是 `halfWidthAt()`，
 *   那个函数**本来就正确地夹了**（`R = min(r, min(w,h)/2)`）→ 是**真胶囊**。
 *   结果是"描边/外圈是椭圆、里面的渐变是胶囊"，两张皮叠在一起，边缘能不脏吗。
 *
 * 【修法】在这里把半径夹成 `min(w,h)/2`，此时 rx == ry == min(w,h)/2 → **正圆角** → 真胶囊。
 *   对本来就小的圆角（面板 16、槽位条 14、重玩 22…）`min()` 不生效，**不会改变任何既有形制**。
 *   这也正是 CSS `border-radius` 的语义（每个角的半径不得超过 `min(w,h)/2`）。
 */
function clampRadius(w: number, h: number, r: number): number {
    return Math.max(0, Math.min(r, Math.min(Math.abs(w), Math.abs(h)) / 2));
}

/** 填充圆角矩形（中心定位） */
export function fillBox(
    g: Graphics, cx: number, cy: number, w: number, h: number, r: number,
    fill: string, alpha = 255,
): void {
    g.fillColor = hex2color(fill, alpha);
    g.roundRect(cx - w / 2, cy - h / 2, w, h, clampRadius(w, h, r));
    g.fill();
}

/** 描边圆角矩形（中心定位） */
export function strokeBox(
    g: Graphics, cx: number, cy: number, w: number, h: number, r: number,
    color: string, lineWidth: number, alpha = 255,
): void {
    g.lineWidth = lineWidth;
    g.strokeColor = hex2color(color, alpha);
    g.roundRect(cx - w / 2, cy - h / 2, w, h, clampRadius(w, h, r));
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
 *
 * ⚠️ S19 起它的用武之地**大幅收窄**：新版控件是"圆角 + 厚描边"，
 *    与硬直角的角花语言不同，所以按钮 / 面板都不再画角花。
 *    保留它是因为 3D 面板内那道细线框、以及未来可能回来的装饰仍可能用上。
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
//  ★★★ 铁律：**UIOpacity 只能用来做两件事 —— 归零、或整层到满** ★★★
//     凡目标值是"中间值"（10% / 50% …），或一块 Graphics 内部有多档 alpha，
//     都必须用 `alphaPainter` 把 alpha **烘焙进绘制参数**。
// ============================================================
//
//  【先说结论 —— 它是"会生效，但生效的方式会骗你"】
//  在这条铁律上本工程**翻过三次车**，每次都是"凭直觉写、看不出错在哪"，
//  所以下面把机制写死，别再靠猜。一句话版：
//
//     · 目标值 **0**（引擎里整棵子树直接跳过渲染）→ UIOpacity 可以；
//     · 目标值 **255** 且整层内部单档（如 `_hudLayer` 整层淡入）→ 可以用，
//       因为"顶点回落值"恰好**就等于**它想要的值；
//     · 目标值是**中间值**（0.10 / 0.5 …）→ **必须 `alphaPainter`**；
//     · 一块 Graphics 内部有**多档 alpha**（晕 / 分层阴影）→ **必须 `alphaPainter`**。
//
//  第三条是 S18.5 失败动效的"全屏黑屏"换来的（整屏变成不透明的 `#22201C`），
//  成因见下面性质 ② —— 那一版就是照旧的、更宽松的判据写的。
//
//  【机制：UIOpacity 不是"乘上去"，是"覆写掉"（引擎源码 + 实测双确认）】
//  ① `cocos/2d/components/ui-opacity.ts`：`opacity` setter 写的是
//     `node._uiProps.localOpacity`，并把 `colorDirty` 置 true。
//  ② `cocos/2d/renderer/batcher-2d.ts` 的 `walk()`：
//        this._pOpacity = opacity *= selfOpacity * uiProps.localOpacity;
//     也就是**透明度沿子树逐级相乘**，并且只要本节点脏，`_opacityDirty` 就 +1。
//  ③ 同一文件的 `_handleUIRenderer()`：
//        if (opacityDirty && vertexCount > 0) {
//            switch (render.getFillColorType()) {
//            case RenderEntityFillColorType.COLOR:  updateOpacity(renderData, finalOpacity);
//            case RenderEntityFillColorType.VERTEX: /* do nothing */
//            }
//        }
//     `Graphics` **从不**调用 `setFillColorType`（全工程只有 spine /
//     dragon-bones 会设成 VERTEX），所以它一律走 COLOR 那一支。
//  ④ 关键在 `updateOpacity()` 的实现（`2d/assembler/utils.ts`）——
//     它把每一个顶点的 alpha 通道**整个替换**成 `finalOpacity`：
//        vb[i] = (vb[i] & 0x00ffffff) | (alpha << 24)
//     **不是**在原有 alpha 上乘一个系数。
//  ⑤ 于是：一块 Graphics 里若有 `INK@0.28 / INK@0.13 / INK@0.07 / INK@0.045`
//     四层同心圆，只要它（或它的任一祖先）这一帧是脏的，四层的 alpha 会被
//     **一起抹平**成同一个值 —— 画面上就是**一块纯色实心圆**，层次全丢。
//     这就是 S18 开场墨晕一开始"四层晕变成一枚黑饼"的真实成因。
//
//  【三条曾经骗过我们的性质 —— 逐条纠偏】
//
//  ① `opacity = 0` 是**硬开关**：`walk()` 里有 `visable = !approx(opacity, 0)`，
//     为假时整棵子树直接跳过。所以 `opacity: 0 → 255` 的"容器淡入"看起来很
//     正常（0 是不可见，>0 立刻全见），很容易让人以为"UIOpacity 对 Graphics 有效"。
//
//  ② "覆写会自己恢复"—— **只对多档图形成立，别拿它给单档开脱**。
//     `Graphics` 会把顶点数据从它自己记录下来的路径重新上传，所以 opacity
//     不再脏之后，顶点 alpha 回落到 **`fillColor` 当初烘焙的那个值**：
//       · 多档图形（四层墨晕）：回落 = 各层各自的 alpha → 分层**会回来**。
//         实测：牌局稳定后采样牌的投影，仍是设计的 `SHADOW_ALPHA=52` 三层叠加
//         （不是被抹成的纯 `#22201C`）—— 见 `tools/probe-bloom.py`。
//       · 目标非 255 的单档图形：回落 = 烘焙时的 255 → **比设计值更不透明，
//         而且再也不会自己变回来**。
//     ★ 这就是 S18.5 失败动效"全屏黑屏"的成因 ★
//         `dim` 层是一整块全屏 INK 矩形（`fillColor` alpha=255），
//         用 UIOpacity 淡到 0.10：
//           · tween 期间（0.27→0.45s）每帧都脏 → 每帧被覆写成 25 → 看着完全正常；
//           · tween 一停 → 顶点被重建 → 回落成 255 → **永久全黑**。
//         冒烟连拍取证：300ms 纸色 251,246,234 正常 → 520ms 起整屏 `#22201C`
//         （四角与中心完全同值、纯黑占比 0%）→ +3700ms 仍全黑，失败面板
//         "已开"却被这一层整个盖住。
//     ⚠️ 反过来说：**在它脏着的那段时间里，画面确实是抹平的**。
//     所以"给某层容器做淡入"时，那一层里的分层阴影/墨晕在这段时间里会变平。
//
//  【实测取证（别再怀疑，也别再重跑一遍）】
//  `tools/probe-bloom.py` 把截图沿一条过圆心的直线做径向采样，反解出每个半径
//  处的墨浓度。四层墨晕修好后实测得到 5 档平台，与设计值逐档吻合到 1% 以内：
//      半径 0–8   浓度 1.000   ← 墨心（设计 α=1.0）
//      半径 10–33 浓度 0.393   ← 四层叠合（设计 1−0.78×0.87×0.93×0.96 = 0.396）
//      半径 35–75 浓度 0.227   ← 三层叠合（设计 0.223）
//      半径 80–125 浓度 0.111  ← 两层叠合（设计 0.106）
//      半径 130–195 浓度 0.042 ← 最外那一层（设计 0.039）
//  修之前，同一个探针在同一时刻只读到**一个**值（0.99+，纯 `#22201C`）。
//  **判据就是"平台数量"**：≥3 档 = 分层活着；只有 1 档 = 被抹平了。
//
//  【正确的做法：烘焙 alpha + 重绘（`alphaPainter`）】
//  把 alpha 当作**绘制参数**而不是节点属性，每帧重画：
//      const rd = alphaPainter(g, (gg, a) => fillCircle(gg, 0, 0, r, INK, a), 0);
//      tween(rd).to(0.15, { a: 0.28 }, { onUpdate: rd.redraw })
//               .to(0.15, { a: 0.22 }, { onUpdate: rd.redraw }).start();
//  代价是每帧一次 `clear()` + 重绘。本工程的量级：一段动效里最多 4~6 个
//  这样的节点、每个只画 1~2 个图元，**远小于同屏 96 张牌的开销**。
//
//  ★ 目标值是"中间值"时**走的也是这条路，写法一模一样**，差别只在 `paint`
//    里把 `a` 用在哪。反例就是上面那个黑屏的压暗层，正确写法：
//        const rd = alphaPainter(dim.g, (g, a) => {
//            g.fillColor = hex2color(CFG.COLOR.INK, a);
//            g.rect(-W * 0.7, -H * 0.7, W * 1.4, H * 1.4);
//            g.fill();
//        }, 0);
//        tween(rd).delay(0.27).to(0.18, { a: 0.10 }, { onUpdate: rd.redraw })
//                 .call(rd.redraw).start();
//
//  ⚠️⚠️ 还有一条更隐蔽的：**祖先的 UIOpacity 一样会抹平后代**。
//      `PageManager.open()` 给每个页面节点挂了一个 UIOpacity 做转场淡入，
//      在它脏着的那 220ms 里，**整页所有 Graphics 的分层都是被抹平的**。
//      所以：
//        · 要做"多档 alpha 的晕"（本文件里就是 `alphaPainter` 的用武之地），
//          别把它放在一个正在被 UIOpacity 淡入淡出的容器里；
//        · 反过来，`GamePage` 的 `_hudLayer` / `_stackLayer` 这种"整层一起淡"
//          的用法是**正确**的 —— 它们要的就是"整层统一一个透明度"。
// ============================================================

/**
 * 「烘焙 alpha + 重绘」的小工具 —— **要给 Graphics 调透明度的唯一正确姿势**。
 *
 * ⚠️ 适用面比"多档 alpha"更宽，两种情形**都必须**用它：
 *    ① 一块 Graphics 内部有**两档以上不同的 alpha**（晕 / 分层阴影）
 *       —— UIOpacity 会把它们一起抹平成同一个值（见铁律第 ⑤ 点）；
 *    ② 目标透明度是**中间值**（10% 的压暗层、50% 的遮罩…）
 *       —— UIOpacity 的覆写**留不住**，顶点一重建就回落成 255（全不透明）。
 *    只有"目标 0"和"目标 255 且内部单档"这两种情形才轮得到 UIOpacity。
 *
 * 用法（三步）：
 *   ① `const rd = alphaPainter(g, (gg, a) => drawSomething(gg, ..., a), 0);`
 *   ② 把 `rd` 当作补间目标：`tween(rd).to(0.2, { a: 1 }, { onUpdate: rd.redraw })`
 *   ③ 补间结束后补一次 `.call(rd.redraw)` —— 保证末帧是精确值而不是近似值
 *
 * ⚠️ `onUpdate` 必须**每一段 `.to()` 都写**：只写在最后一段的话，
 *    前面几段不会重绘（画面上表现为"前两段没动画，最后一段突然动"）。
 *
 * @param g     要驱动的 Graphics
 * @param paint 真正的绘制函数。`alphaPainter` 只负责 `clear()`，
 *              其余绘制全由它负责；它的 `alpha` 参数已经是 0~255 的整数
 * @param initA 初始 alpha（0~1）
 */
export function alphaPainter(
    g: Graphics,
    paint: (g: Graphics, alpha255: number) => void,
    initA = 1,
): { a: number; redraw: () => void } {
    const holder = {
        a: initA,
        redraw: (): void => {
            if (!g || !g.isValid) return;
            g.clear();
            // a <= 0 时干脆不画：留着上一帧的图形在真机上会看到"残影"
            if (holder.a <= 0.002) return;
            const v = Math.max(0, Math.min(1, holder.a));
            paint(g, Math.round(v * 255));
        },
    };
    holder.redraw();
    return holder;
}

// ============================================================
//  绘制基元 · 圆 / 椭圆 / 多边形（S18 追加）
// ============================================================
//
//  【为什么这七个要自己包】
//  原工具箱只有「圆角矩形（填充/描边）+ 折线 + 文字」三类，
//  而 S18 的三段动效（开场墨晕 / 通关印泥 / 失败溅墨）全都要画圆和椭圆。
//  这七个函数**只追加、不改任何现有函数签名** —— 现有页面一行都不用动。
//
//  【为什么全部走"折线逼近"而不是 Graphics.arc / circle / ellipse】
//  ① `arc()` 的 `counterclockwise` 参数在「y 轴朝上」的坐标系里极易搞反，
//     而反了的画法在视觉上只是"少了一块"，构建期不报错、截图才看得出来；
//  ② 开场「墨圆从正中裂开」要求左右两半**共享完全相同的端点坐标**，
//     接缝才看不出。自己出点可以按住这两个端点；
//  ③ 一个代码路径（`arcPoly`）覆盖圆 / 椭圆 / 半圆 / 半环四种需求，
//     不会出现"圆的实现和椭圆的实现不一样"这种事。
//  64 段折线在 r=200 时弦高只有 0.24px —— 比屏幕像素还小，肉眼不可见。
// ============================================================

/**
 * 把一段椭圆弧转成折线（私有）。
 * @param a0 起始角（弧度，0 = 正右、逆时针为正）
 * @param a1 结束角
 * @param seg 折线段数。默认 64（弦高 < 0.3px）
 */
function arcPoly(
    g: Graphics, cx: number, cy: number, rx: number, ry: number,
    a0: number, a1: number, seg = 64,
): void {
    for (let i = 0; i <= seg; i++) {
        const a = a0 + (a1 - a0) * (i / seg);
        const x = cx + Math.cos(a) * rx;
        const y = cy + Math.sin(a) * ry;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
    }
}

/** 实心圆（开场四层墨晕、失败溅墨的墨点都用它） */
export function fillCircle(
    g: Graphics, cx: number, cy: number, r: number, fill: string, alpha = 255,
): void {
    g.fillColor = hex2color(fill, alpha);
    arcPoly(g, cx, cy, r, r, 0, Math.PI * 2);
    g.close();
    g.fill();
}

/**
 * 实心半圆盘（开场「墨圆从正中裂开」的左 / 右两半）。
 * @param side 负 = 左半、正 = 右半
 */
export function fillHalfDisc(
    g: Graphics, cx: number, cy: number, r: number, side: number,
    fill: string, alpha = 255,
): void {
    g.fillColor = hex2color(fill, alpha);
    // ⚠️ BUTT：两半拼合时接缝才看不出（ROUND 会在接缝处各撑出一个半圆帽）
    g.lineCap = Graphics.LineCap.BUTT;
    const a0 = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    const a1 = side < 0 ? Math.PI * 1.5 : Math.PI / 2;
    g.moveTo(cx, cy);
    arcPoly(g, cx, cy, r, r, a0, a1);
    g.close();
    g.fill();
}

/** 半圆环（描边，不闭合）—— 开场墨圆最外那道 2.6px 环的两半 */
export function strokeHalfRing(
    g: Graphics, cx: number, cy: number, r: number, side: number,
    color: string, lineWidth: number, alpha = 255,
): void {
    g.lineWidth = lineWidth;
    g.strokeColor = hex2color(color, alpha);
    g.lineCap = Graphics.LineCap.BUTT;
    const a0 = side < 0 ? Math.PI / 2 : -Math.PI / 2;
    const a1 = side < 0 ? Math.PI * 1.5 : Math.PI / 2;
    arcPoly(g, cx, cy, r, r, a0, a1);
    g.stroke();
}

/** 实心椭圆（首页圆台的 3 层同心淡出） */
export function fillEllipse(
    g: Graphics, cx: number, cy: number, rx: number, ry: number,
    fill: string, alpha = 255,
): void {
    g.fillColor = hex2color(fill, alpha);
    arcPoly(g, cx, cy, rx, ry, 0, Math.PI * 2);
    g.close();
    g.fill();
}

/**
 * 椭圆弧**描边**（不闭合）—— S18.2 追加。
 *
 * 【它的四个特例】圆 / 椭圆 / 半圆环 / 椭圆下半弧 全都由它一个函数覆盖：
 *   · 全圆：a0 = 0、a1 = 2π、rx = ry
 *   · 半圆环：a0 = −π/2、a1 = +π/2（右半）
 *   · 首页圆台外环：a0 = π、a1 = 2π（下半圈，y 向上坐标系里就是"只留下半截"）
 * 单独包出来是为了让"画一段弧"这件事不必每次自己写角度。
 *
 * @param a0 起始角（弧度，0 = 正右、**逆时针**为正 —— 与 Cocos `node.angle` 的
 *           "顺时针为正"不是一回事，见 CFG.rotatedVisualBox 的口径说明）
 */
export function strokeArc(
    g: Graphics, cx: number, cy: number, rx: number, ry: number,
    a0: number, a1: number, color: string, lineWidth: number, alpha = 255,
): void {
    g.lineWidth = lineWidth;
    g.strokeColor = hex2color(color, alpha);
    g.lineCap = Graphics.LineCap.BUTT;
    arcPoly(g, cx, cy, rx, ry, a0, a1);
    g.stroke();
}

/** 描边椭圆（首页圆台外圈那道靛青环，整圈） */
export function strokeEllipse(
    g: Graphics, cx: number, cy: number, rx: number, ry: number,
    color: string, lineWidth: number, alpha = 255,
): void {
    strokeArc(g, cx, cy, rx, ry, 0, Math.PI * 2, color, lineWidth, alpha);
}

/** 实心多边形（首页「当前关」刻度头顶那枚 10×6 小三角） */
export function fillPoly(
    g: Graphics, pts: Array<[number, number]>, fill: string, alpha = 255,
): void {
    if (pts.length < 3) return;
    g.fillColor = hex2color(fill, alpha);
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.close();
    g.fill();
}

/**
 * 竖向细缝（首页中轴竖缝）。
 *
 * 【为什么叫"缝"却用 6 个实心方块拼】Graphics 没有渐变能力。
 * 想要「上浓下淡」只有一条路：**分段 + 每段各自的透明度**。
 * 6 段是实测的甜点 —— 4 段能看出台阶，8 段以上在 662px 的长度上白白多出两次
 * draw call 而看不出差别。
 *
 * @param cyTop    缝的顶端 y（向下延伸）
 * @param totalH   缝的总高
 * @param segs     分几段
 * @param alphaTop 顶端透明度（0–255）
 * @param alphaBottom 底端透明度（0–255）
 */
export function drawSlit(
    g: Graphics, cx: number, cyTop: number, w: number, totalH: number,
    segs: number, color: string, alphaTop: number, alphaBottom: number,
): void {
    const segH = totalH / segs;
    for (let i = 0; i < segs; i++) {
        const t = segs <= 1 ? 0 : i / (segs - 1);
        fillBox(g, cx, cyTop - segH * (i + 0.5), w, segH, 0, color,
            alphaTop + (alphaBottom - alphaTop) * t);
    }
}

/**
 * 建一个「自带 Graphics 的节点」—— 画任何自绘图形的标准起手式。
 * 只是把 `createNode + addComponent(Graphics)` 这两行收成一行，
 * 避免每个动效文件里重复十几次。
 */
export function createGraphicsNode(
    name: string, parent: Node, opts: NodeOpts = {},
): { node: Node; g: Graphics } {
    const node = createNode(name, parent, opts);
    return { node, g: node.addComponent(Graphics) };
}

// ============================================================
//  ★ S19 新增：3D 厚描边控件的绘制内核
// ============================================================

/**
 * 圆角矩形在「距中心 dy」处的水平半宽。
 *
 * 【它为什么是这套 3D 控件的地基】
 * Graphics 没有渐变，渐变只能"分段 + 每段一个颜色"；
 * 而每一段只要用直角矩形填，圆角就会被切成方角 ——
 * 分段越细，切出来的多边形越明显。
 * 正解是每段画成**梯形**，两条腰按圆角的真实轮廓收进去，这个函数就是那条轮廓。
 *
 * 圆角矩形的轮廓分三段（以中心为原点、y 向上）：
 *   |dy| ≤ h/2 − r  →  直腰，半宽 = w/2
 *   |dy| >  h/2 − r  →  圆弧，半宽 = w/2 − r + √(r² − (|dy| − (h/2 − r))²)
 */
function halfWidthAt(w: number, h: number, r: number, dy: number): number {
    const hw = w / 2;
    const R = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    const sy = Math.abs(dy);
    const flat = h / 2 - R;
    if (sy <= flat) return hw;
    if (sy >= h / 2) return Math.max(0, hw - R);
    const k = sy - flat;
    return hw - R + Math.sqrt(Math.max(0, R * R - k * k));
}

/**
 * 把一段 hex 抠成 [r,g,b]（0–255）。只在本文件的渐变插值里用。
 * 「按位置取色」这件事不适合每次 `new Color`，所以走纯数字。
 */
function rgbOf(hex: string): [number, number, number] {
    const h = hex.replace('#', '');
    return [
        parseInt(h.slice(0, 2), 16),
        parseInt(h.slice(2, 4), 16),
        parseInt(h.slice(4, 6), 16),
    ];
}

/**
 * 在一组等距色标上按位置 p（0 = 最上、1 = 最下）取色（线性插值）。
 *
 * ⚠️ 为什么要插值而不是"四舍五入挑一个"：本工程的色标是 6 档，
 *    而分段数会按控件高度自适应到 30+ 段（见 `drawGradFace`）。
 *    直接挑一个会导致**相邻两三段同色**，在浅色控件上看得出来是"色带"。
 */
function samplePalette(stops: string[], p: number): [number, number, number] {
    const n = stops.length;
    if (n === 1) return rgbOf(stops[0]);
    const t = Math.max(0, Math.min(1, p)) * (n - 1);
    const i = Math.min(n - 2, Math.floor(t));
    const u = t - i;
    const a = rgbOf(stops[i]);
    const b = rgbOf(stops[i + 1]);
    return [
        Math.round(a[0] + (b[0] - a[0]) * u),
        Math.round(a[1] + (b[1] - a[1]) * u),
        Math.round(a[2] + (b[2] - a[2]) * u),
    ];
}

/** 分段数：至少 GRAD_SEGS，且高度每 5px 一段（大圆角控件才不会切出多边形缺口） */
function gradSegs(h: number): number {
    return Math.max(CFG.SKIN.R3D.GRAD_SEGS, Math.min(64, Math.ceil(Math.abs(h) / 5)));
}

/**
 * 竖向渐变圆角矩形（**3D 控件面层的地基**）。
 *
 * @param stops  色标，第 0 个在最上、最后一个在最下（等距）
 * @param alpha  整块的不透明度（0–255）。给中间值时也**必须**走这里重画，
 *               不要外面套 UIOpacity（见文件头的铁律）
 */
export function drawGradFace(
    g: Graphics, cx: number, cy: number, w: number, h: number, r: number,
    stops: string[], alpha = 255,
): void {
    if (w <= 0 || h <= 0 || alpha <= 0) return;
    const segs = gradSegs(h);
    for (let i = 0; i < segs; i++) {
        const t0 = i / segs;
        const t1 = (i + 1) / segs;
        const yTop = cy + h / 2 - t0 * h;
        const yBot = cy + h / 2 - t1 * h;
        const hwTop = halfWidthAt(w, h, r, yTop - cy);
        const hwBot = halfWidthAt(w, h, r, yBot - cy);
        if (hwTop <= 0 && hwBot <= 0) continue;
        const [R, G, B] = samplePalette(stops, (t0 + t1) / 2);
        g.fillColor = new Color(R, G, B, alpha);
        g.moveTo(cx - hwTop, yTop);
        g.lineTo(cx + hwTop, yTop);
        g.lineTo(cx + hwBot, yBot);
        g.lineTo(cx - hwBot, yBot);
        g.close();
        g.fill();
    }
}

/**
 * 顶部高光带（CSS `.btn::before{left:5%;right:5%;top:8%;height:36%}`）。
 *
 * 【为什么必须有它】3D 糖果质感的一半来自"光源在上方"这一条约定：
 *  面层顶部亮、底部暗是**渐变**给的，而顶部那条**弧形亮带**给的是"这是一块
 *  压出来的塑料"这个材质暗示。少了它，渐变再准也只是"一块渐变色块"。
 *  它必须是弧形（跟着圆角走），直条会在胶囊两端戳出去。
 */
export function drawHilite(
    g: Graphics, cx: number, cy: number, w: number, h: number, r: number,
    inset: number, alphaTop: number,
): void {
    const R3 = CFG.SKIN.R3D;
    const iw = w - inset * 2;
    if (iw <= 0 || h <= 0) return;
    const top = h / 2 - h * R3.HILITE_TOP;
    const bandH = h * R3.HILITE_H;
    const segs = Math.max(4, Math.ceil(bandH / 3));
    const rr = Math.max(0, r - inset);
    for (let i = 0; i < segs; i++) {
        const yTop = cy + top - (bandH * i) / segs;
        const yBot = cy + top - (bandH * (i + 1)) / segs;
        // 高光带的圆心要跟着面层一起内缩，否则贴不到圆角上
        const hwTop = halfWidthAt(iw, h, rr, yTop - cy);
        const hwBot = halfWidthAt(iw, h, rr, yBot - cy);
        if (hwTop <= 0 && hwBot <= 0) continue;
        const a = Math.round(alphaTop * (1 - (i + 1) / segs));
        if (a <= 0) continue;
        g.fillColor = new Color(255, 255, 255, a);
        g.moveTo(cx - hwTop, yTop);
        g.lineTo(cx + hwTop, yTop);
        g.lineTo(cx + hwBot, yBot);
        g.lineTo(cx - hwBot, yBot);
        g.close();
        g.fill();
    }
}

/**
 * 顶部内阴影（CSS `box-shadow: inset 0 Npx Mpx rgba(34,32,28,.20)`）。
 * 只有"内凹件"需要：进度槽、槽位条底、空槽格。
 * 凸起件（按钮、面板）**不要**加 —— 那会读成"凹下去"，与厚度层矛盾。
 */
export function drawInsetTop(
    g: Graphics, cx: number, cy: number, w: number, h: number, r: number,
    depth: number, alphaTop: number,
): void {
    const segs = Math.max(3, Math.ceil(depth / 2));
    for (let i = 0; i < segs; i++) {
        const yTop = cy + h / 2 - (depth * i) / segs;
        const yBot = cy + h / 2 - (depth * (i + 1)) / segs;
        const hwTop = halfWidthAt(w, h, r, yTop - cy);
        const hwBot = halfWidthAt(w, h, r, yBot - cy);
        const a = Math.round(alphaTop * (1 - (i + 1) / segs));
        if (a <= 0) continue;
        g.fillColor = hex2color(CFG.COLOR.INK, a);
        g.moveTo(cx - hwTop, yTop);
        g.lineTo(cx + hwTop, yTop);
        g.lineTo(cx + hwBot, yBot);
        g.lineTo(cx - hwBot, yBot);
        g.close();
        g.fill();
    }
}

/**
 * 柔影各层的**外扩量表**（单位：blur；下标 0 = 最外层、最大）。
 *
 * 【怎么算出来的】`grow_j = −(blur/2) × Φ⁻¹((j + 0.5) / N)`，j = 0…N−1。
 *   推导见 `drawSoftShadow` 的函数头注释（一句话：让"离边界 d 处被几层盖住"
 *   恰好等于 `N × Φ(−d/σ)`，于是边界处 = 50%，与 CSS `box-shadow` 的定义一致）。
 *   表是**常数**，所以直接算好写死 —— 省掉运行时求正态反函数，也方便逐层核对。
 *
 * ⚠️ `CFG.SKIN.R3D.SHADOW_LAYERS` 改了就必须同步这张表（对不上时会退回
 *    旧的经验式 `t − 0.25`，不会崩，但影会偏重）。
 */
const SHADOW_GROW: Record<number, number[]> = {
    // N = 13：边界 50%、最外 0.884·blur、层间不透明度 7.7%（看不出台阶）
    13: [0.8844, 0.5992, 0.4347, 0.3076, 0.1979, 0.0970,
        -0.0000, -0.0970, -0.1979, -0.3076, -0.4347, -0.5992, -0.8844],
    // N = 9（旧配置，留着以便对照回退）
    9: [0.7966, 0.4837, 0.2947, 0.1411, -0.0000,
        -0.1411, -0.2947, -0.4837, -0.7966],
};

/**
 * 接地柔影（CSS `box-shadow: 0 Ypx Bpx rgba(34,32,28,α)` 的 Graphics 近似）。
 *
 * 【它解决什么问题】S19 落地时只抄了 CSS 的前两条 shadow（厚度色 + 墨外圈），
 * 漏了第三条**模糊投影**。控件所有的立体感都在自己内部（渐变 / 厚度 / 高光），
 * 与背景之间**没有任何"接触"暗示** → 真机上读作"一枚贴纸漂在纸面上"。
 * 这一笔补上之后，控件才"落"到纸面上（用户 2026-10-02 点名的三处都是缺它）。
 *
 * 【Graphics 没有模糊，怎么做出"柔"】
 *   用 N 层**同心圆角矩形**逼近高斯：
 *     · 第 j 层按下面的 `SHADOW_GROW` 表向外扩
 *     · 每层只给 `alpha / N` 的不透明度 —— 于是
 *         **最外那一两层只覆盖到边缘**（几乎看不见）→ 边缘自然虚掉；
 *         **中心被 N 层叠满**（合成不透明度 ≈ alpha）→ 接触处够实。
 *   这正是模糊投影"边缘虚、中心实"的观感。
 *
 * 【各层外扩多少：不能用线性 t，要用正态分位表】
 *   CSS 的 `blur:Bpx` ＝ 高斯 σ = B/2。所以"离形状边界 d 处的影强"应该等于
 *   `alpha × Φ(−d/σ)`（Φ = 标准正态 CDF）。
 *   本函数把 N 层的不透明度做成**台阶**：距边界 d 处被 k 层盖住 ⇒ 影强 = k/N。
 *   令「k = N·Φ(−d/σ)」，反解出第 k 层的外扩量就是 `−σ·Φ⁻¹(k/N)`
 *   —— 也就是下面的表（σ = blur/2，表里存的是 `grow / blur`）。
 *   这样**边界处恰好落在一半的层上（≈50%）**，与 CSS 的定义严格一致。
 *
 * 【为什么不能用 `blur × t` 这种线性外扩（踩过的两个坑）】
 *   · `grow = blur × t`（最内层与控件同形，边界处 = 100%）
 *     → 边缘一圈"光晕"，实测比设计稿暗 13 级。
 *   · `grow = blur × (t − 0.25)`（边界处 ≈ 78%）
 *     → 比设计稿**整体偏重约 1.5 倍**，近场尤其明显。
 *       2026-10-02 用"底图归一化"量过道具键：设计净影 22 / 20 / 17 / 15 …，
 *       渲染出来是 40 / 36 / 35 / 31 …（近场接近 2 倍）。
 *   · 曾经担心 `− 0.5`（边界 50%）会让影"太弱"，那是因为 9 层太稀 ——
 *     用上面那张分位表后，边界就是 50%，不需要再手调系数。
 *
 * 【为什么不画成一整块实心】实心会有硬边，比不画还难看：那读作"控件多了一圈描边"。
 *
 * @param blur   CSS 的模糊半径（σ = blur / 2；见 `CFG.SKIN.R3D.SHADOW` 的实测表）
 * @param drop   CSS 的下移量
 * @param alpha  合成后的最大不透明度（0~255）
 */
export function drawSoftShadow(
    g: Graphics, cx: number, cy: number, w: number, h: number, r: number,
    blur: number, drop: number, alpha: number,
): void {
    if (alpha <= 0 || blur <= 0 || w <= 0 || h <= 0) return;
    const layers = Math.max(2, CFG.SKIN.R3D.SHADOW_LAYERS);
    const per = Math.max(1, Math.round(alpha / layers));
    //  ⚠️ 所有层的**中心都固定在 `cy − drop`**，只让尺寸不同。
    //  【为什么不能写成 `cy − drop × t`】CSS 的语义是"把形状整体下移 drop **之后**
    //   再做高斯模糊" —— 模糊只让**边缘**向两侧散开，中心不动。
    //   曾经按 `drop × t` 写过一版（想表现"外圈更远"），结果是：最内层落在按钮
    //   自己身上、柔影的重心比设计稿高 drop/2，看起来"糊在按钮身上"而不是
    //   "落在按钮下方" —— 那正是"漂"没治好、反而更脏的原因（2026-10-02 实测）。
    const table = SHADOW_GROW[layers];
    for (let j = layers; j >= 1; j--) {
        //  `grow` 的单位是 blur（表里就是 grow/blur），先转成像素再 ×2 扩到两边。
        const grow = (table ? table[j - 1] : (j - 1) / (layers - 1) - 0.25) * blur;
        fillBox(
            g, cx, cy - drop,
            w + grow * 2, h + grow * 2, Math.max(0, r + grow),
            CFG.COLOR.INK, per,
        );
    }
}

/** 3D 控件的全套参数 */
export interface Face3DOpts {
    /** 面层尺寸（＝ CSS 的 border-box）*/
    w: number;
    h: number;
    /** 面层圆角（想画胶囊就传 `CFG.SKIN.R3D.RADIUS_PILL`）*/
    radius: number;
    /** 面层渐变色标（见 `CFG.SKIN.GRAD`）*/
    stops: string[];
    /** 描边宽度（0 = 不描边，空槽格用）*/
    border?: number;
    /** 描边色（默认墨）*/
    borderColor?: string;
    /**
     * **厚度层外圈**的颜色（不传则跟随 `borderColor`）。
     *
     * 【为什么需要它】CSS 里"外圈"和"面层描边"本来就是两条独立的东西：
     *      `box-shadow: 0 Npx 0 Spx <外圈色>`  +  `border: Npx solid <描边色>`
     *   绝大多数控件两条同色（都是墨），所以一直共用一个参数没出问题；
     *   但朱砂大印是**外圈墨 `#22201C`、面层暗红 `#7E1D16`** —— 共用就会
     *   把 5px 的描边染成墨色（印立刻失去"朱砂"的观感）。
     */
    depthBorderColor?: string;
    /** 底部厚度：0 = 不做立体（贴在别的面上时用）*/
    depth?: number;
    /** 厚度色（CSS 里 `0 Npx 0 <这个色>`）*/
    depthColor?: string;
    /**
     * **厚度层外圈的 spread**（CSS `0 Npx 0 <Spread>px <外圈色>` 里那个长度）。
     *
     * 不传 = 跟随 `border`（= 描边的宽度）。**绝大多数控件都是这个值**，
     * 设计稿里逐条对过：`.btn-*` 4/4、`.rule-btn` 3/3、`.panel` 5/5、`.tool` 3.5/3.5、
     * `.seal-big` 5/5 —— 也就是"外圈与描边齐平"，看起来就是一圈完整墨边。
     *
     * ⚠️ **槽位条是唯一的例外**：`.slotbar{border:3.5px solid #22201C;
     *    box-shadow:inset 0 5px 9px …, 0 5px 0 #C3B89F, 0 10px 14px …}`
     *    —— 第二条**没有 spread**，所以它**没有外圈**，下缘只有 5px 的厚度色就接纸面。
     *    （与 `.seal` 小方印同一种情况，只是印是"外圈与描边都省"。）
     *    若给它按默认值画一圈墨，下缘会多出 4px 纯黑 —— 2026-10-02 实测：
     *    设计稿 y979 起是 202~207（纸+柔影），当时渲染出来是 31.3（纯墨）。
     */
    depthSpread?: number;
    /** 顶部高光带的不透明度（0 = 不要；面板这类大件默认关掉）*/
    hiliteAlpha?: number;
    /**
     * 顶部内阴影带的高度（px）。**只有"内凹件"才传**：进度槽、槽位条、空槽格。
     * 凸起件（按钮、面板）传了会与厚度层打架 —— 同一块面既"凸"又"凹"。
     */
    insetTop?: number;
    /** 顶部内阴影的不透明度（默认 46，与 CSS `rgba(34,32,28,.20)` 等值）*/
    insetAlpha?: number;
    /** 整块不透明度 */
    alpha?: number;
    /**
     * 接地柔影。**凸起件都要给**（按钮、面板、印）；内凹件（槽、格）不要给。
     *
     * 三件套（blur/drop/alpha）整组传，取 `CFG.SKIN.R3D.SHADOW` 里对应那一条：
     *   MAIN / SUB / RED / WHITE / BACK / REPLAY / TOOL / TOOL_RED / RULE / PANEL / SEAL / SEAL_BIG
     * 不传 = 不画柔影（那会让控件读作"贴在纸上的贴纸"，见 `drawSoftShadow` 的说明）。
     * 传 `depth: 0` 时柔影自动跳过 —— 贴在别的面上的控件不该有接地影。
     */
    shadow?: ShadowSpec;
    /** 在面层之上再叠一层"细线内框"（面板用：CSS `.panel .inner`）*/
    innerInset?: number;
    innerRadius?: number;
    innerBorder?: number;
}

/**
 * 画一个完整的 3D 厚描边控件（**所有控件形制的唯一出口**）。
 *
 * 绘制顺序（不能反）：
 *   ① 墨色外圈（比面层大 2×border，向下偏 depth）
 *   ② 厚度色块（同面层尺寸，向下偏 depth）
 *   ③ 面层描边（墨色圆角矩形）
 *   ④ 面层渐变
 *   ⑤ 顶部高光带
 *   ⑥ 可选的细线内框
 *
 * @param cx/cx 控件中心（相对所在节点）
 */
export function draw3dFace(
    g: Graphics, cx: number, cy: number, o: Face3DOpts,
): void {
    const w = o.w;
    const h = o.h;
    const r = o.radius;
    const b = o.border ?? 0;
    const depth = o.depth ?? 0;
    const alpha = o.alpha ?? 255;
    const R3 = CFG.SKIN.R3D;   // 高光带内缩 / 内框圆角的令牌出口

    // ⓪ 接地柔影（必须最先画：它是"地面"，压在所有层之下）
    //   `depth === 0` 时跳过 —— 贴在别的面上的控件不该有接地影（见 `Face3DOpts.depth`）
    const sh = o.shadow;
    if (sh && sh.alpha > 0 && depth > 0) {
        drawSoftShadow(g, cx, cy, w, h, r, sh.blur, sh.drop, sh.alpha);
    }

    // ①② 厚度层
    if (depth > 0) {
        // 外圈色可以**与面层描边不同**（CSS 里本就是两条独立的 shadow / border）。
        // 默认跟随 `borderColor`，只有朱砂大印传了 `depthBorderColor`。
        const bd = o.depthBorderColor ?? o.borderColor ?? CFG.COLOR.INK;
        // ★ 外圈 = CSS `box-shadow: 0 Npx 0 Spx <外圈色>`：**比面层外扩 b**（spread = 描边宽）。
        //   【为什么是 `w + b*2 / r + b`，以及 S20 为什么删错过一次】
        //   设计稿实测（`局内-优化后-1x.png`，返回键 y=1118 横切）：
        //       左墨边 x 206~213 = **8px**  ＝ 外圈 4px（206~209） + 面层描边 4px（210~213）
        //       右墨边 x 386~393 = **8px**  ＝ 面层描边 + 外圈
        //       底部 x=300 竖切：1142~1145 面层描边 / 1146~1150 厚度色 / 1151~1154 外圈
        //   —— 也就是"左右两侧各比面层多出 4px 墨边"**本来就是设计稿的样子**。
        //   S20 曾把它删成与面层同宽（误判为"控件旁边多出一根游离的竖线"），
        //   结果是厚度色被挤成 1px、控件比设计稿瘦一圈（三方实测：左墨边 8px→4px）。
        //   那根"竖线"的真凶是底图 bg-home.jpg 里一条竖向接缝（x378~381，y840~1106），
        //   已在 `temp/clean-bg.py` 的 1a) 抹掉 —— 两者无关，外圈必须留着。
        //   Graphics 的绘制顺序与 CSS 的阴影叠放顺序一致：外圈 → 厚度色 → 面层。
        //   ⚠️ spread 可以**不是**描边宽（`o.depthSpread`）—— 槽位条的 CSS 就没写
        //   spread，硬按默认画会在它下缘多出 4px 纯黑（见 `Face3DOpts.depthSpread`）。
        //   spread=0 时这层退化成与面层同尺寸，且先画，随后被厚度色完全盖住 ⇒ 等于不画。
        const sp = o.depthSpread ?? b;
        fillBox(g, cx, cy - depth, w + sp * 2, h + sp * 2, r + sp, bd, alpha);
        // 厚度色块 = CSS 第一条 shadow（**不 spread**、只下移 depth，尺寸等于面层）
        fillBox(
            g, cx, cy - depth,
            w, h, r,
            o.depthColor ?? CFG.SKIN.GRAD.WHITE_DEPTH, alpha,
        );
    }

    // ③ 面层描边
    if (b > 0) {
        fillBox(g, cx, cy, w, h, r, o.borderColor ?? CFG.COLOR.INK, alpha);
    }

    // ④ 面层渐变（内缩 border）
    const iw = Math.max(1, w - b * 2);
    const ih = Math.max(1, h - b * 2);
    const ir = Math.max(0, r - b);
    drawGradFace(g, cx, cy, iw, ih, ir, o.stops, alpha);

    // ⑤ 顶部高光带
    const ha = o.hiliteAlpha ?? 0;
    if (ha > 0) {
        drawHilite(g, cx, cy, iw, ih, ir, iw * R3.HILITE_INSET, ha);
    }

    // ⑤b 顶部内阴影（内凹件）
    if (o.insetTop && o.insetTop > 0) {
        drawInsetTop(g, cx, cy, iw, ih, ir, o.insetTop, o.insetAlpha ?? 46);
    }

    // ⑥ 细线内框
    if (o.innerInset && o.innerInset > 0) {
        const nw = iw - o.innerInset * 2;
        const nh = ih - o.innerInset * 2;
        if (nw > 4 && nh > 4) {
            strokeBox(g, cx, cy, nw, nh, o.innerRadius ?? R3.RADIUS_PANEL_INNER,
                CFG.COLOR.INK, o.innerBorder ?? 2, Math.round(alpha * 0.18));
        }
    }
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

/**
 * 估一段文字的像素宽。
 *
 * 【为什么需要估】`Label` 的实际宽度来自平台字体度量，**构建期拿不到** ——
 * `UITransform.contentSize` 要等渲染管线跑过一遍才准，而我们的布局
 * （顶条弹性三段、首页提示行居中）都发生在构建 / 入场那一刻。
 * 中日韩全角按 `1.0 × 字号`、其余按 `0.56 × 字号` ——
 * 实测与本机字体的偏差在 ±3px 内。
 *
 * 【什么时候不要用它】宽度会被"容器"约束的地方（例如 `overflow: CLAMP` 的换行）
 * 一律以引擎实测为准，估算只用于"给个保守的占位宽度"。
 */
export function estTextWidth(text: string, size: number): number {
    let w = 0;
    for (const ch of text) {
        w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.56;
    }
    return w;
}

/**
 * 读一个 `Label` 的**实际**文字宽度，读不到就退回 `estTextWidth`。
 *
 * 【踩过的坑】构建期直接读 `contentSize.width` 会拿到**默认值**（100×100 那种），
 * 而且**不报错** —— 用它算出来的位置会安静地错一整天。
 * 这里先强制把渲染数据算一遍（`updateRenderData(true)`），
 * 仍拿到"可疑值"（0 或与估算严重不符）时以估算为准。
 *
 * @param text 该 Label 当前的文字（用于兜底估算）
 */
export function measureLabel(label: Label, text: string): number {
    if (!label || !label.node || !label.node.isValid) return estTextWidth(text, CFG.FONT.SIZE_BODY);
    const size = label.fontSize;
    let w = 0;
    try {
        // 引擎内部 API，没有类型声明；包一层 try —— 拿不到就退回估算，不该因此崩页面。
        const anyLabel = label as unknown as { updateRenderData?: (force: boolean) => void };
        anyLabel.updateRenderData?.(true);
        const ui = label.node.getComponent(UITransform);
        w = ui ? ui.contentSize.width : 0;
    } catch (e) {
        warn(`[UIFactory] 预量文字宽度失败，改用估算：${e}`);
        w = 0;
    }
    const est = estTextWidth(text, size);
    // "可疑值"= 0 / 负数 / 与估算相差 2 倍以上（默认 100 恰好落在这一档）
    if (!(w > 0) || w > est * 2 || w < est * 0.5) return est;
    return w;
}

// ============================================================
//  页面骨架（S19：位图底图；引擎不再自绘页框）
// ============================================================

/** 已加载的底图缓存（同一张图只 load 一次；两个页面共用同一个 path 时也只用一次）*/
const _bgCache = new Map<string, SpriteFrame>();
/** 正在加载中的排队回调 */
const _bgQueue = new Map<string, Array<(sf: SpriteFrame | null) => void>>();

/** 最近一次成功显示的底图（`ResultFx` 的"揉纸"要按它裁横条）*/
let _bgShown: SpriteFrame | null = null;
/** 最近一次显示的底图在屏幕上的覆盖尺寸（`cropFrame` 用它换算像素）*/
let _bgShownScale = 1;

/**
 * 异步加载一张底图。
 *
 * ⚠️ `path` 末尾的 `/spriteFrame` 不能省（见 `CFG.SKIN.BG_HOME` 的注释）：
 *    图片被导入后自身是 `ImageAsset`，`SpriteFrame` 是挂在它下面的**子资源**，
 *    `resources.load` 必须点到子资源 —— 少了这一段会加载成功但拿到 ImageAsset，
 *    赋给 Sprite 无效（背景一片空白，而且控制台不报错）。
 */
export function loadBg(path: string, cb: (sf: SpriteFrame | null) => void): void {
    const hit = _bgCache.get(path);
    if (hit) { cb(hit); return; }
    const q = _bgQueue.get(path);
    if (q) { q.push(cb); return; }
    _bgQueue.set(path, [cb]);
    resources.load(path, SpriteFrame, (err: Error | null, sf: SpriteFrame) => {
        const list = _bgQueue.get(path) || [];
        _bgQueue.delete(path);
        const ok = !err && !!sf;
        if (ok) _bgCache.set(path, sf);
        for (const f of list) f(ok ? sf : null);
    });
}

/** 同步取一张**已经加载过**的底图（没加载完返回 null）*/
export function backgroundFrame(path: string): SpriteFrame | null {
    return _bgCache.get(path) ?? null;
}

/**
 * 从一张底图上裁出一个小矩形，做成新的 SpriteFrame（**共享同一张纹理，不额外占显存**）。
 *
 * 【谁在用】`ResultFx.buildPaperBands` 的"揉纸"：它要把整屏横切成 6 段、每段各自抖动。
 *  以前那 6 段是引擎用 `Graphics` 画的"纸底 + 页框线"，所以复制一份就能动；
 *  现在页框在**贴图**里，引擎画不出来了 —— 必须把那 6 段各自**裁一张图**出来。
 *  共享纹理是关键：6 张 SpriteFrame 指向同一张 Texture2D，显存只有一份。
 *
 * ⚠️ `rect` 的 y **从纹理顶端往下量**（不是从底部）。Cocos 的
 *    `SpriteFrame._calculateUV()` 把 `rect.y` 映射到 v 的上边，所以 y 越小越靠上。
 */
export function cropFrame(
    base: SpriteFrame, px: number, py: number, pw: number, ph: number,
): SpriteFrame {
    const sf = new SpriteFrame();
    sf.texture = base.texture;
    sf.rect = new Rect(px, py, pw, ph);
    sf.originalSize = new Size(pw, ph);
    return sf;
}

/**
 * 铺满整屏的底图背景（S19 起是**位图**，不再是一块纯色）。
 *
 * @param kind `'page'` = 其余四页的通用底图（R3）；`'home'` = 首页底图（R4）
 *
 * 【为什么底下还要垫一层纯纸色】
 *  ① 底图是异步加载的，加载完之前那一两帧不能是黑的；
 *  ② 加载失败（路径写错 / 资源没进包）时页面仍然可用 —— 只是少了纹理；
 *  ③ 「通关印砸落」的**纸面震**会横向抖这个节点 ±9px，抖动时边缘要能露出纸色，
 *     而不是画布的清屏色。所以这层纸色矩形画成 1.6 倍大小。
 *
 * 【铺法 = cover，不是 stretch】图片原生 720×1280；20:9 的机器可视高度更大，
 *  按 `max(w/720, h/1280)` 等比放大到两边都盖住为止（宁可裁掉一点，不能露白边）。
 */
export function createPaperBackground(parent: Node, kind: 'home' | 'page' = 'page'): Node {
    const vs = view.getVisibleSize();
    const root = createNode('PaperBackground', parent, { w: vs.width, h: vs.height });

    const g = root.addComponent(Graphics);
    g.fillColor = hex2color(CFG.COLOR.PAPER);
    g.rect(-vs.width * 0.8, -vs.height * 0.8, vs.width * 1.6, vs.height * 1.6);
    g.fill();

    const path = kind === 'home' ? CFG.SKIN.BG_HOME : CFG.SKIN.BG_PAGE;
    const cover = Math.max(vs.width / CFG.SKIN.BG_W, vs.height / CFG.SKIN.BG_H);
    const dw = CFG.SKIN.BG_W * cover;
    const dh = CFG.SKIN.BG_H * cover;

    const apply = (sf: SpriteFrame | null): void => {
        if (!sf || !root.isValid) return;
        const node = createNode('BgImage', root, { w: dw, h: dh });
        const sp = node.addComponent(Sprite);
        sp.spriteFrame = sf;
        sp.sizeMode = Sprite.SizeMode.CUSTOM;
        sp.trim = false;
        // 记下来给 `ResultFx` 的揉纸用（它要知道纹理像素 ↔ 设计像素的倍率）
        _bgShown = sf;
        _bgShownScale = cover;
    };
    loadBg(path, apply);
    return root;
}

/**
 * 最近一次显示过的底图 + 它的覆盖倍率（供 `ResultFx` 裁横条）。
 * 返回 null 表示底图还没加载好 —— 调用方必须能接受这一点（退回旧的自绘纸面）。
 */
export function shownBackground(): { frame: SpriteFrame; scale: number } | null {
    return _bgShown ? { frame: _bgShown, scale: _bgShownScale } : null;
}

/**
 * @deprecated S19 起**不再绘制任何东西**。
 *
 * 页框（朱红双线）、四角回纹角花现在画在**底图贴图**里（见 `CFG.SKIN`）。
 * 引擎再画一遍就是**重影** —— 这是换底图时最容易踩的坑：
 * 两套线只差 1~14px，叠在一起看起来像"线画毛了"，很难联想到是画了两遍。
 *
 * 保留这个函数（返回一个空节点）是为了：
 *  ① 老调用点不用改（`GamePage` 还在拿它的返回节点做别的事）；
 *  ② 让下一个人一眼看到"这里曾经画过页框、现在故意不画了"。
 */
export function createPageFrame(parent: Node): Node {
    return createNode('PageFrame', parent, { w: CFG.SCREEN.W, h: CFG.SCREEN.H });
}

/**
 * 页面**版心**：布局的唯一几何依据（S19 起口径变了）。
 *
 * 旧口径是"按 `FRAME_INSET=66` 算出来的内框"，那是**引擎自绘页框**时代的数字。
 * 现在页框来自 R3 底图，实测内框 x 65/653、y 96/1180（像素），
 * 换算设计坐标再内缩 22 得到版心：
 *      x ∈ [−272, 272]（宽 544）、y ∈ [−518, 522]
 * 四条通栏元素（细墨线 / 进度条 / 槽位条 / 道具栏）左右边界一律 ±272。
 *
 * ⚠️ 这里只对**其余四页**成立。首页底图（R4）的页框更靠外，首页不套版心。
 */
export function frameRect(): { x0: number; x1: number; y0: number; y1: number; w: number; h: number } {
    const S = CFG.SKIN;
    const x0 = S.SAFE_X0;
    const x1 = S.SAFE_X1;
    const y0 = S.SAFE_Y0;
    const y1 = S.SAFE_Y1;
    return { x0, x1, y0, y1, w: x1 - x0, h: y1 - y0 };
}

// ============================================================
//  通用件
// ============================================================

export interface PanelOpts extends NodeOpts {
    radius?: number;
    /** 面层渐变色标 */
    stops?: string[];
    /** 是否画细线内框（CSS `.panel .inner`）*/
    inner?: boolean;
    /** 底部厚度 */
    depth?: number;
    depthColor?: string;
    /** 描边宽度 */
    border?: number;
    /** 接地柔影（默认 `R3D.SHADOW.PANEL`）*/
    shadow?: ShadowSpec;
}

/**
 * 宣纸面板（S19：3D 厚描边 + 细线内框）。
 *
 * 【形制来自】CSS `.panel{border-radius:26px; border:5px solid #22201C;
 *   background:linear-gradient(180deg,#FFFDF6 0%,#F8F2E4 46%,#EFE6D2 100%);
 *   box-shadow:0 14px 0 #C3B89F, 0 14px 0 5px #22201C, 0 30px 46px rgba(34,32,28,.42),
 *              inset 0 6px 0 rgba(255,255,255,.9)}` +
 *   `.panel .inner{inset:15px; radius:14px; border:2px solid rgba(34,32,28,.18)}`
 *
 * ⚠️ 面板**有**第三条柔影（`0 30px 46px rgba(34,32,28,.42)`）。
 *   S20 曾误判成"面板只有两条" —— 那条 CSS 的 box-shadow 列表跨了两行，
 *   用单行正则去抓时只截到前两条，于是"没抓到就等于没有"，把柔影漏了。
 *   后果正是用户点名的第 3 处：广告弹窗的**整个面板糊在暗背景上、没有"落下来"的重量**。
 *
 * ⚠️ **不画角花**：角花是"硬直角国潮"的语言，与圆角厚描边混用会互相打架。
 */
export function createPanel(
    parent: Node, name: string, w: number, h: number, opts: PanelOpts = {},
): Node {
    const node = createNode(name, parent, { w, h, x: opts.x, y: opts.y });
    const g = node.addComponent(Graphics);
    const R3 = CFG.SKIN.R3D;
    draw3dFace(g, 0, 0, {
        w,
        h,
        radius: opts.radius ?? R3.RADIUS_PANEL,
        stops: opts.stops ?? CFG.SKIN.GRAD.PANEL,
        border: opts.border ?? R3.BORDER_PANEL,
        borderColor: CFG.COLOR.INK,
        depth: opts.depth ?? R3.DEPTH_PANEL,
        depthColor: opts.depthColor ?? CFG.SKIN.GRAD.WHITE_DEPTH,
        hiliteAlpha: 0,          // 面板是"一大块纸"，顶部高光带会让它读成"塑料按钮"
        // 面板的柔影是 46/30（最大的那一档）—— 它面积大、离地远，投影本来就散。
        shadow: opts.shadow ?? R3.SHADOW.PANEL,
        innerInset: opts.inner === false ? 0 : R3.PANEL_INNER_INSET,
    });
    return node;
}

export interface ProgressBarOpts extends NodeOpts {
    w: number;
    h: number;
    /** 0..1 */
    value: number;
    /** 刻度线数量（含两端）。0 = 不画刻度 */
    ticks?: number;
}

/**
 * 进度条（S19：胶囊 + 内凹槽 + 分段刻度）。
 *
 * 【形制来自】CSS `.bar{radius:99px; border:2.5px solid #22201C;
 *   background:linear-gradient(180deg,#DFD5BE,#F2EADA);
 *   box-shadow:inset 0 3px 5px rgba(34,32,28,.20),0 3px 0 #C9BFA8}` +
 *   `.bar i{left:2.5px;height:52%;background:linear-gradient(180deg,#E85A4F,#C4362B);radius:99px}` +
 *   `.bar b{width:3px;height:190%;background:#B9B09A}`
 *
 * 【为什么填充只有 52% 高】它嵌在槽里、上下各留一圈，读起来是"液体在管子里"
 *  而不是"管子被涂了一半"。这个细节是设计稿定的，别顺手改成 100%。
 *
 * 【刻度线为什么比槽还高（190%）】刻度要同时压住槽的上沿和下沿，
 *  读成"把管子分段的箍"；只画在槽内会读成"槽上的杂色"。
 */
export function createProgressBar(parent: Node, name: string, opts: ProgressBarOpts): Node {
    const node = createNode(name, parent, { w: opts.w, h: opts.h, x: opts.x, y: opts.y });
    const g = node.addComponent(Graphics);
    drawProgressBar(g, opts.w, opts.h, opts.value, opts.ticks ?? 0);
    return node;
}

/** 重画进度条（进度会变，所以要能单独调；`createProgressBar` 只是它的壳） */
export function drawProgressBar(
    g: Graphics, w: number, h: number, value: number, ticks: number,
): void {
    g.clear();
    const b = 2.5;
    const r = w / 2;               // 胶囊
    const v = Math.max(0, Math.min(1, value));

    // ① 厚度层（CSS `0 3px 0 #C9BFA8`）
    //  ⚠️ **这条 shadow 没有 spread**（不像按钮的 `0 Npx 0 <描边宽>px #22201C`），
    //     所以**不画墨色外圈**。原来按 `w + b*2` 画过一圈墨，后果是进度条下缘
    //     多出 2px 纯黑（2026-10-02 实测：设计稿 y205 是 223，渲染出来是 31.3），
    //     整条进度条看起来"压在一块黑板上"。
    fillBox(g, 0, -3, w, h, r, '#C9BFA8');

    // ② 槽体（墨边 + 内凹渐变）
    fillBox(g, 0, 0, w, h, r, CFG.COLOR.INK);
    const iw = w - b * 2;
    const ih = h - b * 2;
    drawGradFace(g, 0, 0, iw, ih, Math.max(0, r - b), CFG.SKIN.GRAD.BAR_TRACK);
    drawInsetTop(g, 0, 0, iw, ih, Math.max(0, r - b), ih * 0.42, 46);

    // ③ 填充（左端对齐，高 52%）
    if (v > 0.001) {
        const fw = Math.max(ih * 0.52, iw * v);   // 至少一个圆头的宽度，否则读不出"有进度"
        const fh = ih * 0.52;
        const fr = fh / 2;
        const cx = -iw / 2 + fw / 2;
        drawGradFace(g, cx, 0, fw, fh, fr, CFG.SKIN.GRAD.BAR_FILL);
    }

    // ④ 刻度线
    if (ticks > 1) {
        const th = h * 1.9;
        const tr = 1.5;
        for (let i = 0; i < ticks; i++) {
            const x = -w / 2 + (w * i) / (ticks - 1);
            fillBox(g, x, 0, 3, th, tr, '#B9B09A');
        }
    }
}

// ============================================================
//  按钮
// ============================================================

/**
 * 按钮的「色调」。S19 起用"色调名"而不是逐个传颜色 ——
 * 传颜色的话，改一次设计稿要在十几个调用点里各改一遍，漏一个就是一处不一致。
 */
export type ButtonTone = 'red' | 'redBig' | 'white' | 'paper' | 'tool' | 'rule';

interface ToneSpec {
    stops: string[];
    depthColor: string;
    textColor: string;
    depth: number;
    border: number;
    hilite: number;
    /** 接地柔影（见 `CFG.SKIN.R3D.SHADOW` 的实测表）*/
    shadow: ShadowSpec;
}

/**
 * 接地柔影参数 —— 一一对应设计稿里的一条
 * `box-shadow: 0 <drop>px <blur>px rgba(34,32,28, <alpha>/255)`。
 *
 * ⚠️ 三个数**必须整组一起给**，不能只给 alpha 让别处去猜 blur/drop：
 *   设计稿是逐控件手调的（同为 depth 7，`.btn-red` 是 22/16、`.tool-red` 是 17/13），
 *   曾经按 depth 拟合过一次，结果道具键与结算红钮的柔影互相错位。
 */
export interface ShadowSpec { blur: number; drop: number; alpha: number }

/**
 * 色调 → 具体绘制参数（全部来自 CFG.SKIN，业务代码不许自己拼颜色）。
 *
 * ⚠️ **depth 是按"设计稿里那一类控件"给的默认值**，不是"大中小分档"：
 *   设计稿里同为白按钮，首页重玩小方 `0 8px 0`、局内重玩 `0 5px 0`、
 *   结算白钮 `0 6px 0` —— 所以 `white` 的默认值是结算那颗的 6，
 *   首页/局内要用时**显式传 `depth` 覆盖**（见各自的调用点注释）。
 *   `shadow` 取 `CFG.SKIN.R3D.SHADOW` 里**那一类控件自己**的实测值（blur/drop/alpha
 *   三件套），**不要**按 depth 去推 —— 两者不成比例（见该表的注释）。
 */
function toneSpec(tone: ButtonTone): ToneSpec {
    const G = CFG.SKIN.GRAD;
    const R3 = CFG.SKIN.R3D;
    const SH = R3.SHADOW;
    switch (tone) {
        // 结算页红钮：`.btn-red{0 7px 0 …,0 16px 22px rgba(34,32,28,.32)}`
        case 'red':
            return { stops: G.RED_MID, depthColor: G.RED_DEPTH, textColor: CFG.COLOR.FACE, depth: R3.DEPTH_BTN, border: R3.BORDER_BTN, hilite: R3.HILITE_ALPHA, shadow: SH.RED };
        // 首页主按钮：`.btn-main{0 9px 0 …,0 20px 26px rgba(34,32,28,.34)}`
        case 'redBig':
            return { stops: G.RED_MAIN, depthColor: G.RED_DEPTH, textColor: CFG.COLOR.FACE, depth: R3.DEPTH_BIG, border: R3.BORDER_BTN, hilite: R3.HILITE_ALPHA, shadow: SH.MAIN };
        // 结算页白钮：`.btn-white{0 6px 0 …,0 13px 18px rgba(34,32,28,.26)}`
        case 'white':
            return { stops: G.WHITE, depthColor: G.WHITE_DEPTH, textColor: '#2B2823', depth: R3.DEPTH_BTN_WHITE, border: R3.BORDER_BTN, hilite: R3.HILITE_ALPHA, shadow: SH.WHITE };
        // 局内「返回」：`.btn-back{0 5px 0 …,0 10px 14px rgba(34,32,28,.24)}`
        case 'paper':
            return { stops: G.PAPER_BACK, depthColor: G.WHITE_DEPTH, textColor: '#2B2823', depth: R3.DEPTH_SMALL, border: R3.BORDER_BTN, hilite: R3.HILITE_ALPHA, shadow: SH.BACK };
        // 顶条「规则」：`.rule-btn{0 4px 0 #C3B89F,0 4px 0 3px #22201C,0 9px 12px rgba(34,32,28,.24)}`
        //  ⚠️ 它**有**第三条柔影（9/12/.24）—— S20 曾误读成"没有"，理由写在 `SHADOW.RULE` 的注释里。
        case 'rule':
            return { stops: G.TOOL, depthColor: G.WHITE_DEPTH, textColor: '#2B2823', depth: R3.DEPTH_RULE, border: R3.BORDER_RULE, hilite: R3.HILITE_ALPHA, shadow: SH.RULE };
        // 道具键（白态）：`.tool{0 6px 0 …,0 11px 15px rgba(34,32,28,.22)}`
        // 红态（可用）的柔影更重且更"远"：`.tool-red{0 7px 0 …,0 13px 17px rgba(34,32,28,.30)}`
        //   —— 在 `GamePage.drawPropFace` 里按可用态传 `SHADOW.TOOL_RED`。
        case 'tool':
        default:
            return { stops: G.TOOL, depthColor: G.WHITE_DEPTH, textColor: '#2B2823', depth: R3.DEPTH_MID, border: R3.BORDER_TOOL, hilite: R3.HILITE_ALPHA, shadow: SH.TOOL };
    }
}

export interface ButtonOpts extends NodeOpts {
    w: number;
    h: number;
    radius?: number;
    /** 色调（默认朱红中号）*/
    tone?: ButtonTone;
    /** 自定义渐变色标（给了就覆盖 tone 的 stops）*/
    stops?: string[];
    /** 自定义厚度色 */
    depthColor?: string;
    /** 自定义厚度（给了就覆盖 tone 的 depth）。⚠️ 柔影**不会**跟着自动变，要改就整组传 `shadow` */
    depth?: number;
    /** 自定义接地柔影（给了就覆盖 tone 的 shadow；不传 = 用 tone 的）*/
    shadow?: ShadowSpec;
    /** 顶部高光带不透明度（0 = 关）*/
    hiliteAlpha?: number;

    text: string;
    fontSize?: number;
    textColor?: string;
    /** 衬线体（主按钮用，标题感更强） */
    serif?: boolean;
    /** 文字字距（Cocos 没有 letter-spacing，用空格近似；0 = 不处理）*/
    spacing?: number;

    /**
     * 禁用态。⚠️ S19 起语义变了 —— 见 `drawPropFace` / `refreshPropBar`：
     *   可用的道具键是**朱红**，不可用的是**纸白**（设计稿定的）。
     *   这里是"整体变灰 + 不响应"，与道具键那套"两色并存"不是一回事。
     */
    enabled?: boolean;
    enabledStops?: string[];

    onClick?: () => void;
}

/**
 * 3D 厚描边按钮。
 *
 * 【形制来自】CSS `.btn{border-radius:999px;border:4px solid #22201C}` +
 *  `.btn::before{left:5%;right:5%;top:8%;height:36%;白色渐变}` +
 *  `.btn-main / .btn-sub / .btn-back / .btn-red / .btn-white` 各自的渐变与厚度。
 *
 * 手感细节（沿用旧版，未改）：
 *  · 按下：缩到 0.94（模拟被按进去）
 *  · 抬起：backOut 缓动回弹，带回一点过冲，手感更「活」
 *  · 禁用：变纸灰、不响应
 *
 * ⚠️ 热区用 `UITransform.contentSize`，**不含厚度层** ——
 *    厚度层是"影子"，点到影子上不该触发。所以外层节点的高度就是面层高度。
 */
export function createButton(parent: Node, name: string, opts: ButtonOpts): Node {
    const enabled = opts.enabled ?? true;
    const tone = opts.tone ?? 'red';
    const spec = toneSpec(tone);
    const radius = opts.radius ?? CFG.SKIN.R3D.RADIUS_PILL;
    const depth = opts.depth ?? spec.depth;

    const btn = createNode(name, parent, { w: opts.w, h: opts.h, x: opts.x, y: opts.y });
    btn.addComponent(UIOpacity);   // 供转场淡入淡出使用

    const g = btn.addComponent(Graphics);
    draw3dFace(g, 0, 0, {
        w: opts.w,
        h: opts.h,
        radius,
        stops: enabled ? (opts.stops ?? spec.stops) : (opts.enabledStops ?? CFG.SKIN.GRAD.LOCK),
        border: spec.border,
        borderColor: enabled ? CFG.COLOR.INK : CFG.COLOR.LOCK,
        depth,
        depthColor: enabled ? (opts.depthColor ?? spec.depthColor) : CFG.SKIN.GRAD.WHITE_DEPTH,
        hiliteAlpha: enabled ? (opts.hiliteAlpha ?? spec.hilite) : 0,
        // 禁用态的按钮仍然是"浮在纸面上的一块实体"，柔影照留 ——
        // 去掉反而会让它读作"陷进纸里了"（那样更像可点的）。
        shadow: opts.shadow ?? spec.shadow,
    });

    // ---- 文字 ----
    // 【为什么文字可以挂在按钮节点上（与 Graphics 同级）】
    //  Label 自己的顶点是单档 alpha，与 Graphics 的顶点是两批数据，
    //  先后顺序由节点顺序决定：Graphics 是后加的组件但绘制顺序按组件顺序，
    //  这里文字节点是子节点 → 一定在面层之上。
    createLabel(btn, opts.text, {
        fontSize: opts.fontSize ?? CFG.FONT.SIZE_BUTTON,
        color: enabled
            ? (opts.textColor ?? spec.textColor)
            // ★ S18 决议 5′：禁用态文字也是**要读的信息**（"本关复活机会已用完"
            // 这类文案读不出来，玩家就不知道按钮为什么点不动），
            // 所以默认色是 INK_MID（6.70:1），不用只有 3.06:1 的 INK_SOFT。
            : (opts.textColor ?? CFG.COLOR.INK_MID),
        bold: true,
        serif: opts.serif,
        w: opts.w - 24,
        h: opts.h,
    });

    // ---- 交互 ----
    if (!enabled) {
        return btn;
    }

    const press = (): void => {
        Tween.stopAllByTarget(btn);
        tween(btn).to(0.06, { scale: v3(0.94, 0.94, 1) }).start();
    };
    const release = (): void => {
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

/** 只重画一个已存在按钮的面（换色调 / 换禁用态时用，不重建节点） */
export function redrawButtonFace(
    g: Graphics, w: number, h: number, radius: number, enabled: boolean, tone: ButtonTone,
    hiliteAlpha?: number, depth?: number, shadow?: ShadowSpec,
): void {
    const spec = toneSpec(tone);
    g.clear();
    draw3dFace(g, 0, 0, {
        w,
        h,
        radius,
        stops: enabled ? spec.stops : CFG.SKIN.GRAD.LOCK,
        border: spec.border,
        borderColor: enabled ? CFG.COLOR.INK : CFG.COLOR.LOCK,
        depth: depth ?? spec.depth,
        depthColor: enabled ? spec.depthColor : CFG.SKIN.GRAD.WHITE_DEPTH,
        hiliteAlpha: enabled ? (hiliteAlpha ?? spec.hilite) : 0,
        shadow: shadow ?? spec.shadow,
    });
}

// ============================================================
//  轻提示（Toast）
// ============================================================

/**
 * 屏幕中下方弹一条会自动消失的提示。
 * 形制（S19）：墨色胶囊 + 宣纸色文字 —— 与整页"圆角厚描边"的语言统一。
 */
export function toast(parent: Node, text: string, duration = 1.4): void {
    const node = createNode('Toast', parent, { x: 0, y: -80 });
    const opacity = node.addComponent(UIOpacity);
    opacity.opacity = 0;

    const fontSize = CFG.FONT.SIZE_BODY;
    const w = Math.max(240, text.length * (fontSize + 6) + 64);
    const h = 74;

    const g = node.addComponent(Graphics);
    // 单档 alpha（235）—— 但外层用 UIOpacity 做 0→255→0 的淡入淡出，
    // 只在"脏着"的时候被覆写，末值是 0（硬开关）→ 符合铁律允许的两种情形。
    g.fillColor = hex2color(CFG.COLOR.INK, 235);
    g.roundRect(-w / 2, -h / 2, w, h, h / 2);
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
 * @deprecated 旧名（S1 的「麻将桌布」）。
 * 保留这个别名只是为了让老代码能编译过，新代码请用 createPaperBackground。
 */
export function createTableBackground(parent: Node): Node {
    return createPaperBackground(parent);
}
