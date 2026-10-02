/**
 * ============================================================
 *  IntroAnim.ts · 开场动画「一滴墨」（S18 新增）
 * ============================================================
 *  设计源：`docs/design/S18/01-方案A-宣纸墨戏.html` §3 ③-A（6 张分镜帧 + 参数表）
 *  施工依据：`docs/design/S18/04-拍板结论与实施规格.md` §二·修正①
 *
 * ------------------------------------------------------------
 *  【它在整个入场里的位置】—— 用户拍板「先播开场动画，再出现牌堆涌现」
 *
 *      第 1 拍  开场（本文件，1.5s）—— 负责「**舞台**」
 *               页框 / 顶部信息 / 槽位条 / 道具栏（＝全部静态 HUD）淡入，
 *               **牌堆区是空的**。
 *      第 2 拍  涌现（GamePage.playSproutMotion，1.6s）—— 负责「**演员**」
 *               牌堆从棋盘里成束升起、挤压、回弹。
 *
 *  ⚠️ 方案 A 原稿作者建议的是"**取代**"（理由：取代之后总时长能压进 1.5s）。
 *     用户拍的是"先开场，**再**涌现" —— 本文件按用户的来，
 *     代价是总等待 3.1s，补偿手段是 `CFG.MOTION.SPROUT_TIME_SCALE` 那个加速旋钮。
 *
 * ------------------------------------------------------------
 *  【"墨圆裂开"时到底亮什么】—— 这是本文件最容易做错的一处
 *  原稿那句"棋盘容器 α 0→255"里的"容器"必须拆成**两个节点**：
 *    · HUD 组（页框之外的静态界面）→ 裂开时亮；
 *    · 牌堆组                    → 涌现时才亮。
 *  不拆的话，玩家会看到「棋盘已经在了，牌又冒出来一次」—— 同一件事讲两遍。
 *  所以本文件只接受一个 `hudLayer`，**从不碰牌堆组**。
 *
 * ------------------------------------------------------------
 *  【为什么全部用"实心圆 + 不同透明度"做晕】
 *  `Graphics` 没有模糊 / 渐变能力。四层实心圆 + 四档 alpha 是唯一能在纯色块
 *  体系里做出"墨在渗"的守法；三层就够看出柔化，六层以上纯属浪费 draw call。
 *  ⚠️ 四层必须**错峰 150ms 起播**（RING_START）—— 同时放大读成"光圈"，
 *     错峰才读成"墨在渗"。这是本段"魔性"的一半来源。
 *
 * ------------------------------------------------------------
 *  【两条硬约束】
 *  ① **可跳过**：任意点击直接跳到末态（只跳时间轴，不跳状态）；
 *  ② **绝不能卡住**：除了点击跳过，还有一条"到了总时长必然收尾"的兜底定时器。
 *     本项目的铁律是"状态流转必须走必然执行的路径"——一段开场动画
 *     把游戏挡在门外（哪怕只有万分之一的情况）都是不可接受的。
 * ============================================================
 */

import { Color, Label, Node, Tween, UIOpacity, UITransform, tween, v3 } from 'cc';
import { CFG } from '../CFG';
import {
    alphaPainter, createGraphicsNode, createLabel, createNode, fillCircle, fillEllipse,
    fillHalfDisc, strokeHalfRing,
} from './UIFactory';

/** 开场需要的上下文 */
export interface IntroOpts {
    /** 挂到哪（一般是页面的 root —— 追加为最后一个子节点即"最上层"） */
    parent: Node;
    /** 关卡名（从墨里浮出来的那一行） */
    title: string;
    /**
     * HUD 组 —— 第 ⑥ 帧"墨圆裂开"时淡入的那个组。
     * ⚠️ **不要传牌堆组**：牌堆归涌现管，这里传了就会"同一件事讲两遍"。
     */
    hudLayer: Node;
    /** 动画走完（或玩家跳过）时调用。**只会被调用一次** */
    onDone: () => void;
}

/** 一个"烘焙 alpha"的可绘制层（所有墨的形状都用它驱动透明度，见 UIFactory 的铁律） */
interface Paintable { a: number; redraw: () => void }

export class IntroAnim {

    /** 当前正在播的开场（同一时刻只允许一个） */
    private static _active: IntroAnim | null = null;

    private readonly _o: IntroOpts;
    private readonly _root: Node;
    /** 左右两半各自的分组节点（裂开时整体推出画面） */
    private readonly _halfGroups: Node[] = [];
    /**
     * 所有"墨"的可绘制层 —— 跳过 / 裂开时要让它们**各自**淡掉。
     *
     * ⚠️ 为什么不靠一个挂在本动画 root 上的 UIOpacity 一起淡：
     *    这些"墨"每一块内部都有**多档 alpha**（四层晕就是四档、墨滴的拖尾与
     *    头部是两档），而 UIOpacity 会把一整个 Graphics 的顶点 alpha **抹平**成
     *    同一个值（见 UIFactory 的铁律第 ⑤ 点）—— 一起淡的结果是
     *    "四层晕先塌成一块实心圆，再整块淡掉"。所以这里每个元素自己
     *    把 alpha 烘焙进颜色重画。
     */
    private readonly _paintables: Paintable[] = [];
    private readonly _drop: Node;
    private readonly _dropP: Paintable;
    private readonly _nameNode: Node;
    private readonly _nameOp: UIOpacity;
    /** 只允许收尾一次 */
    private _done = false;
    /** 兜底定时器句柄 */
    private _failsafe: ReturnType<typeof setTimeout> | null = null;

    // ========================================================
    //  对外入口
    // ========================================================
    public static play(opts: IntroOpts): void {
        if (IntroAnim._active) return;
        IntroAnim._active = new IntroAnim(opts);
    }

    /** 立即收掉正在播的开场（页面被切走时用），不会再触发 onDone */
    public static cancel(): void {
        const a = IntroAnim._active;
        IntroAnim._active = null;
        if (!a) return;
        a._done = true;
        if (a._failsafe) clearTimeout(a._failsafe);
        if (a._root.isValid) a._root.destroy();
    }

    // ========================================================
    //  构建 + 编排
    // ========================================================
    private constructor(o: IntroOpts) {
        this._o = o;
        const I = CFG.MOTION.INTRO;

        // ---------- 顶层：全屏触摸捕捉层（点击 = 跳过）----------
        this._root = new Node('IntroAnim');
        this._root.layer = o.parent.layer;
        o.parent.addChild(this._root);
        const rui = this._root.addComponent(UITransform);
        rui.setAnchorPoint(0.5, 0.5);
        rui.setContentSize(CFG.SCREEN.W * 1.2, CFG.SCREEN.H * 1.2);
        const catcher = createGraphicsNode('Catcher', this._root, {
            w: CFG.SCREEN.W * 1.2, h: CFG.SCREEN.H * 1.2,
        });
        // 画一个 alpha=1 的极淡矩形：**必须真的画点什么**，
        // 否则这个节点没有渲染内容，收不到触摸事件。
        catcher.g.fillColor = new Color(0, 0, 0, 1);
        catcher.g.rect(-CFG.SCREEN.W * 0.6, -CFG.SCREEN.H * 0.6, CFG.SCREEN.W * 1.2, CFG.SCREEN.H * 1.2);
        catcher.g.fill();
        catcher.node.on(Node.EventType.TOUCH_END, () => this.finish(true), this._root);
        this._root.setSiblingIndex(o.parent.children.length - 1);

        // ---------- ① 墨滴（8×26 的墨色竖条，带一条浅拖尾线在它上方）----------
        const dropRoot = createGraphicsNode('Drop', this._root, { w: 40, h: 80 });
        this._drop = dropRoot.node;
        // ⚠️ 全部用烘焙 alpha 画（不能用 UIOpacity 淡出：墨滴的拖尾是 0.16、
        //    头部是 1.0，**同一块 Graphics 里两档 alpha**，一挂 UIOpacity
        //    两档就会被抹平成同一档 —— 拖尾会变得和头一样黑。见 UIFactory 铁律）
        this._dropP = alphaPainter(dropRoot.g, (g, a) => {
            // 拖尾：一条淡竖线（"正在落下"，不是"已经落了"）
            g.fillColor = new Color(34, 32, 28, Math.round(a * 0.16));
            g.rect(-1, I.DROP_H / 2, 2, 34);
            g.fill();
            fillEllipse(g, 0, 0, I.DROP_W / 2, I.DROP_H / 2, CFG.COLOR.INK, a);
        }, 1);
        this._paintables.push(this._dropP);
        this._drop.setPosition(0, I.DROP_Y0, 0);

        // ---------- ②③④ 墨心 + 四层晕 + 外环（左右各一组，为第 ⑥ 帧的裂开做准备）----------
        for (const side of [-1, 1]) {
            const group = createNode(`Half${side < 0 ? 'L' : 'R'}`, this._root, {});
            group.setPosition(0, I.DROP_Y1, 0);
            this._halfGroups.push(group);

            for (let i = 0; i < I.RING_R.length; i++) {
                const r = I.RING_R[i];
                const { node, g } = createGraphicsNode(`Ring${i}`, group, {});
                // ★ 透明度**烘焙进颜色**，靠 alphaPainter 每帧重画。
                //   （四层晕各自有自己的 alpha，**同一时刻四档不同值**；
                //   原来的写法是给节点挂 UIOpacity、tween 它的 opacity ——
                //   那会把四层的顶点 alpha 一起抹平成同一档，
                //   四层叠起来就成了一块纯色实心圆。见 UIFactory 的铁律）
                const p = alphaPainter(g, (gg, a) => fillHalfDisc(gg, 0, 0, r, side, CFG.COLOR.INK, a), 0);
                this._paintables.push(p);
                node.setScale(v3(0, 0, 1));

                // 第 1 层（最小那层）在后层压上来时要稍微沉一点（0.28 → 0.22），
                // 否则四层叠在一起，圆心会越来越亮 —— 那是"发光"而不是"渗开"。
                const peak = I.RING_ALPHA[i];
                const settle = i === 0 ? I.RING_CORE_ALPHA : I.RING_ALPHA[i];

                tween(p)
                    .delay(I.RING_START[i])
                    .to(I.RING_IN, { a: peak }, { easing: 'quadOut', onUpdate: p.redraw })
                    .to(I.RING_IN, { a: settle }, { easing: 'quadOut', onUpdate: p.redraw })
                    .call(p.redraw)
                    .start();
                tween(node)
                    .delay(I.RING_START[i])
                    .to(I.RING_IN, { scale: v3(1, 1, 1) }, { easing: 'quadOut' })
                    .start();
            }

            // 最外那道 2.6px 墨环（只在 t = RING_START[3] 出现一次，r 固定不放大）
            const rr = I.RING_R[I.RING_R.length - 1];
            const ring = createGraphicsNode('Outline', group, {});
            const rp = alphaPainter(ring.g, (gg, a) => {
                strokeHalfRing(gg, 0, 0, rr, side, CFG.COLOR.INK, I.OUTLINE_W, a);
            }, 0);
            this._paintables.push(rp);
            tween(rp)
                .delay(I.RING_START[I.RING_START.length - 1])
                .to(I.OUTLINE_IN, { a: I.OUTLINE_ALPHA }, { easing: 'quadOut', onUpdate: rp.redraw })
                .call(rp.redraw)
                .start();
        }

        // ---------- ③' 墨心（那枚扁块；四层晕的中心，裂开时跟着消失）----------
        const core = createGraphicsNode('Core', this._root, {});
        core.node.setPosition(0, I.DROP_Y1, 0);
        const coreP = alphaPainter(core.g, (gg, a) => {
            fillEllipse(gg, 0, 0, I.CORE_W / 2, I.CORE_H / 2, CFG.COLOR.INK, a);
        }, 0);
        this._paintables.push(coreP);

        // ---------- ⑤ 关卡名（比第 4 层晕晚 280ms 起播 —— 先有墨，再有字）----------
        // ⚠️ 这一处**可以**用 UIOpacity：Label 走的是能生效的那条路
        //    （Label 的 assembler 会把 opacity 写进顶点色）。别顺手也改成烘焙式，
        //    那是没必要的重复劳动。
        const nameLabel: Label = createLabel(this._root, o.title, {
            y: I.NAME_Y,
            fontSize: CFG.FONT.SIZE_LABEL,
            color: CFG.COLOR.INK,
            bold: true,
            serif: true,
            outline: CFG.COLOR.PAPER,
            outlineWidth: 6,     // 压在墨上时靠一圈纸色描边把字"抠"出来
        });
        this._nameNode = nameLabel.node;
        this._nameOp = this._nameNode.addComponent(UIOpacity);
        this._nameOp.opacity = 0;
        this._nameNode.setScale(v3(I.NAME_SCALE_FROM, I.NAME_SCALE_FROM, 1));

        // ---------- 编排：② 落 → ③④ 晕 → ⑤ 名 → ⑥ 裂 ----------
        // ② 墨滴落下并**被压扁**（scaleY → 0.42 / scaleX → 2.10）
        //    【为什么压这么狠】"啪"那一声的听感全靠这次压扁；
        //    压到 0.9 只是"抖了一下"，压到 0.42 才是"墨砸在纸上摊开"。
        tween(this._drop)
            .to(I.DROP_IN, {
                position: v3(0, I.DROP_Y1, 0),
                scale: v3(I.DROP_SQUASH_X, I.DROP_SQUASH_Y, 1),
            }, { easing: 'quadIn' })
            .start();

        // 墨心在 ③ 阶段（第一层晕出现时）接手：墨滴主体融进墨心
        tween(this._dropP)
            .delay(I.RING_START[0])
            .to(I.RING_IN, { a: 0 }, { onUpdate: this._dropP.redraw })
            .call(this._dropP.redraw)
            .start();
        tween(coreP)
            .delay(I.RING_START[0])
            .to(I.RING_IN, { a: 1 }, { onUpdate: coreP.redraw })
            .call(coreP.redraw)
            .start();

        // ⑤ 关卡名
        tween(this._nameOp)
            .delay(I.NAME_START)
            .to(I.NAME_IN, { opacity: 255 }, { easing: 'quadOut' })
            .start();
        tween(this._nameNode)
            .delay(I.NAME_START)
            .to(I.NAME_IN, { scale: v3(1, 1, 1) }, { easing: 'backOut' })
            .start();

        // ⑥ 墨圆从正中裂开 + 同时亮 HUD（"舞台"在这一拍揭幕，"演员"还在后台）
        this.scheduleCrack();

        // ---------- 兜底：到点必然收尾 ----------
        // ⚠️ 这不是"保险起见"，是硬约束：一段开场动画绝不能被允许把游戏挡在门外。
        this._failsafe = setTimeout(
            () => this.finish(false),
            (I.TOTAL + 0.6) * 1000,
        );
    }

    /** 第 ⑥ 帧：左右两半推出画面 + HUD 淡入推镜 */
    private scheduleCrack(): void {
        const I = CFG.MOTION.INTRO;
        const delayMs = Math.max(0, (I.CRACK_START - 0.0) * 1000);
        setTimeout(() => {
            if (this._done || !this._root.isValid) return;
            this.crack();
        }, delayMs);
    }

    private crack(): void {
        const I = CFG.MOTION.INTRO;

        // 左右两半各自整体推出 ±CRACK_DX
        // 【为什么是 420】＝一个圆半径（200）的两倍多一点，
        // 保证在 260ms 内一定推出画面，不会"裂了一半停住"。
        // ⚠️ 只推 position，**不淡出** —— 淡出交给下面每个"墨"元素各自做。
        //    这半组里装的是四层墨晕（四档 alpha），在它上面挂一个 UIOpacity
        //    会把四档抹平成同一档（"四层晕塌成一块实心圆再淡出"）。
        //    而且这两半是**推出去**的，本来也不需要靠透明度收场。
        this._halfGroups.forEach((group, i) => {
            if (!group.isValid) return;
            const dx = (i === 0 ? -1 : 1) * I.CRACK_DX;
            Tween.stopAllByTarget(group);
            tween(group).to(I.CRACK_IN, { position: v3(dx, I.DROP_Y1, 0) }, { easing: 'quadIn' }).start();
        });

        // 所有"墨"各自淡掉（四层晕 / 外环 / 墨心 / 墨滴残留）
        for (const p of this._paintables) {
            Tween.stopAllByTarget(p);
            tween(p).to(I.CRACK_IN, { a: 0 }, { onUpdate: p.redraw }).call(p.redraw).start();
        }
        // 名字跟着一起退出（分镜第 ⑥ 帧里已经看不到它）
        Tween.stopAllByTarget(this._nameOp);
        tween(this._nameOp).to(I.CRACK_IN, { opacity: 0 }).start();

        // 与此同时：HUD 组 α 0→255、scale 1.06→1.00（复用 PAGE.ENTER_SCALE_FROM 的推镜语言）
        this.revealHud();

        setTimeout(() => this.finish(false), (I.CRACK_IN + 0.05) * 1000);
    }

    /** 把 HUD 组从"没有"变成"有" */
    private revealHud(): void {
        const I = CFG.MOTION.INTRO;
        const hud = this._o.hudLayer;
        if (!hud || !hud.isValid) return;
        let op = hud.getComponent(UIOpacity);
        if (!op) op = hud.addComponent(UIOpacity);
        Tween.stopAllByTarget(op);
        Tween.stopAllByTarget(hud);
        // ✅ 这一处 UIOpacity 是**正确用法**：`hudLayer` 要的就是"整层统一淡入"，
        //    页框 / 顶部信息条 / 槽位条 / 道具栏在这一拍**一起**从 0 走到 255。
        //    （引擎里它是把子树每个顶点的 alpha **覆写**成同一个级联值，
        //     见 UIFactory 铁律的 ②③④ —— 所以"整层一个透明度"天然成立。）
        //  ★ 但要注意这里**合规的理由是"终点是 255 + 整层单档"**，而不是
        //    "UIOpacity 对 Graphics 有效"。它的覆写是**一次性**的：tween 一停、
        //    顶点被重建，alpha 就回落成 Graphics 自己烘焙的值。
        //    终点正好是 255，回落值就等于目标值，所以这一处稳。
        //    ⚠️ 别照着它抄"中间值"——若要停在 128，就得用 `alphaPainter`
        //    烘焙（否则 tween 一结束就会弹回全不透明）。判据见 UIFactory 铁律。
        //  ⚠️ 另外**别把多档 alpha 的"晕"放进这个容器**：那几档会被抹平。
        //     本文件里所有"墨"都挂在 `_root` 上（与 hudLayer 是兄弟节点），
        //     刻意不进这个容器 —— 这也是它们能保持分层的原因之一。
        tween(op).to(I.CRACK_IN, { opacity: 255 }).start();
        // 推镜：从 1.06 缩到 1.00（"镜头推近落定"）
        hud.setScale(v3(I.HUD_SCALE_FROM, I.HUD_SCALE_FROM, 1));
        tween(hud).to(I.CRACK_IN, { scale: v3(1, 1, 1) }, { easing: 'quadOut' }).start();
    }

    /**
     * 收尾。
     *
     * @param skipped 玩家点了跳过。两种情况的**末态完全一样** ——
     *                这正是"只跳时间轴，不跳状态"的落地：跳过之后
     *                HUD 该亮的亮、牌堆该冒的冒，只是不让玩家等。
     */
    private finish(skipped: boolean): void {
        if (this._done) return;
        this._done = true;
        if (this._failsafe) { clearTimeout(this._failsafe); this._failsafe = null; }
        IntroAnim._active = null;

        const hud = this._o.hudLayer;
        if (hud && hud.isValid) {
            Tween.stopAllByTarget(hud);
            hud.setScale(v3(1, 1, 1));
            const op = hud.getComponent(UIOpacity);
            if (op) { Tween.stopAllByTarget(op); op.opacity = 255; }
        }

        if (this._root.isValid) {
            Tween.stopAllByTarget(this._root);
            if (skipped) {
                // 跳过时让残留的墨在 100ms 里散掉，不要"啪"地消失。
                // ⚠️ 注意这里必须**逐个**淡那些墨（各自烘焙 alpha 重画），
                //    不能在本动画 root 上挂一个 UIOpacity 一起淡 ——
                //    那样四层晕会先被抹平成一块实心圆、再整块消失。
                //    （引擎机制见 UIFactory 的铁律；不是"不生效"，是"生效得没有层次"。）
                const live = this._paintables.slice();
                const p0 = live.shift();
                if (p0) {
                    tween(p0).to(0.10, { a: 0 }, { onUpdate: p0.redraw }).call(p0.redraw)
                        .call(() => {
                            for (const p of live) { Tween.stopAllByTarget(p); p.a = 0; p.redraw(); }
                            if (this._root.isValid) this._root.destroy();
                        })
                        .start();
                } else if (this._root.isValid) {
                    this._root.destroy();
                }
                Tween.stopAllByTarget(this._nameOp);
                tween(this._nameOp).to(0.10, { opacity: 0 }).start();
            } else {
                this._root.destroy();
            }
        }

        this._o.onDone();
    }
}
