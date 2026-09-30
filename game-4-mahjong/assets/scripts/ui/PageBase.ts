/**
 * ============================================================
 *  PageBase.ts · 页面基类
 * ============================================================
 *  一屏 = 一个页面。每个页面是一个挂在独立节点上的组件，
 *  由 PageManager 负责创建 / 转场 / 销毁，页面自身只关心内容。
 *
 *  生命周期（由 PageManager 驱动，子类不要手动调用）：
 *      build(params)  创建时 —— 在此构建界面，只执行一次
 *      enter()        转场完成后 —— 在此启动计时器 / 播放入场动效
 *      leave()        即将销毁前 —— 在此停止计时器 / 保存临时状态
 * ============================================================
 */

import { _decorator, Component, Node, UIOpacity, UITransform } from 'cc';
import { CFG } from '../CFG';
import { PageManager } from '../core/PageManager';

const { ccclass } = _decorator;

@ccclass('PageBase')
export class PageBase extends Component {

    /** 打开本页时传入的参数（由 PageManager.open 透传） */
    protected params: any = null;

    // --------------------------------------------------------
    //  供子类使用的便捷入口
    // --------------------------------------------------------

    /** 本页的节点（等价于 this.node，此处只是让语义更清晰） */
    protected get root(): Node { return this.node; }

    /** 本页的 UITransform（布局尺寸用） */
    protected get ui(): UITransform { return this.node.getComponent(UITransform)!; }

    /** 本页的 UIOpacity（转场淡入淡出用，由 PageManager 挂载） */
    protected get opacity(): UIOpacity { return this.node.getComponent(UIOpacity)!; }

    /** 跳转到另一个页面（替换当前页） */
    protected goto(pageName: string, params?: any): void {
        PageManager.instance.open(pageName, params);
    }

    // --------------------------------------------------------
    //  生命周期（骨架，子类按需重写 on* 方法）
    // --------------------------------------------------------

    /** @internal 由 PageManager 调用 —— 不要覆写 */
    public __build(params: any): void {
        this.params = params;
        this.onBuild();
    }

    /** @internal 由 PageManager 调用 —— 不要覆写 */
    public __enter(): void {
        this.onEnter();
    }

    /** @internal 由 PageManager 调用 —— 不要覆写 */
    public __leave(): void {
        this.onLeave();
    }

    // --------------------------------------------------------
    //  子类实现这些空钩子即可
    // --------------------------------------------------------

    /** 构建界面：所有 createXxx 都写在这里，只执行一次 */
    protected onBuild(): void { /* 子类重写 */ }

    /** 入场完成：开始计时、播动画、读存档等 */
    protected onEnter(): void { /* 子类重写 */ }

    /** 离场之前：停止计时、清理定时器等 */
    protected onLeave(): void { /* 子类重写 */ }
}

/** 页面类构造器类型（PageManager 用它与注册表配合） */
export type PageCtor = new (...args: any[]) => PageBase;
