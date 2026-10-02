/**
 * ============================================================
 *  ResultFx.ts · 结算动效（S18 新增）
 * ============================================================
 *  设计源：`docs/design/S18/01-方案A-宣纸墨戏.html` §3 ③-B（通关）与 ③-C（失败）
 *  施工依据：`docs/design/S18/04-拍板结论与实施规格.md` §六 · S18.5
 *
 * ------------------------------------------------------------
 *  【通关 = 一枚朱砂印砸下来】（总 1600ms，含 700ms 读印停顿）
 *  一枚 190×190 的朱砂大印（S19 起由 96 放大，见 `CFG.MOTION.STAMP.SIZE`），
 *  印面一个「过」字，从画面上方**砸**到纸面上。
 *  整段的重量感来自三个数：
 *    · 砸下来时**过冲到 1.32**    —— 过冲是"惯性"的唯一视觉证据；
 *    · 落点**纵向压扁到 86%**     —— ⚠️ 横向刻意不动，横向一起收会读成"印变小了"；
 *    · 纸面**震 3 次、幅度衰减到 44%** —— 固定比例，不用随机数（随机化的震读成"画面在乱抖"）。
 *  16 枚印泥颗粒**全程向上飞** —— 不对下、不对侧，因为"向上飞溅"才是**砸**出来的，
 *  向下飘是"掉"出来的。
 *
 *  【失败 = 纸被揉皱 + 溅墨】（总 1140ms）
 *  ⚠️ 真实的褶皱需要法线 / 置换贴图（用灰度图偏移 UV），`Graphics` 根本做不到，
 *     而且一张 720×1280 的灰度图约 180~400KB，会吃掉包体积红线 4MB 的 10~20%。
 *     所以本实现**主动放弃褶皱明暗，只保留"分段错位"这个几何信息**：
 *     把纸面横切成 6 段，每段各自按相位抖动。玩家读到的是"纸抖了一下"，
 *     不是"纸上有几道褶" —— 几何错位已经把这个意思说完了。
 *  ⛔ **不要给整页 root 做这个抖动** —— 整页抖是"镜头在抖"，分段抖才是"纸被揉"。
 *
 * ------------------------------------------------------------
 *  【为什么用"折线逼近圆"而不是 Graphics.arc / circle】
 *  见 `UIFactory.arcPoly` 的注释：`arc()` 的 counterclockwise 语义在 y 轴朝上的
 *  坐标系里容易搞反，而反了只是"少画一块"、构建期不报错。统一走折线最稳。
 * ============================================================
 */

// ⚠️ 这里**刻意不 import `Color`**：S18 修掉"用 UIOpacity 给 Graphics 做淡出"之后，
//    本文件所有颜色都改由 `draw3dFace / strokeArc / hex2color` 的 alpha 参数承载，
//    没有任何地方再手工 `new Color(...)`。
//    （注：本工程的 tscheck 是 `strict:false`、没开 noUnusedLocals，
//     所以多 import 一个 `Color` 其实**不会**报错 —— 这条注释是为了防下一个人
//     看到 `Color` 就以为"还有地方在做手工颜色"，然后又写回 UIOpacity。）
import { Graphics, Node, Sprite, Tween, UIOpacity, tween, v3, view, warn } from 'cc';
import { CFG } from '../CFG';
import {
    alphaPainter, createGraphicsNode, createLabel, createNode, createPanel, cropFrame,
    draw3dFace, hex2color, shownBackground, strokeArc, strokePath,
} from './UIFactory';

/** 秒 → mm:ss */
function mmss(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    return `${`${Math.floor(s / 60)}`.padStart(2, '0')}:${`${s % 60}`.padStart(2, '0')}`;
}

/** 一个在飞行中的粒子（粒子表用不到对象，用普通数组足矣） */
interface Particle {
    x: number; y: number;        // 当前位置
    vx: number; vy: number;      // 速度（px/s）
    size: number;                // 方块边长
    spin: number;                // 自转角速度（°/s）
    angle: number;               // 当前角度
    life: number;                // 总寿命（秒）
    age: number;                 // 已存活（秒）
}

export class ResultFx {

    // ========================================================
    //  通关 · 朱砂印砸下来
    // ========================================================
    /**
     * 播通关动效。
     *
     * @param parent    挂到哪（页面 root 即可；动效自己会保证不被弹窗压住）
     * @param frameNode 会被"纸面震"的那个节点（**内框**，不是整页 root）
     * @param onPanel   印静止 700ms 之后回调 —— 结算面板在这一刻才开始推入
     */
    public static stamp(parent: Node, frameNode: Node | null, onPanel: () => void): void {
        const S = CFG.MOTION.STAMP;

        const root = createNode('StampFx', parent, { w: CFG.SCREEN.W, h: CFG.SCREEN.H });

        // ---------- ① 印本体（3D 厚描边：墨外圈 + 暗红描边 + 朱砂渐变面）----------
        // ★ S19 形制改版：从"朱红面 + 金线 + 硬直角(4)"换成**与全局控件同一套 3D 形制**
        //   （`draw3dFace`，规格见 `CFG.SKIN.R3D` / `GRAD.SEAL`）。
        //   三个数来自设计稿 `通关结算-优化后-1x.html` 的 `.seal-big`：
        //     border:5px solid #7E1D16  → 面层描边 SEAL_BORDER
        //     0 12px 0 #6D1811          → 厚度层 SEAL_DEPTH（SIZE 放大后同步放大到 12）
        //     0 12px 0 5px #22201C      → **外圈墨**（与外圈同宽的 spread）
        //   ⚠️ 外圈与面层描边不同色，所以要多传一个 `depthBorderColor`
        //      （见 `Face3DOpts.depthBorderColor` 的注释）。
        //   ⚠️ 设计稿那条 `inset 0 5px 0 rgba(255,255,255,.26)`（顶部一道亮边）
        //      **刻意不做**：190px 的大块头上加高光带会把它读成"塑料按钮"，
        //      与 `createPanel` 里 `hiliteAlpha:0` 是同一条理由。
        //   ⛔ 金的退场是刻意的：旧版那圈金线是"一次性事件色"，新形制里
        //      朱砂靠**暗红描边 + 厚度**立住，再加金就撞了。
        const seal = createGraphicsNode('Seal', root, { w: S.SIZE, h: S.SIZE });
        // ★ 印的"淡入"（α 0.25 → 1.0）必须**烘焙进颜色**重画。
        //   ⚠️ 因为这一块 Graphics 是**多档 alpha**：厚度层、面层、外圈各自的
        //      绘制参数里都带着 `a`，挂一个 UIOpacity 上去会被引擎**一次覆写**
        //      成同一个级联值（见 UIFactory 的文件头铁律），厚度层会变得和面层
        //      一样实 —— 印看起来是一枚没有厚度的红方块。必须走 alphaPainter。
        const sealP = alphaPainter(seal.g, (g, a) => {
            draw3dFace(g, 0, 0, {
                w: S.SIZE,
                h: S.SIZE,
                radius: S.RADIUS,
                stops: CFG.SKIN.GRAD.SEAL,
                border: CFG.SKIN.R3D.BORDER_SEAL,
                borderColor: CFG.SKIN.GRAD.SEAL_BORDER,
                depth: S.DEPTH,
                depthColor: CFG.SKIN.GRAD.SEAL_DEPTH,
                depthBorderColor: CFG.COLOR.INK,
                hiliteAlpha: 0,
                // 接地柔影 = `.seal-big` 的第三条 `0 26px 40px rgba(34,32,28,.44)`。
                // ★ 这组数**不能按比例从 depth 推**：印的 depth 是 12，若按通用的
                //   2.6/1.9 比例只会得到 31/23，而设计稿写的是 40/26 —— 大件的
                //   投影本来就比小件更散（面积越大，环境光遮蔽的过渡越宽）。
                //   所以走 `SHADOW.SEAL_BIG` 这张实测表（40 / 26 / 112）。
                shadow: CFG.SKIN.R3D.SHADOW.SEAL_BIG,
                alpha: a,
            });
        }, S.ALPHA_FROM);
        seal.node.setPosition(0, S.Y0, 0);
        seal.node.setScale(v3(S.SCALE_FROM, S.SCALE_FROM, 1));
        seal.node.angle = S.ROT_FROM;

        // 「过」字（闸门：它直到第 ④ 格才开始显 —— "印泥洇开"的时间差）
        // ⚠️ 这里**可以**用 UIOpacity：Label 的顶点色本来就是单一档，
        //    被覆写成级联值不会丢掉任何层次。而且它挂在自己的节点上，
        //    与旁边那枚**多档**的印是兄弟关系 —— 抹平不了印。
        const glyph = createLabel(seal.node, '过', {
            fontSize: S.SIZE * S.GLYPH_RATIO,
            color: CFG.COLOR.FACE,
            bold: true,
            serif: true,
        });
        const glyphOp = glyph.node.addComponent(UIOpacity);
        glyphOp.opacity = 0;

        // ---------- 外扩环（第 ⑤ 格）----------
        // 环的透明度走"烘焙 + 重画"（见 hit() 里的 ringP / alphaPainter 那两段补间）。
        // 【为什么环也用烘焙，明明它只有一档 alpha】
        // 因为它同时还要**变形状**（r 78→132、线宽 4→1.6）——形状每帧变就必须每帧
        // `fill()`，而每帧 `fill()` 会把当下的 `fillColor` 一起烤进去。
        // 让"形状"和"透明度"由同一条通路（alphaPainter 的 redraw）负责，
        // 比"形状走重绘 + 透明度走 UIOpacity"两条通路要好排查得多。
        const ring = createGraphicsNode('Ring', root, {});
        ring.node.setPosition(0, S.Y2, 0);

        // ---------- 印泥颗粒（16 枚，1 个 Graphics 逐帧重绘）----------
        const dust = createGraphicsNode('Dust', root, {});

        // ---------- ② 砸落：越落越快（quadIn），过冲 32% ----------
        //  【为什么用 quadIn 而不是 quadOut】砸下来必须"越落越快"，
        //  用缓出会读成"飘下来"。这条曲线与 MOTION.EASE_DROP 同族。
        tween(seal.node)
            .delay(S.DROP_START)
            .to(S.DROP_IN, {
                position: v3(0, S.Y1, 0),
                scale: v3(S.SCALE_OVERSHOOT, S.SCALE_OVERSHOOT, 1),
                angle: S.ROT_TO,
            }, { easing: 'quadIn' })
            .call(() => {
                if (!root.isValid) return;
                // 传的是 `ring.g`（Graphics 本体）而不是 `ring.node`：
                // 环的淡出走"烘焙 + 重画"，驱动的是 Graphics 自己，不是节点属性。
                this.hit(seal.node, glyphOp, ring.g, dust.g, frameNode);
                // 第 ⑥ 格：印静止 700ms（给玩家读那个「过」字），之后面板才推入
                setTimeout(() => { if (root.isValid) onPanel(); }, (S.HOLD + S.REBOUND_IN) * 1000);
            })
            .start();
        tween(sealP)
            .delay(S.DROP_START)
            .to(S.DROP_IN, { a: 1 }, { onUpdate: sealP.redraw })
            .call(sealP.redraw)
            .start();

        // 整段结束后销毁（印留在面板推入之后一小会儿，然后随页面一起走）
        setTimeout(() => {
            if (root.isValid) root.destroy();
        }, (S.DROP_START + S.DROP_IN + S.SQUASH_IN + S.REBOUND_IN
            + S.CHAR_IN2 + S.HOLD + 1.2) * 1000);
    }

    /**
     * 命中：压扁 + 纸面震（第 ③ 格之后的所有拍子）。
     *
     * ⚠️ 形参里传的是 **`Graphics` 本体**（`ringG` / `dustG`）而不是节点：
     *    环与颗粒的显隐都靠"每帧重画"实现，驱动对象是 Graphics；
     *    传节点会诱导下一个人又去写 `node.getComponent(Graphics)`
     *    或更糟 —— 给节点挂 `UIOpacity`（对 Graphics 它只能**一次性覆写**顶点
     *    alpha：多档会被抹平、中间值留不住，见 UIFactory 铁律）。
     *    `glyphOp` 是唯一按节点属性驱动的：它是 Label，且只走
     *    0 → 140 → 255 这种"端点 + 一次中间值"。顶点若被重建会回落成 255
     *    （提前变实、不会低于设计意图），且停在 140 的窗口只有 0.32s。
     *    ⚠️ 但**别照着它抄**：将来要给 Label 调更细腻的中间透明度，
     *    正解是直接写 `label.color` 的 alpha，而不是靠 UIOpacity。
     */
    private static hit(
        seal: Node, glyphOp: UIOpacity, ringG: Graphics,
        dustG: Graphics, frameNode: Node | null,
    ): void {
        const S = CFG.MOTION.STAMP;

        // ---------- ③ 纵向压到 86%（横向刻意不动）----------
        Tween.stopAllByTarget(seal);
        tween(seal)
            .to(S.SQUASH_IN, {
                scale: v3(S.SCALE_OVERSHOOT, S.SCALE_OVERSHOOT * S.SQUASH_Y, 1),
            }, { easing: 'quadOut' })
            // ---------- ④ 回弹：过冲 7% 再收，同时上浮 6px 落定、角度归正 ----------
            .to(S.REBOUND_IN, {
                scale: v3(1, S.REBOUND_OVERSHOOT, 1),
                position: v3(0, S.Y2, 0),
                angle: 0,
            }, { easing: 'backOut' })
            .to(S.REBOUND_IN * 0.8, { scale: v3(1, 1, 1) }, { easing: 'quadOut' })
            // 第 ⑤ 格的"极轻余震"：两拍，各 90ms
            .to(S.ECHO_IN, { scale: v3(S.ECHO_SCALE, S.ECHO_SCALE, 1) }, { easing: 'quadOut' })
            .to(S.ECHO_IN, { scale: v3(1, 1, 1) }, { easing: 'quadOut' })
            .start();

        // 「过」字：先走到 55%（第 ④ 格），再走完剩下的（第 ⑤ 格，比印晚 320ms 起播）
        tween(glyphOp)
            .to(S.REBOUND_IN, { opacity: S.CHAR_ALPHA_MID }, { easing: 'quadOut' })
            .delay(S.CHAR_IN2_START - S.REBOUND_IN)
            .to(S.CHAR_IN2, { opacity: 255 }, { easing: 'quadOut' })
            .start();

        // ---------- ③ 纸面震：四拍 1 : 0.78 : 0.44 : 0 ----------
        if (frameNode && frameNode.isValid && S.SHAKE_TARGET_IS_FRAME) {
            const amp = S.SHAKE_DX;
            const step = S.SQUASH_IN / 4;
            const seq: Array<[number, number]> = [
                [amp, 0],
                [-amp * 0.78, step],
                [amp * 0.44, step * 2],
                [0, step * 3],
            ];
            const holder = { x: 0 };
            Tween.stopAllByTarget(holder as any);
            tween(holder)
                .to(step, { x: seq[0][0] }, { easing: 'sineOut' })
                .to(step, { x: seq[1][0] }, { easing: 'sineOut' })
                .to(step, { x: seq[2][0] }, { easing: 'sineOut' })
                .to(step, { x: seq[3][0] }, { easing: 'sineOut' })
                .call(() => {
                    if (frameNode.isValid) frameNode.setPosition(0, frameNode.position.y, 0);
                })
                .start();
            // 每帧把 holder.x 写进节点（用一条并行的"读数"补间驱动，避免引随机数/帧回调依赖）
            const follower = { t: 0 };
            tween(follower)
                .to(S.SQUASH_IN, { t: 1 }, {
                    onUpdate: () => {
                        if (frameNode.isValid) frameNode.setPosition(holder.x, frameNode.position.y, 0);
                    },
                })
                .start();
        }

        // ---------- ⑤ 外扩环：r 155 → 260、线宽 4 → 1.6、α 0.5 → 0 ----------
        //  （S19：印从 96 放大到 190，环的半径按印边长**等比**放大，见 CFG.RING_R0/R1）
        // ★ 环的淡化走"烘焙 alpha + 重画"。
        //   ⚠️ 这里要同时推进**形状**（r / w）与**透明度**（α）两路，所以拆成两条补间：
        //   α 归 alphaPainter 自己的 holder 管（它的 redraw 只认 `holder.a`），
        //   形状归 ringHolder 管；两条并行、同时长、都以 `ringP.redraw` 逐帧收。
        //   想"合成一条"就必须把 r/w/a 塞进同一个对象 —— 那会绕开 alphaPainter
        //   的 a，等于又退回手工 clear()+stroke()，下次改的人多半会漏掉末帧。
        //   （环只有一档 alpha，本来也可以用 UIOpacity；选烘焙是因为形状也要每帧
        //     重画 —— 让形状与透明度共用一个出口，见 stamp() 里 Ring 的注释。）
        const ringHolder = { r: S.RING_R0, w: S.RING_W0 };
        const ringP = alphaPainter(ringG, (g, a) => {
            if (a <= 0) return;
            strokeArc(g, 0, 0, ringHolder.r, ringHolder.r,
                0, Math.PI * 2, CFG.COLOR.VERMILION, ringHolder.w, a);
        }, S.RING_ALPHA);
        tween(ringHolder)
            .to(S.RING_IN, { r: S.RING_R1, w: S.RING_W1 },
                { easing: 'quadOut', onUpdate: ringP.redraw })
            .call(ringP.redraw)
            .start();
        tween(ringP)
            .to(S.RING_IN, { a: 0 }, { easing: 'quadOut', onUpdate: ringP.redraw })
            .call(ringP.redraw)
            .start();

        // ---------- ⑤ 印泥颗粒 16 枚 ----------
        const parts: Particle[] = [];
        for (let i = 0; i < S.P_COUNT; i++) {
            // 起始位置：印的**四边**上随机取点（不是从印心发射）
            const side = i % 4;
            const t = Math.random();
            const half = S.SIZE / 2;
            let px = 0; let py = 0;
            if (side === 0) { px = -half + t * S.SIZE; py = half; }
            else if (side === 1) { px = half; py = -half + t * S.SIZE; }
            else if (side === 2) { px = -half + t * S.SIZE; py = -half; }
            else { px = -half; py = -half + t * S.SIZE; }

            // 扇形向上：相对竖直向上的 ±52°，再叠 ±12° 的二次随机。
            // ⚠️ 二次随机是"不整齐"的来源 —— 少了它，16 枚会排成一条漂亮的弧，
            //    而漂亮就是假的。
            const deg = (Math.random() * 2 - 1) * S.P_ANGLE_SPAN
                + (Math.random() * 2 - 1) * S.P_ANGLE_JITTER;
            const rad = (deg * Math.PI) / 180;
            const spd = S.P_SPEED_MIN + Math.random() * (S.P_SPEED_MAX - S.P_SPEED_MIN);
            parts.push({
                x: px, y: py + S.Y2,
                vx: Math.sin(rad) * spd,
                vy: Math.cos(rad) * spd,
                size: S.P_SIZE_MIN + Math.random() * (S.P_SIZE_MAX - S.P_SIZE_MIN),
                spin: (Math.random() * 2 - 1) * S.P_SPIN,
                angle: Math.random() * 360,
                life: S.P_LIFE_MIN + Math.random() * (S.P_LIFE_MAX - S.P_LIFE_MIN),
                age: 0,
            });
        }
        this.driveParticles(dustG, parts, true);
    }

    // ========================================================
    //  失败 · 纸被揉皱 + 溅墨
    // ========================================================
    /**
     * 播失败动效。
     *
     * @param pageRoot  页面 root（6 段纸面带会插到「纸底之后、牌堆之前」）
     * @param onPanel   抖动收束之后回调 —— 失败面板在这一刻推入
     */
    public static crease(pageRoot: Node, onPanel: () => void): void {
        const C = CFG.MOTION.CREASE;

        // ---------- ①②③ 六段纸面各自错相抖动 ----------
        //  段 i 的相位 = i × 61.8%（黄金分割错相）：
        //  保证 6 段两两不同、**可复现**、且不需要随机数
        //（动效里引随机数会让"重放一次"结果不同，排查成本陡增）。
        //  ⚠️ 段高由 buildPaperBands 按**底图**算（`图高×cover / segs`），
        //     不等于 `SCREEN.H / segs` —— 这里不要自己再算一遍高度，
        //     拿到的是"已经摆好、只需抖动"的节点。
        const bands = this.buildPaperBands(pageRoot, C.SHAKE_SEGS);

        const stops: Array<{ node: Node; delay: number }> = [];
        for (let i = 0; i < bands.length; i++) {
            const node = bands[i];
            const phase = i * C.SHAKE_PHASE;
            // 幅度四轮衰减：6 → 4.3 → 3.1 → 2.2
            const holder = { x: 0, sx: 1, rot: 0 };
            const stopAt = C.SHAKE_STEP * C.SHAKE_ROUNDS
                + Math.random() * (C.RESET_MAX - C.RESET_MIN) + C.RESET_MIN;
            stops.push({ node, delay: stopAt });

            tween(holder)
                .to(C.SHAKE_STEP, { x: 0 }, { easing: 'sineInOut' })   // 占位，真正驱动见下面 follower
                .start();

            // 用一条按帧推进的"驱动器"实现 A·sin(2π(t/step + 相位))，
            // 并对幅度做四轮 ×0.72 的衰减；同时按相位给 scaleX 与 rotate。
            const driver = { t: 0 };
            tween(driver)
                .to(C.SHAKE_ROUNDS * C.SHAKE_STEP, { t: 1 }, {
                    onUpdate: () => {
                        if (!node.isValid) return;
                        const el = driver.t * C.SHAKE_ROUNDS * C.SHAKE_STEP;
                        const round = Math.min(C.SHAKE_ROUNDS - 1, Math.floor(el / C.SHAKE_STEP));
                        const amp = C.SHAKE_AMP * Math.pow(C.SHAKE_DECAY, round);
                        const ph = phase * Math.PI * 2;
                        const ang = (el / C.SHAKE_STEP) * Math.PI * 2 + ph;
                        holder.x = amp * Math.sin(ang);
                        // rotate 与 x **反相** —— 这样读起来像"纸被扭"而不是"纸在平移"
                        holder.rot = -C.SHAKE_ROT * Math.sin(ang);
                        holder.sx = 1 + C.SHAKE_SCALE_X * Math.sin(ang);
                        node.setPosition(holder.x, node.position.y, 0);
                        node.setScale(holder.sx, 1, 1);
                        node.angle = holder.rot;
                    },
                })
                .start();

            // ④ 收束：各段在 [RESET_MIN, RESET_MAX] 里**各自**随机一个时长归零
            //    【为什么要随机】齐刷刷一起停会被读成"按了暂停键"。
            const reset = C.RESET_MIN + Math.random() * (C.RESET_MAX - C.RESET_MIN);
            tween(node)
                .delay(stopAt)
                .to(reset, { position: v3(0, node.position.y, 0), scale: v3(1, 1, 1), angle: 0 },
                    { easing: 'quadOut' })
                .start();
        }

        // ---------- ④ 全屏薄墨层 α 0 → 0.10 ----------
        //  放最上层：它是"整张纸暗下去"，包括 HUD 也要暗。
        //  ⚠️ 这个节点**不注册任何触摸监听** —— 没有监听就不会参与命中测试，
        //    点击原样穿过（引擎的派发只挑"有监听且在命中范围内"的最上层节点）。
        const dim = createGraphicsNode('Dim', pageRoot, {
            w: CFG.SCREEN.W * 1.4, h: CFG.SCREEN.H * 1.4,
        });
        // ★★ 这一层**必须用 alphaPainter 烘焙**，绝不能用 UIOpacity ★★
        //
        //  【上一版就是这么写错的，代价是一次全屏黑屏】
        //  上一版这里挂的是 UIOpacity，注释给的理由是"它只有一档 alpha，
        //  正是 UIOpacity 的正确用法"——**那个理由是错的**。实测证据（冒烟连拍）：
        //     · 判负后 300ms 画面正常（左上角纸色 251,246,234）
        //     · 520ms 起**整屏变成纯 INK 色 #22201c**，四角与中心**完全同值**、
        //       纯黑像素占比 0%（= 不是 Canvas 清屏黑，就是这一层不透明）
        //     · +3700ms 仍是全黑 → 失败面板"已开"但被它整个盖住
        //  时间点 520ms ≈ RESET_START(0.27) + DIM_IN(0.18) = 450ms，
        //  说明 tween 一直在跑、只是**终点值没留住**。
        //
        //  【机制：UIOpacity 对 Graphics 是"一次性覆写"】
        //  引擎在 opacity 变脏的那几帧，把顶点 alpha **覆写**成级联值
        //  （见 UIFactory 铁律 ②③④）—— 所以 tween 期间看起来完全正常。
        //  但 tween 一停就不再置脏；此后 Graphics 的顶点数据一旦被重建
        //  （render-data 的 chunk recycle / allocate），alpha 就回落到
        //  `fillColor` 自己烘焙的那个值 = 255 → **永久全黑**。
        //  alphaPainter 把 alpha **烤进 fillColor**，重建后仍是 25 → 稳。
        //
        //  【修正后的判据 —— 比"内部有没有多档 alpha"更严格】
        //  只有这两种情况才可以用 UIOpacity：
        //    ① 目标值 = 255 且整层内部单档（如 hudLayer 整层淡入）
        //       —— 回落值恰好就是想要的；
        //    ② 目标值 = 0（引擎里 opacity≈0 是硬开关，整棵子树直接跳过渲染）。
        //  凡目标值是**中间值**（0.10 / 0.5 …）→ 一律 alphaPainter 烘焙。
        const dimP = alphaPainter(dim.g, (g, a) => {
            if (a <= 0) return;
            g.fillColor = hex2color(CFG.COLOR.INK, a);
            g.rect(-CFG.SCREEN.W * 0.7, -CFG.SCREEN.H * 0.7, CFG.SCREEN.W * 1.4, CFG.SCREEN.H * 1.4);
            g.fill();
        }, 0);
        tween(dimP)
            .delay(C.RESET_START)
            .to(C.DIM_IN, { a: C.DIM_ALPHA }, { easing: 'quadOut', onUpdate: dimP.redraw })
            .call(dimP.redraw)
            .start();

        // ---------- ⑤⑥ 溅墨 8 滴 + 溅痕尾巴 ----------
        const splashRoot = createGraphicsNode('Splash', pageRoot, {});
        splashRoot.node.setPosition(0, 0, 0);
        const dots: Particle[] = [];
        const tails: number[] = new Array(C.DOT_COUNT).fill(0);
        for (let i = 0; i < C.DOT_COUNT; i++) {
            // 方向：360° 均分 8 份，再叠 ±22° 随机
            const deg = (i / C.DOT_COUNT) * 360 + (Math.random() * 2 - 1) * C.DOT_ANGLE_JITTER;
            const rad = (deg * Math.PI) / 180;
            // 速度 210~330 px/s，**全程不变** —— 溅墨是惯性运动，减速会读成"飘"
            const spd = C.DOT_SPEED_MIN + Math.random() * (C.DOT_SPEED_MAX - C.DOT_SPEED_MIN);
            dots.push({
                x: 0, y: C.DOT_Y,
                vx: Math.cos(rad) * spd,
                vy: Math.sin(rad) * spd,
                size: C.DOT_R * 2,
                spin: 0,
                angle: 0,
                life: C.DOT_LIFE_MIN + Math.random() * (C.DOT_LIFE_MAX - C.DOT_LIFE_MIN),
                age: 0,
            });
        }
        // 尾巴：每滴一条随机长度的线段，方向 = 飞行的反方向 ±10°
        for (let i = 0; i < C.DOT_COUNT; i++) {
            tails[i] = C.TAIL_MIN + Math.random() * (C.TAIL_MAX - C.TAIL_MIN);
        }
        setTimeout(() => {
            if (!splashRoot.node.isValid) return;
            this.driveSplash(splashRoot.g, dots, tails);
        }, C.SPLASH_DELAY * 1000);

        // ---------- ⑦ 失败面板推入 ----------
        setTimeout(() => { if (pageRoot.isValid) onPanel(); }, C.PANEL_DELAY * 1000);
    }

    // ========================================================
    //  结算面板（两处共用）
    // ========================================================
    /**
     * 把一块已经建好的面板"从屏幕下沿推上来"。
     * 形制不动、布局不动，**只加进场动效**（规格 §六 · S18.5 的要求）。
     */
    public static slidePanelIn(panel: Node, fromY: number, toY: number, duration: number): void {
        if (!panel || !panel.isValid) return;
        panel.setPosition(panel.position.x, fromY, 0);
        Tween.stopAllByTarget(panel);
        tween(panel).to(duration, { position: v3(panel.position.x, toY, 0) },
            { easing: 'backOut' }).start();
    }

    /**
     * 通关结算条：一枚 **440 × 168** 的宣纸小面板，两行字
     * 「用时 mm:ss」（朱红 34）／「新纪录 · mm:ss」（墨灰 20）。
     *
     * 【为什么是"一条"而不是"一块大面板"】通关这一屏的主体是**那枚「过」印**，
     * 面板再大就会跟它抢注意力（§5 自律规则一：一级重心只允许 1 个）。
     * 所以这里只铺两条信息，把"读印"这件事让给印本身。
     *
     * 【S19 为什么从 420×92 一行改成 440×168 两行】
     *  印从 96 放大到 190 之后，"用时 00:12 · 最佳 00:09"这一行小字压在它下面
     *  读起来像印的脚注。拆成两行、大字报成绩，两行之间的字号差（34 vs 20）
     *  才是主次关系的载体 —— 等距两行会被读成"两个同级信息"。
     *
     * 【isRecord 的口径没变，只是换了表达】
     *  旧版一行里用「· 最佳纪录」/「· 最佳 mm:ss」两个后缀区分；
     *  现在第二行整行就是纪录 —— 破纪录时写「新纪录 · <本次用时>」
     *  （此刻本次用时**就是**新的最佳），否则写「最佳纪录 · <历史最佳>」。
     *  ⚠️ `bestSec` 传进来的仍是**本轮之前**的最佳（见 GamePage 调用点），
     *     所以破纪录时必须用 `usedSec`，用 `bestSec` 会显示上一档的旧成绩。
     */
    public static buildWinPanel(
        parent: Node, usedSec: number, bestSec: number, isRecord: boolean,
    ): Node {
        const S = CFG.MOTION.STAMP;
        // 面板本体走通用件（3D 厚描边 + 细线内框），形制与失败面板完全一致
        const panel = createPanel(parent, 'WinPanel', S.PANEL_W, S.PANEL_H, {
            y: S.PANEL_Y1, inner: true,
        });

        // 第一行：成绩（朱红大字）
        createLabel(panel, `用时 ${mmss(usedSec)}`, {
            y: S.PANEL_USED_DY,
            fontSize: S.PANEL_USED_SIZE,
            color: CFG.COLOR.VERMILION,
            bold: true,
            serif: true,
            w: S.PANEL_W - 60,
        });

        // 第二行：纪录（墨灰小字）
        // 破纪录 → 本次用时就是新的最佳；否则报历史最佳。
        const bestShown = isRecord ? usedSec : bestSec;
        createLabel(panel, `${isRecord ? '新纪录' : '最佳纪录'} · ${mmss(bestShown)}`, {
            y: S.PANEL_BEST_DY,
            fontSize: S.PANEL_BEST_SIZE,
            color: CFG.COLOR.INK_MID,
            serif: true,
            w: S.PANEL_W - 60,
        });
        return panel;
    }

    // ========================================================
    //  内部：粒子驱动
    // ========================================================

    /**
     * 驱动"印泥颗粒"（有重力、有自转）。
     * 1 个 Graphics 节点，每帧 clear() + 重绘 16 个方块。
     * 参照：现有工程正常一帧要画 96 张牌（每张 15+ 个图元），
     * 这里 16 次 roundRect 不到它的 1.2%。
     */
    private static driveParticles(g: Graphics, parts: Particle[], gravity: boolean): void {
        const S = CFG.MOTION.STAMP;
        const total = Math.max(...parts.map((p) => p.life));
        const dt = 1 / 60;
        let elapsed = 0;
        const holder = { t: 0 };
        tween(holder).to(total, { t: total }, {
            onUpdate: () => {
                if (!g.isValid) return;
                // 以固定步长推进（与帧率解耦：低帧率下不会"跳帧飞出去"）
                while (elapsed < holder.t) {
                    for (const p of parts) {
                        p.age += dt;
                        p.x += p.vx * dt;
                        p.y += p.vy * dt;
                        // 重力 1400 px/s²，比真实重力（≈980）重 ——
                        // 手绘感的抛物线应该更"塌"一点
                        if (gravity) p.vy -= S.P_GRAVITY * dt;
                        p.angle += p.spin * dt;
                    }
                    elapsed += dt;
                }
                g.clear();
                for (const p of parts) {
                    const k = p.age / p.life;
                    if (k >= 1) continue;
                    // 前 60% 保持实心、后 40% 线性淡出（不做淡入：
                    // 淡入会让 16 枚看起来"慢慢长出来"）
                    const a = k < S.P_FADE_AT
                        ? 1 : 1 - (k - S.P_FADE_AT) / (1 - S.P_FADE_AT);
                    // ⚠️ 方块必须自转 —— 不自转的方块看起来像像素噪点
                    g.fillColor = hex2color(CFG.COLOR.VERMILION, a * 255);
                    const s = p.size;
                    g.moveTo(p.x, p.y);
                    const rad = (p.angle * Math.PI) / 180;
                    const c = Math.cos(rad); const sn = Math.sin(rad);
                    const corners: Array<[number, number]> = [
                        [-s / 2, -s / 2], [s / 2, -s / 2], [s / 2, s / 2], [-s / 2, s / 2],
                    ];
                    corners.forEach(([lx, ly], idx) => {
                        const wx = p.x + lx * c - ly * sn;
                        const wy = p.y + lx * sn + ly * c;
                        if (idx === 0) g.moveTo(wx, wy); else g.lineTo(wx, wy);
                    });
                    g.close();
                    g.fill();
                }
            },
        }).start();
    }

    /** 驱动"溅墨"：8 滴匀速墨点 + 各自一条逐渐长出的尾巴（无重力） */
    private static driveSplash(g: Graphics, dots: Particle[], tails: number[]): void {
        const C = CFG.MOTION.CREASE;
        const total = Math.max(...dots.map((d) => d.life)) + C.TAIL_IN;
        const dt = 1 / 60;
        let elapsed = 0;
        const tailGrowth = new Array(dots.length).fill(0);
        const holder = { t: 0 };
        tween(holder).to(total, { t: total }, {
            onUpdate: () => {
                if (!g.isValid) return;
                while (elapsed < holder.t) {
                    for (const d of dots) {
                        if (d.age >= d.life) continue;
                        d.age += dt;
                        d.x += d.vx * dt;
                        d.y += d.vy * dt;   // 重力 = 0：墨点在平面上溅开，不下坠
                    }
                    elapsed += dt;
                }
                // 尾巴：从各自的起点方向长出
                for (let i = 0; i < dots.length; i++) {
                    const k = Math.min(1, Math.max(0, (holder.t - C.TAIL_START) / C.TAIL_IN));
                    tailGrowth[i] = tails[i] * k;
                }
                g.clear();
                for (let i = 0; i < dots.length; i++) {
                    const d = dots[i];
                    const k = d.age / d.life;
                    if (k >= 1) continue;
                    const a = k < C.DOT_FADE_AT
                        ? 1 : 1 - (k - C.DOT_FADE_AT) / (1 - C.DOT_FADE_AT);

                    // 尾巴：方向 = 飞行的反方向（+ ±10° 随机由长度抖动近似）
                    const len = tailGrowth[i];
                    if (len > 0.5) {
                        const m = Math.hypot(d.vx, d.vy) || 1;
                        const ux = -d.vx / m;
                        const uy = -d.vy / m;
                        strokePath(g, [
                            [d.x, d.y],
                            [d.x + ux * len, d.y + uy * len],
                        ], CFG.COLOR.INK, C.TAIL_W);
                        // lineCap 用圆头：戳在墨点上像"被拉出来"，方头会像"接了一根棍"
                        g.lineCap = Graphics.LineCap.ROUND;
                    }
                    // 墨点：实心圆（半径随坠落略缩，读起来像"墨在吸进纸里"）
                    const r = Math.max(1.5, (d.size / 2) * (1 - k * 0.35));
                    g.fillColor = hex2color(CFG.COLOR.INK, a * 255);
                    const seg = 24;
                    for (let s = 0; s <= seg; s++) {
                        const ang = (s / seg) * Math.PI * 2;
                        const px = d.x + Math.cos(ang) * r;
                        const py = d.y + Math.sin(ang) * r;
                        if (s === 0) g.moveTo(px, py); else g.lineTo(px, py);
                    }
                    g.close();
                    g.fill();
                }
            },
        }).start();
    }

    // ========================================================
    //  内部：六段纸面
    // ========================================================
    /**
     * 把整屏 **从底图上横切成 segs 段**，每段是一张独立可动的 Sprite（揉纸的几何载体）。
     *
     * 【为什么从"自绘纸底 + 页框线"改成"裁贴图"】
     *  S18 那版页框是引擎用 `Graphics` 画的，所以"每段复制一份几何"就能各自抖动；
     *  S19 把页框画进了底图 —— 引擎再也画不出来了。唯一还成立的路径是
     *  **把同一张底图裁成几段**：`cropFrame` 生成的新 SpriteFrame 与底图
     *  **共享同一张 Texture2D**，6 段只多 6 个 SpriteFrame 对象，显存仍是一份。
     *  ⚠️ 若沿用旧代码（自己画纸底 + 页框），结果是"抖动的纸面上叠着两套页框线"：
     *     段一错位，错位处就露出**双重描边** —— 读作重影，不是揉皱。
     *
     * 【为什么每段盖住"整张图"而不是"可见区"】
     *  底图按 `cover` 铺，设计尺寸 = 720×1280 × cover ≥ 可视区。
     *  按**图片矩形**切，段与段严丝合缝（都是"图高/segs"的整数分之几）；
     *  按可视区切则两头要裁掉图片的溢出部分，切出来反而不连续。
     *  又因 `cover ≥ 1`，盖住图片矩形必然盖住可视区 —— 不必再算第二遍。
     *
     * @returns 段节点数组（**从上往下**）；底图尚未就绪时返回空数组
     */
    private static buildPaperBands(pageRoot: Node, segs: number): Node[] {
        const shown = shownBackground();
        if (!shown) {
            // 揉纸是锦上添花：底图没就位时**降级**（仍保留全屏压暗 + 溅墨），
            // 而不是抛异常把整条失败结算打断 —— 玩家此刻已经输了，
            // 结算面板必须出得来。
            warn('[ResultFx] 底图未就绪，揉纸动效降级为「只压暗 + 溅墨」');
            return [];
        }

        const vs = view.getVisibleSize();
        const cover = shown.scale;
        const dw = CFG.SKIN.BG_W * cover;          // 底图在设计坐标下的宽
        const dh = CFG.SKIN.BG_H * cover;          // …高
        const bandDesignH = dh / segs;             // 每段的设计高
        const bandTexH = CFG.SKIN.BG_H / segs;     // 每段的纹理高（像素）

        const root = createNode('CreaseBands', pageRoot, { w: vs.width, h: vs.height });
        // ⚠️ 必须插在「纸底」之后、牌堆 / HUD 之前：
        //    在下面则盖不住原图（段一挪就露馅）；在上面会把整盘牌也抖起来
        //    （那是"镜头在抖"，不是"纸被揉"）。
        //    这里按**节点名**找底图、插到它后面 —— 不要写死索引：
        //    页面根下的兄弟会随功能增删而变（S19 就刚删掉过一个 PageFrame 的绘制）。
        const bgNode = pageRoot.getChildByName('PaperBackground');
        const at = bgNode ? bgNode.getSiblingIndex() + 1 : 0;
        root.setSiblingIndex(Math.min(at, pageRoot.children.length - 1));

        const out: Node[] = [];
        for (let i = 0; i < segs; i++) {
            // 纹理行区间（`cropFrame` 的 y **从纹理顶端往下量**）
            const py = Math.round(i * bandTexH);
            const ph = Math.round((i + 1) * bandTexH) - py;

            // 高度多给 0.6px：相邻段落在分数像素边界上若不重叠，真机可能看到一条缝
            const node = createNode(`Band${i}`, root, { w: dw, h: bandDesignH + 0.6 });
            const sp = node.addComponent(Sprite);
            sp.spriteFrame = cropFrame(shown.frame, 0, py, CFG.SKIN.BG_W, ph);
            // ⚠️ `CUSTOM` 与 `trim = false` 都不能省：
            //    TRIMMED 会按 originalSize 去查"透明边裁切"，而这帧是手工构造的、
            //    没有 packable 信息 —— 会拿到 0 尺寸 → 整段不渲染，且不报错。
            sp.sizeMode = Sprite.SizeMode.CUSTOM;
            sp.trim = false;

            // 第 i 段在图片矩形里的中心（设计坐标：图片中心 = 屏幕中心 = 原点）
            node.setPosition(0, dh / 2 - (i + 0.5) * bandDesignH, 0);
            out.push(node);
        }
        return out;
    }
}
