/**
 * ============================================================
 *  GameRoot.ts · 游戏入口组件
 * ============================================================
 *  它是整个游戏的"总装车间"：所有界面都由它在运行时创建 ——
 *  这是「代码驱动 UI」的落点（DESIGN §8）。
 *
 *  ⚠️ 注意它不是挂在场景里的：Main.scene 保持零脚本引用，
 *  由 Bootstrap.ts 在运行时把它挂到 Canvas 上（原因见 Bootstrap 的注释）。
 *
 *  启动顺序：
 *     ① 建 UIRoot 容器（铺满 Canvas）
 *     ② 初始化页面状态机 PageManager
 *     ③ 注册所有页面（集中在此，页面之间因此不需要互相 import）
 *     ④ 预热存档
 *     ⑤ 进入首屏 menu
 *
 *  为什么 UIRoot 尺寸用 view.getVisibleSize() 显式设置一次、
 *  同时还挂 Widget？
 *    · 显式设置 —— 保证首帧尺寸就是对的（不依赖组件 onLoad 时序）；
 *    · Widget   —— 保证之后屏幕旋转 / 尺寸变化时自动跟随。
 * ============================================================
 */

import { _decorator, Component, Layers, Node, UITransform, Widget, log, view } from 'cc';
import { CFG } from './CFG';
import { PageManager } from './core/PageManager';
import { SaveService } from './core/SaveService';
import { GamePage } from './ui/GamePage';
import { AudioService } from './ui/AudioService';
import { MenuPage } from './ui/MenuPage';

const { ccclass } = _decorator;

/**
 * 页面名常量（避免各处写裸字符串写错）。
 *
 * ★ S18.3：`LEVEL_SELECT` 已删除 —— 选关页被首页吸收（决议 7）。
 *   ⚠️ 删这个键之前必须先 grep **`levelSelect`** 而不是 `LevelSelectPage`：
 *   后者只有本文件命中，而真正的调用点（4 处 `goto('levelSelect')`）
 *   散在 MenuPage / GamePage 里，漏一处就是一个白屏。
 */
export const PAGE = {
    MENU: 'menu',
    GAME: 'game',
} as const;

@ccclass('GameRoot')
export class GameRoot extends Component {

    /** UI 根容器（所有页面的父亲） */
    private _uiRoot: Node | null = null;
    /** UIRoot 的 UITransform（尺寸变化时更新用） */
    private _uiTransform: UITransform | null = null;

    protected onLoad(): void {
        log(`[GameRoot] 《${CFG.GAME.NAME}》${CFG.GAME.VERSION} 启动`);

        // ① UI 根容器
        const uiRoot = this.buildUIRoot();
        this._uiRoot = uiRoot;
        this.step('[1/6] buildUIRoot 完成');

        // ①' 音频服务（S7.5）
        // 必须在这里建，不能等到玩家第一次点牌 ——
        // 声道池要在启动时建好、音效要在启动时发起加载，
        // 等玩家点下去才建的话，头几次操作一定是"静音"的。
        // 声道挂在 UIRoot 下（而不是某个页面下）：音效不跟着页面销毁，
        // 否则从游戏页退回菜单页时，正在播的尾巴会被一起销毁。
        AudioService.init(uiRoot);
        this.step('[2/6] AudioService.init 完成');

        // ② 页面状态机（必须先 create，后面 register / open 才有宿主）
        PageManager.create(uiRoot);
        this.step('[3/6] PageManager.create 完成');

        // ③ 注册页面
        this.registerPages();
        this.step('[4/6] registerPages 完成');

        // ④ 存档预热
        this.preloadData();
        this.step('[5/6] preloadData 完成');

        // ⑤ 进入首屏
        PageManager.instance.open(PAGE.MENU);
        this.step('[6/6] open(menu) 完成');

        // 屏幕尺寸变化（旋转 / 分屏 / 浏览器改窗口）时同步 UIRoot
        view.on('canvas-resize', this.syncUIRootSize, this);
    }

    /** 启动分步日志：命令行无头构建时看不到调试器，这几行是唯一的排障线索。
     *  正常发版可以把 CFG.DEBUG.LOG_STATE 置 false 关掉。 */
    private step(tag: string): void {
        if (CFG.DEBUG.LOG_STATE) log(`[GameRoot] ${tag}`);
    }

    protected onDestroy(): void {
        view.off('canvas-resize', this.syncUIRootSize, this);
    }

    // --------------------------------------------------------
    //  ① UI 根容器
    // --------------------------------------------------------
    private buildUIRoot(): Node {
        const uiRoot = new Node('UIRoot');
        uiRoot.layer = Layers.Enum.UI_2D;   // 2D UI 必须归属 UI_2D 层
        this.node.addChild(uiRoot);
        uiRoot.setPosition(0, 0, 0);

        const ui = uiRoot.addComponent(UITransform);
        ui.setAnchorPoint(0.5, 0.5);
        this._uiTransform = ui;

        // 显式设一次尺寸：不等于写死设计分辨率，而是取"当前适配策略下的可视尺寸"，
        // 在 20:9 之类超长屏上会自然得到更高的高度，背景与布局都不会露白边。
        const vs = view.getVisibleSize();
        ui.setContentSize(vs.width, vs.height);

        // Widget 兜底：屏幕变化时自动四边贴齐 Canvas
        const widget = uiRoot.addComponent(Widget);
        widget.isAlignTop = true;
        widget.isAlignBottom = true;
        widget.isAlignLeft = true;
        widget.isAlignRight = true;
        widget.top = widget.bottom = widget.left = widget.right = 0;
        widget.alignMode = Widget.AlignMode.ALWAYS;

        return uiRoot;
    }

    private syncUIRootSize(): void {
        if (!this._uiTransform) return;
        const vs = view.getVisibleSize();
        this._uiTransform.setContentSize(vs.width, vs.height);
    }

    // --------------------------------------------------------
    //  ② 页面注册
    // --------------------------------------------------------
    private registerPages(): void {
        PageManager.register(PAGE.MENU, MenuPage);
        // ★ S18.3：选关页已删除。首页主按钮**直达**游戏页 —— 少一次点击、少一次转场。
        PageManager.register(PAGE.GAME, GamePage);
        // 后续里程碑在此追加：result（S7 正式结算面板）……
    }

    // --------------------------------------------------------
    //  ③ 数据预热
    // --------------------------------------------------------
    private preloadData(): void {
        // 构造函数里已 load 过一次，这里再显式读一遍，
        // 让启动日志能明确显示存档状态（调试期很有用）
        SaveService.instance.load();
    }
}
