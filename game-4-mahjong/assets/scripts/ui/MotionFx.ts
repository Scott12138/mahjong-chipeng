/**
 * ============================================================
 *  MotionFx.ts · 动效工具箱（S7 手感层的唯一出口）
 * ============================================================
 *  这个文件解决的问题只有一个：**让"动效"这件事不再散落在业务代码里**。
 *  动效散落有三个必然后果，本工程都真实踩过：
 *    ① 同一个节点被两条 tween 同时改 position → 一顿一顿地抽搐
 *       （典型场景：牌正在飞向槽位，槽位又同时在做"左移补位"）；
 *    ② 换一条曲线要满工程 grep 改字符串，改漏一处就只剩那一个动效不搭；
 *    ③ 跨容器飞行的坐标靠"两个容器原点恰好重合"这个巧合，一旦
 *       某天给槽位层加个偏移，所有飞牌立刻飞到屏幕外。
 *  所以这里把三件事收口：
 *
 *  ------------------------------------------------------------
 *  【一、带 tag 的 tween 管理】
 *  同一节点 + 同一 tag 再次触发时，**先 stop 旧的、再起新的**。
 *  tag 是"动效的通道名"（press / fly / slot / hint …），不是"动效的名字"：
 *    · 同 tag = 争抢同一批属性 → 必须互斥（后发者赢）；
 *    · 不同 tag = 动不同的属性 → 允许并行（这正是"丝滑"的来源）。
 *  例：牌在飞（tag=fly，改 position+scale）的同时可以做按压反馈
 *      （tag=press，改 scale）—— 但本工程刻意不让 press 与 fly 并存，
 *      因为 scale 会互相覆盖，看上去就是抖。**要不要并行，由调用方选 tag 决定。**
 *
 *  ⚠️ 为什么不给 tween 挂 .call() 做清理：
 *     工程铁律 —— 动效链路只负责好看，状态流转必须走"必然执行"的路径。
 *     清理注册表这种"顺带"的事一旦挂在回调上，回调丢失就会留下僵尸引用。
 *     这里改成"下次启动时无脑覆盖"，一个回调都不需要。
 *
 *  ------------------------------------------------------------
 *  【二、缓动常量】
 *  业务代码只许写 EASE.MOVE 这种语义名，不许写 'quadOut'。
 *  值来自 CFG.MOTION，语义与理由见 CFG 里的注释。
 *
 *  ------------------------------------------------------------
 *  【三、跨容器坐标换算】
 *  `localToWorld` / `worldToLocal` / `between` 三个函数把 Cocos 的
 *  `UITransform.convertToWorldSpaceAR` / `convertToNodeSpaceAR` 包成
 *  「传一个 Vec3 进去，拿一个 Vec3 出来」，并且**返回新对象**
 *  （引擎的那两个 API 会复用传入的 out 参数，直接返回它会被下一个调用覆盖，
 *   这类 bug 表现为"牌偶尔飞向上一张牌的位置"，极难查）。
 *
 *  ------------------------------------------------------------
 *  【四、临时特效层 + 对象池】
 *  C3 的碎屑、D1 的脉冲圆环都是"生成 → 播完 → 销毁"的短命节点。
 *  每帧 new + destroy 会产生可观的 GC 抖动（微信小游戏上尤其明显），
 *  所以走池子。池子有两条硬约束（都写在代码里，别改成软约束）：
 *    · **到期强制回收**：任何租出去的节点，`FX_MAX_LIFE` 之后无条件回收，
 *      不依赖 tween 回调 —— 回调丢了池子就漏，跑几局帧率肉眼可见地掉；
 *    · **防重复回收**：用 generation 计数，过期定时器不会把
 *      "已经还回池子、又被别人租走"的节点误伤。
 *
 *  ------------------------------------------------------------
 *  【本文件不做的事】
 *  · 不驱动任何游戏状态（不碰 GamePage 的 _slots / _taken / _busy）；
 *  · 不 import 任何业务模块（只依赖 CFG + TileRenderer 的取色工具）。
 *    → 依赖方向永远是 GamePage → MotionFx，反过来就乱了。
 * ============================================================
 */

import {
    Graphics, Layers, Node, Tween, TweenEasing, UIOpacity, UITransform, Vec3, easing, error, tween, v3,
} from 'cc';

import { CFG } from '../CFG';
import { hex2color } from './TileRenderer';

// ============================================================
//  一、语义缓动常量
// ============================================================

/**
 * 缓动的语义名。
 * ⚠️ 业务代码里出现 'quadOut' 这种字面量 = 违规：
 *    它既说不清"为什么是这条曲线"，也让换曲线变成考古。
 */
export const EASE = {
    /** 入场 / 出现 */
    ENTER: CFG.MOTION.EASE_ENTER,
    /** 位移（与入场同族，保证"飞"和"浮现"像同一个世界里的东西） */
    MOVE: CFG.MOTION.EASE_MOVE,
    /** 弹跳 / 胀开（带过冲，"手感"的主要来源） */
    POP: CFG.MOTION.EASE_POP,
    /** 消失（先慢后快地加速离开） */
    EXIT: CFG.MOTION.EASE_EXIT,
    /** 呼吸 / 往复 */
    IDLE: CFG.MOTION.EASE_IDLE,
    /** 拒绝 / 抖动 */
    REJECT: CFG.MOTION.EASE_REJECT,
    /** 下落（越落越快 = 重力感） */
    DROP: CFG.MOTION.EASE_DROP,
    /** 冲刺 / 撞击（越冲越快 = 力量感，与 DROP 数值相同但语义不同） */
    DASH: CFG.MOTION.EASE_DASH,
    /**
     * ★ 牌飞入槽位（S12.1 新增）。
     * 数值上与 DASH 相同（都是 quadIn），但**语义不同、不能互相替代**：
     *   · DASH 是"撞过去"（碰/杠的三张牌互撞）；
     *   · FLY  是"被槽位吸走"（玩家点完牌，牌加速离场）。
     * 之所以不直接复用 DASH，是为了让阅读代码的人看到 EASE.FLY 就知道
     * 这是"入槽"那条链路 —— 顺手把 DASH 调成别的曲线时不会误伤飞行。
     */
    FLY: CFG.MOTION.EASE_FLY,
} as const;

/**
 * 缓动名 → 缓动函数。
 *
 * 【为什么需要这张表】
 * `Tween.to(..., { easing: 'quadOut' })` 里的 easing 只作用于**那一段**
 * 的线性插值。而弧线是"很多段直线的拼合" —— 如果把 quadOut 挨个套到
 * 每一小段上，等于把加速曲线重复了 8 次，观感是"一顿一顿地往前拱"。
 * 正确做法是：把缓动作用在**整条弧的参数 u 上**（采样点按 ease(i/n) 分布），
 * 每小段本身用 linear。这张表就是给采样用的。
 *
 * 【为什么只列这几种】
 * 只列 CFG.MOTION 里真实会用作"弧线整体缓动"的那几条。
 * 多列无用项会让"到底哪些曲线能用在弧线上"变得含糊。
 */
const EASE_FN: Record<string, (k: number) => number> = {
    quadOut: easing.quadOut,
    quadIn: easing.quadIn,
    backOut: easing.backOut,
    sineInOut: easing.sineInOut,
    linear: easing.linear,
};

// ============================================================
//  二、动效通道（tag）
// ============================================================
//  tag 是**通道**不是**名字**：同通道互斥、异通道并行。
//  命名规则 = "这条动效在改哪一组属性"，不是"这是哪个功能"。
// ============================================================

export const TAG = {
    /** 按压（改 scale / 纵向微位移） */
    PRESS: 'press',
    /** 选中强调（改 position / scale / 描边） */
    SELECT: 'select',
    /** 飞向槽位（改 position / scale） */
    FLY: 'fly',
    /** 槽内落位与聚拢（改 position / scale） */
    SLOT: 'slot',
    /**
     * 旋转（改 angle）。
     * 单独成通道的原因：D4「移出」的位移走 MotionFx.arc，
     * 它按采样点直接驱动 position，表达不了"顺便转个角度"，
     * 只能拆成两条 tween；而两条 tween 改的是不同属性，
     * 用同一个 tag 反而会互相打断（后起的把前一条 stop 掉）。
     */
    SPIN: 'spin',
    /** 牌堆内的位置（入场涌现、洗牌铺开、提示呼吸） */
    STACK: 'stack',
    /** 牌堆整体浮现（改容器 scale / opacity） */
    ENTER: 'enter',
    /**
     * 牌堆整体的**冲击位移**（改容器 position）。
     * 【为什么不能和 ENTER 共用】S7 踩过一次共用 tag 导致动画被自己停掉的坑
     * （缩放与淡入共用 ENTER，后起的把先起的 stop 了）。
     * "碰"的撞击踢与"入场浮现"在时间上不重叠，理论上可以共用；
     * 但共用通道等于给未来的自己埋雷 —— 只要有一天两者重叠，就是一次难查的抖动。
     */
    KICK: 'kick',
    /** 透明度（与上面几条分开，便于"位移动画不打断淡入淡出"） */
    FADE: 'fade',
    /** 临时特效 */
    FX: 'fx',
} as const;

export type MotionTag = string;

// ============================================================
//  三、tween 注册表（同节点同 tag → 唯一在跑的 tween）
// ============================================================

type AnyTween = Tween<any>;

/** WeakMap：节点被销毁后注册表自动释放，不会攒住内存 */
const _running = new WeakMap<Node, Map<MotionTag, AnyTween>>();

function slotOf(node: Node): Map<MotionTag, AnyTween> {
    let m = _running.get(node);
    if (!m) {
        m = new Map<MotionTag, AnyTween>();
        _running.set(node, m);
    }
    return m;
}

/** 可以交给 tween 的节点属性（只列本工程用到的） */
export interface NodeProps {
    position?: Vec3;
    scale?: Vec3;
    angle?: number;
}

/** 一条 tween 的公共选项（不含时长 —— 时长在各自的 steps 里给） */
export interface FxOpts {
    /** 起始延时（秒）。多张牌错峰就用它，而不是给每条 tween 各写一个 setTimeout */
    delay?: number;
    easing?: string;
    tag?: MotionTag;
}

/** 单段位移 / 缩放 / 旋转的目标参数 */
export interface ToOpts extends FxOpts {
    /** 时长（秒） */
    duration?: number;
}

export class MotionFx {

    // --------------------------------------------------------
    //  tween 控制
    // --------------------------------------------------------

    /**
     * 停掉某节点某通道上正在跑的 tween。
     * 对"已经跑完"的 tween 调用 stop() 也是安全的（引擎内部会自行判断），
     * 所以这里不需要"它还在不在跑"的判断 —— 少一个判断就少一类 bug。
     */
    public static stop(node: Node | null | undefined, tag: MotionTag): void {
        if (!node || !node.isValid) return;
        const m = _running.get(node);
        const t = m?.get(tag);
        if (!t) return;
        t.stop();
        m!.delete(tag);
    }

    /** 停掉某节点上的全部通道（换父节点 / 回收进池之前必须调，否则残留 tween 会写坏复位值） */
    public static stopAll(node: Node | null | undefined): void {
        if (!node || !node.isValid) return;
        const m = _running.get(node);
        if (!m) return;
        m.forEach((t) => t.stop());
        m.clear();
    }

    /**
     * 启动一条带 tag 的 tween。
     *
     * @param key  注册表键节点（动画目标可以是它自己，也可以是它的 UIOpacity 组件）
     * @param make 构建器。做成回调是为了让调用方能自由追加 `.to().to()`
     *             （两段式消除 C2 就是这么写的），而不必在工具箱里堆一堆特化方法。
     */
    private static launch(key: Node, tag: MotionTag, make: () => AnyTween): void {
        if (!key || !key.isValid) return;
        MotionFx.stop(key, tag);
        const t = make();
        slotOf(key).set(tag, t);
        t.start();
    }

    /**
     * 弧线飞行（D1 奖励飞向目标、D4 移出道具的下坠）。
     *
     * 【为什么必须自己算，而不是用引擎的弧线 API】
     * Cocos Creator 3.8 的 Tween 里**没有** bezierTo / splineTo ——
     * 那套 API 是 2.x 的 Action 系统，3.0 起重写后只剩 to/by/set/delay。
     * 凡是写 `tween(x).bezierTo(...)` 的代码都只会在运行时报 undefined。
     * 所以这里把三次贝塞尔采样成 N 段直线，交给链式 to() 跑。
     *
     * 【采样为什么要过缓动函数】
     * 每小段时长相等（duration/N），所以"第 i 个采样点"对应时间进度 i/N。
     * 如果直接取 B(i/N)，整条弧就是**匀速**的 —— 起手生硬、收尾撞墙。
     * 取 B(ease(i/N)) 后，采样点在弧上按缓动函数分布（缓动快的地方点稀），
     * 于是"位移速度"就跟着缓动走了，而每小段仍用 linear 衔接。
     *
     * @param from 起点（节点局部坐标，须与节点父容器一致）
     * @param c1   第一控制点（起点侧的"拉出方向"）
     * @param c2   第二控制点（终点侧的"送进方向"）
     * @param to   终点
     */
    public static arc(
        node: Node | null | undefined,
        from: Vec3, c1: Vec3, c2: Vec3, to: Vec3,
        duration: number,
        opts: { tag?: MotionTag; easing?: string; segments?: number } = {},
    ): void {
        if (!node || !node.isValid || duration <= 0) return;
        const tag = opts.tag ?? TAG.FLY;
        const n = Math.max(2, opts.segments ?? CFG.MOTION.ARC_SEGMENTS);
        const fn = EASE_FN[opts.easing ?? EASE.MOVE] ?? easing.linear;

        node.setPosition(from);
        MotionFx.launch(node, tag, () => {
            let cur: AnyTween = tween(node);
            for (let i = 1; i <= n; i++) {
                const u = fn(i / n);
                // 三次贝塞尔：B(u) = (1-u)³P0 + 3(1-u)²u·P1 + 3(1-u)u²·P2 + u³P3
                const iu = 1 - u;
                const a = iu * iu * iu;
                const b = 3 * iu * iu * u;
                const c = 3 * iu * u * u;
                const d = u * u * u;
                const p = v3(
                    a * from.x + b * c1.x + c * c2.x + d * to.x,
                    a * from.y + b * c1.y + c * c2.y + d * to.y,
                    0,
                );
                // 每小段 linear：缓动已经体现在采样点的疏密上了
                cur = cur.to(duration / n, { position: p } as any,
                    { easing: 'linear' as TweenEasing });
            }
            return cur;
        });
    }

    /**
     * 节点属性 tween（position / scale / angle 可任意组合）。
     *
     * ⚠️⚠️ **第二参是「属性表」，不是「步骤表」** —— 本文件最容易传错的一处。
     *   ✅ 对：`MotionFx.to(node, { position: v3(x, y, 0) }, { duration: 0.3, easing: EASE.IDLE })`
     *   ❌ 错：`MotionFx.to(node, { props: { position: … }, duration: 0.3 }, { … })`
     *      —— 这是把 `chain` / `to2` 的「step」形状照搬过来了。chain 的每个 step
     *      确实是 `{ props, duration, easing }`，但 `to` **不是**（`to` 只有一层）。
     *
     * 【传错之后会发生什么（S7.5 真踩过，花了很久才定位）】
     *   引擎会把 `props` / `duration` / `easing` 当成三个**节点属性名**去动画：
     *   ① `Node` 上根本没有这三个属性 → `TweenAction._initProps` 给 `prop.start`
     *      留下的初值是 `null`；
     *   ② 而 **`typeof null === 'object'`（JS 经典陷阱）骗过**了引擎的类型分支
     *      （`TweenAction.update`：`typeof start === 'object'`），于是走进
     *      「按 keys 逐字段插值」的分支，去读同样为 `null` 的 `prop.keys.length`
     *      → **每一帧都抛 `TypeError: Cannot read properties of null (reading 'length')`**；
     *   ③ 且 `duration` 落在了 props 里，`opts.duration` 是 `undefined` → 时长 0，
     *      目标节点**根本不动**。
     *   这三个后果都很坏：不白屏（只是控制台刷屏 + 动效静默失效），
     *   报错还指向引擎内部的插值代码，看不出是调用方的锅。
     *
     *   → 所以下面加了运行时防呆。哪怕将来又有人传错，代价也只是"一行显眼的报错"，
     *     而不再是"一小时定位引擎内部异常"。
     */
    public static to(
        node: Node | null | undefined, props: NodeProps, opts: ToOpts,
    ): void {
        if (!node || !node.isValid) return;
        // 防呆：只接受 position / scale / angle（NodeProps 的全部合法键）。
        // 只做一次 O(3) 的循环，却很划算 —— 见上面 JSDoc 里"传错之后会发生什么"。
        for (const k in props) {
            if (k !== 'position' && k !== 'scale' && k !== 'angle') {
                error(`[MotionFx.to] 非法的属性名 "${k}"：只接受 position / scale / angle。`
                    + '（是否把 chain / to2 的 {props, duration, easing} 形状误传给了 to？）');
                return;
            }
        }
        const tag = opts.tag ?? TAG.SELECT;
        const dur = opts.duration ?? 0;
        MotionFx.launch(node, tag, () => {
            let cur: AnyTween = tween(node);
            if (opts.delay && opts.delay > 0) cur = cur.delay(opts.delay);
            return cur.to(dur, props as any, { easing: (opts.easing ?? EASE.MOVE) as TweenEasing });
        });
    }

    /**
     * 两段式 tween（C2「先胀到峰值、再收缩消失」就是它）。
     * 之所以要显式支持两段，是因为**一条曲线跑完的收缩没有"胀"的记忆**：
     * backOut 直接跑到 0 会先过冲再回来，看起来像"弹了一下才消失"，
     * 而不是"胀开后被打散"。顺序错了，消除的爽感就没了。
     */
    public static to2(
        node: Node | null | undefined,
        first: { props: NodeProps; duration: number; easing?: string },
        second: { props: NodeProps; duration: number; easing?: string },
        opts: ToOpts = {},
    ): void {
        MotionFx.chain(node, [
            { props: first.props, duration: first.duration, easing: first.easing ?? EASE.POP },
            { props: second.props, duration: second.duration, easing: second.easing ?? EASE.EXIT },
        ], opts);
    }

    /**
     * N 段式 tween（B6 的"抖两下"、C2 的"胀开再散掉"都由它表达）。
     *
     * 【为什么坚持用一条链而不是几条独立 tween】
     * 几条独立 tween 抢同一批属性时，段与段的交界处必然有重叠帧，
     * 真机上表现为一次肉眼可见的顿挫。一条链由引擎保证顺序，
     * 交界处严格首尾相接 —— 这正是"丝滑"与"有点卡"的分界线。
     */
    public static chain(
        node: Node | null | undefined,
        steps: Array<{ props: NodeProps; duration: number; easing?: string }>,
        opts: ToOpts = {},
    ): void {
        if (!node || !node.isValid || steps.length === 0) return;
        const tag = opts.tag ?? TAG.SELECT;
        MotionFx.launch(node, tag, () => {
            let cur: AnyTween = tween(node);
            if (opts.delay && opts.delay > 0) cur = cur.delay(opts.delay);
            for (const s of steps) {
                cur = cur.to(s.duration, s.props as any, { easing: (s.easing ?? EASE.MOVE) as TweenEasing });
            }
            return cur;
        });
    }

    /** 透明度 tween 的通用入口（节点没有 UIOpacity 会自动补一个） */
    private static opacityOf(node: Node): UIOpacity {
        let op = node.getComponent(UIOpacity);
        if (!op) op = node.addComponent(UIOpacity);
        return op;
    }

    /**
     * 透明度 tween。
     * ⚠️ 节点缺少 UIOpacity 时**自动补挂** —— 少了它 opacity 会静默不生效，
     *    表现为"动画写了但画面没淡出"，这类 bug 十有八九就是漏挂组件。
     */
    public static fade(
        node: Node | null | undefined, to: number, duration: number,
        opts: { delay?: number; easing?: string; tag?: MotionTag } = {},
    ): void {
        if (!node || !node.isValid) return;
        const op = MotionFx.opacityOf(node);
        const tag = opts.tag ?? TAG.FADE;
        MotionFx.launch(node, tag, () => {
            let cur: AnyTween = tween(op);
            if (opts.delay && opts.delay > 0) cur = cur.delay(opts.delay);
            return cur.to(duration, { opacity: to }, { easing: (opts.easing ?? EASE.ENTER) as TweenEasing });
        });
    }

    /**
     * 透明度链式 tween：按给定关键帧依次走完（E3 洗牌白闪的"亮起再灭"用它）。
     * 为什么不用两次 fade：两次独立的 tween 会同时持有同一个 UIOpacity，
     * 在"前一条的结束时刻"和"后一条的起始时刻"之间必然有重叠帧，
     * 那种重叠在真机上是肉眼可见的一顿。
     */
    public static fadeChain(
        node: Node | null | undefined,
        steps: Array<{ to: number; duration: number; easing?: string }>,
        opts: { delay?: number; tag?: MotionTag } = {},
    ): void {
        if (!node || !node.isValid || steps.length === 0) return;
        const op = MotionFx.opacityOf(node);
        const tag = opts.tag ?? TAG.FADE;
        MotionFx.launch(node, tag, () => {
            let cur: AnyTween = tween(op);
            if (opts.delay && opts.delay > 0) cur = cur.delay(opts.delay);
            for (const s of steps) {
                cur = cur.to(s.duration, { opacity: s.to }, { easing: (s.easing ?? EASE.ENTER) as TweenEasing });
            }
            return cur;
        });
    }

    /** 立即设置透明度（不做动画）。用于"先摆好初始状态再播"。 */
    public static setFade(node: Node | null | undefined, value: number): void {
        if (!node || !node.isValid) return;
        let op = node.getComponent(UIOpacity);
        if (!op) op = node.addComponent(UIOpacity);
        op.opacity = value;
    }

    /** 立即设置缩放（不做动画） */
    public static setScale(node: Node | null | undefined, s: number): void {
        if (!node || !node.isValid) return;
        node.setScale(s, s, 1);
    }

    // --------------------------------------------------------
    //  时长推导
    // --------------------------------------------------------

    /**
     * 按距离推导位移时长（毫秒 → 秒）。
     *
     * 【为什么不能拍一个固定时长】
     * 牌堆到槽位的距离，第 1 关（平铺、牌都在上半区）和第 4 关（六层堆叠、
     * 最远的牌几乎贴顶）能差一倍。固定 180ms 的后果是：近的牌慢悠悠、
     * 远的牌一闪而过 —— 玩家会明显觉得"这游戏忽快忽慢"。
     * 用速度（px/ms）反推、再夹到 [MOVE_MIN, MOVE_MAX]，
     * 观感就与距离解耦了。
     */
    public static moveDuration(from: Vec3, to: Vec3): number {
        const M = CFG.MOTION;
        const dist = Vec3.distance(from, to);
        const ms = Math.max(M.MOVE_MIN, Math.min(M.MOVE_MAX, dist / M.MOVE_SPEED));
        return ms / 1000;
    }

    /** 状态解锁的等待毫秒数（= 动画时长 + 余量）。铁律：状态流转只走这条路径 */
    public static unlockMs(durationSec: number): number {
        return durationSec * 1000 + CFG.MOTION.UNLOCK_MS;
    }

    // --------------------------------------------------------
    //  跨容器坐标换算
    // --------------------------------------------------------

    /**
     * 局部坐标 → 世界坐标。
     * ⚠️ 必须 clone：引擎 API 会把结果写进传入的 out（或内部复用对象），
     *    直接返回会让上一次的结果被下一次调用覆盖。
     */
    public static localToWorld(node: Node | null | undefined, local: Vec3): Vec3 {
        if (!node || !node.isValid) return local.clone();
        const ui = node.getComponent(UITransform);
        if (!ui) return local.clone();
        return ui.convertToWorldSpaceAR(local, new Vec3()).clone();
    }

    /** 世界坐标 → 局部坐标 */
    public static worldToLocal(node: Node | null | undefined, world: Vec3): Vec3 {
        if (!node || !node.isValid) return world.clone();
        const ui = node.getComponent(UITransform);
        if (!ui) return world.clone();
        return ui.convertToNodeSpaceAR(world, new Vec3()).clone();
    }

    /**
     * 把「from 容器里的一点」换算成「to 容器里的坐标」。
     *
     * 这是本文件里最值钱的一个函数：飞牌要跨 StackLayer → FxLayer → SlotLayer
     * 三个容器，一旦靠"层级原点相同"这种巧合去省掉换算，
     * 任何一层被加上偏移（比如为了适配超长屏）都会让飞牌集体飞出屏幕，
     * 而且报错信息是**完全没有**的。换算一下的成本可以忽略。
     */
    public static between(from: Node | null | undefined, to: Node | null | undefined, local: Vec3): Vec3 {
        return MotionFx.worldToLocal(to, MotionFx.localToWorld(from, local));
    }

    /**
     * 取节点在世界坐标下的位置（不受父容器变换影响）。
     * 用于"从牌当前实际所在处起飞"——正在播提示呼吸、正在洗牌铺开的牌，
     * 它的**数据坐标**和**视觉坐标**是不一致的，必须以视觉位置为准。
     */
    public static worldPosOf(node: Node | null | undefined): Vec3 {
        if (!node || !node.isValid) return new Vec3();
        const ui = node.getComponent(UITransform);
        if (!ui) return node.worldPosition.clone();
        return ui.convertToWorldSpaceAR(new Vec3(), new Vec3()).clone();
    }
}

// ============================================================
//  四、临时特效层 + 对象池
// ============================================================

/** 特效种类（池子的分桶键）。同类节点结构一致，才能复用 */
export type FxKind = 'debris' | 'pulse' | 'flash' | 'icon' | 'jaw';

interface PoolBucket {
    free: Node[];
}

/**
 * 特效对象池。
 *
 * 生命周期约定（硬约束，改之前先想清楚代价）：
 *   租出 → 播动画（≤ FX_MAX_LIFE）→ 归还（动画结束 or 到期强制）
 * **到期强制回收**是这里的兜底，不是优化：tween 回调在
 * 「节点被销毁 / 页面切换 / 引擎暂停」时都可能不触发，
 * 只靠回调收回的池子跑几局就会把 free 列表掏空、变成"每次都新建"。
 */
export class FxPool {

    private _layer: Node | null = null;
    private _buckets = new Map<FxKind, PoolBucket>();
    /** 已归还到池子里的节点（防重复归还） */
    private _idle = new Set<Node>();
    /** 世代号：过期定时器不会误伤"已还给别人"的节点 */
    private _gen = new Map<Node, number>();

    /** 挂在哪个层下（飞牌与临时特效统一放 FxLayer，见 GamePage 的层序） */
    public attach(layer: Node): void {
        this._layer = layer;
    }

    public get layer(): Node | null { return this._layer; }

    /**
     * 租一个特效节点。
     * 返回值已经复位（位置 0,0、缩放 1、角度 0、不透明、active），
     * 调用方直接摆位置 + 起 tween 即可。
     */
    public rent(kind: FxKind): Node {
        const bucket = this._buckets.get(kind) ?? { free: [] };
        this._buckets.set(kind, bucket);

        let node: Node | null = null;
        while (bucket.free.length > 0) {
            const cand = bucket.free.pop()!;
            if (cand.isValid) { node = cand; break; }
        }
        if (!node) node = this.create(kind);

        this._idle.delete(node);
        this._gen.set(node, (this._gen.get(node) ?? 0) + 1);

        // 挂回特效层（换过父的节点必须换回来，否则会跟着旧父一起被销毁）
        if (this._layer && node.isValid && node.parent !== this._layer) {
            node.setParent(this._layer);
        }
        // 复位：**必须 stopAll**，否则上一位租客的残留 tween 会继续写这些值
        MotionFx.stopAll(node);
        node.active = true;
        node.setPosition(0, 0, 0);
        node.setScale(1, 1, 1);
        node.angle = 0;
        MotionFx.setFade(node, 255);
        return node;
    }

    /** 归还。重复归还、归还已销毁节点都会被安全忽略 */
    public give(kind: FxKind, node: Node | null | undefined): void {
        if (!node || !node.isValid) return;
        if (this._idle.has(node)) return;

        MotionFx.stopAll(node);
        node.active = false;
        this._idle.add(node);

        const bucket = this._buckets.get(kind) ?? { free: [] };
        this._buckets.set(kind, bucket);
        bucket.free.push(node);
    }

    /**
     * 给刚租出的节点登记一次"到期强制回收"。
     * 到期时若这个节点**仍然是这一代的租客**才回收 ——
     * 世代号对不上说明它已经按正常流程还回去了（甚至已被别人租走），
     * 这时再去回收就会把别人正在用的节点抽走。
     */
    public autoRecycle(kind: FxKind, node: Node, lifeSec?: number): void {
        const myGen = this._gen.get(node) ?? 0;
        // 寿命默认 FX_MAX_LIFE，但**调用方可以传更长的值**。
        //
        // ⚠️ 这条兜底必须**晚于**该特效自己安排的显式回收，否则"兜底"就变成了
        //    "提前掐断"。踩过的坑：奖励图标要飞 REWARD_FLY(0.42s)，
        //    而默认寿命只有 0.40s —— 兜底比显式回收早 20ms 触发，
        //    图标在到位前被 give()（内部 stopAll + active=false），
        //    飞行补间被截断。现在人眼只是少一帧，但只要有人把飞行时长调大、
        //    或把寿命调小，就会变成"图标飞到一半凭空消失"，
        //    恰好摧毁这段动画存在的唯一理由（交代"奖励已到手"的因果）。
        const life = Math.max(1, Math.ceil((lifeSec ?? CFG.MOTION.FX_MAX_LIFE) * 1000));
        setTimeout(() => {
            if (!node.isValid) return;
            if ((this._gen.get(node) ?? 0) !== myGen) return;   // 已经不是这一代了
            this.give(kind, node);
        }, life);
    }

    /** 页面销毁时清池（池子里的节点是页面子节点，会随之销毁，这里只是断开引用） */
    public clear(): void {
        this._buckets.clear();
        this._idle.clear();
        this._gen.clear();
        this._layer = null;
    }

    // --------------------------------------------------------
    //  节点工厂（每种特效用"一个 Graphics 一次画完"，不建子节点）
    // --------------------------------------------------------
    private create(kind: FxKind): Node {
        const node = new Node(`Fx_${kind}`);
        node.layer = Layers.Enum.UI_2D;
        const ui = node.addComponent(UITransform);
        ui.setAnchorPoint(0.5, 0.5);
        ui.setContentSize(CFG.SCREEN.W, CFG.SCREEN.H);
        node.addComponent(UIOpacity);
        node.addComponent(Graphics);
        return node;
    }
}

// ============================================================
//  五、两种成品特效（C3 碎屑 / D1 脉冲圆环）
// ============================================================

/**
 * C3「爆开」：一圈小点四散淡出。
 *
 * 【为什么是圆点而不是方块（S12 追加了例外，见下）】圆点的半径可以随着"飞散"
 * 一起缩小，视觉上是"碎屑"，方块缩小时更像"缩放的贴图"。而且真牌的碎屑本来就该是圆的。
 *
 * 【S12 的例外：「吃」的咀嚼残渣用**方**点】
 * 这是「碰 / 吃」**差异底线**的一部分（见 CFG.MOTION §十五）：
 *   · 圆点 = 能量从中心**炸开**（碰）；
 *   · 方点 = 被**嚼碎**的渣（吃）。
 * 两者用同一个函数、靠一个 `square` 开关区分 —— 刻意不复制一份实现，
 * 因为复制出来的两份迟早会分叉（改了一处忘了另一处）。
 *
 * 【为什么碎屑要独立节点而不是画在一张 Graphics 上】
 * 一张 Graphics 上画 8 个圆，它们只能整体缩放/淡出，
 * "四散"这个方向性就丢了。8 个节点走池子复用，成本可控。
 *
 * @param opt S12 新增，全部可选；不传 = 与 S12 之前的行为逐字节一致。
 */
export function spawnDebris(
    pool: FxPool, localX: number, localY: number, count: number, color: string,
    opt: { square?: boolean; r?: number; spread?: number; life?: number } = {},
): void {
    const M = CFG.MOTION;
    const g = pool.layer;
    if (!g) return;

    const baseR = opt.r ?? M.DEBRIS_R;
    const spread = opt.spread ?? M.DEBRIS_SPREAD;
    const life = opt.life ?? M.DEBRIS_DURATION;

    for (let i = 0; i < count; i++) {
        const node = pool.rent('debris');
        // 圆周均分起角 + 一点随机：均分保证"360° 都有人"，
        // 随机保证不像仪仗队（纯均分一眼就看出是程序生成的）。
        const ang = (Math.PI * 2 * i) / count + Math.random() * 0.6;
        const dist = spread * (0.6 + Math.random() * 0.6);
        const r = baseR * (0.55 + Math.random() * 0.75);

        const gg = node.getComponent(Graphics);
        if (gg) {
            gg.clear();
            gg.fillColor = hex2color(color);
            if (opt.square) {
                // 方点：边长按"面积近似相等"取自半径 —— 直接拿 r 当半边长会让
                // 方点看着比圆点大一圈（πr² vs (2r)²=4r²），两种碎屑的"分量"就串了。
                const half = r * 0.886;                 // √π / 2
                gg.rect(-half, -half, half * 2, half * 2);
            } else {
                gg.circle(0, 0, r);
            }
            gg.fill();
        }
        node.setPosition(localX, localY, 0);
        node.setScale(1, 1, 1);

        MotionFx.to(node,
            { position: v3(localX + Math.cos(ang) * dist, localY + Math.sin(ang) * dist, 0),
              scale: v3(0.3, 0.3, 1) },
            { duration: life, easing: EASE.MOVE, tag: TAG.FX });
        MotionFx.fade(node, 0, life, { easing: EASE.MOVE, tag: TAG.FADE });

        // 到期强制回收（不依赖 tween 回调 —— 回调丢了池子就漏）
        pool.autoRecycle('debris', node, Math.max(M.FX_MAX_LIFE, life + 0.06));
    }
}

/**
 * D1「落点脉冲」：一圈由小到大、同时淡出的描边环。
 * 它是"奖励到了"的句号 —— 只有飞行没有落点反馈，玩家会怀疑"到底生效没有"。
 *
 * 【opt 参数的意义（S7.5 新增）】
 * 原来它的尺寸写死用 CFG.MOTION.PULSE_*（为"奖励到账"调的，小而精致）。
 * "碰"的撞击环需要**更大更狠**：它是三张牌撞在一起的能量释放，
 * 用奖励环的尺寸会显得"不够响"。与其复制一份代码，不如把三个尺寸参数开放出来。
 *
 * 【opt.flat（S12 新增）：把正圆压成扁椭圆】
 * 「吃」的咬合脉冲**不能是正圆**：正圆是「碰」的语汇（能量向四周炸开），
 * 「吃」的脉冲要像"嘴横向开合留下的缝"，所以压成扁椭圆。
 *   flat = 1   → 正圆（碰、奖励，S12 之前的全部调用）
 *   flat = 0.42 → 扁椭圆（吃）
 * 这是「碰 / 吃」差异底线的一部分，不是审美微调（见 CFG.MOTION §十五）。
 */
export function spawnPulse(
    pool: FxPool, localX: number, localY: number, color: string,
    opt: { r0?: number; r1?: number; line?: number; life?: number; flat?: number } = {},
): void {
    const M = CFG.MOTION;
    if (!pool.layer) return;

    const r0 = opt.r0 ?? M.PULSE_R0;
    const r1 = opt.r1 ?? M.PULSE_R1;
    const life = opt.life ?? M.PULSE;
    const flat = opt.flat ?? 1;

    const node = pool.rent('pulse');
    const gg = node.getComponent(Graphics);
    if (gg) {
        gg.clear();
        gg.lineWidth = opt.line ?? M.PULSE_LINE;
        gg.strokeColor = hex2color(color);
        // flat = 1 时必须走 circle()，不能用 ellipse(0,0,r,r)：
        // 两者在多数后端结果一致，但 circle 是各自后端的原生路径
        // （WebGL 走 arc、原生走圆弧），而 ellipse 需要额外的变换。
        // 已经渲染正常的"碰"不该因为一个默认参数被换实现。
        if (flat === 1) {
            gg.circle(0, 0, r0);
        } else {
            gg.ellipse(0, 0, r0, r0 * flat);
        }
        gg.stroke();
    }
    node.setPosition(localX, localY, 0);
    // 从"细环"放大成"大环"：起始 scale 就是这个比值，收在 r1
    const k0 = r0 / r1;
    node.setScale(k0, k0, 1);

    MotionFx.to(node, { scale: v3(1, 1, 1) },
        { duration: life, easing: EASE.ENTER, tag: TAG.FX });
    MotionFx.fade(node, 0, life, { easing: EASE.MOVE, tag: TAG.FADE });

    // 生命周期兜底：撞击环比默认 PULSE 活得久，必须把寿命一起传下去，
    // 否则环还在放大就被池子强行回收了（表现为"环没扩散完就没了"）
    pool.autoRecycle('pulse', node, Math.max(M.FX_MAX_LIFE, life + 0.06));
}

/**
 * S12 新增：「吃」的**上下颚片** —— 张嘴 → 咬合 → 收走。
 *
 * 🔴〔已停用 · 2026-10-01 晚〕**本函数当前没有任何调用方。**
 *    用户认为"吃"的咀嚼效果还是不够好，要求「直接应用碰的特效」，于是
 *    「吃」改走撞击（GamePage.playClashClear），唯一的调用方 playEatClear
 *    已停用。整段保留而不删，因为这批改动**尚未 commit**，删了就找不回来。
 *    要彻底清理：本函数 + GamePage 的 playEatClear/onEatBite/onEatBurp
 *    + CFG.MOTION §十五 的 EAT_* **一起删**（常量与引用方必须同一个提交）。
 *    → 下面的设计记录将来重做"吃"的动效时仍有参考价值。
 *
 * ------------------------------------------------------------
 * 【它为什么必须存在：这是"一口一个"里唯一带"嘴"的东西】
 * 「碰」的所有表现（冲击环、圆碎屑、上踢）表达的都是"能量往外炸"；
 * 「吃」要表达的是"被咬进去"，而"咬"必须有一个**开合**的动作载体。
 * 没有颚片的话，逐口消失看起来只是"三张牌依次缩没了"，仍然读不出"吃"。
 *
 * 【为什么是两条弧、而不是一个"嘴"的图形】
 *   ① 零贴图：本工程全程矢量画，加一张嘴的 PNG 会破坏这条路（也吃包体）；
 *   ② 弧线只靠 position 就能开合 —— 若画成一个闭合图形，开合只能靠 scaleY，
 *      而 scaleY 会把线宽一起拉粗（张开时线宽 ×5，糊成一团）。
 *      用两条独立节点各改各的 position，**线宽恒定**，这才是"张嘴"该有的样子。
 *
 * 【上下颚的形状约定（决定了它读起来像不像嘴）】
 *   上颚：(−w/2, 0) → 控制点 (0, **+bow**) → (w/2, 0)，即**向上拱**的弧
 *   下颚：(−w/2, 0) → 控制点 (0, **−bow**) → (w/2, 0)，即**向下拱**的弧
 *   ⇒ 两弧一律**朝外**拱，因此**永不重叠**：
 *       张开时各自离开中线 open → 中间空出 2·open 的开口（这就是嘴）；
 *       合拢时两端落回中线、两个弧腹各鼓出 bow → 拼成一个透镜 ◇（紧闭的嘴）。
 * ⚠️ 两条踩过的坑，改这一段之前务必读完：
 *   ① **控制点必须朝外**。朝内（S12 补丁里的写法）会让两弧穿过中线交叉，
 *      画面上是一个"X"而不是嘴。它**不报任何错**，只是"看起来不像嘴" ——
 *      所以只能靠把截图放大来看，别指望编译或运行时报出来。
 *   ② **不需要 `open > bow`**（旧注释这么写过，那是"朝内拱"才有的结论，错的）。
 *      朝外拱之后开口宽度恒为 2·open，与 bow 无关：
 *      bow 只决定唇有多"厚"，open 只决定嘴张多大，两者正交。
 *      真正要小心的是**合拢的那一瞬**：两弧贴合、形状不体面，
 *      所以合拢时唇必须不可见（见下面的透明度说明）。
 *
 * 【时间轴】由调用方决定 openDur / biteDur / holdDur，
 * 但内部的**顺序是固定的**：先张嘴、再咬合、再收走。顺序反了就不是嘴了。
 * 特别是**不能"先闭合再张开"** —— 那是"吐"不是"吃"。
 *
 * ------------------------------------------------------------
 * 【为什么是"一个嘴咬 N 次"，而不是"每口起一个嘴"】（S12.2 新增 bites）
 *
 * 直觉上"一口一个"应该每口调一次本函数。**那样会糊**，理由是一条纯几何的：
 *   三口在时间上是**重叠**的 —— 单张吸行 openDur(0.20s) 明显长于口间隔
 *   EAT_STAGGER(0.13s)。于是 t=0.20 时第 1 个嘴全开、第 2 个嘴刚张到 8px，
 *   而两个嘴**叠在同一个 (x, y)**、线宽相同、颜色相同，只是高度的弧线不同 ——
 *   看上去就是"上下颚各变成两条"的重影，像渲染 bug 而不像嘴。
 *   （demo 里是用 max() 把三口的张开量合并成一条曲线绕开了它，
 *     那是 canvas 逐帧重绘的做法，tween 驱动做不到 —— 所以在这里加 bites。）
 *
 * 加了 bites 之后链变成：
 *   张开(openDur) → [咬合(biteDur) → 再张开(reopenDur)]×(bites-1) → 咬合 → 停留
 * 只要调用方让 `reopenDur = 口间隔 - biteDur`，**每次合拢的瞬间就正好落在
 * 那一口"牌到位"的时刻上** —— 节奏对得上，而且全程只有一个嘴。
 *
 * 【透明度是"跟着开合走"的（S12.2 改）】
 * 唇在**张开时可见、合拢时淡尽**，与位置共用同一批时长（见下面的 parts 表）。
 * 原因有两条，缺一都会露馅：
 *   ① 合拢时两弧是贴在一起的（张开量小时近乎一条"眼睛形的细缝"），
 *      那是 demo 里被明确点名的"看着像渲染 bug"的形状；
 *   ② 唇在最后一次咬合时就已经淡尽，于是**不再需要**单独的"收尾淡出"——
 *      接口里原来的 `fadeDur` 因此删掉了（留着一个永远不起作用的参数
 *      比没有更糟：读代码的人会以为它在起作用）。
 *
 * @param openDur  张嘴时长。调用方通常传"牌的吸行时长"，
 *                 让"张嘴"占满整个吸行过程（这样玩家一定看得见）。
 * @param bow      弧的拱高。默认取 CFG.MOTION.EAT_MOUTH_BOW。
 *                 ⚠️ 它同时决定了"闭紧的嘴"那个透镜有多胖 ——
 *                 太小会像两条直线，太大就成了一张嘴的轮廓被拉成了梭形。
 * @param bites    咬合次数。默认 1（= S12 的旧行为）。
 * @param reopenDur 第 2 口起"再张开"的时长，默认取 openDur。
 * @returns 整段（张开 + 各次咬合 + 停留）的总秒数，
 *          供调用方安排"打嗝收尾"与数据收尾的时刻。
 */
export function spawnJaw(
    pool: FxPool, localX: number, localY: number, color: string,
    opt: {
        w: number; open: number; bow?: number; line?: number;
        openDur: number; biteDur: number; holdDur: number;
        /** 咬合次数（S12.2 新增）。1 = 张一次咬一次 = S12 的旧行为（默认） */
        bites?: number;
        /** 第 2 口起"再张开"的时长。仅 bites > 1 时用得上 */
        reopenDur?: number;
    },
): number {
    const bow = opt.bow ?? CFG.MOTION.EAT_MOUTH_BOW;
    const line = opt.line ?? CFG.MOTION.EAT_MOUTH_LINE;
    const bites = Math.max(1, Math.floor(opt.bites ?? 1));
    const reopen = opt.reopenDur ?? opt.openDur;

    const up = pool.rent('jaw');
    const dn = pool.rent('jaw');

    const draw = (node: Node, upArc: boolean): void => {
        const gg = node.getComponent(Graphics);
        if (!gg) return;
        gg.clear();
        gg.lineWidth = line;
        gg.strokeColor = hex2color(color);
        gg.moveTo(-opt.w / 2, 0);
        // ★ 控制点必须**朝外**：上颚往上拱、下颚往下拱。
        //   S12 存进补丁的版本这里符号写反了（上颚用 -bow = 其实往下拱），
        //   于是两弧穿过中线**互相交叉**，画面上是个"X"而不是一张嘴；
        //   而上面那句注释一直写着"向上拱"—— 代码与注释对不上，光读代码看不出来，
        //   2026-10-01 把截图放大 2 倍才确认。
        //   符号朝外之后有个很好的性质：无论张开量多小，上颚最低点都 ≥ 中线、
        //   下颚最高点都 ≤ 中线 → **两弧永不重叠**（张开量 = 0 时刚好在两端相切，
        //   拼成一个透镜 ◇，那正是"闭紧的嘴"）。
        gg.quadraticCurveTo(0, upArc ? bow : -bow, opt.w / 2, 0);
        gg.stroke();
    };
    draw(up, true);
    draw(dn, false);

    // 段落表：一次"张开" → [咬合 + 再张开]×(bites-1) → 咬合 → 停留
    //   第 1 次张开单独列，因为它的时长有特殊含义（见 JSDoc：通常 = "牌的吸行时长"）；
    //   后面几次"再张开"只负责把节奏撑开。
    // ★ 位置与透明度**共用这一张表** —— 这是"淡出时机不会跑偏"的全部保证。
    //   拆成两张表迟早会错位，而错位的表现是"唇已经合上了却还很实"这类诡异画面。
    const parts: Array<{ open: boolean; dur: number }> = [
        { open: true, dur: opt.openDur },
    ];
    for (let b = 0; b < bites; b++) {
        parts.push({ open: false, dur: opt.biteDur });
        // 最后一口咬完**不再张开** —— 直接进"停留"，否则嘴会空张一下
        if (b < bites - 1) parts.push({ open: true, dur: reopen });
    }
    // "停留"段（位置/透明度都写在合拢值上）。用链的空转段而不是 setTimeout，
    // 是为了让"张—咬—停"严格首尾相接（几条独立 tween 会在交界处重叠出顿挫）。
    parts.push({ open: false, dur: opt.holdDur });

    let stopTotal = 0;
    for (const p of parts) stopTotal += p.dur;

    for (const [node, dir] of [[up, 1], [dn, -1]] as Array<[Node, number]>) {
        const openY = localY + dir * opt.open;

        // 起点 = **合拢 + 看不见**。两点都不能省：
        //   ① 合拢 —— 看不到"张开"这个动作的话，"张嘴"就不成立了（吃三要素之一）；
        //   ② 不可见 —— `pool.rent` 会把节点复位成完全不透明，而合拢时两弧是
        //      贴在一起的（张开量小时近乎一条"眼睛形的细缝"）。
        //      demo 的 canvas 版用 `open < 4 就不画` 绕开它；tween 驱动做不到逐帧
        //      判断路径，改成"越合越淡"等价，而且连续得更好。
        node.setPosition(localX, localY, 0);
        MotionFx.setFade(node, 0);

        MotionFx.chain(node, parts.map((p) => ({
            props: { position: v3(localX, p.open ? openY : localY, 0) },
            duration: p.dur,
            easing: p.open ? EASE.ENTER : EASE.EXIT,
        })), { tag: TAG.FX });

        // 透明度与位置共用同一批时长：
        //   张开段用 ENTER(quadOut，前快后慢) → 唇很快清晰、"张嘴"看得见；
        //   合拢段用 EXIT(quadIn，前慢后快)  → 唇大部分时间还实着，最后一下才淡掉。
        // 若两段都用线性的，视觉上会像"还没咬到就先把唇擦掉了"。
        MotionFx.fadeChain(node, parts.map((p) => ({
            to: p.open ? 255 : 0,
            duration: p.dur,
            easing: p.open ? EASE.ENTER : EASE.EXIT,
        })), { tag: TAG.FADE });
    }

    // 唇在**最后一次咬合**时就已经淡尽，所以这里不再有"收尾淡出"这一档 ——
    // 寿命只需覆盖到"停留"段结束（+60ms 余量，把最后一帧让给渲染）。
    const life = stopTotal + 0.06;
    pool.autoRecycle('jaw', up, life);
    pool.autoRecycle('jaw', dn, life);
    return life;
}

/**
 * 洗牌结束的"整堆白闪"（E3）：一个覆盖整片牌堆区的描边矩形闪一下。
 * 用途是给洗牌一个**明确的结束句号** —— 没有它，牌铺开之后
 * 玩家不知道"现在能不能点了"。
 */
export function spawnRectFlash(
    pool: FxPool, cx: number, cy: number, w: number, h: number, color: string,
): void {
    const M = CFG.MOTION;
    if (!pool.layer) return;

    const node = pool.rent('flash');
    const gg = node.getComponent(Graphics);
    if (gg) {
        gg.clear();
        gg.lineWidth = 3;
        gg.strokeColor = hex2color(color);
        gg.roundRect(-w / 2, -h / 2, w, h, 10);
        gg.stroke();
    }
    node.setPosition(cx, cy, 0);
    node.setScale(1, 1, 1);
    MotionFx.setFade(node, 0);

    // 亮 → 灭 一条链走完：来回闪会像"报错"，闪一次才像"完成"
    MotionFx.fadeChain(node, [
        { to: 255, duration: M.SHUFFLE_FLASH * 0.35, easing: EASE.ENTER },
        { to: 0, duration: M.SHUFFLE_FLASH * 0.65, easing: EASE.MOVE },
    ]);

    pool.autoRecycle('flash', node);
}
