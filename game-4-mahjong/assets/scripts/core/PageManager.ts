/**
 * ============================================================
 *  PageManager.ts · 页面状态机 + 转场
 * ============================================================
 *  职责：
 *   ① 页面注册表（名字 → 类），避免页面之间互相 import 形成循环依赖；
 *   ② 页面切换：旧页淡出销毁 + 新页淡入推近（Tween），互斥防连点；
 *   ③ 提供全局唯一的页面容器（PageManager.instance 单例）。
 *
 *  依赖方向（单向，不要破坏）：
 *      各页面  ──►  PageManager  ◄──  GameRoot（在启动时注册所有页面）
 * ============================================================
 */

import { Layers, Node, UIOpacity, Widget, log, tween, v3, warn } from 'cc';
import { CFG } from '../CFG';
import { PageBase, PageCtor } from '../ui/PageBase';

export class PageManager {

    // --------------------------------------------------------
    //  单例
    // --------------------------------------------------------
    private static _instance: PageManager | null = null;
    public static get instance(): PageManager {
        if (!PageManager._instance) {
            // 这里刻意【抛异常】而不是返回 null：
            // 静默返回 null 会把"未初始化"伪装成一个看不懂的 TypeError，
            // 排查成本极高（本工程就踩过——漏调 create() 导致白屏）。
            throw new Error('[PageManager] 尚未初始化：请先在 GameRoot.onLoad 里调用 PageManager.create(uiRoot)');
        }
        return PageManager._instance;
    }

    /** 由 GameRoot 在启动时调用 */
    public static create(pageRoot: Node): PageManager {
        PageManager._instance = new PageManager(pageRoot);
        return PageManager._instance;
    }

    // --------------------------------------------------------
    //  页面注册表
    // --------------------------------------------------------
    private static _registry: Map<string, PageCtor> = new Map();

    /** 注册页面：名字 → 类。同名重复注册会覆盖并告警 */
    public static register(name: string, ctor: PageCtor): void {
        if (PageManager._registry.has(name)) {
            warn(`[PageManager] 页面 "${name}" 被重复注册，后者覆盖前者`);
        }
        PageManager._registry.set(name, ctor);
    }

    // --------------------------------------------------------
    //  实例状态
    // --------------------------------------------------------
    /** 所有页面的挂载点（顶层容器） */
    private _pageRoot: Node;
    /** 当前页面 */
    private _current: PageBase | null = null;
    /** 当前页面的名字（供日志与调试用） */
    private _currentName = '';
    /** 转场互斥锁 */
    private _transitioning = false;

    private constructor(pageRoot: Node) {
        this._pageRoot = pageRoot;
    }

    /** 当前页面名 */
    public get currentPageName(): string { return this._currentName; }

    /** 转场进行中？ */
    public get isTransitioning(): boolean { return this._transitioning; }

    /** 当前页面的节点（供 Toast 等挂在最上层使用） */
    public get layer(): Node { return this._pageRoot; }

    // --------------------------------------------------------
    //  核心：打开（替换）一个页面
    // --------------------------------------------------------
    /**
     * 切换到指定页面。
     * 语义是「替换」而不是「入栈」——返回上一页由页面自己在按钮里显式 goto。
     */
    public open(name: string, params?: any): void {
        if (this._transitioning && CFG.PAGE.LOCK_DURING_TRANSITION) {
            if (CFG.DEBUG.LOG_STATE) log(`[PageManager] 转场中，忽略对 "${name}" 的请求`);
            return;
        }

        const ctor = PageManager._registry.get(name);
        if (!ctor) {
            warn(`[PageManager] 页面 "${name}" 未注册，检查 GameRoot 的注册列表`);
            return;
        }

        this._transitioning = true;
        const oldPage = this._current;
        const duration = CFG.PAGE.FADE_DURATION;

        // ---------- 1. 建新页 ----------
        const node = new Node(`Page_${name}`);
        node.layer = Layers.Enum.UI_2D;   // 2D UI 必须归属 UI_2D 层
        this._pageRoot.addChild(node);

        // 页面节点必备三件套：尺寸（铺满可视区）、透明度（转场）、
        // 组件（页面逻辑本身）。
        // 尺寸用 Widget 四边贴齐容器（UIRoot 已铺满 Canvas），而不是写死设计分辨率
        // —— 这样在 20:9 之类的超长屏上背景也能铺满、不露白边。
        const widget = node.addComponent(Widget);
        widget.isAlignTop = true;
        widget.isAlignBottom = true;
        widget.isAlignLeft = true;
        widget.isAlignRight = true;
        widget.top = widget.bottom = widget.left = widget.right = 0;
        widget.alignMode = Widget.AlignMode.ALWAYS;
        const opacity = node.addComponent(UIOpacity);
        opacity.opacity = 0;
        node.setScale(v3(CFG.PAGE.ENTER_SCALE_FROM, CFG.PAGE.ENTER_SCALE_FROM, 1));

        const page = node.addComponent(ctor) as unknown as PageBase;
        page.__build(params);
        this._current = page;
        this._currentName = name;

        if (CFG.DEBUG.LOG_STATE) log(`[PageManager] → ${name}`);

        // ---------- 2. 入场表现：淡入 + 推近（纯视觉，不承担状态机职责）----------
        tween(opacity).to(duration, { opacity: 255 }).start();
        tween(node)
            .to(duration, { scale: v3(1, 1, 1) }, { easing: 'quadOut' })
            .start();

        // ---------- 3. 解锁与入场通知：用定时器，绝不用 tween 回调 ----------
        //  ⚠️ 踩过的坑：原先用 tween(...).call() 解锁 _transitioning，
        //  一旦动效链路异常，回调不触发 → 状态机永久卡死、页面再也切不动。
        //  铁律：状态流转必须走"必然执行"的路径，动效只负责好看。
        setTimeout(() => {
            this._transitioning = false;
            if (!node.isValid) return;
            // 兜底：无论淡入动效是否正常，转场结束都强制完全可见
            // （避免"动效失效导致 UI 永久透明 = 白屏"这种最难查的故障）
            opacity.opacity = 255;
            page.__enter();
        }, duration * 1000 + 20);

        // ---------- 4. 旧页清理 ----------
        if (oldPage && oldPage.isValid) {
            oldPage.__leave();
            const oldOpacity = oldPage.node.getComponent(UIOpacity);
            if (oldOpacity) {
                tween(oldOpacity).to(duration, { opacity: 0 }).start();
            }
            // 销毁同样用定时器兜底，不依赖 tween 回调
            setTimeout(() => {
                if (oldPage.isValid) oldPage.node.destroy();
            }, duration * 1000 + 20);
        }
    }
}
