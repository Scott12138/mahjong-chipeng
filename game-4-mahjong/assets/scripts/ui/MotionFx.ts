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
    Graphics, Layers, Node, Tween, TweenEasing, UIOpacity, UITransform, Vec3, easing, tween, v3,
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
    /** 牌堆内的位置（入场铺开、洗牌铺开、提示呼吸） */
    STACK: 'stack',
    /** 牌堆整体浮现（改容器 scale / opacity） */
    ENTER: 'enter',
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

    /** 节点属性 tween（position / scale / angle 可任意组合） */
    public static to(
        node: Node | null | undefined, props: NodeProps, opts: ToOpts,
    ): void {
        if (!node || !node.isValid) return;
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
export type FxKind = 'debris' | 'pulse' | 'flash' | 'icon';

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
 * C3「爆开」：一圈小圆点四散淡出。
 *
 * 【为什么是圆点而不是方块】圆点的半径可以随着"飞散"一起缩小，
 * 视觉上是"碎屑"，方块缩小时更像"缩放的贴图"。而且真牌的碎屑本来就该是圆的。
 *
 * 【为什么碎屑要独立节点而不是画在一张 Graphics 上】
 * 一张 Graphics 上画 8 个圆，它们只能整体缩放/淡出，
 * "四散"这个方向性就丢了。8 个节点走池子复用，成本可控。
 */
export function spawnDebris(
    pool: FxPool, localX: number, localY: number, count: number, color: string,
): void {
    const M = CFG.MOTION;
    const g = pool.layer;
    if (!g) return;

    for (let i = 0; i < count; i++) {
        const node = pool.rent('debris');
        // 圆周均分起角 + 一点随机：均分保证"360° 都有人"，
        // 随机保证不像仪仗队（纯均分一眼就看出是程序生成的）。
        const ang = (Math.PI * 2 * i) / count + Math.random() * 0.6;
        const dist = M.DEBRIS_SPREAD * (0.6 + Math.random() * 0.6);
        const r = M.DEBRIS_R * (0.55 + Math.random() * 0.75);

        const gg = node.getComponent(Graphics);
        if (gg) {
            gg.clear();
            gg.fillColor = hex2color(color);
            gg.circle(0, 0, r);
            gg.fill();
        }
        node.setPosition(localX, localY, 0);
        node.setScale(1, 1, 1);

        MotionFx.to(node,
            { position: v3(localX + Math.cos(ang) * dist, localY + Math.sin(ang) * dist, 0),
              scale: v3(0.3, 0.3, 1) },
            { duration: M.DEBRIS_DURATION, easing: EASE.MOVE, tag: TAG.FX });
        MotionFx.fade(node, 0, M.DEBRIS_DURATION, { easing: EASE.MOVE, tag: TAG.FADE });

        // 到期强制回收（不依赖 tween 回调 —— 回调丢了池子就漏）
        pool.autoRecycle('debris', node);
    }
}

/**
 * D1「落点脉冲」：一圈由小到大、同时淡出的描边圆环。
 * 它是"奖励到了"的句号 —— 只有飞行没有落点反馈，玩家会怀疑"到底生效没有"。
 */
export function spawnPulse(pool: FxPool, localX: number, localY: number, color: string): void {
    const M = CFG.MOTION;
    if (!pool.layer) return;

    const node = pool.rent('pulse');
    const gg = node.getComponent(Graphics);
    const r0 = M.PULSE_R0;
    if (gg) {
        gg.clear();
        gg.lineWidth = M.PULSE_LINE;
        gg.strokeColor = hex2color(color);
        gg.circle(0, 0, r0);
        gg.stroke();
    }
    node.setPosition(localX, localY, 0);
    // 从"细环"放大成"大环"：起始 scale 就是这个比值，收在 PULSE_R1
    const k0 = r0 / M.PULSE_R1;
    node.setScale(k0, k0, 1);

    MotionFx.to(node, { scale: v3(1, 1, 1) },
        { duration: M.PULSE, easing: EASE.ENTER, tag: TAG.FX });
    MotionFx.fade(node, 0, M.PULSE, { easing: EASE.MOVE, tag: TAG.FADE });

    pool.autoRecycle('pulse', node);
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
