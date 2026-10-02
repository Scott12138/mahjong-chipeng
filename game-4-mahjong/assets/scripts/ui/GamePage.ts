/**
 * ============================================================
 *  GamePage.ts · 游戏页（牌堆 + 槽位 + 碰吃杠消除 + 道具）
 * ============================================================
 *  这是"真正能玩"的那一页。职责：
 *    ① 把生成好的牌局画出来；
 *    ② 处理点击 → 入槽 → 判定 → 消除这条主循环；
 *    ③ 判定通关 / 失败，失败后提供复活；
 *    ④ 四个道具（消除 / 移出 / 洗牌 / 加槽）及其获取门禁。
 *
 *  ------------------------------------------------------------
 *  【遮挡与点击的两条设计决定】
 *  1. 点击用「**统一命中测试**」而不是给每张牌挂监听。
 *     原因：被压住的牌在视觉上明明被盖住了，如果它自己也接了触摸事件，
 *     上层那张"不可点、但它接走了事件"就会吃掉这次点击，玩家会觉得
 *     "我点的明明是上面那张，没反应"。统一命中测试里，
 *     一次点击只认最上面那张牌，且被压住就直接吃掉、不穿透。
 *  2. 「可点」的判定是**矩形相交**（DESIGN §3）：只要有任何一张更靠上的牌
 *     和它重叠，就算被压住。规则最直观，玩家一眼就能认同。
 *
 *  ------------------------------------------------------------
 *  【铁律：状态流转不走动效回调】
 *  所有"能不能继续操作"的开关都用 setTimeout 解锁，绝不用 tween 的 .call()。
 *  S1 踩过这个坑：动效链路一断，回调不触发，状态机永久卡死。
 *
 *  ------------------------------------------------------------
 *  【铁律：弹窗必须自己吃掉点击】
 *  弹窗下面就是牌堆。Cocos 的事件是**冒泡**的，弹窗上的一次点击会一路
 *  冒泡到本页的 TOUCH_END，于是玩家隔着弹窗把牌点走了。
 *  双保险：① RewardGate 的遮罩里 propagationStopped；② 本页的 `_modal` 闸门。
 *
 *  ------------------------------------------------------------
 *  【2026-09-30 第二次改版要点】
 *  · 牌面 64×85 → 128×171（用户要求放大到两倍）；
 *  · 牌数 18/60/78/90 → 12/18/21/24（**容量倒推**，见 CFG.LEVELS 注释）；
 *  · 新增暂存架（移出道具）与道具栏（S6），竖向预算整条重排；
 *  · 槽内牌的缩放改为**自适应**（8 格与加槽后的 9 格共用一套算法）。
 * ============================================================
 */

import {
    _decorator, EventTouch, Graphics, Label, Node, UIOpacity, UITransform, Vec3,
    log, tween, v3, warn,
} from 'cc';

import { CFG, LevelConfig } from '../CFG';
import {
    BlockGraph, Layout, ReshufflePlan, TileInst, buildBlockGraph, generateLevel,
    pickableIds, planReshuffle, pointInRect, pointInTile, tileSizeOf,
} from '../core/Generator';
import { MATCH_LABEL, MATCH_SIZE, MATCH_WORD, MatchResult, findMatch } from '../core/MatchRule';
import { SaveService } from '../core/SaveService';
import { PatternKey } from '../TileData';
import { PageBase } from './PageBase';
import { TileView } from './TileRenderer';
import {
    createButton, createLabel, createNode, createPaperBackground,
    createPanel, draw3dFace, drawProgressBar, estTextWidth, fillBox, frameRect,
    hex2color, measureLabel, strokeBox, toast,
} from './UIFactory';
import { RewardGate } from './RewardGate';
import { AudioService } from './AudioService';
import { Haptics } from './Haptics';
import {
    EASE, FxPool, MotionFx, TAG, spawnDebris, spawnJaw, spawnPulse, spawnRectFlash,
} from './MotionFx';
// ---- S18 新增的三件：开场动画 / 结算动效 / 玩法浮层 ----
import { IntroAnim } from './IntroAnim';
import { ResultFx } from './ResultFx';
import { RuleSheet } from './RuleSheet';

const { ccclass } = _decorator;

// ============================================================
//  类型与常量表
// ============================================================

/** 槽位 / 暂存架里的一个位置 */
interface SlotEntry {
    /**
     * 原始的牌 id。
     * 必须记下来 —— 复活、洗牌这些操作要按 id 找回"槽里这张牌在布局里的哪一项"，
     * 如果只按牌面找，遇到"同名牌面有好几张"就会还原到错误的那一张（视图与数据错位）。
     */
    id: number;
    key: PatternKey;
    view: TileView;
}

/** 四个道具 */
type PropId = 'remove' | 'move' | 'shuffle' | 'addslot';

/**
 * 判负原因。由触发判负的入口写入，结算面板只负责展示。
 * 'slotfull' = 槽位塞满；'timeout' = 限时关卡时间耗尽；'none' = 尚未判负。
 */
type FailReason = 'none' | 'slotfull' | 'timeout';

/** 道具的静态定义。顺序 = 界面从左到右的顺序，改顺序只改这张表 */
const PROP_DEFS: Array<{ id: PropId; name: string }> = [
    { id: 'remove', name: '消 除' },
    { id: 'move', name: '移 出' },
    { id: 'shuffle', name: '洗 牌' },
    { id: 'addslot', name: '加 槽' },
];

const PROP_LABEL: Record<PropId, string> = {
    remove: '消除', move: '移出', shuffle: '洗牌', addslot: '加槽',
};

@ccclass('GamePage')
export class GamePage extends PageBase {

    // ---- 牌局 ----
    private _level!: LevelConfig;
    private _layout!: Layout;
    private _graph!: BlockGraph;
    /** 每张牌当前被几张未拿走的牌压住（拿牌时增量维护，判定 O(1)） */
    private _blocked: number[] = [];
    private _taken: boolean[] = [];
    private _views: TileView[] = [];
    /** 按深度升序的 id 列表（点击命中测试从后往前扫） */
    private _depthOrder: number[] = [];

    // ---- 槽位与暂存架 ----
    private _slots: SlotEntry[] = [];
    private _temp: SlotEntry[] = [];
    private _slotCapacity = CFG.GAMEPLAY.SLOT_CAPACITY;

    // ---- 道具 ----
    /** 本关每个道具已使用次数 */
    private _propUsed: Record<PropId, number> = { remove: 0, move: 0, shuffle: 0, addslot: 0 };
    /** 「消除」已就绪，等玩家点槽里的一张牌 */
    private _armedRemove = false;
    /** 本关已复活次数 */
    private _revives = 0;
    /**
     * 本关的判负原因，由**触发判负的那个入口**写入。
     *
     * 【为什么必须由入口写，而不是在结算页反推】
     * 结算页原本写的是 `this._timeLeft <= 0 ? '时间到' : '槽位满了'` ——
     * 看上去合理，其实错得离谱：**「不限时」关卡的 `_timeLeft` 恒为 0**，
     * 于是无论玩家是被槽位塞满还是真的超时，面板一律显示"时间到"。
     * 实测（第 1 关「试手气」故意塞满槽位）就撞上了：
     *     日志 第 1 关 失败，已清 0/12 … / 失败面板已开 原因=时间到
     * 而第 1 关明明写着"不限时"。
     * 教训：**"为什么输"是一等公民的信息，必须在发生的那一刻记下来**，
     * 事后靠另一个变量反推，迟早会因为"那个变量在某种关卡配置下不成立"而说谎。
     */
    private _failReason: FailReason = 'none';

    // ---- 计数与状态 ----
    private _cleared = 0;
    private _left = 0;
    private _busy = false;      // 有动画在跑，忽略输入
    private _over = false;      // 已经结算，忽略输入
    /** 有弹窗开着：忽略牌面/槽位的点击（弹窗点击会冒泡上来，必须自己拦） */
    private _modal = false;

    // ---- 计时 ----
    private _timeLeft = 0;
    private _usedTime = 0;
    private _timing = false;
    /**
     * 本局是否要播开场动画（★ S18.4）。
     * `params.instant === true` 时跳过 —— 首页那颗「重玩」小方走的就是这条路：
     * 它的语义是"原地立刻再开一局"，再让玩家等 1.5 秒开场就成了惩罚。
     */
    private _introOn = true;

    // ---- 节点引用 ----
    private _stackLayer!: Node;
    /**
     * HUD 组（＝顶部信息条 / 暂存架 / 槽位条 / 道具栏 / 返回 / 重玩）。
     *
     * ★ S18.4 起它有了新职责：**"舞台"与"演员"的分界线**。
     * 开场动画负责"舞台"（页框 + 全部静态 HUD 淡入，牌堆区是空的），
     * 涌现负责"演员"（牌堆从棋盘里成束升起）。两段串行，所以这两个组
     * 在开场期间**必须能被分别控制显隐** —— 一句 `_hudLayer` 与
     * `_stackLayer` 的透明度切换，就是"墨圆裂开时只亮 HUD、不亮牌堆"
     * 这件事全部的实现。
     */
    private _hudLayer!: Node;
    /**
     * 页框节点（外框 + 内框 + 四角角花），★ S18.5 起承担新职责：
     * **通关时"纸面震"的那个节点**。
     *
     * 【为什么震页框而不是震整页 root】震 root = 连背景纸一起平移，读起来是
     * "镜头在抖"（而且边缘会露出底色）；震页框 = 只有那张"纸"在动，读起来才是
     * "印砸在纸上把纸震了一下"。这与失败动效的分段抖动是同一个判断。
     */
    private _frameNode!: Node;
    private _slotLayer!: Node;
    private _tempLayer!: Node;
    private _fxLayer!: Node;
    private _modalLayer!: Node;
    private _slotBarG!: Graphics;
    private _tempRackG!: Graphics;
    private _barG!: Graphics;
    private _timeLabel!: Label;
    private _countLabel!: Label;
    /** 顶条关卡名（`layoutHeader` 要读它的实际宽度来给「规则」钮算 x） */
    private _titleLabel!: Label;
    /** 顶条「规则」钮：图形节点与它的热区节点（热区比图形大一圈，见 CFG.RULE_BTN_HIT_*） */
    private _ruleNode!: Node;
    private _ruleHitNode!: Node;

    // ---- 动效（S7）----
    /**
     * 特效对象池。承载 C3 碎屑、D1 脉冲圆环、E3 白闪这些"短命节点"。
     * 挂在 FxLayer 下 —— 飞牌与特效共用这一层，靠世界坐标换算定位，
     * **绝不去改槽位层的坐标体系**（改那个会让所有槽内逻辑的坐标一起变）。
     */
    private _fx = new FxPool();

    /** 槽位条 / 暂存架 / 道具栏的容器节点（入场动效 A3 要整体位移，必须有引用） */
    private _slotBarNode!: Node;
    private _tempRackNode!: Node;
    private _tempLabelNode!: Node;
    /** 暂存架是否已经浮现过（S14.2b：默认隐藏，首次用「移出」道具时浮现，只播一次） */
    private _tempRackShown = false;
    /** 返回按钮（A3 与槽位条一起滑入，否则"槽位上来了按钮没上来"很怪） */
    private _backBtnNode!: Node;
    /** 局内「重玩」小方（S18，与返回同排） */
    private _replayBtnNode!: Node;
    private _replayLabel!: Label;
    private _propNodes: Partial<Record<PropId, Node>> = {};
    /** 顶部状态条的元素集合（A4 整体下落淡入）。存目标 y，动画结束后要精确落回原位 */
    private _hudItems: Array<{ node: Node; y: number }> = [];
    /** 道具按钮的白色高光层（D2 的"图标亮度提升"） */
    private _propGlows: Partial<Record<PropId, UIOpacity>> = {};

    /**
     * C7 槽位警戒层。
     * 单独一层覆盖在槽位条之上，只负责画"剩余空位"的红色描边 ——
     * 因为 Graphics 的描边颜色没法 tween，只能靠整层透明度来做呼吸。
     */
    private _warnNode!: Node;
    private _warnG!: Graphics;
    private _warnOn = false;

    /**
     * 正在"选中 / 飞行"的那张牌（B2 / B3 / B7 的抓手）。
     * 存原始坐标 ox/oy 是为了两件事：
     *   ① 飞行途中再点同一张 → 取消选中，要能原地回落；
     *   ② 命中测试始终按**原始矩形**判定 —— 牌飞出去了也不该改变"它原来在哪"。
     */
    private _pending: {
        id: number; view: TileView; ox: number; oy: number;
    } | null = null;

    /** 当前被手指按住的牌（-1 = 没有）。B1 的按压态必须能被精确地还回去 */
    private _pressedId = -1;

    /**
     * ★ 输入缓冲（S12.1 新增）：被"忙"挡掉的那一次点击，记在这里，稍后补做。
     *
     * 【为什么需要它】
     * 改之前，`_busy` 期间的点击是**直接丢弃**的（`if (this._busy) return`）。
     * 用户描述的"点了没反应"就是这个：手快的人连着点两张，第二张凭空消失。
     * S12.1 把锁窗口从 ~510ms 压到 ~150ms（见 CFG.MOTION 的 PICK_SELECT / MOVE_*），
     * 但**只要还有窗口，窗口里的点击就会丢** —— 所以补这一道缓冲。
     *
     * 【为什么只缓冲"最后一次"，不做真正的队列】
     * 队列（允许多张同时在空中）要处理五个风险点：插入顺序按点击序、连锁判定要等排空、
     * 槽满预占要把在飞的也算上、B7 撤回要能撤队列里任意一张、道具/洗牌要能整体作废。
     * 那是另一个量级的改动，且每一处都可能踩到"`_busy` 永久为 true → 整局死锁"。
     * 而"记住最后一次点击、解锁后补做"用**一个字段**就消掉了 90% 的挫败感，
     * 且天然不会并发 —— 补做的那一次一定在上一张完全落位、判定跑完之后才发起。
     *
     * ⚠️ 补做前必须**重新校验**（见 drainBufferedPick）：期间局面可能变了
     *    （那张牌被别的操作拿走、或者被压住了），照单执行会凭空多占一格。
     */
    private _buffered: number | null = null;

    // ---- 道具按钮引用（只建一次，状态变化时改文字与颜色，不重建节点）----
    private _propSubs: Partial<Record<PropId, Label>> = {};
    private _propNames: Partial<Record<PropId, Label>> = {};
    private _propFaces: Partial<Record<PropId, Graphics>> = {};

    private _failPanel: Node | null = null;

    // ========================================================
    //  构建
    // ========================================================
    protected onBuild(): void {
        const levelId = (this.params && this.params.levelId) ? Number(this.params.levelId) : 1;
        const level = CFG.LEVELS.find((l) => l.id === levelId) ?? CFG.LEVELS[0];
        this._level = level;

        // ---------- 1. 生成牌局（含可解性校验）----------
        const t0 = Date.now();
        this._layout = generateLevel(level);
        const genMs = Date.now() - t0;
        this._graph = buildBlockGraph(this._layout.tiles);
        const n = this._layout.tiles.length;
        this._taken = new Array(n).fill(false);
        this._blocked = new Array(n).fill(0);
        for (let i = 0; i < n; i++) this._blocked[i] = this._graph.above[i].length;
        this._left = n;
        this._timeLeft = level.timeLimit;

        if (CFG.DEBUG.LOG_STATE) {
            // ⚠️ `certified` 必须打出来。大牌数关卡（63/96 张）常态就是
            //    certified=false + 可解率 0% —— 那不是故障，而是"羊了个羊"
            //    模式的设计结果（详见 CFG.STACK.MAX_RETRY 的注释）。
            //    少了这个字段，排查的人会把"设计如此"读成"生成器坏了"。
            log(`[GamePage] 第 ${level.id} 关「${level.name}」：${n} 张牌 / `
                + `${this._layout.attempts} 次采样 / `
                + `${this._layout.certified ? '已认证可解' : '仅认证开局不卡'}`
                + `（可解率 ${(this._layout.solveRate * 100).toFixed(0)}%）/ `
                + `生成耗时 ${genMs}ms / seed=${this._layout.seed}`);
        }
        this.logPickable();

        // ---------- 2. 页面骨架 ----------
        // ⚠️ `_frameNode` 必须是**底图那个节点本身**：S19 起页框画在贴图里，
        //    `createPageFrame` 现在只返回一个**不画任何东西**的空节点 ——
        //    通关时那四拍「纸面震」如果抖的是它，画面完全不动、而且不报错
        //    （口径见 `CFG.MOTION.STAMP.SHAKE_TARGET_IS_FRAME`）。
        //    底图节点下面垫着一层 1.6 倍大的纯纸色矩形，横移 ±9px 不会露画布底色。
        this._frameNode = createPaperBackground(this.root);

        // ---------- 3. 分层容器 ----------
        // 层序（从下到上）：牌堆 → UI → 槽内牌 → 暂存牌 → 特效 → 弹窗
        //  · 槽内牌必须单独一层，否则飞向槽位的牌会被槽位条盖住；
        //  · 飞牌与临时特效放 FxLayer（S7）：它们在视觉上要压过槽位条与暂存架，
        //    但绝不能进入弹窗之上（弹窗必须永远在最上面，否则会被穿透点击）。
        this._stackLayer = createNode('StackLayer', this.root, { w: CFG.SCREEN.W, h: CFG.SCREEN.H });
        const uiLayer = createNode('UILayer', this.root, { w: CFG.SCREEN.W, h: CFG.SCREEN.H });
        this._hudLayer = uiLayer;
        // ★ S18.4：两个组各挂一个 UIOpacity —— 开场期间要**分别**控制显隐
        //（只亮 HUD、不亮牌堆），这是"串行两段"能讲清楚两件事的唯一手段。
        uiLayer.addComponent(UIOpacity);
        this._stackLayer.addComponent(UIOpacity);
        this._slotLayer = createNode('SlotLayer', this.root, { w: CFG.SCREEN.W, h: CFG.SCREEN.H });
        this._tempLayer = createNode('TempLayer', this.root, { w: CFG.SCREEN.W, h: CFG.SCREEN.H });
        this._fxLayer = createNode('FxLayer', this.root, { w: CFG.SCREEN.W, h: CFG.SCREEN.H });
        this._modalLayer = createNode('ModalLayer', this.root, { w: CFG.SCREEN.W, h: CFG.SCREEN.H });
        this._fx.attach(this._fxLayer);

        this.buildHeader(uiLayer);
        this.buildTempRack(uiLayer);
        this.buildSlotBar(uiLayer);
        this.buildPropBar(uiLayer);
        this.buildStack();

        // ---------- 3'. 开场动画：决定"先看到空舞台"还是"直接看到牌" ----------
        //  params.instant = true 时**跳过开场**（首页那颗「重玩」小方走的就是这条路：
        //  它的语义是"原地立刻再开一局"，再播一遍 1.5s 的开场就变成了惩罚）。
        this._introOn = !(this.params && this.params.instant);
        if (this._introOn) {
            // 牌堆区先压到全透明 —— 它的内容在涌现开始前一张都不许露出来
            MotionFx.setFade(this._stackLayer, 0);
            MotionFx.setFade(this._hudLayer, 0);
        }

        // ---------- 4. 统一点击入口 ----------
        // 页面节点铺满全屏（Widget），所以整屏的触摸都会到这里。
        //  · TOUCH_START 只做**按压反馈**（B1）：牌必须立刻缩一下，等 TOUCH_END 就晚了；
        //  · TOUCH_END 才是真正的"点击"（选中 / 飞行 / 拒绝 / 取消）；
        //  · TOUCH_CANCEL 必须把按压态还回去，否则手指滑出按钮会留下一张永远缩着的牌。
        this.node.on(Node.EventType.TOUCH_START, this.onTouchStart, this);
        this.node.on(Node.EventType.TOUCH_END, this.onTap, this);
        this.node.on(Node.EventType.TOUCH_CANCEL, this.onTouchCancel, this);

        this.refreshHud();
        this.refreshPropBar();

        // ---------- 音频：局内起 BGM（S14）----------
        // 位置必须在 onBuild：这里由 PageManager.open **同步**执行，而 open 又由
        // "点关卡 → goto" 同步触发 ⇒ 在用户手势的调用栈内，autoplay 才放行。
        // ⚠️ 挪到 onEnter 就播不响了（那是 setTimeout 之后，已出栈）——
        //    而且这个 bug 是**静默**的：不报错、日志也没有线索，只是没声音。
        // 幂等：从选关页进来时音乐已在播，不会重启；重开同一关也不会重启。
        AudioService.playBgm();
    }

    // --------------------------------------------------------
    //  顶部信息（关卡名 / 规则 / 计时 / 进度 / 提示）
    // --------------------------------------------------------
    /**
     * 顶条 + 进度条 + 计数行。
     *
     * 【S19 版式：四条通栏 + 一条弹性三段】
     *  通栏（左右边界 = 版心 ±272，逐像素对齐）：
     *     细墨线(460) → 进度条(444) → 槽位条(−284) → 道具栏(−386)
     *  弹性三段（标题 / 规则钮 / 计时）：
     *     [ 第 4 关 · 就差一点 ]  ⟵gap⟶  [ 规则 ]  ⟵gap⟶  [ 05:23 ]
     *  两处 gap **恒相等**（余量均分），见 `layoutHeader`。
     *
     * 【为什么取消旧版的"极浅墨色底带"】
     *  旧版在顶条后面铺了一条 INK/13 的横带，用来把"状态"和"牌局"分开。
     *  S19 的底图（R3 通用底图）本身是干净的宣纸 + 朱红页框，
     *  再加一条横带会把"一张纸"切成上下两块，反而破坏了底图的整体性；
     *  设计稿的 `.hdr` 也没有底色。所以整条去掉，靠字重和字号建立层级。
     */
    private buildHeader(parent: Node): void {
        const L = CFG.GAME_LAYOUT;
        const R3 = CFG.SKIN.R3D;

        // ---------- 关卡名（左对齐，节点位置 = 左边界）----------
        this._titleLabel = createLabel(parent, this.titleText(), {
            x: L.HEADER_TITLE_X, y: L.HEADER_Y, alignLeft: true, w: CFG.SCREEN.W,
            fontSize: L.HEADER_TITLE_SIZE, color: CFG.COLOR.INK, bold: true, serif: true,
        });

        // ---------- 计时（右对齐，节点位置 = 右边界；文字自己往左长）----------
        this._timeLabel = createLabel(parent, this.timeText(), {
            x: L.HEADER_TIME_X, y: L.HEADER_Y,
            fontSize: L.HEADER_TITLE_SIZE, color: CFG.COLOR.VERMILION, bold: true, serif: true,
        });
        const tui = this._timeLabel.node.getComponent(UITransform)!;
        tui.setAnchorPoint(1, 0.5);
        this._timeLabel.node.setPosition(L.HEADER_TIME_X, L.HEADER_Y, 0);
        this._timeLabel.horizontalAlign = Label.HorizontalAlign.RIGHT;

        // ---------- ★ S19：「规则」钮（92×46 圆角方，与底部「重玩」同形制）----------
        // 【为什么从「?」改成「规则」】旧稿那颗 42 正圆绝对居中在 x=0，
        //  换成汉字后最窄要 88 宽，居中会与关卡名的右边界**必撞**（实测只剩 5px）。
        //  新做法是「跟随标题」的弹性三段（见 layoutHeader），它是**结构上不可能重叠**的。
        // 【为什么热区比图形大】这是"伸上去点"的元素，手指抖动量比点底部大。
        //  ⚠️ 热区宽 108 > 图形宽 92 —— 不能沿用旧稿的 88（那样左右各 2px 点不到）。
        this._ruleHitNode = createNode('RuleHit', parent, {
            w: L.RULE_BTN_HIT_W, h: L.RULE_BTN_HIT_H,
        });
        this._ruleHitNode.setPosition(0, L.RULE_BTN_Y, 0);   // 真位置由 layoutHeader 定
        this._ruleHitNode.on(Node.EventType.TOUCH_END, (e: EventTouch) => {
            // 顶条在页面 TOUCH_END（统一命中测试）的上方，不拦的话这次点击
            // 会继续冒泡到 onTap 去做一次牌命中测试 —— 虽然顶条上没有牌、
            // 结果无害，但"无害"是靠巧合成立的，显式吃掉更稳。
            e.propagationStopped = true;
            if (this._modal || this._over) return;
            RuleSheet.open(this.root);
        }, this._ruleHitNode);

        // 图形画在热区的**子节点**上 —— 热区一动它就跟着动，位置只有一个来源。
        this._ruleNode = createNode('RuleBtn', this._ruleHitNode, {
            w: L.RULE_BTN_W, h: L.RULE_BTN_H,
        });
        const rg = this._ruleNode.addComponent(Graphics);
        draw3dFace(rg, 0, 0, {
            w: L.RULE_BTN_W,
            h: L.RULE_BTN_H,
            radius: L.RULE_BTN_RADIUS,
            stops: CFG.SKIN.GRAD.TOOL,
            border: R3.BORDER_RULE,
            depth: R3.DEPTH_RULE,      // CSS `.rule-btn{0 4px 0}`（不是 DEPTH_SMALL 的 5）
            depthColor: CFG.SKIN.GRAD.WHITE_DEPTH,
            hiliteAlpha: R3.HILITE_ALPHA,
            // 规则钮**有**柔影：`.rule-btn{…,0 9px 12px rgba(34,32,28,.24)}`（12 / 9 / 61）。
            //  ⚠️ S20 曾把这条读成"没有第三条"，理由是"规则钮贴着顶条，不该有投影" ——
            //  那是**凭感觉反推设计稿**，不是实测。原 CSS 就写在 `局内-优化后-1x.html` 第 48 行。
            shadow: R3.SHADOW.RULE,
        });
        createLabel(this._ruleNode, L.RULE_BTN_LABEL, {
            fontSize: L.RULE_BTN_FONT, color: '#2B2823', bold: true, serif: true,
        });

        // ---------- 细墨线分隔（通栏）----------
        // 两端渐隐（CSS `linear-gradient(90deg, 透明, .42 12%, .42 88%, 透明)`）：
        // 用 3 段不同 alpha 的矩形逼近，比整条实线"软"，不会在两端形成硬切点。
        const line = createNode('HeaderLine', parent, { w: L.BAR_W, h: 2 });
        const lg = line.addComponent(Graphics);
        const segW = L.BAR_W / 6;
        const alphas = [0, 40, 107, 107, 40, 0];
        for (let i = 0; i < 6; i++) {
            const a = (alphas[i] + (alphas[i + 1] ?? alphas[i])) / 2;
            if (a <= 0) continue;
            fillBox(lg, -L.BAR_W / 2 + segW * (i + 0.5), 0, segW + 0.5, 2, 0,
                CFG.COLOR.INK, a);
        }
        line.setPosition(0, L.HEADER_LINE_Y, 0);

        // ---------- 进度条（胶囊 + 内凹顶阴影 + 刻度）----------
        const progressRoot = createNode('Progress', parent, { w: L.BAR_W, h: L.BAR_H });
        progressRoot.setPosition(0, L.BAR_Y, 0);
        this._barG = progressRoot.addComponent(Graphics);
        this.drawProgress();

        // ---------- 计数（左）与玩法提示（右）—— 同一行，各自贴住版心边 ----------
        this._countLabel = createLabel(parent, '', {
            x: -L.ROW_X, y: L.ROW_Y, alignLeft: true, w: 300,
            fontSize: L.TIP_SIZE, color: CFG.COLOR.INK_MID,
        });

        const tip = createLabel(parent, this._level.teach, {
            x: L.ROW_X, y: L.ROW_Y, w: 520,
            fontSize: L.TIP_SIZE, color: CFG.COLOR.INK_MID,
        });
        tip.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);
        tip.node.setPosition(L.ROW_X, L.ROW_Y, 0);
        tip.horizontalAlign = Label.HorizontalAlign.RIGHT;

        // ---------- S7 · A4：状态条整体"从上方落下 + 淡入"----------
        // 为什么是"下落"而不是"淡入"：这些元素在视觉上是**从上往下读**的
        // （关卡名 → 进度 → 已清计数 → 提示），让它们错落地"落"下来，
        // 视线会被自然地带到牌堆上；纯粹淡入则没有方向感。
        // 这里只登记「节点 + 它的目标 y」，真正的动画在 onEnter 里播
        // （构建期页面还不可见，播了也白播）。
        // ⚠️ 规则钮登记的是**热区**节点 —— 图形是它的子节点，动一个就够；
        //    两个都登记会让父子各叠一次位移，位置翻倍（且不报错）。
        this._hudItems = [
            { node: this._titleLabel.node, y: L.HEADER_Y },
            { node: this._timeLabel.node, y: L.HEADER_Y },
            { node: line, y: L.HEADER_LINE_Y },
            { node: progressRoot, y: L.BAR_Y },
            { node: this._countLabel.node, y: L.ROW_Y },
            { node: tip.node, y: L.ROW_Y },
            { node: this._ruleHitNode, y: L.RULE_BTN_Y },
        ];

        // 先算一次（构建期量不准也没关系，`onEnter` 会再算一次 —— 见那里的注释）
        this.layoutHeader();
    }

    /** 顶条关卡名的文案（一处生成，避免 onEnter 重算时两边不一致）*/
    private titleText(): string {
        return `第 ${this._level.id} 关 · ${this._level.name}`;
    }

    /**
     * 顶条**弹性三段**排版：把「标题 → 规则钮 → 计时」之间的余量**均分**。
     *
     *      标题左边界(−272) ─ 标题宽 ─┐
     *                                 ├─ gap ─ [规则钮 92] ─ gap ─ 计时左边界 ┐
     *      计时右边界(+272) ─ 计时宽 ─┘                                        │
     *      2·gap = 544 − 标题宽 − 92 − 计时宽                                  ┘
     *
     * 【为什么必须"均分"而不是"固定 24px 间距"】
     *  固定间距的话，关卡名一变长，间隙就从右边单方向被吃掉 —— 最后必然撞上计时。
     *  均分的话两侧同时收，**结构上不可能重叠**，而且关卡名越长视觉上越"平衡"。
     *  （设计稿实测：标题 219 宽 → 两侧各 70px，正是均分。）
     *
     * 【为什么要在这里改字号】标题有 311px 的硬上限（「不能被挤掉的入口」优先于字号）。
     *  超了就降到 HEADER_TITLE_MIN_SIZE 一档 —— 只降一档，不循环，
     *  避免"量宽度 → 改字号 → 宽度又变"这种在构建期跑不稳的反馈环。
     *
     * ⚠️ 调用时机：`buildHeader` 末尾一次 + `onEnter` 开头一次。
     *  `onEnter` 那次才是准的（PageManager 用 setTimeout 延后 ~240ms 才调它，
     *  此时 Label 已经过渲染管线、`contentSize` 可信）；构建期那次只是兜底。
     */
    private layoutHeader(): void {
        const L = CFG.GAME_LAYOUT;
        const t = this._titleLabel;
        const hit = this._ruleHitNode;
        if (!t || !t.node || !t.node.isValid || !hit || !hit.isValid) return;

        const text = this.titleText();
        let tw = measureLabel(t, text);
        if (tw > L.HEADER_TITLE_MAX_W && t.fontSize > L.HEADER_TITLE_MIN_SIZE) {
            t.fontSize = L.HEADER_TITLE_MIN_SIZE;
            t.lineHeight = t.fontSize * CFG.FONT.LINE_HEIGHT_RATIO;
            tw = Math.min(measureLabel(t, text), estTextWidth(text, t.fontSize));
        }

        const timeW = measureLabel(this._timeLabel, this.timeText());
        const avail = CFG.SKIN.SAFE_X1 - CFG.SKIN.SAFE_X0;      // = 544
        let gap = (avail - tw - L.RULE_BTN_W - timeW) / 2;
        // 兜底：标题被极端长名字撑满时，宁可退回固定间隙（偏左一点），
        // 也不能让 gap 变成负数 —— 负数会让规则钮插进标题里。
        if (gap < L.RULE_BTN_GAP) gap = L.RULE_BTN_GAP;

        const rx = CFG.SKIN.SAFE_X0 + tw + gap + L.RULE_BTN_W / 2;
        hit.setPosition(rx, L.RULE_BTN_Y, 0);
    }

    // --------------------------------------------------------
    //  暂存架（「移出」道具的落点）
    // --------------------------------------------------------
    private buildTempRack(parent: Node): void {
        const L = CFG.GAME_LAYOUT;
        const rack = createNode('TempRack', parent, { w: L.TEMP_SLOT_W * 3 + L.TEMP_SLOT_GAP * 2, h: L.TEMP_RACK_H });
        rack.setPosition(0, L.TEMP_RACK_Y, 0);
        this._tempRackG = rack.addComponent(Graphics);
        this._tempRackNode = rack;

        const label = createLabel(parent, '暂存', {
            x: L.TEMP_LABEL_X, y: L.TEMP_RACK_Y, w: 120,
            fontSize: CFG.FONT.SIZE_TINY, color: CFG.COLOR.INK_MID,
        });
        this._tempLabelNode = label.node;

        this.drawTempRack();

        // ⚠️ S14.2b：**默认隐藏**，点了「移出」道具才浮现（见 showTempRack）。
        // 原因见 CFG.GAME_LAYOUT.TEMP_RACK_Y 上方：牌堆区扩容后牌堆底探到 -320，
        // 与暂存架（-364~-288）必然重叠；不用道具时那三格空槽只是在跟槽位条抢注意力。
        // 注意必须在 drawTempRack() **之后**再关 —— 先关的话 Graphics 不会绘制，
        // 首次 show 时是空的（这个坑很隐蔽：不报错，只是"牌落进了一个看不见的架子"）。
        this.setTempRackVisible(false);
    }

    /** 暂存架整体显隐（图形 + 「暂存」标签一起，少一个就会错位） */
    private setTempRackVisible(on: boolean): void {
        if (this._tempRackNode?.isValid) this._tempRackNode.active = on;
        if (this._tempLabelNode?.isValid) this._tempLabelNode.active = on;
    }

    /**
     * 首次「移出」时把暂存架**浮现**出来。
     * 用"从下往上滑一小段 + 淡入"而不是直接 active=true：
     * 架子是从牌堆底下钻出来的，硬切会让它像"突然贴上去的一张图"。
     * 幂等 —— 第二次用移出道具不会重播。
     */
    private showTempRack(): void {
        if (this._tempRackShown) return;
        this._tempRackShown = true;
        this.setTempRackVisible(true);
        const M = CFG.MOTION;
        for (const n of [this._tempRackNode, this._tempLabelNode]) {
            if (!n || !n.isValid) continue;
            n.setPosition(n.position.x, CFG.GAME_LAYOUT.TEMP_RACK_Y - M.SLOT_IN_FROM_Y * 0.6, 0);
            MotionFx.to(n, { position: v3(n.position.x, CFG.GAME_LAYOUT.TEMP_RACK_Y, 0) },
                { duration: M.SLOT_IN, easing: EASE.POP, tag: TAG.ENTER });
        }
    }

    private drawTempRack(): void {
        const L = CFG.GAME_LAYOUT;
        const g = this._tempRackG;
        if (!g) return;
        g.clear();
        for (let i = 0; i < CFG.GAMEPLAY.TEMP_CAPACITY; i++) {
            const cx = this.tempOffsetX(i);
            // 暂存格只画虚线感的浅描边：它是"备用位"不是"主战场"，
            // 画重了会和下面真正的槽位条抢注意力。
            strokeBox(g, cx, 0, L.TEMP_SLOT_W, L.TEMP_RACK_H, CFG.SHAPE.RADIUS_TEMP,
                CFG.COLOR.LOCK, 1.6, 150);
        }
    }

    private tempOffsetX(i: number): number {
        const L = CFG.GAME_LAYOUT;
        const step = L.TEMP_SLOT_W + L.TEMP_SLOT_GAP;
        const total = CFG.GAMEPLAY.TEMP_CAPACITY * L.TEMP_SLOT_W
            + (CFG.GAMEPLAY.TEMP_CAPACITY - 1) * L.TEMP_SLOT_GAP;
        return -total / 2 + L.TEMP_SLOT_W / 2 + i * step;
    }

    private tempPos(i: number): Vec3 {
        return v3(this.tempOffsetX(i), CFG.GAME_LAYOUT.TEMP_RACK_Y, 0);
    }

    // --------------------------------------------------------
    //  槽位条
    // --------------------------------------------------------
    private buildSlotBar(parent: Node): void {
        const L = CFG.GAME_LAYOUT;
        const bar = createNode('SlotBar', parent, { w: L.SLOT_BAR_W, h: L.SLOT_BAR_H });
        bar.setPosition(0, L.SLOT_BAR_Y, 0);
        this._slotBarG = bar.addComponent(Graphics);
        this._slotBarNode = bar;

        // C7 警戒层：贴在槽位条**之上**的一张透明覆盖层，只画"剩余空位"的红描边。
        // 为什么不直接改槽位条的描边色：Graphics 的颜色没法 tween，
        // 而呼吸闪烁靠的就是透明度的往复 —— 覆盖层是唯一能把"颜色变化"
        // 变成"可动画属性"的办法（也顺手躲开了重画整条槽位条的开销）。
        this._warnNode = createNode('SlotWarn', bar, { w: L.SLOT_BAR_W, h: L.SLOT_BAR_H });
        this._warnG = this._warnNode.addComponent(Graphics);
        MotionFx.setFade(this._warnNode, 0);

        this.drawSlotBar();

        // ---------- 底部返回（S19：3D 纸白胶囊，与「重玩」并排成一组）----------
        // ⚠️ X 不能再是 0：旧稿"返回居中 + 重玩甩到最右"让两个按钮中间空出一大块，
        //    视觉上读成"两个不相干的控件"。现在 (−60) 与 (+96) 组成一组，
        //    整组以 x = 18 为中心大致居中（见 CFG.BACK_BTN_X 的推导）。
        const back = createNode('BackBtn', parent, { w: L.BACK_BTN_W, h: L.BACK_BTN_H });
        back.setPosition(L.BACK_BTN_X, L.BACK_BTN_Y, 0);
        this._backBtnNode = back;
        const R3 = CFG.SKIN.R3D;
        const bg = back.addComponent(Graphics);
        draw3dFace(bg, 0, 0, {
            w: L.BACK_BTN_W,
            h: L.BACK_BTN_H,
            radius: R3.RADIUS_PILL,
            stops: CFG.SKIN.GRAD.PAPER_BACK,
            border: R3.BORDER_BTN,
            depth: R3.DEPTH_SMALL,
            depthColor: CFG.SKIN.GRAD.WHITE_DEPTH,
            hiliteAlpha: R3.HILITE_ALPHA,
            // 接地柔影 = `.btn-back{0 10px 14px rgba(34,32,28,.24)}`（14 / 10 / 61）
            shadow: R3.SHADOW.BACK,
        });
        createLabel(back, '返 回', {
            fontSize: CFG.FONT.SIZE_BODY, color: '#2B2823', bold: true, serif: true,
        });
        back.on(Node.EventType.TOUCH_END, () => {
            if (this._modal) return;
            // ★ S18.3：选关页已删除 → 返回的位置改为**首页**。
            this.goto('menu');
        }, back);

        // ---------- S18：局内常驻「重玩」小方 ----------
        // 【为什么它必须常驻】打不过想重来，不该先失败一次才能重开。
        //  位置 = 返回按钮右侧同高，与首页那颗「重玩」小方**同形制、同语义**
        //  （首页是"主按钮 + 小方"，这里是"返回 + 小方"）。
        //  走的也是 `instant: true` —— 重开就是重开，不再播一遍 1.5s 开场。
        // 【形制】圆角方（RADIUS_REPLAY 22），不是胶囊 —— 胶囊会与「返回」撞形制。
        const replay = createButton(parent, 'ReplayBtn', {
            w: L.REPLAY_BTN_SIZE, h: L.REPLAY_BTN_SIZE,
            x: L.REPLAY_BTN_X, y: L.REPLAY_BTN_Y,
            radius: R3.RADIUS_REPLAY,
            // 形制 = `.btn-replay{0 5px 0 #C3B89F, 0 5px 0 4px #22201C, 0 10px 14px .26}`
            //  ⚠️ 用 'white' 而不是 'tool'：两者底色渐变相近，但 `tool` 的
            //  厚度是 6、描边 3.5（道具键规格），而重玩小方是 **5 / 4**。
            //  差 1px 的厚度在 76×76 的小方上很显眼（会读成"比返回键厚"）。
            tone: 'white',
            depth: R3.DEPTH_SMALL,
            text: '重 玩',
            fontSize: CFG.FONT.SIZE_SMALL,
            serif: true,
            onClick: () => {
                if (this._modal) return;
                this.goto('game', { levelId: this._level.id, instant: true });
            },
        });
        this._replayBtnNode = replay;
        this._replayLabel = replay.getComponentInChildren(Label);
    }

    /**
     * 重画槽位条。
     * 「加槽」道具会改变容量，所以这个方法必须能在运行中被再调一次 ——
     * 槽格的宽度是**按容量算出来的**，容量一变整条都要重画。
     *
     * 【S19 形制】条体 = 3D 厚描边（radius14 / border3.5 / depth5）+ 顶部内阴影；
     * 槽格 = **凹陷的格底**（SLOTCELL 渐变 + 内阴影，无描边）。
     *  ⚠️ 旧版只给空槽画描边（"空与满一眼可分"）。现在格底**一律画出来**：
     *     牌落上去会正好盖住它，占用与否由牌本身表达 ——
     *     再留一层描边反而会在牌的四周露出"第二个框"，像没对准。
     */
    private drawSlotBar(): void {
        const L = CFG.GAME_LAYOUT;
        const g = this._slotBarG;
        if (!g) return;
        const R3 = CFG.SKIN.R3D;
        g.clear();

        draw3dFace(g, 0, 0, {
            w: L.SLOT_BAR_W,
            h: L.SLOT_BAR_H,
            radius: R3.RADIUS_SLOT,
            stops: CFG.SKIN.GRAD.SLOT,
            border: R3.BORDER_SLOT,
            depth: R3.DEPTH_SMALL,
            depthColor: CFG.SKIN.GRAD.WHITE_DEPTH,
            // ⚠️ **槽位条没有外圈墨边**：CSS 是
            //   `.slotbar{border:3.5px solid #22201C; box-shadow:inset 0 5px 9px …,
            //             0 5px 0 #C3B89F,   ← 这条**没有 spread**
            //             0 10px 14px rgba(34,32,28,.18)}`
            //   其它控件的第二条都写了 `0 Npx 0 <描边宽>px #22201C`（外圈与描边齐平），
            //   只有它没写 ⇒ 下缘只有 5px 厚度色就接纸面。
            //   不显式关掉的话，下缘会多出 4px 纯黑（实测：设计稿 y979 起是 202~207，
            //   渲染出来是 31.3）—— 槽位条会读成"浮在一个黑色托盘上"，很脏。
            depthSpread: 0,
            hiliteAlpha: 0,                       // 内凹件不要高光带
            insetTop: 5,                          // CSS `inset 0 5px 9px`
            insetAlpha: 40,
            // 接地柔影 = `.slotbar{…, 0 10px 14px rgba(34,32,28,.18)}`（14 / 10 / 46）。
            //  ⚠️ 它是**最轻的一档**：槽位条本身是"凹槽"，只该在纸面上微微压出一点接触影。
            //  它下沿（y≈979）到道具栏上沿（y≈986）只有 7px，所以实际露出极少 —— 但正是
            //  这 7px 决定它是"嵌在纸里"还是"一张浮起来的纸片"。
            shadow: R3.SHADOW.SLOTBAR,
        });

        const slotW = this.slotWidth();
        const cellH = L.SLOT_BAR_H - CFG.GAMEPLAY.SLOT_INSET_Y * 2;
        for (let i = 0; i < this._slotCapacity; i++) {
            draw3dFace(g, this.slotOffsetX(i), 0, {
                w: slotW,
                h: cellH,
                radius: R3.RADIUS_SLOTCELL,
                stops: CFG.SKIN.GRAD.SLOTCELL,
                border: 0,
                depth: 0,
                hiliteAlpha: 0,
                insetTop: 3,                      // CSS `inset 0 3px 6px`
                insetAlpha: 40,
            });
        }
    }

    /**
     * C7 槽位警戒：剩余空位 ≤ CFG.MOTION.WARN_AT 时，空位描边红色呼吸闪烁。
     *
     * 【两条刻意的限制，都是"反焦虑"设计】
     *  ① **只在"进入警戒"那一次播**。每次加牌都重播的话，槽位越接近满、
     *     屏幕闪得越勤 —— 那是在惩罚玩家"你快输了"，只会让人想摔手机。
     *  ② **播 fixed 次数就停**，不做常驻闪烁。持续闪烁会挤占注意力，
     *     反而让玩家看不清槽里到底有什么牌（而这恰恰是能不能救回来的关键）。
     *
     * 调用时机：**任何改变槽位占用 / 容量的地方**都要调一次。
     * 重播的判定写在方法内部（只在"非警戒 → 警戒"的那一次跃迁上播），
     * 调用方不需要、也不应该自己判断该不该重播 —— 判断逻辑分散出去，
     * 迟早会出现"每放一张牌就闪一轮"的版本。
     */
    private refreshSlotWarn(): void {
        if (!this._warnNode || !this._warnNode.isValid) return;

        const M = CFG.MOTION;
        const empty = this._slotCapacity - this._slots.length;
        const danger = empty > 0 && empty <= M.WARN_AT;

        if (!danger) {
            // 脱离警戒：把图层彻底静下来（stop 是必要的，否则残留 tween 会继续改透明度）
            this._warnOn = false;
            MotionFx.stop(this._warnNode, TAG.FADE);
            MotionFx.stop(this._warnNode, TAG.FX);
            MotionFx.setFade(this._warnNode, 0);
            return;
        }

        // 空位的下标区间 [slots.length, capacity)
        this.drawSlotWarn(this._slots.length);

        if (this._warnOn) return;   // 已在警戒中 → 只更新描边位置，绝不重播
        this._warnOn = true;

        // 亮 → 暗 一次为一个周期，来回 WARN_TIMES 次
        // （用 fadeChain 一条链走完，避免多条 tween 抢同一个 UIOpacity）
        const steps: Array<{ to: number; duration: number; easing?: string }> = [];
        steps.push({ to: 255, duration: M.WARN_CYCLE / 2, easing: EASE.IDLE });
        for (let i = 0; i < M.WARN_TIMES - 1; i++) {
            steps.push({ to: 0, duration: M.WARN_CYCLE / 2, easing: EASE.IDLE });
            steps.push({ to: 255, duration: M.WARN_CYCLE / 2, easing: EASE.IDLE });
        }
        steps.push({ to: 0, duration: M.WARN_CYCLE / 2, easing: EASE.IDLE });
        MotionFx.setFade(this._warnNode, 0);
        MotionFx.fadeChain(this._warnNode, steps, { tag: TAG.FADE });
    }

    /** 画警戒层：把剩余空位的格底**再描一圈朱红**（S19 起槽格本身不再是描边，所以这里补框） */
    private drawSlotWarn(fromIndex: number): void {
        const g = this._warnG;
        if (!g) return;
        const L = CFG.GAME_LAYOUT;
        g.clear();
        const slotW = this.slotWidth();
        const cellH = L.SLOT_BAR_H - CFG.GAMEPLAY.SLOT_INSET_Y * 2;
        for (let i = fromIndex; i < this._slotCapacity; i++) {
            strokeBox(g, this.slotOffsetX(i), 0, slotW, cellH,
                CFG.SKIN.R3D.RADIUS_SLOTCELL, CFG.COLOR.VERMILION, CFG.MOTION.WARN_LINE);
        }
    }

    /** 槽格宽度（随容量自适应） */
    private slotWidth(): number {
        const L = CFG.GAME_LAYOUT;
        const innerW = L.SLOT_BAR_W - CFG.GAMEPLAY.SLOT_PADDING * 2;
        return (innerW - CFG.GAMEPLAY.SLOT_GAP * (this._slotCapacity - 1)) / this._slotCapacity;
    }

    /**
     * 槽内牌的缩放系数。
     * 三个上限取最小：配置上限、格宽能放下的、格高能放下的。
     * 这样「加槽」把 8 格变 9 格时，牌会自动缩一点点继续放得下 ——
     * 不需要为"加槽后"单独写一套尺寸。
     *
     * 【口径为什么按「最长边」算（S10 T3）】
     * 牌是四向随机朝向的，槽里的牌「保不保留原朝向」由开关控制
     * （`CFG.STACK.SLOT_KEEP_ANGLE`，**当前为 false = 一律转正**）。
     * 但**这个函数的口径不跟着开关走**：它按最长边 `max(W, H)` 取方形占位。
     * 原因很实在 —— 开关一翻，槽里就会出现横躺（宽 114×高 85）的牌；
     * 若此时仍按 `TILE.W` 去套 81.5px 的格宽，实际画出来是 114×scale，
     * 直接顶出格子、压到邻格上。按最长边算则两种朝向一视同仁，
     * 翻开关不会引入这个 bug（代价只是槽内牌比理论值小一点，肉眼看不出来）。
     */
    private slotScale(): number {
        const L = CFG.GAME_LAYOUT;
        const f = this.slotFootprint();
        const hLimit = (L.SLOT_BAR_H - CFG.GAMEPLAY.SLOT_INSET_Y * 2) / f;
        return Math.min(CFG.TILE.SLOT_SCALE, this.slotWidth() / f, hLimit);
    }

    /**
     * 槽内 / 暂存架里牌的「视觉正方形边长」。
     * 按最长边算的理由见 slotScale 的注释 —— 它是"翻开关也不会崩"的保险，
     * 不是当前朝向的推导结果。
     * 单独抽出来是因为它同时被槽位和暂存架两处用，改口径只能改这一处。
     */
    private slotFootprint(): number {
        // ⚠️ 必须用**本关的真实牌面尺寸**（tileSizeOf 是唯一口径），
        //    不能写死 CFG.TILE.W/H：L1 是 128、L2 起是基准 ×1.25，
        //    写死基准的话槽内缩放会按旧尺寸算 —— 牌放大后就会顶出格子。
        //    取自 `_layout.tiles[0]`（已在 onBuild 开头生成），保底回落到基准。
        const t = this._layout?.tiles?.[0];
        const w = t ? t.w : tileSizeOf(this._level).w;
        const h = t ? t.h : tileSizeOf(this._level).h;
        return Math.max(w, h);
    }

    /** 暂存架里牌的缩放系数（同样按最长边，暂存架里也不转正） */
    private tempScale(): number {
        const L = CFG.GAME_LAYOUT;
        const f = this.slotFootprint();
        return Math.min(this.slotScale(), L.TEMP_SLOT_W / f, (L.TEMP_RACK_H - 6) / f);
    }

    /**
     * 取某张牌在牌堆里的**朝向**（0 / 90 / 180 / 270）。
     *
     * 【为什么不把 angle 存进 SlotEntry / _temp，而是每次回牌堆里查】
     * 朝向是牌的固有属性，真值只有一份 —— `_layout.tiles[id].angle`。
     * 槽位、暂存架、飞行中的特效牌都只是**这张牌的不同视图状态**。
     * 一旦在 SlotEntry 里再存一份，就多出"两份数据要同步"的义务：
     * 洗牌会改牌堆布局（可能重算朝向）、移出/取回又会在槽与暂存架之间搬 ——
     * 每一条路径都是一个漏同步的机会，
     * 而漏掉的表现是"同一张牌在槽里躺着、回到场上却站起来了"，这种错位极难排查。
     * 统一回牌堆查，就没有这个问题。
     *
     * 牌堆里查不到（id 越界 / 已从布局里删除）时退回 0，等价于旧行为。
     */
    private angleOf(id: number): number {
        const t = this._layout.tiles[id];
        return t ? t.angle : 0;
    }

    /**
     * 槽位 / 暂存架里这张牌**该显示的**朝向。
     *
     * 与 `angleOf` 分开是有意的：牌堆里的朝向永远是牌自己的（不受开关影响，
     * 否则"回场"时会把牌摆正、破坏四向随机的观感），只有**槽位与暂存架**
     * 这两处展示位受 `CFG.STACK.SLOT_KEEP_ANGLE` 控制。
     * 合成一个函数再传布尔参数就分不清"这里该不该受开关管"了。
     */
    private slotAngleOf(id: number): number {
        return CFG.STACK.SLOT_KEEP_ANGLE ? this.angleOf(id) : 0;
    }

    /** 第 i 个槽格的中心 x（相对屏幕中心） */
    private slotOffsetX(i: number): number {
        const L = CFG.GAME_LAYOUT;
        const innerW = L.SLOT_BAR_W - CFG.GAMEPLAY.SLOT_PADDING * 2;
        const startX = -innerW / 2 + this.slotWidth() / 2;
        return startX + i * (this.slotWidth() + CFG.GAMEPLAY.SLOT_GAP);
    }

    /** 第 i 个槽格的中心坐标 */
    private slotPos(i: number): Vec3 {
        return v3(this.slotOffsetX(i), CFG.GAME_LAYOUT.SLOT_BAR_Y, 0);
    }

    // --------------------------------------------------------
    //  道具栏
    // --------------------------------------------------------
    private buildPropBar(parent: Node): void {
        const L = CFG.GAME_LAYOUT;
        const count = PROP_DEFS.length;
        const total = count * L.PROP_BTN_W + (count - 1) * L.PROP_BTN_GAP;

        for (let i = 0; i < count; i++) {
            const def = PROP_DEFS[i];
            const x = -total / 2 + L.PROP_BTN_W / 2 + i * (L.PROP_BTN_W + L.PROP_BTN_GAP);

            // 道具按钮**刻意不用 createButton**：它的文本是居中的，
            // 而道具需要「名字 + 副标签」两行结构。这里手画一个同形制的。
            //  ⚠️ S19：厚度层不再单独建节点 —— 整个 3D 面（厚度 + 描边 + 渐变 + 高光）
            //     由 `drawPropFace` 一次画在同一张 Graphics 上，
            //     因为"可用 = 朱红 / 不可用 = 纸白"要能随时整块重画（见 refreshPropBar）。
            const btn = createNode(`Prop_${def.id}`, parent, { w: L.PROP_BTN_W, h: L.PROP_BTN_H, x, y: L.PROP_BAR_Y });

            const face = createNode('Face', btn, { w: L.PROP_BTN_W, h: L.PROP_BTN_H });
            const fg = face.addComponent(Graphics);
            this._propFaces[def.id] = fg;

            // D2 的"图标亮度提升"：一张只填白色的圆角层，平时全透明，
            // 按下时短暂亮起。用叠白而不是改底色，是因为底色还要承担
            // "可用（朱红）/ 不可用（纸白）"两种语义，不能被按压态污染。
            const glow = createNode('Glow', face, { w: L.PROP_BTN_W, h: L.PROP_BTN_H });
            const glowG = glow.addComponent(Graphics);
            fillBox(glowG, 0, 0, L.PROP_BTN_W, L.PROP_BTN_H, CFG.SKIN.R3D.RADIUS_TOOL, CFG.COLOR.FACE);
            const glowOp = glow.addComponent(UIOpacity);
            glowOp.opacity = 0;
            this._propGlows[def.id] = glowOp;

            const name = createLabel(face, def.name, {
                y: L.PROP_NAME_DY, fontSize: CFG.FONT.SIZE_BODY + 4,
                color: '#2B2823', bold: true, serif: true,
            });
            const sub = createLabel(face, '', {
                y: L.PROP_SUB_DY, fontSize: CFG.FONT.SIZE_TINY,
                color: CFG.COLOR.INK_MID, w: L.PROP_BTN_W - 16,
            });
            this._propNames[def.id] = name;
            this._propSubs[def.id] = sub;

            this._propNodes[def.id] = btn;

            // 首次画一次（默认"不可用"的纸白态；真状态由 refreshPropBar 刷）
            this.drawPropFace(def.id, false, false);

            // D2：按压反馈。**与 B1 共用同一组常量**（CFG.MOTION.TAP_DOWN /
            // PRESS_SCALE / EASE）—— 道具按钮与牌如果按压手感不一致，
            // 玩家会觉得"有两套物理规则"，那是最廉价的不精致。
            // S12.1：跟着牌一起从"缩小 0.96"改成"放大 1.08"。
            // 原来那对 TAP_DOWN_SCALE / TAP_DOWN_DY 已经**删掉**了，不是留着不用 ——
            // 留着的常量迟早会让人以为"还有另一条按压路径"。
            const press = () => {
                if (this._modal) return;
                MotionFx.to(btn, { scale: v3(CFG.MOTION.PRESS_SCALE, CFG.MOTION.PRESS_SCALE, 1) },
                    { duration: CFG.MOTION.TAP_DOWN, easing: EASE.MOVE, tag: TAG.PRESS });
                const gl = this._propGlows[def.id];
                if (gl) gl.opacity = 70;
            };
            const release = () => {
                MotionFx.to(btn, { scale: v3(1, 1, 1) },
                    { duration: CFG.MOTION.TAP_UP, easing: EASE.MOVE, tag: TAG.PRESS });
                const gl = this._propGlows[def.id];
                if (gl) gl.opacity = 0;
            };
            btn.on(Node.EventType.TOUCH_START, press, btn);
            btn.on(Node.EventType.TOUCH_END, () => {
                release();
                void this.onPropTap(def.id);
            }, btn);
            btn.on(Node.EventType.TOUCH_CANCEL, release, btn);
        }
    }

    /**
     * 重画某个道具按钮的面。
     *
     * 【S19 两态，来自设计稿】
     *  可用 = **朱红**（`GRAD.TOOL_RED` + `RED_DEPTH` 厚度 + 白字）
     *  不可用 = **纸白**（`GRAD.TOOL` + `WHITE_DEPTH` 厚度 + 墨字）
     *  （旧版是"朱红 + 角花 / 纸灰 + 无角花"，角花在 3D 圆角体系里已经取消。）
     *
     * ⚠️ `armed`（"已按下、正在等玩家点第二下"）**不再换底色为金色**：
     *    3D 体系里金色与朱红同亮度，交换底色会读成"换了一个道具"。
     *    改为抬高一档高光（`HILITE_ALPHA` 提满），并在外面补一圈金环 ——
     *    形制不变、只变"亮度 + 外环"，才读得出"同一个键被按下去了"。
     */
    private drawPropFace(id: PropId, enabled: boolean, armed: boolean): void {
        const g = this._propFaces[id];
        if (!g) return;
        const L = CFG.GAME_LAYOUT;
        const R3 = CFG.SKIN.R3D;
        g.clear();

        draw3dFace(g, 0, 0, {
            w: L.PROP_BTN_W,
            h: L.PROP_BTN_H,
            radius: R3.RADIUS_TOOL,
            stops: enabled ? CFG.SKIN.GRAD.TOOL_RED : CFG.SKIN.GRAD.TOOL,
            border: R3.BORDER_TOOL,
            depth: R3.DEPTH_MID,
            depthColor: enabled ? CFG.SKIN.GRAD.RED_DEPTH : CFG.SKIN.GRAD.WHITE_DEPTH,
            hiliteAlpha: enabled ? R3.HILITE_ALPHA : 0,
            // 接地柔影：设计稿给了**两态两组值**，但两者**只有 α 不同**（出处是局内页）——
            //   白态 `.tool{   0 6px 0 …,0 11px 15px rgba(34,32,28,.22)}` → 15 / 11 / 56
            //   红态 `.tool.red{0 6px 0 …,0 11px 15px rgba(34,32,28,.28)}` → 15 / 11 / 71
            // 红态影更重是对的：朱红与纸底的明度差更大，影太淡会读成"贴上去的"。
            // ⚠️ 别再抄 `首页-优化后-1x.html` 里的 `.tool-red`（那张表写的是
            //   `0 13px 17px .30`，而且连 `.tool` 的厚度都写 7）—— 它与局内页不是同一版，
            //   实测局内的厚度是 6，以局内页为准。
            shadow: enabled ? R3.SHADOW.TOOL_RED : R3.SHADOW.TOOL,
        });

        // armed：在按钮外圈补一道金环（不改底色，见上面注释）
        if (armed) {
            strokeBox(g, 0, 0, L.PROP_BTN_W + 7, L.PROP_BTN_H + 7, R3.RADIUS_TOOL + 3.5,
                CFG.COLOR.GOLD, 3);
        }

        const nameLabel = this._propNames[id];
        if (nameLabel) nameLabel.color = hex2color(enabled ? CFG.COLOR.FACE : '#2B2823');
        const subLabel = this._propSubs[id];
        if (subLabel) subLabel.color = hex2color(enabled ? '#F6D9D4' : CFG.COLOR.INK_MID);
    }

    /** 道具当前是否可用；返回不可用的原因（null = 可用） */
    private propBlockReason(id: PropId): string | null {
        switch (id) {
            case 'remove':
                if (this._slots.length === 0) return '槽里还没有牌';
                return null;
            case 'move':
                if (this._slots.length === 0) return '槽里还没有牌';
                if (this._temp.length >= CFG.GAMEPLAY.TEMP_CAPACITY) return '暂存架已经满了';
                return null;
            case 'shuffle':
                // 暂存架的牌也算"还在牌局里"（洗牌会把它们一并撒回场上）
                if (this._left + this._temp.length <= 1) return '场上没有可洗的牌了';
                return null;
            case 'addslot':
                if (this._propUsed.addslot >= CFG.PROP.ADD_SLOT_PER_LEVEL) return '本关的加槽名额已用完';
                return null;
            default:
                return null;
        }
    }

    /** 刷新道具栏（可用态 / 副标签文案） */
    private refreshPropBar(): void {
        for (const def of PROP_DEFS) {
            const enabled = this.propBlockReason(def.id) === null;
            const armed = def.id === 'remove' && this._armedRemove;
            this.drawPropFace(def.id, enabled, armed);

            const sub = this._propSubs[def.id];
            if (!sub) continue;
            switch (def.id) {
                case 'remove':
                    sub.string = armed ? '点槽内一张' : '看广告';
                    break;
                case 'move':
                    sub.string = `挪走 ${CFG.PROP.MOVE_OUT_COUNT} 张`;
                    break;
                case 'shuffle':
                    sub.string = '看广告';
                    break;
                case 'addslot':
                    sub.string = this._propUsed.addslot >= CFG.PROP.ADD_SLOT_PER_LEVEL
                        ? '已用完' : `${this._slotCapacity} → ${this._slotCapacity + CFG.PROP.ADD_SLOT_STEP}`;
                    break;
                default:
                    break;
            }
        }
    }

    // --------------------------------------------------------
    //  牌堆
    // --------------------------------------------------------
    private buildStack(): void {
        const tiles = this._layout.tiles;
        const M = CFG.MOTION;

        const order: number[] = [];
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            // 牌宽用**这张牌自己的** w（L1 = 128、L2 起 = 85），不能用全局基准
            const view = new TileView(this._stackLayer, t.key, t.w);
            // A1/A2 改版（S16）：起始态 = **目标位置的正下方** + 横向微散 + 随机小角度
            //                    + 缩小（"还没长开"）+ 全透明。
            //
            // 【为什么在 build 期就摆好，而不是等 onEnter 再摆出去】
            // 页面是"先淡入、再播入场动画"的。如果这里仍把牌摆在自己的位置上、
            // 等到 onEnter 才挪到土里，玩家会看到"牌先在正确位置闪一帧，
            // 然后集体跳下去再长上来" —— 这是最典型的入场瑕疵。
            // 起始态必须在**它第一次被看见之前**就摆好。
            //
            // 【随机值也在这里定死】
            // playSproutMotion 会直接复用这个位置当起点（不再重新随机）。
            // 重新随机一次的后果是**起点跳变**：牌在可见的第一帧瞬移一下。
            //
            // ⚠️ **缩放也必须在 build 期设**（旧版飞入时可以留到 onEnter，
            //    那是因为起点在屏幕外 680px 处，看不见；现在起点就在牌堆正下方
            //    **画面里**，晚一帧设缩放就会看到"一堆大牌在下面闪一下"）。
            view.node.setPosition(
                t.x + (Math.random() * 2 - 1) * M.SPROUT_SPREAD_X,
                t.y - t.h * M.SPROUT_FROM_RATIO,
                0,
            );
            view.node.angle = (Math.random() * 2 - 1) * M.SPROUT_ANGLE;
            view.node.setScale(M.SPROUT_SCALE_FROM, M.SPROUT_SCALE_FROM, 1);
            MotionFx.setFade(view.node, 0);
            // 开局就把被压住的牌画成"灰"的：玩家一眼能看出哪些能点
            view.setState(this._blocked[i] > 0 ? 'dim' : 'normal');
            this._views.push(view);
            order.push(i);
        }

        // 深度升序 = 绘制顺序：后画的盖住先画的
        order.sort((a, b) => tiles[a].depth - tiles[b].depth);
        for (let s = 0; s < order.length; s++) {
            this._views[order[s]].node.setSiblingIndex(s);
        }
        this._depthOrder = order;

        // ⚠️ S16 起牌堆层**不再整体缩放 / 淡出**。
        //    入场改成逐张从土里长出来后，每张牌自己负责自己的淡入；
        //    如果这里还保留整体淡入，先冒出来的那几张会被"淡上再淡"，
        //    看起来比后面的牌更透明 —— 一条时间轴上出现两种淡入速度。
        //    （旧值 ENTER_SCALE_FROM / 整层 setFade(0) 已随之废弃。）
    }

    // ========================================================
    //  动效：入场（A1 / A2 / A3 / A4 / A5）
    // ========================================================
    /**
     * 入场总编排（S17 方案 B：底部涌现 + 借用抓大鹅的物理感）。
     *
     * 【用户原话 S16】"改成抓大鹅那种从底部涌现，就像蘑菇一样喷涌出来的方式，更有动感"
     * 【用户原话 S17】"你先去看抓大鹅的初始牌堆是如何出现的，理解透之后再与我沟通，
     *                  给出方案等我拍板" → 逐帧调研后用户拍板 **方案 B**
     *
     * 【抓大鹅实测 vs 本作诉求（证据：temp/S17-抓大鹅开局参考/）】
     * 抓大鹅是**从容器上方往下倒**的：物件很小地落下来、边落边变大、落点散乱不成行，
     * 先落的沉在底下 —— 所谓"自底向上"是**落体顺序**的结果，它的**运动方向是向下的**。
     * 而本作要的是**从底部涌出**，运动方向朝上。方向相反，所以只借它的**物理感**：
     *   · 节奏散乱   → 错峰改「随机成束」（不是整齐条带）
     *   · 由小变大   → 起始缩放 0.45
     *   · 落地有弹性 → 三段「挤压 → 回弹过冲 → 归位」
     *   · 整体慢下来 → 总时长 1.6s（实测抓大鹅 1.3~2.5s）
     *
     * 【时间轴】
     *   t=0          底部三件套滑入 + 槽格描边依次点亮（A3）
     *                顶部状态条下落淡入（A4）
     *   0 ~ 1.6s     牌按**随机成束**从"锅底"升上来（A1/A2 合并）：
     *                  · 束心随机撒（索引洗牌取前 N 个），每张牌归**最近**的束心
     *                  · 束的先后按**束心高度自下而上** —— 成束管"散"、排序管"方向"
     *                  · 位移与缩放写在同一条 tween（backOut 过冲 = "顶出来"）
     *                  · 旋转从随机角度归到这张牌自己的朝向（"顶正"与"冒出"是一件事）
     *                  · 落位「挤压 → 回弹过冲 → 归位」+ 落牌声（节流）
     *   末尾         首层可点牌做一次上浮提示（仅第 1 关，A5）
     *
     * 【为什么不再用"按屏幕 y 分带"（上一版的做法）】
     * 分带得到的是**整齐的水平条带**、一批一批往上顶，观感是"电梯上升 / 春笋冒头"；
     * 而抓大鹅的观感是**一撮一撮**地涌。所以换成"随机束心 + 就近归并"：
     * 得到的簇散落在牌堆各处、是不规则的小团，而不是横平竖直的条。
     * ⚠️ 绘制顺序（siblingIndex）仍然按深度排，这里只改**先后**，不动 z 序 ——
     *    两者混为一谈会让"谁压住谁"跟着入场顺序一起变，那才是真 bug。
     *
     * 【为什么入场期间仍然要锁输入】
     * 涌现过程中每张牌的位置都在变，而命中测试用的是**数据坐标**；
     * 这时候点下去，玩家点的是"他看见的位置"，判定却按落点算 —— 必然错位。
     * 锁 1.6 秒的代价，远小于"点了没反应 / 点错牌"的代价。
     * ⚠️ 解锁必须走 setTimeout（铁律），不能用 tween 回调。
     */
    private playSproutMotion(): void {
        const M = CFG.MOTION;
        const L = CFG.GAME_LAYOUT;
        const tiles = this._layout.tiles;
        const n = tiles.length;

        // ★ S18.4：涌现段的**整体时间缩放**。
        // 【为什么加这个旋钮】S18 起开局是「先开场（1.5s）→ 再涌现（1.6s）」的串行，
        // 玩家要等 3.1s。1.6s 的涌现是 S17 逐帧验收过的手感，**不能为了凑总时长
        // 去砍它的任何一个参数**（砍了手感就散了）；所以这里让所有**时序量**
        //（升程 / 束间距 / 束内铺开 / 落位回弹）统一乘以一个系数，
        // 形态与相对节奏一比一保留。默认 1.0（＝ S17 原手感），想加速只改 CFG 那一个数。
        const TS = M.SPROUT_TIME_SCALE;

        // ---------- A1 / A2：自下而上涌现（**随机成束**）----------
        // ① 随机挑"束心"：把索引洗牌后取前 bursts 个。
        //    【为什么是洗牌而不是"随机抽到不重复为止"】随机抽要处理重复、可能空转；
        //    洗牌是 O(bursts) 且**必然终止**（这是个"必然执行"路径，不能赌概率）。
        const bursts = Math.max(1, Math.min(M.SPROUT_BURST_MAX,
            Math.max(M.SPROUT_BURST_MIN, Math.ceil(n / M.SPROUT_BURST_SIZE))));
        const pickIdx: number[] = [];
        for (let i = 0; i < n; i++) pickIdx.push(i);
        const pick = Math.min(bursts, n);
        for (let i = 0; i < pick; i++) {
            const j = i + Math.floor(Math.random() * (n - i));
            const tmp = pickIdx[i]; pickIdx[i] = pickIdx[j]; pickIdx[j] = tmp;
        }
        const centers: Array<{ x: number; y: number }> = [];
        for (let b = 0; b < pick; b++) {
            centers.push({ x: tiles[pickIdx[b]].x, y: tiles[pickIdx[b]].y });
        }

        // ② 每张牌归**最近的束心**（欧氏距离）。
        //    束因此是"空间上抱团的一撮"，而不是"按屏幕 y 切出来的一条" ——
        //    这正是它与上一版"田垄"最大的差别：条带一定是横平竖直的，
        //    而随机束心 + 就近归并得到的簇，是散落在牌堆各处的小团。
        const burstOf: number[] = new Array(n);
        // 到**自身束心**的距离（待归一化）：束内按它铺开先后，
        // 让一束"从中心一小片一小片鼓出来"，而不是整团一次性弹起。
        const ringOf: number[] = new Array(n);
        let ringMax = 0;
        for (let i = 0; i < n; i++) {
            let best = 0;
            let bd = Infinity;
            for (let b = 0; b < centers.length; b++) {
                const dx = tiles[i].x - centers[b].x;
                const dy = tiles[i].y - centers[b].y;
                const d = dx * dx + dy * dy;
                if (d < bd) { bd = d; best = b; }
            }
            burstOf[i] = best;
            const dist = Math.sqrt(Math.max(0, bd));
            ringOf[i] = dist;
            if (dist > ringMax) ringMax = dist;
        }
        // 归一化到 0..1（所有牌都落在束心上时 ringMax=0，此时全部记 0，避免除以 0）
        if (ringMax > 0) {
            for (let i = 0; i < n; i++) ringOf[i] /= ringMax;
        }

        // ③ 束的先后按**束心高度自下而上**。
        //    "成束"管散、"排序"管方向，两件事分开管，才能既散乱又不丢"从下往上"。
        //    （如果连顺序也随机，整堆会变成一片没有方向的雪崩 —— 那是抓大鹅
        //      "从上方倒"的观感；本作要的是"从锅底顶上来"。）
        const burstRank: number[] = new Array(centers.length);
        {
            const seq: number[] = [];
            for (let b = 0; b < centers.length; b++) seq.push(b);
            seq.sort((a, b) => centers[a].y - centers[b].y);
            for (let i = 0; i < seq.length; i++) burstRank[seq[i]] = i;
        }

        // ④ 束间距预算：束数变多时**压缩束间距**，而不是把入场拖成 3 秒的等待。
        //    注意扣的是"整段"：单张升程 + 落位回弹 + 束内抖动 + 束内铺开，全都要占预算，
        //    否则实际结束时刻会超出 SPROUT_TOTAL_MAX（S17 第一版只扣了升程，实测 1.84s）。
        //  ⚠️ 先按**未缩放**的口径算 min()，最后才整体乘 TS ——
        //    两边同时缩放会让 min 比较失去意义（SPROUT_BURST_GAP 没缩、gapBudget 缩了）。
        const gapBudget = Math.max(0, M.SPROUT_TOTAL_MAX
            - M.SPROUT_IN - M.SPROUT_SQUASH
            - M.SPROUT_BURST_JITTER - M.SPROUT_BURST_RING);
        const burstGap = centers.length > 1
            ? Math.min(M.SPROUT_BURST_GAP, gapBudget / (centers.length - 1)) * TS
            : 0;

        for (let i = 0; i < n; i++) {
            const v = this._views[i];
            const t = tiles[i];
            if (!v || !v.node.isValid) continue;

            // 束内几乎同时冒，只留 ±jitter 的抖动 —— 同束齐步走会像"方阵"，
            // 完全不抖又会看到"一次冒一撮、中间空一拍"的机械感。
            // 再叠加 ring（到束心的距离）让一束从中心往外鼓开。
            const delay = Math.max(0, burstRank[burstOf[i]] * burstGap
                + ringOf[i] * M.SPROUT_BURST_RING * TS
                + (Math.random() * 2 - 1) * M.SPROUT_BURST_JITTER * TS);

            // 起点**不重新随机** —— 直接沿用 buildStack 里摆好的那个点。
            // 重新随机一次的后果是"起点跳变"：牌在它可见的第一帧瞬移一下。
            // ⚠️ 位移和缩放必须写在**同一次 to()**里：
            //    分两条 tween 抢 scale 会在交界处出现重叠帧；
            //    而共用同一个 tag 又会让后起的那条把先起的 stop 掉。
            MotionFx.to(v.node,
                { position: v3(t.x, t.y, 0), scale: v3(1, 1, 1) },
                { duration: M.SPROUT_IN * TS, delay, easing: EASE.POP, tag: TAG.STACK });
            // 旋转归位：与位移同长同期，视觉上"长正"和"冒头"是一件事。
            // ⚠️ 归的是**这张牌自己的目标朝向** t.angle（0/90/180/270 + 偏斜），不是 0 ——
            //    入场时牌带着随机小角度冒上来，落定必须回到它在牌堆里的摆放方向。
            // 用独立通道 TAG.SPIN —— 它和 TAG.STACK 改的是不同属性，
            // 共用一个 tag 只会互相打断（后起的把先起的 stop 掉）。
            MotionFx.to(v.node, { angle: t.angle },
                { duration: M.SPROUT_IN * TS, delay, easing: EASE.POP, tag: TAG.SPIN });
            // 淡入只占前半程的一小截（0.32）。后程必须完全不透明：
            // 牌在最后 280ms 是要被"看清是什么牌"的，那时还半透明就是废动作。
            // 【为什么从 0.45 收到 0.32】0.45 × 0.42s ≈ 190ms，一垄刚冒到一半还是半透明的
            // ——整堆看上去像一层雾。收到 0.32（≈135ms）之后，牌"顶出土"的瞬间就已经是实的。
            MotionFx.fade(v.node, 255, M.SPROUT_IN * 0.32 * TS,
                { delay, easing: EASE.ENTER, tag: TAG.FADE });

            // 落位挤压 + 落牌声：各自一个定时器（不走 tween 回调）
            setTimeout(() => this.onSproutLand(v, t.x, t.y, t.angle),
                MotionFx.unlockMs(delay + M.SPROUT_IN * TS));
        }
        // 末束起跳点 + 束内铺开 + 束内抖动 + 单张升程 + 落位回弹 = 整段结束时刻
        // ⚠️ burstGap 在上面已经是**缩放后**的值了，这里不能再乘一次 TS。
        const sproutDone = Math.max(0, centers.length - 1) * burstGap
            + (M.SPROUT_BURST_RING + M.SPROUT_BURST_JITTER
                + M.SPROUT_IN + M.SPROUT_SQUASH) * TS;

        // ---------- A3：底部（槽位条 / 暂存架 / 返回 / 重玩）滑入 + 槽格依次点亮 ----------
        // 只做"底部几件套"一起滑：单独滑槽位条会让暂存架悬在半空，
        // 那一帧的排版是错的（玩家会看到"东西错位了一下"）。
        // ★ S18.4：开场动画播过时不走这一段 —— "舞台"（页框 + 全部静态 HUD）
        //    已经在第 ⑥ 帧"墨圆裂开"时整体淡入过了；再来一次滑入等于同一件事讲两遍。
        const bottomNodes: Array<{ node: Node; y: number }> = [
            { node: this._slotBarNode, y: L.SLOT_BAR_Y },
            { node: this._tempRackNode, y: L.TEMP_RACK_Y },
            { node: this._tempLabelNode, y: L.TEMP_RACK_Y },
            { node: this._backBtnNode, y: L.BACK_BTN_Y },
            { node: this._replayBtnNode, y: L.REPLAY_BTN_Y },
        ];
        if (!this._introOn) {
            for (const b of bottomNodes) {
                if (!b.node || !b.node.isValid) continue;
                b.node.setPosition(b.node.position.x, b.y + M.SLOT_IN_FROM_Y, 0);
                MotionFx.to(b.node, { position: v3(b.node.position.x, b.y, 0) },
                    { duration: M.SLOT_IN, easing: EASE.POP, tag: TAG.ENTER });
            }
        }
        this.playSlotCellLightUp();

        // ---------- A4：顶部状态条下落淡入（与 A3 并行）----------
        // 同上：开场动画播过时跳过（HUD 已由第 ⑥ 帧整体淡入）。
        if (!this._introOn) {
            for (const item of this._hudItems) {
                if (!item.node || !item.node.isValid) continue;
                MotionFx.setFade(item.node, 0);
                item.node.setPosition(item.node.position.x, item.y + M.HUD_IN_FROM_Y, 0);
                MotionFx.to(item.node, { position: v3(item.node.position.x, item.y, 0) },
                    { duration: M.HUD_IN, easing: EASE.ENTER, tag: TAG.ENTER });
                MotionFx.fade(item.node, 255, M.HUD_IN, { easing: EASE.ENTER, tag: TAG.FADE });
            }
        }

        // ---------- 解锁输入 ----------
        // 取"最慢的一条 + 余量"：涌现、槽位滑入、HUD 下落里最长的那个。
        // 开场路径下底部/顶部的两段都没播，所以只剩"涌现"这一条在占时间。
        const total = this._introOn
            ? sproutDone
            : Math.max(sproutDone, M.SLOT_IN + M.SLOT_IN_STAGGER * this._slotCapacity, M.HUD_IN);        this._busy = true;
        setTimeout(() => {
            if (!this.node.isValid) return;
            // 兜底复位：无论动效链路是否正常，终值一定要写死到位。
            // 入场这里尤其关键 —— 一旦某条 tween 丢了，那张牌会**永久停在土里**
            // （这次起点就在画面内，比旧版"停在屏幕外"更容易被看见），
            // 表现为"这张牌凭空消失了"，而玩家完全不知道发生了什么。
            // 所以位置 / 缩放也要按数据复位，不能只复位角度与透明度。
            for (let i = 0; i < this._views.length; i++) {
                const v = this._views[i];
                const t = tiles[i];
                if (!v || !v.node.isValid || !t) continue;
                MotionFx.stopAll(v.node);
                MotionFx.setScale(v.node, 1);
                MotionFx.setFade(v.node, 255);
                v.node.angle = t.angle;
                v.node.setPosition(t.x, t.y, 0);
            }
            this._busy = false;
            this.playFirstHint();
        }, MotionFx.unlockMs(total));
    }

    /**
     * 单张牌冒头落定（涌现的收尾）：兜底复位 → 挤压 → 落牌声。
     *
     * 【为什么每张牌都要"兜底复位"】
     * 这个 setTimeout 是"必然执行"路径上的一环。哪怕位移补间因为任何原因
     * 没跑到终点，这里也会把牌写回精确坐标 —— 玩家永远不会看到一张
     * 卡在半路（这次是"卡在土里"）的牌。铁律的另一半：复位走定时器，不依赖 tween 回调。
     */
    private onSproutLand(v: TileView, x: number, y: number, angle: number): void {
        if (!this.node.isValid || !v.node.isValid) return;
        const M = CFG.MOTION;
        // 与涌现段同口径缩放（S18.4）
        const TS = M.SPROUT_TIME_SCALE;

        v.node.setPosition(x, y, 0);
        v.node.angle = angle;
        MotionFx.setFade(v.node, 255);
        MotionFx.setScale(v.node, 1);

        // 落位：**挤压 → 回弹过冲 → 归位** 三段。
        // 【为什么从两段加到三段】两段（压 → 直接回 1）的收尾是"啪"地贴平、没有余韵；
        // 抓大鹅的落地是**有弹性**的 —— 压扁之后先弹过一点，再慢慢收住。
        // 三段必须在**同一条 chain** 上跑：几条独立 tween 抢 scale 会在交界处
        // 出现重叠帧，真机上是一次肉眼可见的顿挫。
        MotionFx.chain(v.node, [
            { props: { scale: v3(M.SQUASH_X, M.SQUASH_Y, 1) },
              duration: M.SPROUT_SQUASH * 0.30 * TS, easing: EASE.EXIT },
            { props: { scale: v3(1, M.SPROUT_BOUNCE, 1) },
              duration: M.SPROUT_SQUASH * 0.35 * TS, easing: EASE.POP },
            { props: { scale: v3(1, 1, 1) },
              duration: M.SPROUT_SQUASH * 0.35 * TS, easing: EASE.ENTER },
        ], { tag: TAG.SLOT });

        // 落牌声。gapMs 放宽到 SPROUT_LAND_GAP_MS：
        // 96 张牌在 1 秒内冒头，不节流会糊成一段白噪声；
        // 错开到 110ms 一声才是"噗、噗、噗"的冒头感。
        AudioService.play('land', {
            gain: M.SPROUT_LAND_GAIN,
            gapMs: M.SPROUT_LAND_GAP_MS,
        });
    }

    /**
     * A3 的"槽格描边依次点亮"。
     *
     * 做法：为每一格临时叠一层**高亮描边**，按 SLOT_IN_STAGGER 依次亮起再收掉。
     * 为什么不直接改槽位条的描边：静态槽位条的描边是一条 Graphics 一次画完的，
     * 没法让"第 3 格的线"单独先亮 —— 要单独亮就得单独成节点。
     * 这些节点只在入场时存在，用完即销毁（它们不属于对象池的长租户）。
     */
    private playSlotCellLightUp(): void {
        const M = CFG.MOTION;
        const L = CFG.GAME_LAYOUT;
        const slotW = this.slotWidth();
        const cellH = L.SLOT_BAR_H - CFG.GAMEPLAY.SLOT_INSET_Y * 2;

        for (let i = 0; i < this._slotCapacity; i++) {
            const node = createNode(`SlotLight_${i}`, this._slotBarNode, {
                w: slotW, h: cellH, x: this.slotOffsetX(i), y: 0,
            });
            const g = node.addComponent(Graphics);
            strokeBox(g, 0, 0, slotW, cellH, CFG.SHAPE.RADIUS_SLOT, CFG.COLOR.VERMILION, 2.4);
            MotionFx.setFade(node, 0);
            const delay = i * M.SLOT_IN_STAGGER;
            MotionFx.fadeChain(node, [
                { to: 255, duration: M.TAP_UP, easing: EASE.ENTER },
                { to: 0, duration: M.SLOT_IN, easing: EASE.MOVE },
            ], { delay, tag: TAG.FX });
            // 纯装饰节点：动画走完即销毁。用 setTimeout 而不是 tween 回调 ——
            // 回调丢了这里只是漏一个空节点，但一旦把"清理"和"回调"绑在一起，
            // 工程里就会出现两种清理风格，后面的人一定会抄错那一种。
            setTimeout(() => { if (node.isValid) node.destroy(); },
                MotionFx.unlockMs(delay + M.SLOT_IN + M.TAP_UP));
        }
    }

    /**
     * A5 / E4：首层可点牌做一次 2px 上浮提示。
     *
     * 【为什么只做一次、且只在前几关做】
     * 提示的价值在"第一次不知道怎么玩"的那几秒。重复提示 = 噪音，
     * 而重复的**动态**提示尤其糟：玩家的视线会被反复拉回牌堆，
     * 反而没法安心规划。所以：只在第 1 关播一次，播完就再也不会出现。
     */
    private playFirstHint(): void {
        if (this._level.id !== 1) return;
        const M = CFG.MOTION;
        const pickable = pickableIds(this._layout.tiles, this._graph, this._taken);
        if (pickable.length === 0) return;

        // 只招呼前 N 张：全部一起动 = 整块板子在抖，不是提示
        const show = pickable.slice(0, M.HINT_MAX_TILES);
        show.forEach((id, k) => {
            const v = this._views[id];
            const t = this._layout.tiles[id];
            // ⚠️ 这里是 forEach 回调，不是 for 循环体：跳过必须用 return 而不是 continue
            if (!v || !v.node.isValid) return;
            const delay = k * M.HINT_STAGGER;
            // 上 → 下 一条链：单程 sineInOut 的速度两端为零，
            // 所以"上去再下来"接在一起时中间没有顿点，像呼吸而不是像抖动。
            MotionFx.to2(v.node,
                { props: { position: v3(t.x, t.y + M.HINT_LIFT, 0) }, duration: M.HINT, easing: EASE.IDLE },
                { props: { position: v3(t.x, t.y, 0) }, duration: M.HINT, easing: EASE.IDLE },
                { tag: TAG.STACK, delay });
        });
    }

    // ========================================================
    //  交互：统一命中测试
    // ========================================================
    /**
     * B1 触摸按下：牌**立刻**放大到 1.08 并上抬 3px。
     *
     * 【为什么必须在 TOUCH_START 而不是 TOUCH_END】
     * 这是"手感"里唯一一条不能商量的：人对"我按到了"的判定发生在手指落下的
     * 那一瞬间，超过 ~80ms 没有反馈就会被读成"这点不动"。
     * 而 TOUCH_END 要等抬手，抬手本身就有几十到几百毫秒的随机延迟 ——
     * 反馈的不确定性比反馈的幅度更伤人。
     *
     * 【S12.1：按下由"缩小"改成"放大"】
     * 用户原话：「点击时可以增加微微放大，给人点击的手感」。
     * 另外还有一层原因：多层牌堆里"牌缩小"会被读成"牌变小了、是不是被拿走了"，
     * 而"放大 + 上抬"只有一个意思 —— 这张牌被拈起来了。
     * ⚠️ 上抬方向由 PRESS_DY 决定（负 = 向上）。原来的 TAP_DOWN_DY 是**下压**，
     *    语义相反，二者不能混用；道具按钮仍用下压那一组（见 setPropBar）。
     */
    private onTouchStart(e: EventTouch): void {
        if (this._over || this._modal || this._busy || this._armedRemove) return;

        const uiPos = e.getUILocation();
        const local = this.ui.convertToNodeSpaceAR(v3(uiPos.x, uiPos.y, 0));

        const id = this.hitStackTile(local);
        if (id < 0) return;
        // 被压住的牌**不给**按压反馈：它按下去是有反应的，但那反应是
        // "你点错了"（B6 的抖动），如果这里也缩一下，玩家会以为它能点。
        if (this._blocked[id] > 0) return;

        const t = this._layout.tiles[id];
        const v = this._views[id];
        if (!v || !v.node.isValid) return;

        this._pressedId = id;
        // 按下即出声 + 轻震（B1 的听觉/触觉分身）。
        // 【为什么同样放在 TOUCH_START】与按压动画的理由完全一致：
        // 人对"我摸到了它"的判定发生在手指落下那一瞬间，
        // 声音和震动晚 80ms 到达，感官上就已经是"另一件事"了。
        AudioService.play('tap');
        Haptics.light();
        const M = CFG.MOTION;
        MotionFx.to(v.node,
            { position: v3(t.x, t.y + M.PRESS_DY, 0),
              scale: v3(M.PRESS_SCALE, M.PRESS_SCALE, 1) },
            { duration: M.TAP_DOWN, easing: EASE.MOVE, tag: TAG.PRESS });
    }

    /** 手指滑出 / 被打断：把按压态还回去，否则会留下一张永远缩着的牌 */
    private onTouchCancel(): void {
        this.releasePressed();
    }

    /**
     * 松开"被按住的那一张"。
     * ⚠️ 只动**被按下的那一张**（_pressedId），绝不遍历全牌堆做"谁的缩放不对就复位"——
     *    那种写法会在洗牌（牌全部缩到 0.86）时把整堆牌误判成"处于按压态"，
     *    于是一次滑出就把洗牌动画整个拍平。
     */
    private releasePressed(): void {
        const id = this._pressedId;
        this._pressedId = -1;
        if (id < 0 || this._taken[id]) return;
        const v = this._views[id];
        const t = this._layout.tiles[id];
        if (!v || !v.node.isValid || !t) return;
        MotionFx.stop(v.node, TAG.PRESS);
        MotionFx.to(v.node,
            { position: v3(t.x, t.y, 0), scale: v3(1, 1, 1) },
            { duration: CFG.MOTION.TAP_UP, easing: EASE.MOVE, tag: TAG.STACK });
    }

    private onTap(e: EventTouch): void {
        const uiPos = e.getUILocation();
        const local = this.ui.convertToNodeSpaceAR(v3(uiPos.x, uiPos.y, 0));

        // ---------- B7 取消选中：必须在 _busy 判断**之前** ----------
        // 牌在飞行途中被再次点击 = 撤回这次选择（"点错了"的唯一救济）。
        // 它必须绕过早退，因为飞行本身就是 _busy 的来源 ——
        // 一个被锁住的输入通道恰好是"取消"这种反向操作最需要的那条通道。
        if (this._pending && this.hitPending(local)) {
            this.cancelPick();
            return;
        }

        // ⚠️ S12.1：这里**不再**一刀切 `if (this._busy) return`。
        //    原来这一行就是"点了没反应"的源头：手快的人连点两张，第二张凭空消失。
        //    现在改成"只有**牌堆上**的点击进输入缓冲（见 ③），其余途径照旧直接忽略"——
        //    暂存取回、消除就绪态本来就依赖槽位状态，缓冲它们只会把状态搅乱。
        if (this._over || this._modal) return;

        // 「消除」就绪时，本页进入"只认槽内牌"的子模式
        if (this._armedRemove) {
            if (this._busy) return;
            const hit = this.hitSlotOrTemp(local);
            if (hit && hit.where === 'slot') {
                this.applyRemoveSlot(hit.index);
            } else if (hit && hit.where === 'temp') {
                toast(this.root, '暂存区里的牌不能直接消除', 1.4);
            } else {
                toast(this.root, '点槽里任意一张，同牌面的 3 张会一起消掉', 1.4);
            }
            return;
        }

        // ① 先看暂存架（它在槽位条上方，可能与飞行动画重叠，优先响应）
        const tempHit = this.hitSlotOrTemp(local);
        if (tempHit) {
            if (tempHit.where === 'temp' && !this._busy) this.takeFromTemp(tempHit.index);
            return;
        }

        // ② 从上往下扫：一次点击只认最上面那张
        const id = this.hitStackTile(local);
        if (id < 0) return;

        if (this._blocked[id] > 0) {
            // B6：命中的是被压住的牌 → **必须给出拒绝反馈**。
            // 不"穿透"去找下面那张 —— 玩家点的是他看见的那张。
            // 但"点了没反应"是绝对不能接受的：玩家会以为游戏卡了。
            // ⚠️ 忙的时候不抖：这一下本来就该被拒，再叠一个抖会与正在播的
            //    消除动效抢注意力；而且它**不该进输入缓冲** —— 它不是"丢掉的点击"，
            //    它是"点错了"，稍后补做等于把错误的手势执行了一遍。
            if (!this._busy) this.rejectBlocked(id);
            return;
        }

        // ③ ★ S12.1 输入缓冲：忙 → **记下来**（而不是丢掉），解锁后补做。
        //    只缓冲牌堆上的点击（见上面 onTap 开头那段说明）。
        if (this._busy) {
            this._buffered = id;
            if (CFG.DEBUG.LOG_STATE) {
                log(`[GamePage] 输入缓冲：id=${id} 暂时忙，等解锁后补做`);
            }
            return;
        }
        this.pickTile(id);
    }

    /**
     * ★ S12.1：把输入缓冲里那一次点击补做掉。
     *
     * 【为什么必须先重新校验，不能照单执行】
     * 从"记下这一下"到"补做"之间隔着 150ms 左右，期间局面可能已经变了：
     *   · 那张牌被别的途径拿走（B7 撤回、道具、洗牌）；
     *   · 那张牌被**压住**了（比如它上面那张刚被放回去）。
     * 照单执行就会凭空多占一个槽位 —— 严重时直接误判"槽满"判负。
     * 所以这里把 onTap 里那两道校验**原样重做**一遍。
     */
    private drainBufferedPick(): void {
        const id = this._buffered;
        if (id === null || id < 0) return;

        // 【第一类：上下文已失效 → 丢弃】结算 / 弹窗 / 移出待点 / 页面销毁，
        // 都说明"这一下"已经不属于当前情境了，留着它只是祸根。
        if (!this.node.isValid || this._over || this._modal || this._armedRemove) {
            this._buffered = null;
            return;
        }
        // 【第二类：还忙 → 留着】正常情况下 drainBufferedPick 是在 _busy 归零
        // 之后才被调的，走不到这里；但万一被别处提前唤起，这一下点击应该被
        // **保留**而不是吞掉 —— 吞掉就等于玩家白点了一次。
        if (this._busy) return;

        // 【第三类：牌没了 / 被压住了 → 丢弃】照单执行会凭空多占一个槽位。
        this._buffered = null;
        if (this._taken[id] || this._blocked[id] > 0) {
            if (CFG.DEBUG.LOG_STATE) {
                log(`[GamePage] 输入缓冲作废：id=${id}`
                    + `（taken=${this._taken[id] ? 1 : 0} blocked=${this._blocked[id] || 0}）`);
            }
            return;
        }
        this.pickTile(id);
    }

    /**
     * 牌堆命中测试：从上往下扫，一次点击只认最上面那张。
     * 抽成独立方法是因为它现在有三个调用方（TOUCH_START / TOUCH_END / 取消判定），
     * 三处各写一遍必然会出现"某一处忘了跳过已拿走的牌"这种错位 bug。
     * @returns 命中的牌 id；-1 = 没命中
     */
    private hitStackTile(local: Vec3): number {
        const tiles = this._layout.tiles;
        for (let k = this._depthOrder.length - 1; k >= 0; k--) {
            const id = this._depthOrder[k];
            if (this._taken[id]) continue;
            const t = tiles[id];
            // ★ S15.3：命中区 = 这张牌**旋转后的真实矩形**，不是它的轴对齐包围盒。
            // 旧版用 AABB 判：那在"只有 0/90/180/270"时误差可接受（退化成正矩形），
            // 但牌能歪到 45° 之后，AABB 的四角是**牌根本没画到**的空白 ——
            // 玩家点在空白角上会选中这张牌，而视觉上那里明明是另一张。
            if (!pointInTile(t, local.x, local.y)) continue;
            return id;
        }
        return -1;
    }

    /**
     * 命中"正在选中 / 飞行"的那张牌？
     * 判定用的是它的**原始矩形**（ox/oy）而不是节点当前位置 ——
     * 牌飞出去之后仍然要能"按原地"把它点回来，这是玩家对撤销的直觉。
     */
    private hitPending(local: Vec3): boolean {
        const p = this._pending;
        if (!p) return false;
        // ★ S15.3：同样走"旋转后的真实矩形"，不是轴对齐包围盒。
        // 牌现在还能歪到 45°，拿 AABB 去判会让"撤销"在牌的空角落上误触发。
        const t = this._layout.tiles[p.id];
        if (!t) {
            return Math.abs(local.x - p.ox) <= CFG.TILE.W / 2
                && Math.abs(local.y - p.oy) <= CFG.TILE.H / 2;
        }
        return pointInRect(local.x, local.y, p.ox, p.oy, t.w, t.h, t.angle);
    }

    /** 命中槽内 / 暂存架里的牌？ */
    private hitSlotOrTemp(local: Vec3): { where: 'slot' | 'temp'; index: number } | null {
        const L = CFG.GAME_LAYOUT;
        const slotW = this.slotWidth();
        const cellH = L.SLOT_BAR_H - CFG.GAMEPLAY.SLOT_INSET_Y * 2;
        for (let i = 0; i < this._slots.length; i++) {
            const cx = this.slotOffsetX(i);
            if (Math.abs(local.x - cx) <= slotW / 2 && Math.abs(local.y - L.SLOT_BAR_Y) <= cellH / 2) {
                return { where: 'slot', index: i };
            }
        }
        for (let i = 0; i < this._temp.length; i++) {
            const cx = this.tempOffsetX(i);
            if (Math.abs(local.x - cx) <= L.TEMP_SLOT_W / 2
                && Math.abs(local.y - L.TEMP_RACK_Y) <= L.TEMP_RACK_H / 2) {
                return { where: 'temp', index: i };
            }
        }
        return null;
    }

    /**
     * B6 拒绝反馈：点到被压住的牌 → 原地左右抖动两下 + 亮度压暗 15%。
     *
     * 【曲线为什么是 sineOut 而不是 backOut】
     * backOut 结尾会"过冲一下再回来"，那个过冲在玩家眼里是**弹性**，
     * 会被读成"这东西是可以动的、只是我力度不够"。拒绝反馈的曲线必须
     * 单调收敛到静止，sineOut 正好"起步快、收尾稳"，摇完就停，不带任何暗示。
     *
     * 【亮度为什么用整牌透明度近似】
     * 牌面是 Graphics + Label 一次性画出来的矢量图，没有"整体亮度"这个通道。
     * 加一层黑色蒙版会引入一个新节点（每张牌一个，牌堆里就是 24 个），
     * 代价远大于收益。降透明度在视觉上等价于"这牌暗下去了"，
     * 而且它天然接得上"被压住 = 本来就更暗"的既有语义。
     */
    private rejectBlocked(id: number): void {
        const view = this._views[id];
        if (!view || !view.node.isValid) return;
        const M = CFG.MOTION;
        // 拒绝反馈也要有声音，但**不震**：
        // 震动是"你做对了"的正向信号，误操作时震一下等于在肯定错误操作。
        AudioService.play('reject');
        const t = this._layout.tiles[id];
        const x = t.x;
        const y = t.y;

        // 一条链走完四个动作（严格的顺序保证，段间不会有重叠帧）：
        //   0 → +3 → -3 → +3 → 0
        // 「±3px 两下」= 两次往返；结尾一定回到 0，否则牌会永久歪着。
        const seg = M.REJECT_DURATION / 4;
        const s = M.REJECT_SHAKE;
        this._pressedId = -1;
        MotionFx.stop(view.node, TAG.STACK);
        MotionFx.stop(view.node, TAG.PRESS);
        MotionFx.stop(view.node, TAG.FX);
        view.node.setScale(1, 1, 1);
        MotionFx.chain(view.node, [
            { props: { position: v3(x + s, y, 0) }, duration: seg, easing: EASE.REJECT },
            { props: { position: v3(x - s, y, 0) }, duration: seg, easing: EASE.REJECT },
            { props: { position: v3(x + s, y, 0) }, duration: seg, easing: EASE.REJECT },
            { props: { position: v3(x, y, 0) }, duration: seg, easing: EASE.REJECT },
        ], { tag: TAG.STACK });

        // 亮度压暗（以当前透明度为基准往下降 15%，再回来）
        const op = view.node.getComponent(UIOpacity);
        if (op) {
            const base = op.opacity;
            const dim = Math.round(base * (1 - M.REJECT_DIM));
            MotionFx.fadeChain(view.node, [
                { to: dim, duration: seg * 2, easing: EASE.REJECT },
                { to: base, duration: seg * 3, easing: EASE.REJECT },
            ], { tag: TAG.FX });
        }
    }

    /**
     * B5 的插入位：找到"最后一张同牌面"的后面。
     *
     * 【为什么必须先聚拢、后判定消除】
     * 3 张相同的牌如果不相邻，玩家看到的是"我明明凑齐了，槽里却东一张西一张"，
     * 消除的因果感会断掉。先把它们推到相邻，再一起消 ——
     * 玩家看到的是一条完整的因果链："我把第 3 张放进去 → 三张凑到一起 → 消掉"。
     * 顺序反过来的话，中间会出现"三张还在各处、却已经开始消失"的错帧。
     */
    private insertIndexFor(key: PatternKey): number {
        let last = -1;
        for (let i = 0; i < this._slots.length; i++) {
            if (this._slots[i].key === key) last = i;
        }
        return last < 0 ? this._slots.length : last + 1;
    }

    /**
     * 拿起一张牌 → B2 选中 → B3 飞入槽位 → B4 落位压感 → B5 同类聚拢 → 判定。
     *
     * 【时序为什么是"选中 180ms 之后才起飞"】
     * 这是本作手感里最有争议的一处取舍，理由写在这里，免得后人以为漏了优化：
     *   · 直接起飞（把选中与飞行做成一条曲线）会让"我选中了一张牌"这件事
     *     完全没有存在感 —— 牌一眨眼就没了，玩家要回头去槽里确认自己点的是哪张；
     *   · 加这 180ms 的顿挫，玩家的眼睛能完成"按下的牌 → 抬起来的牌 → 飞走的牌"
     *     这条因果链，之后他不需要再确认，视线可以直接跟到槽位。
     *   代价是每张牌多 180ms（整局最多多 4 秒）。这个代价换来的是"从容"，
     *   而"从容"恰恰是消除类游戏留人的东西。
     */
    private pickTile(id: number): void {
        const t = this._layout.tiles[id];
        const view = this._views[id];
        const M = CFG.MOTION;

        // ① 数据先行：标记拿走 + 增量更新遮挡计数
        this._taken[id] = true;
        this._left--;
        for (const j of this._graph.below[id]) {
            this._blocked[j]--;
            if (this._blocked[j] === 0 && !this._taken[j]) {
                // 刚被解锁 → 从灰变亮。这才是"层层揭开"的反馈来源
                this._views[j].setState('normal');
            }
        }

        // ② 停掉这张牌身上所有在改 position / scale 的动效。
        //    ⚠️ tag 只能保证**同通道**互斥，按压（PRESS）、提示（STACK）、
        //      洗牌铺开（SLOT）是三条不同通道，都会和飞行抢 scale/position，
        //      所以这里必须显式全停 —— 漏一条就是"飞着飞着抖一下"。
        this._pressedId = -1;
        MotionFx.stop(view.node, TAG.PRESS);
        MotionFx.stop(view.node, TAG.STACK);
        MotionFx.stop(view.node, TAG.SLOT);
        // 也要停掉"被压住时被拒绝"的那条压暗动效，否则它会继续往透明度上写值，
        // 把正在飞的牌调成半透明（而 setState 刚把它恢复成不透明）
        MotionFx.stop(view.node, TAG.FX);

        // ③ 起飞点用**当前视觉位置**（世界坐标换算），而不是数据坐标：
        //    牌可能正停在提示呼吸的半途、或洗牌铺开的中间，
        //    以数据坐标为起点会让它"瞬移回原位再起飞"。
        const worldFrom = MotionFx.worldPosOf(view.node);
        // ④ 换成特效层的子节点，让飞行物压在槽位条 / 暂存架之上。
        //    靠的是世界坐标换算，而不是"两层原点恰好重合"这个巧合 ——
        //    后者一旦被某次改版打破，所有飞牌会集体飞出屏幕，且不留任何报错。
        const fromFx = MotionFx.worldToLocal(this._fxLayer, worldFrom);
        view.node.setParent(this._fxLayer);
        view.node.setPosition(fromFx);
        view.node.setSiblingIndex(this._fxLayer.children.length - 1);

        // ⑤ B5 的插入位 + 落点（槽位层局部坐标）
        const insertAt = this.insertIndexFor(t.key);
        const targetSlot = this.slotPos(insertAt);
        // 飞行用的落点要换算到特效层局部坐标；落地时再用槽位层局部坐标写回去
        const targetFx = MotionFx.between(this._slotLayer, this._fxLayer, targetSlot);
        const scale = this.slotScale();
        const flySec = MotionFx.moveDuration(fromFx, targetFx);

        this._busy = true;
        this._pending = { id, view, ox: t.x, oy: t.y };

        // 拿牌时间轴（自动化排障用）。把"从点击到落位到底要多久"打出来 ——
        // 这个数直接决定"玩家点完多久能再点下一张"，也决定 B7 撤回窗口有多宽。
        // 实测踩过的坑：这个值一旦超过玩家两次点击的间隔，
        // 就会退化成「点一下、撤回一下」的死循环，而现象完全看不出是时长问题。
        if (CFG.DEBUG.LOG_STATE) {
            log(`[GamePage] 拿牌 id=${id} ${t.key}@${Math.round(t.x)},${Math.round(t.y)}`
                + ` 起飞延迟 ${Math.round(M.PICK_SELECT * 1000)}ms + 飞行 ${Math.round(flySec * 1000)}ms`
                + ` → 落位倒计时 ${Math.round(MotionFx.unlockMs(M.PICK_SELECT + flySec))}ms`);
        }

        // 起飞音：'pick' 是"呲"的一声上行扫频，对应"牌离手"这个动作。
        // 它和落位音 'land'（"咔"）是一对，两者相隔一次飞行的时间（约 300ms），
        // 听觉上正好是"呲——咔"，把"离手→到位"这条因果链补全。
        AudioService.play('pick');

        // ⑥ B2 选中：上浮 + 放大 + 朱红描边到 3px（描边由 TileView 的 pick 态绘制）
        view.setState('pick');
        // ⑦ B3 飞行
        if (M.PICK_SELECT > 0) {
            // 两段式起飞（S7.5 的做法）。PICK_SELECT 归零后这条不再走，
            // 但**保留分支**：把它调回 > 0 就能一键回退，也方便做 A/B 对比。
            // 代价就是那 180ms：牌在原地只上浮 6px、位置几乎不动，人眼读成"卡住"。
            MotionFx.to2(view.node,
                { props: { position: v3(fromFx.x, fromFx.y + M.PICK_LIFT, 0),
                           scale: v3(M.PICK_SCALE, M.PICK_SCALE, 1) },
                  duration: M.PICK_SELECT, easing: EASE.POP },
                { props: { position: targetFx, scale: v3(scale, scale, 1) },
                  duration: flySec, easing: EASE.FLY },
                { tag: TAG.FLY });
        } else {
            // ★ S12.1：**当帧起飞**。
            // 起点不用在这里再摆一次 —— 上面第 ② 步已经 `stop(TAG.PRESS)`，
            // 而 `fromFx` 是在 stop **之后**用 `worldPosOf` 读的，
            // 所以按下时那个"放大到 1.08 + 上抬 3px"的样子原样成了飞行起点。
            // （位置与缩放是同一个通道，两条 tween 同时写会打架 —— 这也是
            //   第 ② 步必须显式 stop 掉 PRESS 的原因，不是可选项。）
            // 曲线用 EASE_FLY（quadIn，越飞越快），不是 EASE_MOVE（quadOut，
            // 末段减速会读成"小心翼翼地贴上去"，那正是"不丝滑"的来源之一）。
            MotionFx.to(view.node,
                { position: targetFx, scale: v3(scale, scale, 1) },
                { duration: flySec, easing: EASE.FLY, tag: TAG.FLY });
        }

        // ⑦b 顺手把牌"理顺"（2026-10-01 需求 #1）
        //     牌堆里是四向随机的（可能横躺 90°、倒立 180°），而槽位是玩家的
        //     **信息区** —— 玩家要拿它判断"我手里有什么、还差哪张"，只许好读。
        //     所以入槽一律摆正（CFG.STACK.SLOT_KEEP_ANGLE = false）。
        //
        //     ⚠️ 旋转放在**飞行段**，不是落位那一帧。落位瞬间直接改角度会表现为
        //        "啪"地翻一下，看起来像渲染错帧；放进飞行里读起来是"被理顺了"，
        //        这也正是这个开关的代价被接受的原因（见 CFG 里的说明）。
        //     ⚠️ 走**最短转向**。Cocos 的 `angle` 是顺时针度数且不会自己取模，
        //        270 → 0 若直连，牌会逆时针空转 270°（约 0.3 秒里转四分之三圈，
        //        像被甩出去的）。改写成 270 → 360（落点朝向与 0 完全等价）。
        //     ⚠️ 用独立 tag（SPIN），与位移 tween 改的不是同一个属性，互不干扰。
        //     ⚠️ 已经正了的牌不建 tween：L1 教学关牌本来就正（upright），
        //        多建一条 0→0 的空动画纯属浪费（12 张牌就是 12 条）。
        {
            const cur = view.node.angle;
            const aim = this.slotAngleOf(id);
            // 归一化到 (-180, 180]，得到最短转向量
            const delta = ((aim - cur) % 360 + 540) % 360 - 180;
            if (Math.abs(delta) > 0.01) {
                MotionFx.to(view.node, { angle: cur + delta },
                    { duration: flySec, easing: EASE.MOVE, tag: TAG.SPIN });
            }
        }

        // ⑧ 状态流转用定时器（铁律：绝不用 tween 回调驱动状态）
        setTimeout(() => {
            if (!this.node.isValid) return;   // 页面已销毁，整页都在回收，不必留痕
            // ⚠️ 归属校验：这次落位必须仍属于"当前正在进行的这一次拿牌"。
            //    飞行窗口有 PICK_SELECT + flySec（约 380ms），玩家完全来得及
            //    在这段时间里再点一次同一张牌触发 B7 取消 —— cancelPick 会把
            //    `_pending` 清空，并把 `_taken[id]` 还原成 false、`_left++`。
            //    若这里不校验就继续落位，这张牌会**同时**处于"场上"与"槽内"：
            //      · 槽位占用虚增 → 可能误判"槽满"直接判负；
            //      · `_left` 虚高 → 本关的已清数永远到不了满值，通不了关。
            //    归属不符就直接放弃落位（锁与挂起态此时已由取消方处理妥当）。
            //
            //  【为什么放弃时要打一条日志 —— 这条是拿真实事故换来的】
            //  下面两道 return 一旦命中，后果都是"牌停在空中、永不落槽"。
            //  而它的**外在表现与原因完全对不上**：下一次点击会被 B7 判成
            //  "点错了、撤回"（打出"取消选中"），于是现象是「点一下闪一下、
            //  永远进不去槽」的死循环，日志里只有一条条"取消选中"，
            //  真正拦下它的那一道校验一个字都不说 —— 排查成本极高。
            //  自动化实测踩过：30 次点击、15 次"取消选中"、状态零变化，
            //  光看日志完全定位不到原因。所以两道关都要自报家门。
            if (!this._pending || this._pending.id !== id) {
                if (CFG.DEBUG.LOG_STATE) {
                    log(`[GamePage] 落位放弃 id=${id}：挂起态已不属于本次拿牌`
                        + `（_pending=${this._pending ? this._pending.id : 'null'}）`);
                }
                return;
            }
            if (!view.node.isValid) {
                if (CFG.DEBUG.LOG_STATE) {
                    log(`[GamePage] 落位放弃 id=${id}：视图节点已失效，按数据原样还原`);
                }
                // 视图失效但页面还在。这里不仅要收掉挂起态与锁（否则 `_busy`
                // 永久为 true → 整局死锁），还必须把 pickTile ① 步**已经改过的数据
                // 原样还原**：那张牌此刻在数据上是"已被拿走"，不还原就会凭空少一张
                // （`_left` 虚低 → 本关的已清数永远到不了满值）。
                // 还原逻辑与 cancelPick 严格对称，只是省掉了节点操作。
                this._pending = null;
                this._taken[id] = false;
                this._left++;
                for (const j of this._graph.below[id]) {
                    this._blocked[j]++;
                    if (this._blocked[j] === 1 && !this._taken[j]
                        && this._views[j].node.isValid) {
                        this._views[j].setState('dim');
                    }
                }
                this._busy = false;
                this.refreshHud();
                this.logPickable();
                return;
            }
            this.landTile(view, id, t.key, insertAt, targetSlot, scale);
        }, MotionFx.unlockMs(M.PICK_SELECT + flySec));
    }

    /**
     * 牌落地：换回槽位层 → B4 落位压感 → B5 聚拢 → 过 SHIFT_PER_SLOT 后判定消除。
     */
    private landTile(
        view: TileView, id: number, key: PatternKey,
        insertAt: number, targetSlot: Vec3, scale: number,
    ): void {
        const M = CFG.MOTION;

        // ① 兜底复位到精确落点（动效链路万一出问题，位置也一定是对的）
        view.node.setParent(this._slotLayer);
        view.node.setPosition(targetSlot);
        view.node.setSiblingIndex(this._slotLayer.children.length - 1);
        // 朝向：入槽后是否保留原朝向由 CFG.STACK.SLOT_KEEP_ANGLE 决定。
        // 这里必须是"兜底赋值"而不是等某条 tween 收敛 —— 飞行链路的最后一帧
        // 若因故没跑到，牌就会顶着飞行途中的旋转角停在槽里，且日志里毫无痕迹。
        view.node.angle = this.slotAngleOf(id);
        view.setState('normal');   // 选中描边到此收掉
        this._pending = null;

        if (CFG.DEBUG.LOG_STATE) {
            log(`[GamePage] 落位 id=${id} → 槽 #${insertAt}（当前槽 ${this._slots.length}）`);
        }

        this._slots.splice(insertAt, 0, { id, key, view });

        // 落位音（'land'：闷一点的"咔"）。与落位压感同帧发声 ——
        // 声音和视觉挤压必须对齐，差 1~2 帧就会觉得"声音飘"。
        AudioService.play('land');

        // ② B5 聚拢：已有牌让位，让同牌面的三张相邻。
        //    ⚠️ 必须**先聚拢、后消除**：顺序反了会出现"三张还在各处却已开始消失"的错帧。
        this.relayoutSlots(view.node);

        // ③ B4 落位压感（squash & stretch）：横向一撑、纵向一压，再回到正常
        MotionFx.to2(view.node,
            { props: { scale: v3(scale * M.SQUASH_X, scale * M.SQUASH_Y, 1) },
              duration: M.SNAP * 0.35, easing: EASE.POP },
            { props: { scale: v3(scale, scale, 1) },
              duration: M.SNAP * 0.65, easing: EASE.ENTER },
            { tag: TAG.SLOT });

        this.refreshSlotWarn();
        this.logPickable();

        // ④ ★ S12.1：解锁提前到落位**当帧**。
        //    改之前是"聚拢走完（SHIFT_PER_SLOT = 90ms）才解锁"，那 90ms 纯属白等 ——
        //    聚拢做的是"槽里已有的牌让位"，它跟"能不能点下一张"没有任何关系，
        //    把它算进锁的窗口只会让手感变钝。
        //    `_busy` 从此只覆盖"这次拿牌真正在飞的那段时间"（MOVE_MIN ~ MOVE_MAX = 90~140ms）。
        this._busy = false;

        // ⑤ 判定仍然**延后**到聚拢结束 —— 那一步需要的是"槽位已经排好序"，
        //    而不是"输入被锁住"。把这两件事拆开，是这一版手感的关键。
        //    ⚠️ 补做输入缓冲必须放在 afterInsert **之后**：afterInsert 可能触发消除
        //    （消除会 splice `_slots`），在它之前发起下一次拿牌，算出来的插入位是过期的。
        setTimeout(() => {
            if (!this.node.isValid) return;
            this.afterInsert(insertAt);
            this.drainBufferedPick();
        }, MotionFx.unlockMs(M.SHIFT_PER_SLOT));
    }

    /**
     * B7 取消选中：把正在飞行（或刚被选中）的牌**原路退回**牌堆。
     *
     * 【为什么要做这个功能】
     * 消除类游戏最挫败的一刻是"手滑点错了一张，整局的规划全废"。
     * 飞行只有 300ms 左右，在这个窗口里允许反悔，成本极低（一条 tween 的反向），
     * 但它把"手滑"从"灾难"降级成"无感"。
     *
     * 【为什么必须把遮挡计数一并还原】
     * pickTile 里对被解锁的牌做了 `_blocked[j]--` 并改了它们的颜色。
     * 取消时如果不加回去，那些牌会永远停在"可点"的亮色上，而实际上被压着 ——
     * 玩家点了却发现点不动，那比不让他撤销还糟。
     */
    private cancelPick(): void {
        const p = this._pending;
        if (!p) return;
        this._pending = null;

        const view = p.view;
        const id = p.id;
        const t = this._layout.tiles[id];

        MotionFx.stop(view.node, TAG.FLY);
        MotionFx.stop(view.node, TAG.SELECT);
        MotionFx.stop(view.node, TAG.SLOT);
        MotionFx.stop(view.node, TAG.PRESS);
        MotionFx.stop(view.node, TAG.STACK);

        // 数据还原：如果已经入槽就摘出来
        const at = this._slots.findIndex((s) => s.id === id);
        if (at >= 0) this._slots.splice(at, 1);

        // 遮挡计数还原（与 pickTile 里的自减严格对称）
        this._taken[id] = false;
        this._left++;
        for (const j of this._graph.below[id]) {
            this._blocked[j]++;
            if (this._blocked[j] === 1 && !this._taken[j] && this._views[j].node.isValid) {
                this._views[j].setState('dim');
            }
        }

        // 视图还原：换回牌堆层并落回原坐标
        const back = MotionFx.between(view.node.parent, this._stackLayer, view.node.position);
        view.node.setParent(this._stackLayer);
        view.node.setPosition(back);
        view.setState('normal');
        MotionFx.to(view.node,
            { position: v3(t.x, t.y, 0), scale: v3(1, 1, 1), angle: t.angle },
            { duration: CFG.MOTION.TAP_UP, easing: EASE.MOVE, tag: TAG.STACK });

        this._busy = false;
        this.relayoutSlots();
        this.refreshSlotWarn();
        this.logPickable();
        this.refreshHud();
        this.refreshPropBar();
        // 取消选中用最轻的 'tap'："收回去了"是一件不需要被强调的事 ——
        // 用和"拒绝"一样的低音会让玩家以为自己做错了什么。
        AudioService.play('tap');
        log(`[GamePage] 取消选中 ${t.key}@${Math.round(t.x)},${Math.round(t.y)}`);
    }

    /** 入槽之后：判定消除 → 重排 → 判胜负 */
    private afterInsert(newestIndex: number): void {
        const keys = this._slots.map((s) => s.key);
        const m = findMatch(keys, this._level.gang, newestIndex);

        if (m) {
            this.playClear(m);
            return;
        }

        // ★ 没消成，但**场上已经空了** → 直接通关（S7.9 新口径）。
        //   这一条**必须排在"槽满"之前**：点下最后一张牌时它可能同时让槽到达
        //   上限，而按新口径"场上清空优先"。玩家能走到的典型路径 = 把最后一组
        //   拆着点进槽（场上空了、槽里剩 1~2 张凑不成型）。
        //   ⚠️ 走到这里时 `_slots` 里还留着刚入槽的那张 —— 数据**不清**：
        //      finish 的显示口径会把它计入"已清"，收尾动画会把它收掉。
        if (this.isFieldCleared()) {
            this.finish(true);
            return;
        }

        // 没消成 → 检查槽满
        this.refreshSlotWarn();
        if (this._slots.length >= this._slotCapacity) {
            this.finish(false, 'slotfull');
            return;
        }
        this.logPickable();
        this.refreshHud();
        this.refreshPropBar();
    }

    /**
     * 播放消除。**三种牌型共用同一套「撞击」动效。**
     *
     * 【2026-10-01 晚 用户拍板 —— 这一版为什么又改回来】
     *   用户原话：「吃的特效还是不够好，直接应用碰的特效吧，把字改成"吃"即可」
     *   于是取消「吃」的专属动效（咀嚼），改回与「碰」完全一致的
     *   **蓄力(后退) → 猛冲 → 撞 → 停一拍 → 炸开**。
     *
     * ★ S18 决议 5 之后：牌型差异**在画面上与听觉上都归零了**。
     *      · 飘字：`popMatchLabel(m.type)` 查 `MATCH_WORD` → 一律「消 除」
     *      · 声音：`onClash` 一律 `clash`
     *   也就是说：三种牌型现在**看到的是同一套撞击、听到的是同一个音**。
     *   差异只剩两处，且都不上屏：**消掉几张牌（看得见）**、以及
     *   `MATCH_LABEL` 那行内部日志（排查用）。
     *   ⚠️ 这正是"零棋牌语义"的代价与收益：代价是三种牌型少了一个识别符号，
     *      收益是听觉上不再出现「碰」「吃」两个词 —— 那是**上架硬约束**，
     *      不是审美取舍，没有折中空间。
     *
     * 【被否掉的那一版（咀嚼）去哪了 —— 别到处找】
     *   `playEatClear` / `onEatBite` / `onEatBurp` 三个方法、
     *   `CFG.MOTION` 的 EAT_* 一整段、`MotionFx.spawnJaw`（嘴）
     *   **都还在，只是不再被调用**（各有一处〔已停用〕标记说明）。
     *   之所以保留而不删：这一整批改动**尚未 commit**，删掉就真找不回来了。
     *   · 想切回咀嚼：把本方法末尾那行换成
     *     `if (m.type === 'chi') this.playEatClear(m); else this.playClashClear(m);`
     *     一行即可，两个方法都还在。
     *   · 想彻底清理：三个方法 + EAT_* 常量 + spawnJaw **一起删**
     *     （★ 常量与它的引用方必须落在同一个提交里，教训见 CFG.MOTION 十五·B）。
     *   ☑ 音源已就位：`playEatClear` 里现在播 `swish`（S18 新合成的纸木「唰」），
     *     切回咀嚼**不需要**再补音效。
     *
     * ⚠️ 【术语，务必读】「连章」现在的定义是**连击**（限时窗口内连续消除的
     *    计数），和「同族连号三张」是两回事，本作**不需要**。初版把它误当成
     *    "用户想要的新玩法"，做了一整套流光带 + 「连章 ×N」层数 + 4 档递增音高；
     *    而真正的「连号」当时和「三张相同」**共用同一套撞击动效**。结果是用户要的
     *    两样东西，一样做错了、另一样根本没做。那套连击机制已整体删除
     *    （动机与痕迹见 CFG.MOTION §十五）。**别再让「连章」进入玩法/动效/音效。**
     */
    private playClear(m: MatchResult): void {
        // 这一行是**验证"三种牌型有没有都被触发过"的唯一线索**：它同时说明
        // "消的是哪种牌型"和"走了哪套动效"。没有它，无头跑完一关只能看到
        // "已清 N/M"，根本不知道中间有没有出现过「同族连号」—— 而它在 L1/L2 里
        // **根本不可能出现**（pickPatterns 给那两关的同族连号少于 3 个，凑不成串），
        // 所以"没看到连号消除"到底是"没触发"还是"没实现"，只能靠这行区分。
        // ⚠️ `动效=` 这个字段现在恒为「撞击」，但**别删**：它仍是"这条路走通了"
        //    的唯一无头证据（将来若再加第二套动效，字段原样可用）。
        // ⚠️ 这里用 `MATCH_LABEL`（「碰 / 吃 / 杠」）是**故意的**：日志走 console、
        //    不上屏，有中文别名能省掉一次查字典。**飘字走 `MATCH_WORD`**，两者别拿混。
        if (CFG.DEBUG.LOG_STATE) {
            const keys = m.indices.map((i) => this._slots[i].key).join(' ');
            log(`[GamePage] 消除 牌型=${m.type}(${MATCH_LABEL[m.type]}) 张数=${m.indices.length}`
                + ` → 动效=撞击 ｜ ${keys}`);
        }

        // 三类型共用。**不要再按牌型分叉动作** —— ★ S18 决议 5 之后，
        // 牌型差异**只剩飘字之外的日志**（`MATCH_LABEL` 只进 console，
        // 飘字走中性的 `MATCH_WORD`，声音统一 `clash`）。
        this.playClashClear(m);
    }

    /**
     * 三种牌型的**撞击**：蓄力 → 冲刺 → 撞上 → 停一拍 → 一起炸开。
     *
     * 【旧版为什么不够"撞"】
     * 旧版的三张牌**从头到尾都待在自己的槽格里**：上浮、放大、再缩到 0。
     * 也就是说，它们之间从来没有发生过任何**空间关系** ——
     * 玩家看到的是"三张牌各自胀了一下"，而不是"三张牌撞到了一起"。
     * 差距全在下面这条时间轴上，而不在"幅度够不够大"。
     *
     * 【时间轴】（三类型通用；★ S18 之后三类**完全一致**，没有任何按牌型的分叉）
     *   t=0           蓄力：三张牌朝**远离中心**的方向各退 12px（攒势）
     *   t=90ms        冲刺：quadIn 加速，朝中心猛冲，最终中心间距压到槽格宽的 45%
     *   t=200ms       ★ 撞击帧：挤压(squash & stretch) + 冲击圆环 + 碎屑
     *                            + 牌堆上踢 + 合成音 `clash` + 中档震动
     *   t=290ms       停一拍（POP_HOLD）：给大脑一次眨眼，把"这三张是一组"读进去
     *   t=290ms 起    释放：先胀到 1.20，再收缩到 0 并淡出
     *   t=+240ms      数据收尾 → 连锁判定 → 胜负判定
     *
     * 【为什么"撞击"必须是 quadIn 而不是 quadOut】
     * quadOut 冲到终点时会减速，看起来像"小心翼翼地靠拢"；
     * quadIn 是越冲越快、到位即最高速 —— 那才是撞上去。
     *
     * 【为什么撞完要"停一拍"】
     * 撞击与消散直接连起来，玩家只记得"闪了一下"。
     * 停 70ms 让"撞"和"散"成为两件可以被分别记住的事 ——
     * 这是消除类游戏通用的一条节奏经验：先顿一下，再消失。
     */
    private playClashClear(m: MatchResult): void {
        const M = CFG.MOTION;
        this._busy = true;

        // ① 金圈高亮（TileView 的 clear 态）
        for (const i of m.indices) this._slots[i].view.setState('clear');

        const doomed = m.indices.map((i) => this._slots[i].view);
        const scale = this.slotScale();

        // ② 撞击几何
        const slotW = this.slotWidth();
        const n = doomed.length;
        const centerX = this.clashCenterX(m.indices);
        const centerY = CFG.GAME_LAYOUT.SLOT_BAR_Y;
        // 叠拢程度：撞上后的中心间距 = 槽格宽 × CLASH_OVERLAP。
        // 碰 / 杠的牌面完全相同，"叠成一张厚牌"正是"三合一"的观感；
        // ⚠️「吃」的三张牌面**各不相同**，按理叠狠了会看不清是哪三张 ——
        //    但用户 2026-10-01 要的就是"和碰一模一样"，所以三类共用同一个值，
        //    这里**不再**按牌型分档（原「吃」专用的 EAT_OVERLAP=0.55 已随咀嚼停用）。
        const span = slotW * M.CLASH_OVERLAP;

        // ③ 蓄力 → 冲刺：**一条链**走完，绝不拆成两条 tween。
        //    拆开的话，蓄力与冲刺会同时持有 position（两条 tween 抢同一属性），
        //    在交界处必然出现重叠帧 —— 真机上是肉眼可见的一顿。
        for (let k = 0; k < n; k++) {
            const v = doomed[k];
            if (!v.node.isValid) continue;
            // 第 k 张朝远离中心的方向退：中间的（dir = 0）不动，两侧的向外退。
            // 只动两侧就已经足够表达"攒势"了，中间那张也退反而像整体平移。
            const dir = k < (n - 1) / 2 ? -1 : (k > (n - 1) / 2 ? 1 : 0);
            const x0 = v.node.position.x;
            const y0 = v.node.position.y;
            const tx = centerX + (k - (n - 1) / 2) * span;
            MotionFx.chain(v.node, [
                { props: { position: v3(x0 + dir * M.CLASH_PULLBACK, y0, 0) },
                  duration: M.CLASH_ANTICIPATE, easing: EASE.ENTER },
                { props: { position: v3(tx, centerY, 0) },
                  duration: M.CLASH_DASH, easing: EASE.DASH },
            ], { tag: TAG.SLOT });
        }

        // ④ ★ 撞击帧：所有牌都撞到的时刻
        const hitAt = M.CLASH_ANTICIPATE + M.CLASH_DASH;
        setTimeout(() => {
            if (!this.node.isValid) return;
            this.onClash(doomed, m, scale, centerX, centerY);
        }, MotionFx.unlockMs(hitAt));
    }

    /**
     * ★ 撞击帧的全部表现。抽成独立方法是因为它要做 6 件事，
     * 全塞进 playClear 的 setTimeout 闭包里会让那段代码彻底不可读。
     */
    private onClash(
        doomed: TileView[], m: MatchResult,
        scale: number, centerX: number, centerY: number,
    ): void {
        const M = CFG.MOTION;

        // ① 声音与触感 —— 这是全局唯一"值得震"的瞬间。
        //    ★ S18 决议 5：**这里的声音不再分牌型了。**
        //    原来写的是 `m.type === 'chi' ? 'eat' : 'peng'`，
        //    也就是"同张消除播人声念白「碰」、连号消除播人声念白「吃」"——
        //    那是一句话里塞了两个棋牌术语（听觉上的术语比看得见的文字更容易被漏掉），
        //    与"个人主体 + 休闲益智类目、游戏内零棋牌语义"的硬约束直接冲突。
        //    现在统一播合成音 `clash`（噪声瞬态 + 三音和弦，320ms，不含任何语义）。
        //
        //    ⚠️ 现在这一句是**全局唯一的消除音**：三种牌型（三张相同 / 同族连号 /
        //    四张相同）全部走本方法（见 playClear → playClashClear），
        //    所以运行时每消一次响的都是 `clash`。
        //    `swish`（纸木「唰」）是留给"咀嚼"那条**已停用**路径的（playEatClear），
        //    当前不出声；它保留在包里是为了"切回咀嚼"仍然是一行代码的事。
        AudioService.play('clash');
        Haptics.medium();

        // ② 挤压（squash & stretch）：撞上去的牌会被压扁一点、拉长一点。
        //    两段式：先压（EXIT = 快，被撞的那一下是突然的），
        //    再弹回（POP = 带过冲，材质有弹性）。一条曲线跑完的话，
        //    回到 1.0 的过程没有"弹"的记忆，会像"缩放"而不是"碰撞"。
        for (const v of doomed) {
            if (!v.node.isValid) continue;
            MotionFx.to2(v.node,
                { props: { scale: v3(scale * M.CLASH_SQUASH_X, scale * M.CLASH_SQUASH_Y, 1) },
                  duration: M.CLASH_RECOIL * 0.35, easing: EASE.EXIT },
                { props: { scale: v3(scale, scale, 1) },
                  duration: M.CLASH_RECOIL * 0.65, easing: EASE.POP },
                { tag: TAG.SLOT });
        }

        // ③ 冲击圆环。坐标必须**换算**到特效层（槽位层与特效层是两个坐标系，
        //    绝不去改任何一个的坐标系 —— 改了会把所有槽内逻辑一起带歪）。
        const world = MotionFx.localToWorld(this._slotLayer, v3(centerX, centerY, 0));
        const at = MotionFx.worldToLocal(this._fxLayer, world);
        spawnPulse(this._fx, at.x, at.y, CFG.COLOR.GOLD, {
            r0: M.CLASH_RING_R0,
            r1: M.CLASH_RING_R1,
            line: M.CLASH_RING_LINE,
            life: M.CLASH_RING_LIFE,
        });

        // ④ 碎屑：从**每张牌**的位置喷，而不是只从中心喷一个点。
        //    只在中心喷的话，"三张牌被打散"这件事就没有空间上的分布感。
        for (const v of doomed) this.burstAtTile(v);

        // ⑤ 牌堆上踢：把撞击的能量传导出去（替代被否掉的整屏镜头抖动，
        //    理由见 CFG.MOTION.CLASH_KICK 的注释）。
        //    幅度必须**显式传**（别把默认值写死在这里）。三类型同幅 ——
        //    动作既然一样，传导出去的能量自然也该一样。
        this.kickStack(M.CLASH_KICK);

        // ⑥ 飘字：把牌型名说出来（碰 / 吃 / 杠）。
        //    ★ 与①的人声一起，这是「吃 / 碰」之间**唯一还看得见听得见的差别**。
        //    ⚠️ 这里曾经写成"连章 ×N 与飘字二选一"。「连章」= **连击**，是初版
        //    误做的机制（已整体删除）；飘字与它无关，永远只有一种。
        this.popMatchLabel(m.type);

        // ⑦ 停一拍之后再释放
        setTimeout(() => {
            if (!this.node.isValid) return;
            this.releaseClear(doomed, m, scale);
        }, MotionFx.unlockMs(M.POP_HOLD));
    }

    /**
     * 释放段：先胀到峰值，再收缩到 0 并淡出，然后做数据收尾。
     *
     * 【为什么是两段而不是一条曲线】
     * 一条曲线从 1.0 直接跑到 0，看起来是"缩没了"；
     * 先胀到 1.20 再收缩，看起来是"胀开了、然后被打散"。
     * 前者是"消失"，后者是"消除"—— 差的正是那 60ms 的胀开。
     */
    private releaseClear(doomed: TileView[], m: MatchResult, scale: number): void {
        const M = CFG.MOTION;

        // 消散音：与"碰"的音效分工明确 —— 碰负责"撞上了"，clear 负责"散了"。
        // 两者相隔一次 POP_HOLD（70ms）+ 挤压回弹，听觉上正好是"咚—唰"。
        AudioService.play('clear');

        for (const v of doomed) {
            if (!v.node.isValid) continue;
            MotionFx.to2(v.node,
                { props: { scale: v3(scale * M.POP_SCALE_MAX, scale * M.POP_SCALE_MAX, 1) },
                  duration: M.POP_OUT * 0.3, easing: EASE.POP },
                { props: { scale: v3(0, 0, 1) }, duration: M.POP_OUT * 0.7, easing: EASE.EXIT },
                { tag: TAG.SLOT });
            MotionFx.fade(v.node, 0, M.POP_OUT * 0.7,
                { delay: M.POP_OUT * 0.3, easing: EASE.EXIT, tag: TAG.FADE });
        }

        setTimeout(() => {
            if (!this.node.isValid) return;
            this.finalizeClear(doomed, m);
        }, MotionFx.unlockMs(M.POP_OUT));
    }

    /**
     * 消除之后的**数据收尾** —— 撞击（碰/杠）与咀嚼（吃）两条动效路径共用。
     *
     * 【为什么必须抽出来共用】
     * 两条路径的"好看"各不相同，但"收尾"必须一模一样：
     * 删节点、从槽数据里 splice、清 `_busy`、向左补齐、刷新 HUD、连锁判定、胜负判定。
     * 任何一处变成两份实现，迟早会出现"碰完能连锁、吃完不能"这类
     * 只有特定牌型才复现的 bug —— 而它看起来不像 bug，像"运气不好"。
     */
    private finalizeClear(doomed: TileView[], m: MatchResult): void {
        for (const v of doomed) v.destroy();

        // 从槽数据里删掉（下标大的先删，避免删前面的之后后面全部错位）
        const idx = m.indices.slice().sort((a, b) => b - a);
        for (const i of idx) this._slots.splice(i, 1);

        this._cleared += m.indices.length;
        this._busy = false;

        // C5 回补：剩余牌向左补齐空位
        this.relayoutSlots();
        this.refreshSlotWarn();
        this.logPickable();
        this.refreshHud();
        this.refreshPropBar();

        // 消完之后槽里可能还有能消的（连锁）—— 重新进 playClear，
        // 于是连锁里出现的「吃」也会正确地走咀嚼动效。
        const keys = this._slots.map((s) => s.key);
        const again = findMatch(keys, this._level.gang, -1);
        if (again) {
            this.playClear(again);
            return;
        }

        // 胜负判定。顺序**不能调换**：场上清空优先级高于槽满
        // （点下最后一张牌同时触发两者时，玩家赢了 —— 见 isFieldCleared）。
        if (this.isFieldCleared()) {
            this.finish(true);
        } else if (this._slots.length >= this._slotCapacity) {
            this.finish(false, 'slotfull');
        }
    }

    /**
     * 🔴〔已停用 · 2026-10-01 晚 用户拍板〕「吃」的**咀嚼**（S12.2 落地；S7.5 原为"流水汇合"）。
     *
     * ⚠️ **本方法当前没有任何调用方** —— 用户认为咀嚼"还是不够好"，要求
     *    「直接应用碰的特效」，于是「吃」改走 playClashClear（撞击）。
     *    整段保留而不删，是因为这批改动**尚未 commit**，删掉就真找不回来了。
     *    · 要切回咀嚼：见 playClear 末尾的说明（一行的事）。
     *    · 要彻底清理：本方法 + onEatBite + onEatBurp + CFG 的 EAT_* + spawnJaw。
     *
     * 下面这段是**停用前**的设计记录，将来若重做"吃"的动效仍有参考价值。
     *
     * 【术语】「吃」= **顺子**（234条 / 456万）= MatchRule 里的 `chi`。
     *        ⚠️ 它与「连章」不是一回事 ——「连章」= **连击**（限时窗口内连续
     *        消除的计数），本作不需要，那套机制已整体删除。别再把它引进来。
     *
     * ------------------------------------------------------------
     * 【为什么要推翻 S7.5 的"流水汇合"】
     * 旧实现是：三张依次滑向中心 → 到齐后一起上浮淡出，并且**刻意不加**
     * 挤压 / 冲击环 / 碎屑 / 牌堆上踢，理由是"丝滑是减出来的"。
     * 那条推演没错，但结论错了 —— 它把"撞击的语汇"连同**"动作本身"一起减掉了**：
     * 玩家看到的只是"三张牌挪到一起、然后淡出"，**读不出"吃"这个动作**。
     * 用户 2026-10-01 原话：「触发吃的时候，没有碰那样的特效…
     * 有一种小黄人吃豆子的那种感觉，把吃这个动作表达好」。
     *
     * 【"小黄人吃豆子"只有三个要素】（多一个都不是它）
     *   ① **张嘴**     —— 嘴先张开，豆子才被吃
     *   ② **一口一个** —— 依次被吃、有节奏，不是一次吞完一片
     *   ③ **即触即消** —— 嘴碰到豆子那一帧豆子就没了
     * ★ 与旧实现最大的差别在 ②：旧的是"三张**到齐**后一起消散"，
     *   整个消除只有 **1 个**节奏点；改成"**到一张咬一张**"之后有 **3 个**
     *   —— "咔嚓、咔嚓、咔嚓"才是"吃"。
     *
     * 【时间轴】（以 n = 3 为例，时间全是 CFG.MOTION 的常量）
     *   t=0                     第 1 张起步（EASE.DASH 末段加速 ＝ "被吸进去"）
     *                           + 嘴开始张开（第 1 次张开占满整个吸行 = EAT_SUCK）
     *   t=0.13 / 0.26           第 2 / 3 张起步（错峰 EAT_STAGGER）★ 节奏的来源
     *   t=0.20 / 0.33 / 0.46    各张**到位**：嘴合拢 + 该张被压扁（外撑 + 压扁）
     *                           + 方点残渣 + 扁脉冲
     *   t=到位+EAT_BITE_RECOIL  该张缩到 0（被咬没了）
     *   t≈0.68                  "打嗝"：大扁脉冲 + 飘字「吃」+ 牌堆轻踢
     *   t≈0.94                  **一次性**数据收尾 → 连锁判定 → 胜负判定
     *
     * ⚠️ 【为什么数据收尾是"一次性"的，而不是边咬边删】
     * 逐口只在**视觉上**消失，`_slots` 等到最后一并 splice。理由很实在：
     * 边咬边 splice 会让还没被咬的牌**提前左移**，于是"咬合的位置"与
     * "牌实际在的位置"对不上 —— 表现为后两口咬在了空处。
     * 这也是为什么必须复用 finalizeClear：两条动效路径的**收尾必须一模一样**
     * （理由见 finalizeClear 的注释）。
     *
     * ⚠️ 【为什么"嘴"只调一次 spawnJaw，而不是每口调一次】
     * 三口在时间上是**重叠**的（EAT_SUCK 0.20s > EAT_STAGGER 0.13s）。
     * 每口各起一个嘴，会有两个同位置、同线宽、只有高度不同的弧叠在一起 ——
     * 看上去像"上下颚各长出两条"的重影，像渲染 bug 而不像嘴。
     * 用 bites 让一个嘴咬 N 次可以根治，详见 MotionFx.spawnJaw 的 JSDoc。
     */
    private playEatClear(m: MatchResult): void {
        const M = CFG.MOTION;
        this._busy = true;

        // ① 金圈高亮 + 收齐这次要吃的牌
        for (const i of m.indices) this._slots[i].view.setState('clear');
        const doomed = m.indices.map((i) => this._slots[i].view);
        const n = doomed.length;

        // ② 嘴与咬合点。坐标必须**换算**到特效层 ——
        //    槽位层与特效层是两个坐标系，绝不去改任何一个的坐标系
        //    （改了会把所有槽内逻辑一起带歪）。与「碰」的撞击环同一套换算。
        const centerX = this.clashCenterX(m.indices);
        const centerY = CFG.GAME_LAYOUT.SLOT_BAR_Y;
        const world = MotionFx.localToWorld(this._slotLayer, v3(centerX, centerY, 0));
        const at = MotionFx.worldToLocal(this._fxLayer, world);

        // ③ 吸：每张朝中心收拢，**错峰起步**。"一口一个"的节奏就是这里。
        //    终点间距用 EAT_OVERLAP(0.55)：比碰的 0.45 松 ——
        //    吃的是三张**不同**的牌，叠死了就看不出是哪三张了。
        const span = this.slotWidth() * M.EAT_OVERLAP;
        for (let k = 0; k < n; k++) {
            const v = doomed[k];
            if (!v.node.isValid) continue;
            const tx = centerX + (k - (n - 1) / 2) * span;
            // ⚠️ `MotionFx.to` 的第二参是**属性表**（{position}），不是 chain 的 step
            //    形状（{props, duration, easing}）。传错不会报"未知属性"，
            //    而是每帧在引擎里抛 TypeError —— 详见 MotionFx.to 的 JSDoc。
            MotionFx.to(v.node,
                { position: v3(tx, centerY, 0) },
                { duration: M.EAT_SUCK, easing: EASE.DASH,
                  tag: TAG.SLOT, delay: k * M.EAT_STAGGER });
        }

        // ④ 张嘴：**一个嘴咬 n 次**。
        //    `reopenDur = 口间隔 - 咬合时长` —— 这个等式是"节奏对得上"的全部秘密：
        //    它让每次**合拢的开始**正好落在该口"牌到位"的时刻（见下方 ⑥ 的 tBite）。
        //    等式一旦被破坏（比如把 EAT_MOUTH_BITE 调得比 EAT_STAGGER 还长），
        //    嘴就会开始追着牌跑，节奏当场散掉。
        spawnJaw(this._fx, at.x, at.y, CFG.COLOR.INK, {
            w: M.EAT_MOUTH_W,
            open: M.EAT_MOUTH_OPEN,
            bow: M.EAT_MOUTH_BOW,
            line: M.EAT_MOUTH_LINE,
            openDur: M.EAT_SUCK,
            reopenDur: Math.max(0, M.EAT_STAGGER - M.EAT_MOUTH_BITE),
            bites: n,
            biteDur: M.EAT_MOUTH_BITE,
            holdDur: M.EAT_MOUTH_HOLD,
        });

        // ⑤ 咀嚼音：与第一张起步**同时**响（★ S18 决议 5 换过音源）。
        //    原来是 `eat`（人声念白「吃」）—— 听得见的棋牌术语，已下线；
        //    现在是一记纸 / 木质的「唰」（`swish`，合成音）。
        //    ⚠️ 它**不是"可有可无的背景音"**：整段咀嚼只有这一下声音，
        //    它负责说清"这一段开始了、而且是**另一种**消除" ——
        //    如果这里静音，玩家只能靠画面区分两条路径，
        //    而"逐口咬合"在 200ms 内是看不清的。
        //    （🔴 本方法当前**未被调用**，所以这一句运行时不会响；
        //      留着它是为了"切回咀嚼"仍是一行代码的事。见 playClear 的注释。）
        AudioService.play('swish');

        // ⑥ 逐口咬合。每口一个独立定时器 —— 它们互不依赖，
        //    某一口被打断（页面切走）最多少一口视觉，不影响数据收尾。
        for (let k = 0; k < n; k++) {
            const tBite = k * M.EAT_STAGGER + M.EAT_SUCK;
            setTimeout(() => {
                if (!this.node.isValid) return;
                this.onEatBite(doomed[k]);
            }, MotionFx.unlockMs(tBite));
        }

        // 震动仍是中档：它表达的是"你消成了"，与视觉的软硬无关。
        // （想让"吃"更轻，把这里换成 Haptics.light() 即可，一行的事。）
        Haptics.medium();

        // ⑦ 打嗝收尾：最后一口被咬没之后，软软地收个尾
        const tAllBitten = (n - 1) * M.EAT_STAGGER
            + M.EAT_SUCK + M.EAT_BITE_RECOIL + M.EAT_BITE_VANISH;
        const tBurp = tAllBitten + M.EAT_BURP_DELAY;
        setTimeout(() => {
            if (!this.node.isValid) return;
            this.onEatBurp(m, at);
        }, MotionFx.unlockMs(tBurp));

        // ⑧ 数据收尾。★ 必须晚于打嗝的**视觉**结束，
        //    否则 `_busy = false` 会让玩家在"还在打嗝"时就能点下一张 ——
        //    体感上会像"这一口没吃完就让人动"。
        setTimeout(() => {
            if (!this.node.isValid) return;
            this.finalizeClear(doomed, m);
        }, MotionFx.unlockMs(tBurp + M.EAT_BURP_LIFE));
    }

    /**
     * 🔴〔已停用〕★ 一口咬合的全部表现（只针对**这一张牌**）。见 playEatClear。
     *
     * 【为什么单独抽出来】它要在 0.13s 的间隔里被连续调用 3 次，
     * 全塞进 playEatClear 的 setTimeout 闭包里会让那段彻底不可读 ——
     * 而且它内部要完成"压扁 → 咬没"共 2 段 tween + 2 种特效。
     *
     * 【"压扁"为什么是 X 撑开 + Y 压扁，而不是整体缩小】
     * 整体缩小读作"牌变小了"（＝被拿走），而 squash 读作"被咬住了"。
     * 这是 S12 与旧版最关键的一处体感差别，参数在 CFG.MOTION.EAT_BITE_SQUASH_*。
     */
    private onEatBite(v: TileView): void {
        if (!v || !v.node.isValid) return;
        const M = CFG.MOTION;
        const scale = this.slotScale();

        // ① 压扁（外撑 + 压扁，backOut 收尾 = 材质有弹性）→ 再缩到 0（被咬没了）
        MotionFx.to2(v.node,
            { props: { scale: v3(scale * M.EAT_BITE_SQUASH_X,
                                 scale * M.EAT_BITE_SQUASH_Y, 1) },
              duration: M.EAT_BITE_RECOIL, easing: EASE.POP },
            { props: { scale: v3(0, 0, 1) },
              duration: M.EAT_BITE_VANISH, easing: EASE.EXIT },
            { tag: TAG.SLOT });

        // ② 特效位置：从**这一张牌**的位置喷。
        //    ⚠️ 不能从嘴的中心喷 —— 那样"这一口咬的是哪张"就失去空间上的对应，
        //    三口的残渣会全糊在同一个点上，看上去像一次炸开。
        const local = MotionFx.worldToLocal(this._fxLayer, MotionFx.worldPosOf(v.node));

        //    ★ **方点**（碰是圆点）—— 这是「吃 / 碰」的差异底线之一：
        //      圆 = 能量向外炸开，方 = 被嚼碎的渣。混用等于抹掉差异。
        spawnDebris(this._fx, local.x, local.y, M.EAT_CRUMB_COUNT, CFG.COLOR.VERMILION, {
            square: true,
            r: M.EAT_CRUMB_R,
            spread: M.EAT_CRUMB_SPREAD,
            life: M.EAT_CRUMB_LIFE,
        });

        // ③ 小脉冲：**扁椭圆**（EAT_FLAT = 0.42）。
        //    它是"这一口确实咬下来了"的句号；没有它，牌会显得是"凭空没了"。
        //    ⚠️ 用正圆就变成「碰」的语汇了 —— 这就是 EAT_FLAT 存在的唯一理由。
        spawnPulse(this._fx, local.x, local.y, CFG.COLOR.GOLD, {
            r0: M.EAT_PULSE_R0,
            r1: M.EAT_PULSE_R1,
            line: M.EAT_PULSE_LINE,
            life: M.EAT_PULSE_LIFE,
            flat: M.EAT_FLAT,
        });
    }

    /**
     * 🔴〔已停用〕★ 咀嚼的收束 —— "打嗝"。见 playEatClear。
     *
     * 【为什么需要这一步】三口咬完直接收数据，玩家会觉得"就……没了？"
     * 打嗝是整段咀嚼的**句号**：它把"我吃完了"这件事说出来，
     * 也顺便把飘字「吃」带出来 —— 旧版连飘字都没有。
     *
     * 【为什么踢的幅度只有「碰」的一半】
     * CFG.MOTION.EAT_KICK = 2.5，CLASH_KICK = 5。
     * 踢牌堆表达的是"能量传导出去"：「碰」是撞，该传得多；「吃」是吞，该收着点。
     * 两个牌型的力度一样的话，体感上就分不出谁是谁了。
     */
    private onEatBurp(m: MatchResult, at: Vec3): void {
        const M = CFG.MOTION;

        spawnPulse(this._fx, at.x, at.y, CFG.COLOR.GOLD, {
            r0: M.EAT_BURP_R0,
            r1: M.EAT_BURP_R1,
            line: M.EAT_BURP_LINE,
            life: M.EAT_BURP_LIFE,
            flat: M.EAT_FLAT,
        });

        this.kickStack(M.EAT_KICK);

        // 飘字稍慢一拍再弹：先让脉冲把"吞下去了"说清楚，字再跟上
        setTimeout(() => {
            if (!this.node.isValid) return;
            this.popMatchLabel(m.type);
        }, MotionFx.unlockMs(M.EAT_LABEL_DELAY));
    }

    /** 本次要撞的那几张牌的中心 x（槽位层局部坐标） */
    private clashCenterX(indices: number[]): number {
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        for (const i of indices) {
            const x = this.slotOffsetX(i);
            if (x < min) min = x;
            if (x > max) max = x;
        }
        if (!Number.isFinite(min) || !Number.isFinite(max)) return 0;
        return (min + max) / 2;
    }

    /**
     * 撞击的能量传导：牌堆整体上弹一下再落回。
     *
     * 【为什么抖"牌堆层"而不是"整屏镜头"】
     * 见 CFG.MOTION.CLASH_KICK 的注释：全屏抖动会影响触摸坐标换算，
     * 而且一局触发几十次会让人不适。抖牌堆层视觉等效、坐标系零改动。
     *
     * @param amount 上踢幅度（像素）。**必须由调用方给**，不能写死：
     *   「碰」用 CLASH_KICK(5)、「吃」用 EAT_KICK(2.5) ——
     *   这个差值本身就是两个牌型"硬 / 软"的分别（见 CFG.MOTION 的差异底线）。
     *   升降时长两档共用（踢起来的物理过程是一样的，只是力的大小不同）。
     */
    private kickStack(amount: number): void {
        const M = CFG.MOTION;
        if (!this._stackLayer || !this._stackLayer.isValid) return;
        MotionFx.to2(this._stackLayer,
            { props: { position: v3(0, amount, 0) },
              duration: M.CLASH_KICK_UP, easing: EASE.EXIT },
            { props: { position: v3(0, 0, 0) },
              duration: M.CLASH_KICK_DOWN, easing: EASE.POP },
            { tag: TAG.KICK });
    }

    /** C3 在某个槽内牌处喷一小圈碎屑（位置取牌的**当前视觉位置**，换算到特效层） */
    private burstAtTile(v: TileView): void {
        if (!v || !v.node.isValid || !this._fxLayer) return;
        const M = CFG.MOTION;
        const world = MotionFx.worldPosOf(v.node);
        const local = MotionFx.worldToLocal(this._fxLayer, world);
        const count = M.DEBRIS_MIN
            + Math.floor(Math.random() * (M.DEBRIS_MAX - M.DEBRIS_MIN + 1));
        spawnDebris(this._fx, local.x, local.y, count, CFG.COLOR.GOLD);
    }

    /**
     * ★ 通关判定：**场上清空即通关**（S7.9 口径变更，2026-10-01）。
     *
     * 【为什么从"三者齐空"改成"只看场上"】
     * 旧定义要求 `_left === 0 && 槽空 && 暂存空`，它有一个玩家**真的能走到**的
     * 死角：把最后一组牌拆着点进槽（场上空了、槽里剩 1~2 张凑不成型、暂存架也空）
     * —— 既不通关、也不判负，玩家对着空牌堆点哪儿都没反应，界面**没有任何出口**。
     *
     * 新定义下这种局面直接算赢：**牌是从场上被拿完的，这就是"清完了"**。
     * 槽里那 1~2 张、暂存架里挂着的牌都不影响判定（它们只是"没来得及成型"）。
     * 结算时进度条会把它们一并计入已清（见 finish 里的显示口径），
     * 屏幕上残留的几张牌也会在通关动画里收掉（见 sweepLeftovers）。
     *
     * ⚠️ "槽满 = 失败"这条惩罚**照旧生效**，只是优先级低于本判定：
     *    点下最后一张牌时若场上清空与槽满同时发生，判**通关**。
     *    （顺序写在 afterInsert / finalizeClear 里，改代码时别调换。）
     */
    private isFieldCleared(): boolean {
        return this._left === 0;
    }

    /**
     * C5 槽内余牌左移补位（B5 聚拢也走它）。
     *
     * 单格 90ms：这个值不能更快 —— 补位是"后排的人往前走一步"，
     * 它必须**慢于**消除本身（消除 240ms 里前半段在胀开），
     * 否则玩家会看到"牌瞬间归位"而不是"牌补上来了"。
     *
     * @param except 刚落位、已经在正确位置上的那张牌。
     *               排除它是为了不和它的 B4 压感动效抢 scale
     *               （两个动效如果同 tag，后起的会把前一个打断，
     *                表现就是"落位压感只抖了一半"）。
     */
    private relayoutSlots(except?: Node): void {
        const scale = this.slotScale();
        for (let i = 0; i < this._slots.length; i++) {
            const v = this._slots[i].view;
            if (!v.node.isValid) continue;
            if (except && v.node === except) continue;
            MotionFx.to(v.node,
                { position: this.slotPos(i), scale: v3(scale, scale, 1) },
                { duration: CFG.MOTION.SHIFT_PER_SLOT, easing: EASE.MOVE, tag: TAG.SLOT });
        }
    }

    /**
     * C6 飘字：从消除位置上浮 40px 并淡出，「消 除」大字。
     *
     * ★ S18 决议 5：**字换了，位置 / 字号 / 动效 / 时长一个字没动。**
     *  原来飘的是「碰 / 吃 / 杠」，那是棋牌术语，必须下线；
     *  现在统一飘「消 除」（取词见 `MatchRule.MATCH_WORD`）。
     *  ⚠️ 取词表是 `MATCH_WORD`（对外）而**不是** `MATCH_LABEL`（仅内部日志）——
     *  这两个表长得像，拿错一个就把术语又飘回屏幕上了。
     *
     * 【为什么要延后 80ms 起播】
     * 它和前摇（C1）是同一时刻发生的两件事。同时起播时，
     * 玩家先看到大字、后看到牌胀开 —— 因果顺序反了，
     * 大脑会把大字读成"结果"，而牌的变化变成"紧接着发生的另一件事"。
     * 错开 80ms，顺序就正过来了：牌先动，字再跟上。
     *
     * 【为什么是 620ms 的 backOut→quadIn】
     * 上浮用 backOut（起步快、收尾稳，像被"弹"出去），
     * 淡出用 quadIn（越淡越快，收得干净）。总长压在 620ms：
     * 再长就会盖住下一张牌飞进来的过程，那是干扰不是反馈。
     */
    private popMatchLabel(type: keyof typeof MATCH_WORD): void {
        const layer = this._fxLayer;
        if (!layer || !layer.isValid) return;
        const M = CFG.MOTION;

        // 起点取槽位条上方一点：飘字是"从消除的位置长出来的"，
        // 从屏幕正中冒出来会失去它和槽位的空间联系。
        const startY = CFG.GAME_LAYOUT.SLOT_BAR_Y + 130;
        const label = createLabel(layer, MATCH_WORD[type], {
            y: startY,
            fontSize: 96,
            color: CFG.COLOR.GOLD,
            bold: true,
            serif: true,
            outline: CFG.COLOR.INK,
            outlineWidth: 6,
        });
        const node = label.node;
        MotionFx.setFade(node, 0);
        node.setScale(v3(0.7, 0.7, 1));

        // 位置：上浮 FLOAT_RISE（用 backOut → 先快后慢，像被抛上去）
        // 缩放：先弹到 1.12 再回到 1.0（大字要有"蹦出来"的那一下）
        MotionFx.chain(node, [
            { props: { position: v3(0, startY + M.FLOAT_RISE * 0.55, 0),
                       scale: v3(1.12, 1.12, 1) },
              duration: M.FLOAT_DURATION * 0.35, easing: EASE.POP },
            { props: { position: v3(0, startY + M.FLOAT_RISE, 0),
                       scale: v3(1, 1, 1) },
              duration: M.FLOAT_DURATION * 0.65, easing: EASE.MOVE },
        ], { tag: TAG.FX });
        MotionFx.fadeChain(node, [
            { to: 255, duration: M.FLOAT_DURATION * 0.25, easing: EASE.ENTER },
            { to: 255, duration: M.FLOAT_DURATION * 0.35 },
            { to: 0, duration: M.FLOAT_DURATION * 0.4, easing: EASE.EXIT },
        ], { delay: M.FLOAT_DELAY, tag: TAG.FADE });

        // 飘字是**一次性装饰节点**，不进对象池（它带一个 Label，
        // 复用 Label 节点要处理"换字重排版"，比重建贵）。
        // 清理同样走 setTimeout：不把"清理"这个职责挂到 tween 回调上。
        setTimeout(() => { if (node.isValid) node.destroy(); },
            MotionFx.unlockMs(M.FLOAT_DELAY + M.FLOAT_DURATION));
    }

    // ========================================================
    //  道具
    // ========================================================

    /**
     * 玩家点了某个道具按钮。
     *
     * 流程刻意是「先查能不能用 → 再要权限 → 最后才执行」：
     * 顺序反过来的话，玩家会先看完广告才被告知"你槽里没牌"，
     * 那种体验足以让人直接卸载。
     */
    private async onPropTap(id: PropId): Promise<void> {
        if (this._busy || this._over || this._modal) return;

        // 「消除」的二次点击 = 取消就绪态（不消耗任何东西）
        if (id === 'remove' && this._armedRemove) {
            this._armedRemove = false;
            for (const s of this._slots) s.view.setState('normal');
            this.refreshPropBar();
            toast(this.root, '已取消「消除」', 1.2);
            return;
        }

        const reason = this.propBlockReason(id);
        if (reason) {
            toast(this.root, reason, 1.6);
            return;
        }

        // ★ 「洗牌」的特殊处理：**先把方案算出来，再弹广告**。
        //   顺序反过来的话，一旦算不出可行方案，玩家就白白看了一条广告。
        //   planReshuffle 是纯计算（在影子副本上试排），算不出时牌局一个字节都没动。
        let plan: ReshufflePlan | null = null;
        if (id === 'shuffle') {
            plan = planReshuffle(
                this._level, this._layout.tiles, this._taken,
                this._slots.map((s) => s.key), this._slotCapacity,
                this._temp.map((e) => e.id),
            );
            if (!plan) {
                toast(this.root, '这局已经没什么可洗的了', 1.8);
                return;
            }
        }

        this._modal = true;
        const ok = await RewardGate.request(this.root, `使用「${PROP_LABEL[id]}」`);
        this._modal = false;

        // 广告期间局面可能已经变了（超时判负 / 页面被销毁），全部要复查
        if (!ok) return;
        if (!this.node.isValid || this._over) return;
        if (this.propBlockReason(id) !== null) return;

        // ---------- D1：奖励图标从广告按钮位置弧线飞向目标 ----------
        // 为什么要有这一段：看完 15 秒广告之后，玩家最需要的是**明确的因果**——
        // "我的等待换来了一件东西，而且它已经到手了"。
        // 直接把道具效果演一遍是不够的（效果在牌堆里、发生在别处）；
        // 让一个图标从"我刚点的那个按钮"飞出去，因果链才是完整的。
        //
        // ⚠️ 状态推进依然走 setTimeout（铁律），不用补间的完成回调。
        this._busy = true;
        this.playRewardFly(id);
        setTimeout(() => {
            if (!this.node.isValid || this._over) return;
            this._busy = false;
            if (id === 'shuffle' && plan) {
                this.applyShuffle(plan);
                return;
            }
            this.applyProp(id);
        }, MotionFx.unlockMs(CFG.MOTION.REWARD_FLY));
    }

    /**
     * D1 奖励图标飞行：从道具按钮沿弧线飞到本次动作的"落点"，落点扩散一圈脉冲。
     *
     * 落点是**按道具有意义的目标**选的，不是随便找个位置：
     *   消除 → 槽位条（消的是槽里的牌）；移出 → 暂存架；加槽 → 槽位条；
     *   洗牌 → 牌堆中心（洗的是整堆）。
     * 目标选错的话，玩家会"看着奖励飞到一个跟这次操作无关的地方"，
     * 那比不做这段动画还糟 —— 它传达了一个错误的因果。
     */
    private playRewardFly(id: PropId): void {
        const M = CFG.MOTION;
        const L = CFG.GAME_LAYOUT;
        const btn = this._propNodes[id];
        if (!btn || !btn.isValid) return;

        // 起点：道具按钮的中心（世界坐标 → 特效层局部）
        const from = MotionFx.worldToLocal(this._fxLayer, MotionFx.worldPosOf(btn));

        // 奖励音（上行四音琶音）。它与图标**同帧起飞** ——
        // 声音是"东西离手了"的听觉证据，晚一点就和图标对不上了。
        AudioService.play('reward');

        // 终点：按道具有意义的目标（槽位层 / 牌堆层的局部坐标 → 特效层局部）
        let target = v3(0, L.SLOT_BAR_Y, 0);
        switch (id) {
            case 'move':
                target = this.tempPos(0);
                target = MotionFx.between(this._tempLayer, this._fxLayer, target);
                break;
            case 'shuffle': {
                const S = CFG.STACK;
                target = MotionFx.between(this._stackLayer, this._fxLayer,
                    v3((S.X_MIN + S.X_MAX) / 2, (S.Y_MIN + S.Y_MAX) / 2, 0));
                break;
            }
            default:
                target = MotionFx.between(this._slotLayer, this._fxLayer, target);
                break;
        }

        const icon = this._fx.rent('icon');
        // 与 debris / pulse / flash 一样挂"保底回收"：显式回收走下面的落点定时器，
        // 但那个定时器带 `!this.node.isValid` 的提前 return —— 页面在飞行途中被销毁时
        // 它不会执行，图标就会一直留在池外（既不 give 也无人持有）。
        //
        // ⚠️ 寿命必须**显式传** `REWARD_FLY + FX_MAX_LIFE`，不能用默认的 FX_MAX_LIFE：
        //    默认 0.40s 比飞行 0.42s 还短，兜底会抢在落点之前把图标收走。
        this._fx.autoRecycle('icon', icon, CFG.MOTION.REWARD_FLY + CFG.MOTION.FX_MAX_LIFE);
        const g = icon.getComponent(Graphics);
        const r = 22;
        if (g) {
            g.clear();
            g.fillColor = hex2color(CFG.COLOR.GOLD);
            g.circle(0, 0, r);
            g.fill();
            g.lineWidth = 3;
            g.strokeColor = hex2color(CFG.COLOR.INK);
            g.circle(0, 0, r);
            g.stroke();
        }
        icon.setPosition(from);
        icon.setScale(0.7, 0.7, 1);

        // 弧线：两个控制点抬到起点与终点连线之上 REWARD_ARC，
        // 形成一条"抛出去"的轨迹。直线飞行的观感是"被吸过去了"，
        // 弧线的观感是"被送过去了"—— 后者才像奖励。
        // （用 MotionFx.arc 而不是引擎的 bezierTo：3.8 的 Tween 没有那个 API，
        //   arc 内部把三次贝塞尔采样成 ARC_SEGMENTS 段，缓动作用在整条弧上）
        const midY = Math.max(from.y, target.y) + M.REWARD_ARC;
        const c1 = v3(from.x, midY, 0);
        const c2 = v3(target.x, midY, 0);
        MotionFx.arc(icon, from, c1, c2, target, M.REWARD_FLY,
            { tag: TAG.FLY, easing: EASE.POP });
        MotionFx.to(icon, { scale: v3(1, 1, 1) },
            { duration: M.REWARD_FLY * 0.4, easing: EASE.POP, tag: TAG.SLOT });

        // 落点脉冲：由 setTimeout 触发（不用补间回调），
        // 时间点取"图标刚落到位"的那一刻
        setTimeout(() => {
            if (!this.node.isValid) return;
            spawnPulse(this._fx, target.x, target.y, CFG.COLOR.GOLD);
            this._fx.give('icon', icon);
        }, MotionFx.unlockMs(M.REWARD_FLY));
    }

    private applyProp(id: PropId): void {
        switch (id) {
            case 'remove': this.armRemove(); break;
            case 'move': this.applyMoveOut(); break;
            case 'shuffle': /* 走的是带方案的重载，不会到这里 */ break;
            case 'addslot': this.applyAddSlot(); break;
            default: break;
        }
    }

    /** 「消除」：进入就绪态，等玩家点槽里的一张牌 */
    private armRemove(): void {
        this._armedRemove = true;
        for (const s of this._slots) s.view.setState('pick');
        this.refreshPropBar();
        toast(this.root, `点槽里任意一张，同牌面的 ${MATCH_SIZE} 张一起消掉`, 2.0);
        log('[GamePage] 道具 消除 就绪');
    }

    /**
     * 「消除」真正落地：把**被点那张牌所在的整组（3 张同牌面）**一起消掉。
     *
     * ------------------------------------------------------------
     *  ⚠️ 为什么不是"消掉被点的 1 张"（DESIGN §5 的原话）
     *  牌组是 **3 张一组**构造的（Generator.buildBag）。只消 1 张的话，
     *  同一牌面剩下的 2 张永远凑不成型（碰要 3、杠要 4、吃要连号）——
     *  等于道具亲手把这一局变成死局。
     *
     *  第一次实装的自动化测试就撞上了这个：
     *  L1 最终停在「已清 10/12、槽里 1 张、场上 0 张可点」，玩家再也动不了。
     *  所以规则收敛成一句：**消就消一整组**，槽里的优先，不够的从场上补。
     *  这样"牌面张数 ≡ 0 (mod 3)"这个不变量在所有操作下都保持成立。
     *
     *  这是对 DESIGN §5 的一处**有意修正**，已同步回设计文档。
     * ------------------------------------------------------------
     */
    private applyRemoveSlot(index: number): void {
        const entry = this._slots[index];
        if (!entry) return;
        const pattern = entry.key;

        // ① 槽内同牌面的全部（被点的那张一定在其中）
        const slotIdx: number[] = [];
        for (let i = 0; i < this._slots.length; i++) {
            if (this._slots[i].key === pattern) slotIdx.push(i);
        }

        // ② 还差几张 → 从场上补。优先取"可点的"，玩家看得见它们消失；
        //    不足时再退而求其次取被压住的（总比凑不满 3 张强）。
        const need = Math.max(0, MATCH_SIZE - slotIdx.length);
        const boardIds: number[] = [];
        if (need > 0) {
            const pickable = pickableIds(this._layout.tiles, this._graph, this._taken);
            const rest: number[] = [];
            for (let i = 0; i < this._layout.tiles.length; i++) {
                if (!this._taken[i] && pickable.indexOf(i) < 0) rest.push(i);
            }
            for (const id of pickable.concat(rest)) {
                if (boardIds.length >= need) break;
                if (this._layout.tiles[id].key === pattern) boardIds.push(id);
            }
        }

        // ③ 兜底：槽里也没有、场上也没有同牌面 —— 理论上不该发生，
        //    真发生了就只消掉被点的这一张（宁可少消，也不要抛异常卡死界面）
        if (slotIdx.length + boardIds.length <= 0) return;

        this._armedRemove = false;
        this._busy = true;
        this._propUsed.remove++;

        // ④ D5「收割」：**依次**扫过要消的牌，每张间隔 HARVEST_STEP。
        //    为什么不是同时消失：这是道具，玩家花了代价换来的东西，
        //    同时消失只有"少了点东西"的观感；依次放大会产生"一把撸过去"的节奏，
        //    节奏 = 价值感。收割顺序也刻意是"槽内 → 场上"，正好是道具的作用顺序。
        const M = CFG.MOTION;
        const doomedViews: TileView[] = [];
        const victims: TileView[] = [];

        for (const i of slotIdx) {
            const v = this._slots[i].view;
            if (!v || !v.node.isValid) continue;
            doomedViews.push(v);
            victims.push(v);
        }
        for (const id of boardIds) {
            const v = this._views[id];
            if (!v || !v.node.isValid) continue;
            doomedViews.push(v);
            victims.push(v);
        }

        victims.forEach((v, k) => {
            const delay = k * M.HARVEST_STEP;
            const s0 = v.node.scale.x;
            // 放大 → 消失：先胀到 1.25 倍（"被抓住"），再迅速缩到 0（"被收走"）
            MotionFx.chain(v.node, [
                { props: { scale: v3(s0 * 1.25, s0 * 1.25, 1) },
                  duration: M.HARVEST_ONE * 0.35, easing: EASE.POP },
                { props: { scale: v3(0, 0, 1) },
                  duration: M.HARVEST_ONE * 0.65, easing: EASE.EXIT },
            ], { tag: TAG.SLOT, delay });
            MotionFx.fadeChain(v.node, [
                { to: 255, duration: M.HARVEST_ONE * 0.35 },
                { to: 0, duration: M.HARVEST_ONE * 0.65, easing: EASE.EXIT },
            ], { delay, tag: TAG.FADE });
            // 收割到哪一张，哪一张就喷碎屑（跟着节奏走，不是一次性全喷）
            setTimeout(() => {
                if (!this.node.isValid || !v.node.isValid) return;
                this.burstAtTile(v);
            }, MotionFx.unlockMs(delay));
        });

        const harvestTotal = M.HARVEST_ONE + M.HARVEST_STEP * Math.max(0, victims.length - 1);

        // ⑤ 场上被消的牌：立即更新遮挡计数（数据不跟着动画走）
        for (const id of boardIds) {
            this._taken[id] = true;
            this._left--;
            for (const j of this._graph.below[id]) {
                this._blocked[j]--;
                if (this._blocked[j] === 0 && !this._taken[j] && this._views[j].node.isValid) {
                    this._views[j].setState('normal');
                }
            }
        }

        const removed = slotIdx.length + boardIds.length;

        setTimeout(() => {
            if (!this.node.isValid) return;
            for (const v of doomedViews) v.destroy();

            // 槽数据删除（下标大的先删，避免错位）
            const sorted = slotIdx.slice().sort((a, b) => b - a);
            for (const i of sorted) this._slots.splice(i, 1);

            this._cleared += removed;
            this._busy = false;
            this.relayoutSlots();
            this.refreshSlotWarn();
            this.logPickable();
            this.refreshHud();
            this.refreshPropBar();
            log(`[GamePage] 道具 消除 已生效（消 ${removed} 张：槽内 ${slotIdx.length} + 场上 ${boardIds.length}）`);

            // 消完之后槽里可能刚好凑齐了别的一组
            const keys = this._slots.map((s) => s.key);
            const again = findMatch(keys, this._level.gang, -1);
            if (again) { this.playClear(again); return; }
            // 道具把场上最后一组消掉 → 同样按新口径判通关（槽里剩什么都不管）
            if (this.isFieldCleared()) this.finish(true);
        }, MotionFx.unlockMs(harvestTotal));
    }

    /**
     * D4「移出」：槽内最左 N 张**被抛出槽位**，走抛物线落进暂存架。
     *
     * 【为什么是抛物线 + 旋转，而不是直线平移】
     * 这两样东西是"被扔出去"的全部视觉语法：
     *   · 抛物线（控制点先往下沉，再被"接"进暂存架）交代了"它脱离了我的控制"；
     *   · 30° 的旋转交代了"它是被甩出去的"，而不是"它自己走过去的"。
     * 直线的后果是"牌平移了"——看起来像 UI 在重排，而不是道具在动手。
     *
     * 【飞行途中的透明度下沉】
     * 牌在飞出槽位的一瞬间"淡"一下（MOVE_OUT_ALPHA），落架时再回到全不透明。
     * 这是为了把"离开槽位"和"进入暂存架"这两个事件在视觉上分开，
     * 否则牌会像一条直线挪过去，玩家分不清它到底"还在不在槽里"。
     */
    private applyMoveOut(): void {
        const M = CFG.MOTION;
        const room = CFG.GAMEPLAY.TEMP_CAPACITY - this._temp.length;
        const n = Math.min(room, CFG.PROP.MOVE_OUT_COUNT, this._slots.length);
        if (n <= 0) return;

        this._busy = true;
        this._propUsed.move++;
        // S14.2b：架子平时是藏着的，牌要飞出去之前先把它叫出来 ——
        // 顺序不能反，否则会看到"牌飞到一个还不存在的格子里"。
        this.showTempRack();

        const moving = this._slots.splice(0, n);   // 最左 N 张
        const scale = this.tempScale();
        // 同步重排留在槽里的牌：先动数据再动视图，避免中间态错位
        this.relayoutSlots();
        this.refreshSlotWarn();

        for (let k = 0; k < n; k++) {
            const entry = moving[k];
            const node = entry.view.node;
            if (!node.isValid) continue;
            const targetIndex = this._temp.length + k;
            const target = this.tempPos(targetIndex);
            // 这张牌在"槽/暂存架展示位"上的朝向（受 SLOT_KEEP_ANGLE 控制）。
            // 该开关现为 false → 恒为 0°（槽位是信息区，必须正放）。
            // 移出只是"换个地方放"，不额外做转正动作 —— 它本来就是正的。
            const a0 = this.slotAngleOf(entry.id);

            // 起飞点：当前视觉位置（世界坐标换算到特效层），
            // 这样"正在做补位动画的牌"也能从它真实所在处起飞
            const world = MotionFx.worldPosOf(node);
            const fromFx = MotionFx.worldToLocal(this._fxLayer, world);
            const targetFx = MotionFx.between(this._tempLayer, this._fxLayer, target);
            node.setParent(this._fxLayer);
            node.setPosition(fromFx);
            node.setSiblingIndex(this._fxLayer.children.length - 1);
            node.angle = a0;

            // 抛物线的两个控制点：
            //   c1 = 起点往下沉 MOVE_OUT_DROP（"掉出槽位"）
            //   c2 = 终点上方一点（"被接住"）
            const c1 = v3(fromFx.x, fromFx.y - M.MOVE_OUT_DROP, 0);
            const c2 = v3(targetFx.x, targetFx.y + M.MOVE_OUT_DROP * 0.4, 0);

            node.setSiblingIndex(this._fxLayer.children.length - 1);
            // 旋转与位移**刻意分成两条不同 tag 的 tween**：
            // 位移走 MotionFx.arc（弧线），它按采样点驱动 position，
            // 天生表达不了"顺便把角度也转了"；硬塞进同一条就得手写一串
            // 中间点 —— 那是在重新实现贝塞尔。
            // 分通道没有任何副作用：两条 tween 改的是不同属性。
            //
            // ⚠️ 旋转的**起点和终点都是 a0**（现为 0°）：这条 tween 表达的是
            //    "被挪走时晃一下"这个手感，**不是**用来改朝向的 ——
            //    写死 0 之外的终值会变成"移出顺手把牌转个角度"，与槽位正放的规则打架。
            MotionFx.chain(node, [
                { props: { angle: a0 + M.MOVE_OUT_ANGLE }, duration: M.MOVE_OUT * 0.4, easing: EASE.MOVE },
                { props: { angle: a0 }, duration: M.MOVE_OUT * 0.6, easing: EASE.MOVE },
            ], { tag: TAG.SPIN });
            MotionFx.arc(node, fromFx, c1, c2, targetFx, M.MOVE_OUT,
                { tag: TAG.FLY, easing: EASE.MOVE });
            MotionFx.fadeChain(node, [
                { to: M.MOVE_OUT_ALPHA, duration: M.MOVE_OUT * 0.35, easing: EASE.MOVE },
                { to: 255, duration: M.MOVE_OUT * 0.45, easing: EASE.ENTER },
            ], { tag: TAG.FADE });
            MotionFx.to(node, { scale: v3(scale, scale, 1) },
                { duration: M.MOVE_OUT, easing: EASE.MOVE, tag: TAG.SLOT });
        }

        setTimeout(() => {
            if (!this.node.isValid) return;
            for (let k = 0; k < n; k++) {
                const node = moving[k].view.node;
                if (!node.isValid) continue;
                // 落架：换回暂存层并精确归位（视觉上无变化，结构上守住
                // "暂存架的牌都在暂存层"这条不变量）
                node.setParent(this._tempLayer);
                node.setPosition(this.tempPos(this._temp.length + k));
                node.setScale(v3(scale, scale, 1));
                node.angle = this.slotAngleOf(moving[k].id);
            }
            for (let k = 0; k < n; k++) {
                this._temp.push(moving[k]);
            }
            this._busy = false;
            this.logPickable();
            this.refreshHud();
            this.refreshPropBar();
            log(`[GamePage] 道具 移出 已生效，暂存 ${this._temp.length} 张`);
        }, MotionFx.unlockMs(M.MOVE_OUT));
    }

    /** 从暂存架取回一张（放回槽位；槽满则提示） */
    private takeFromTemp(index: number): void {
        if (this._slots.length >= this._slotCapacity) {
            toast(this.root, '槽位已满，先消掉几张再取回', 1.6);
            return;
        }
        const entry = this._temp[index];
        if (!entry) return;

        const M = CFG.MOTION;
        this._busy = true;
        this._temp.splice(index, 1);

        // 暂存架里剩下的牌要往前补位（与槽位补位同一节奏，单格 90ms）
        const tScale = this.tempScale();
        for (let i = 0; i < this._temp.length; i++) {
            MotionFx.to(this._temp[i].view.node,
                { position: this.tempPos(i), scale: v3(tScale, tScale, 1) },
                { duration: M.SHIFT_PER_SLOT, easing: EASE.MOVE, tag: TAG.SLOT });
        }

        // 取回这一张：走与 B3 完全相同的飞行链路（同样的速度基准、同样的落位压感），
        // 「从暂存取回」与「从牌堆拿牌」在手感上必须是同一件事 ——
        // 两处各写一套时长，迟早会有一处忘了跟着改。
        const slotIndex = this.insertIndexFor(entry.key);
        const scale = this.slotScale();
        const world = MotionFx.worldPosOf(entry.view.node);
        const fromFx = MotionFx.worldToLocal(this._fxLayer, world);
        const targetSlot = this.slotPos(slotIndex);
        const targetFx = MotionFx.between(this._slotLayer, this._fxLayer, targetSlot);
        const flySec = MotionFx.moveDuration(fromFx, targetFx);

        const node = entry.view.node;
        node.setParent(this._fxLayer);
        node.setPosition(fromFx);
        node.setSiblingIndex(this._fxLayer.children.length - 1);
        MotionFx.to(node,
            { position: targetFx, scale: v3(scale, scale, 1) },
            { duration: flySec, easing: EASE.MOVE, tag: TAG.FLY });

        setTimeout(() => {
            if (!this.node.isValid) return;
            if (node.isValid) {
                node.setParent(this._slotLayer);
                node.setPosition(targetSlot);
                node.setSiblingIndex(this._slotLayer.children.length - 1);
                // B4 落位压感（与牌堆拿牌一致）
                MotionFx.to2(node,
                    { props: { scale: v3(scale * M.SQUASH_X, scale * M.SQUASH_Y, 1) },
                      duration: M.SNAP * 0.35, easing: EASE.POP },
                    { props: { scale: v3(scale, scale, 1) },
                      duration: M.SNAP * 0.65, easing: EASE.ENTER },
                    { tag: TAG.SLOT });
            }
            this._slots.splice(slotIndex, 0, entry);
            this.relayoutSlots(node);
            this._busy = false;
            this.refreshSlotWarn();
            // 取回之后可能立刻能消（暂存里那张正好补上了缺口）
            const keys = this._slots.map((s) => s.key);
            const m = findMatch(keys, this._level.gang, slotIndex);
            if (m) { this.playClear(m); return; }
            this.logPickable();
            this.refreshHud();
            this.refreshPropBar();
        }, MotionFx.unlockMs(flySec));
    }

    /**
     * 「洗牌」：提交已经算好的方案。
     *
     * 关键点是**带着玩家当前的槽位状态**去验证可解性（见 Generator.planReshuffle），
     * 否则可能洗完更死 —— 那这个道具就成了纯粹的坑。
     * 另外，暂存架里的牌会一并撒回场上：它们本来就能取回，
     * 留在架子里会让"场上这批牌"被误判成天生无解。
     */
    private applyShuffle(plan: ReshufflePlan): void {
        const tiles = this._layout.tiles;
        const M = CFG.MOTION;
        this._busy = true;
        this._propUsed.shuffle++;

        // 洗牌音（'唰'的纸牌摩擦声）。放在三段动画的**起点**而不是铺开时：
        // 声音是"洗牌开始了"的信号，它和"牌收拢"同步；
        // 如果放在铺开时，玩家会先看到牌缩成一团、再听到声音，因果反了。
        AudioService.play('shuffle');

        // ① 暂存架的牌先回场（数据 + 视图），它们和场上的牌一起参与重排。
        //    视图先挂回牌堆层但**不急着摆位置** —— 第 ② 步会把它们收拢到原地，
        //    第 ③ 步才统一铺开。少了"收拢"这一步，暂存牌会从架子位置直接
        //    飞向新位置，视觉上是"一张牌从下面窜上来"，很突兀。
        for (const e of this._temp) {
            if (e.id >= 0 && e.id < this._taken.length) this._taken[e.id] = false;
            const v = e.view;
            if (v && v.node.isValid) {
                v.node.setParent(this._stackLayer);
                v.node.setScale(v3(1, 1, 1));
            }
        }
        this._temp = [];
        this._left = 0;
        for (let i = 0; i < this._taken.length; i++) if (!this._taken[i]) this._left++;

        // 参与重排的牌（场上剩余的 + 刚回场的）
        const movingIds = plan.moves.map((mv) => mv.id);

        // ---------- 第 ① 段：全部收拢 ----------
        // 缩到 0.86 + 半透明 + 带 ±12° 随机角度。
        // 角度是"要被重新抛出去"的预告：静止的牌突然旋转，玩家的直觉是
        // "这堆东西在动了"，接下来的重排就有了"因"。
        //
        // ⚠️ 这个 ±12° 是**相对这张牌自己的朝向**（a0 + ang），不是绝对角：
        //    牌是四向随机的，写绝对值会让大半牌在原地拧 90°~180° ——
        //    那不再是"抖一下"，而是"整堆翻了个面"，看不出是同一批牌。
        for (const id of movingIds) {
            const v = this._views[id];
            if (!v || !v.node.isValid) continue;
            const a0 = this.angleOf(id);
            const ang = a0 + (Math.random() * 2 - 1) * M.SHUFFLE_ANGLE;
            MotionFx.chain(v.node, [
                { props: { scale: v3(0.86, 0.86, 1), angle: ang },
                  duration: M.SHUFFLE_GATHER, easing: EASE.EXIT },
            ], { tag: TAG.STACK });
            MotionFx.fadeChain(v.node, [
                { to: 102, duration: M.SHUFFLE_GATHER, easing: EASE.EXIT },
            ], { tag: TAG.FADE });
        }

        // ---------- 第 ③ 段的错峰预算 ----------
        // ⚠️ 硬指标：洗牌总长 ≤ SHUFFLE_TOTAL_MAX。
        //    第 4 关有 24 张牌、6 层，按名义步长 25ms 排下来是 125ms，
        //    还在预算内；但一旦有人把层数或张数调大，这里必须**压缩步长**
        //    而不是让总长涨上去 —— 改的是"密度"，不是"总时长"。
        const depths: number[] = [];
        for (const id of movingIds) {
            const d = tiles[id]?.depth ?? 0;
            if (depths.indexOf(d) < 0) depths.push(d);
        }
        depths.sort((a, b) => a - b);
        const layers = Math.max(1, depths.length);
        const budget = Math.max(0,
            M.SHUFFLE_TOTAL_MAX - M.SHUFFLE_GATHER - M.SHUFFLE_SWAP - M.SHUFFLE_SPREAD);
        const stagger = layers > 1 ? Math.min(M.SHUFFLE_STAGGER, budget / (layers - 1)) : 0;
        const spreadDone = stagger * (layers - 1) + M.SHUFFLE_SPREAD;
        const total = M.SHUFFLE_GATHER + M.SHUFFLE_SWAP + spreadDone;

        // ---------- 第 ② 段：纯数据重排（无动画）----------
        // 120ms 的"留白"：牌已经缩没了、新坐标已经算好，但先不给视觉。
        // 这段空白是"重新布局"这件事本身被感知到的唯一机会 ——
        // 没有它，玩家只会看到牌在原地抖了一下就换了个样子。
        setTimeout(() => {
            if (!this.node.isValid) return;

            for (const m of plan.moves) {
                const t = tiles[m.id];
                if (!t) continue;
                t.x = m.x; t.y = m.y;
                t.depth = m.depth; t.row = m.row; t.col = m.col; t.floor = m.floor;
            }
            // 重建遮挡图（位置变了，遮挡关系全变）
            this._graph = buildBlockGraph(tiles, this._taken);
            for (let i = 0; i < tiles.length; i++) {
                this._blocked[i] = this._graph.above[i].length;
            }
            this.reorderStack();
            // 数据已经就位 → 先把每张牌摆到新坐标（此时还是缩着 + 半透明的，
            // 所以玩家看不见这次"瞬移"，第 ③ 段再让它们显形）
            for (const m of plan.moves) {
                const v = this._views[m.id];
                if (v && v.node.isValid) v.node.setPosition(m.x, m.y, 0);
            }
        }, MotionFx.unlockMs(M.SHUFFLE_GATHER));

        // ---------- E5 输入锁：提前 SHUFFLE_UNLOCK_LEAD 解锁 ----------
        // 解锁点取"铺开动画还差最后 100ms"的时刻：
        // 玩家抬手准备点的时候，牌已经基本就位了，读到的就是"洗牌已经结束"。
        // 等动画**真正**结束再解锁，会多出一次可以感觉到的等待。
        //
        // ⚠️ 用 setTimeout 而不是 tween 回调（铁律）。这条链路一旦断掉，
        //    _busy 会永久为 true，整个牌局直接死锁 —— 那是最严重的一类故障。
        setTimeout(() => {
            if (!this.node.isValid) return;
            this._busy = false;
            // 提前解锁时把状态颜色一并刷好，保证"可点牌列表"立刻是准的：
            // 自动化试玩（tools/web-smoke.mjs 的 auto）正是靠这份列表决定点哪里，
            // 列表晚一拍刷新，脚本就会去点一张已经不可点的牌，然后整局停摆。
            this.refreshStackStates();
            this.logPickable();
        }, MotionFx.unlockMs(Math.max(0, total - M.SHUFFLE_UNLOCK_LEAD)));

        // ---------- 第 ③ 段：按层错峰铺开回位 ----------
        setTimeout(() => {
            if (!this.node.isValid) return;
            for (const m of plan.moves) {
                const v = this._views[m.id];
                if (!v || !v.node.isValid) continue;
                const layerIdx = depths.indexOf(tiles[m.id]?.depth ?? 0);
                // 铺开时角度归到**这张牌自己的朝向**（不是 0）——
                // 洗牌只换位置，不该顺手把所有牌摆正。
                MotionFx.chain(v.node, [
                    { props: { position: v3(m.x, m.y, 0), scale: v3(1, 1, 1),
                               angle: tiles[m.id].angle },
                      duration: M.SHUFFLE_SPREAD, easing: EASE.POP },
                ], { tag: TAG.STACK, delay: layerIdx * stagger });
                MotionFx.fade(this._views[m.id].node, 255, M.SHUFFLE_SPREAD,
                    { delay: layerIdx * stagger, easing: EASE.ENTER, tag: TAG.FADE });
            }
            // E3：整堆描边白闪一次 —— 给洗牌一个明确的"完成"句号
            const S = CFG.STACK;
            spawnRectFlash(this._fx,
                (S.X_MIN + S.X_MAX) / 2, (S.Y_MIN + S.Y_MAX) / 2,
                S.X_MAX - S.X_MIN, S.Y_MAX - S.Y_MIN, CFG.COLOR.FACE);
        }, MotionFx.unlockMs(M.SHUFFLE_GATHER + M.SHUFFLE_SWAP));

        // ---------- 收尾：兜底复位 + 日志 ----------
        // 兜底复位是必须的：删掉它的话，一旦某条 tween 没跑完，
        // 就会有牌永远停在 0.86 缩放或半透明状态 —— 而那种故障
        // 在日志里完全看不出来（"能点、能消、就是看着怪"）。
        setTimeout(() => {
            if (!this.node.isValid) return;
            for (const m of plan.moves) {
                const v = this._views[m.id];
                if (!v || !v.node.isValid) continue;
                MotionFx.stop(v.node, TAG.STACK);
                MotionFx.stop(v.node, TAG.FADE);
                v.node.setPosition(m.x, m.y, 0);
                v.node.setScale(1, 1, 1);
                v.node.angle = tiles[m.id].angle;
                MotionFx.setFade(v.node, 255);
            }
            // ⚠️ 收尾定时器**故意完全不碰 `_busy`**。
            //
            // 这里原来写的是 `if (!this._pending) this._busy = false;`，
            // 意图是"玩家已经在提前解锁的那 100ms 里拿起了下一张牌，
            // 就别把他的锁清掉"。但那个判据只覆盖了一半：
            //   · 拿牌会置 `_pending`，挡得住；
            //   · **道具不置 `_pending`** —— 玩家在这 100ms 窗口里点道具，
            //     道具早已 `_busy = true` 并起了 420ms 的奖励飞行，
            //     这一段一执行就把**别人的锁**清掉了，于是飞行途中还能再点牌，
            //     两条链路同时改槽位数据（槽内顺序随机错乱）。
            //
            // 正解是认识到"这段收尾本来就不该有权解锁"：
            // 上面那段提前解锁定时器（`total - SHUFFLE_UNLOCK_LEAD`）与本节
            // 在同一函数里无条件注册，且必然先于本段触发，锁早就被它放掉了。
            // 本段再放一次纯属多余 —— 而"多余的放锁"正是竞态的入口。
            this.refreshStackStates();
            this.logPickable();
            this.refreshPropBar();
            log(`[GamePage] 道具 洗牌 已生效（第 ${plan.attempts} 次尝试，可解率 `
                + `${(plan.solveRate * 100).toFixed(0)}%，可点 `
                + `${pickableIds(tiles, this._graph, this._taken).length} 张，`
                + `错峰 ${Math.round(stagger * 1000)}ms / 总长 ${Math.round(total * 1000)}ms）`);
        }, MotionFx.unlockMs(total));
    }

    /** 按深度重排牌堆的绘制顺序（洗牌后深度会变） */
    private reorderStack(): void {
        const tiles = this._layout.tiles;
        const order: number[] = [];
        for (let i = 0; i < tiles.length; i++) if (!this._taken[i]) order.push(i);
        order.sort((a, b) => tiles[a].depth - tiles[b].depth);
        for (let s = 0; s < order.length; s++) {
            const v = this._views[order[s]];
            if (v.node.isValid) v.node.setSiblingIndex(s);
        }
        // 已拿走的牌不再参与命中测试，但仍在 _depthOrder 里；
        // 这里重建一遍，保证"从上往下扫"的顺序与视觉一致
        const full: number[] = [];
        for (let i = 0; i < tiles.length; i++) full.push(i);
        full.sort((a, b) => tiles[a].depth - tiles[b].depth);
        this._depthOrder = full;
    }

    /** 按当前遮挡计数刷新每张牌的状态（可点 = 亮，被压 = 灰） */
    private refreshStackStates(): void {
        for (let i = 0; i < this._views.length; i++) {
            if (this._taken[i]) continue;
            const v = this._views[i];
            if (!v.node.isValid) continue;
            v.setState(this._blocked[i] > 0 ? 'dim' : 'normal');
        }
    }

    /**
     * D3「加槽」：容量 +1，新格从两侧"长"出来。
     *
     * ⚠️ **布局与触摸热区必须先同步，再播动画**。
     * 这是本道具最容易出事的地方：`_slotCapacity` 一改，槽格宽度、
     * 每格的 x 坐标、以及 hopSlotOrTemp 的命中区间全都会变。
     * 如果先播动画、动画结束才更新容量，那么在这 300ms 里：
     * 玩家看到的是"新格子长出来了"，但点击仍然按旧布局判定 ——
     * 表现就是"点新格子没反应、点旁边空处反而取回了牌"。
     * 所以顺序是：**先改数据 → 先同步布局与热区 → 最后才补一段纯视觉的动画**。
     *
     * 视觉上"从两侧长出来"用 scaleX 0→1 表达：Graphics 的宽度没法 tween，
     * 但缩放可以，而且从中心向两侧长开恰好就是"从两侧长出来"的形状。
     */
    private applyAddSlot(): void {
        const M = CFG.MOTION;
        const L = CFG.GAME_LAYOUT;

        // 加槽音（'咔哒—外扩'的机械感）。动作发生在按钮上，
        // 所以声音也要在动作开始的同一帧响，而不是等新格长完。
        AudioService.play('addslot');

        // ---------- ① 数据与布局（同步完成，不等动画）----------
        const beforeCap = this._slotCapacity;
        this._slotCapacity += CFG.PROP.ADD_SLOT_STEP;
        this._propUsed.addslot++;
        this.drawSlotBar();          // 容量变了，槽格宽度要重算
        this.relayoutSlots();        // 槽内已有的牌跟着缩一点
        this.refreshSlotWarn();
        this.refreshHud();
        this.refreshPropBar();
        this.logPickable();

        // ---------- ② 新格的"长出来"动画（纯装饰，不影响任何判定）----------
        const newIndex = beforeCap;                 // 新加的是最后一格
        const slotW = this.slotWidth();
        const cellH = L.SLOT_BAR_H - CFG.GAMEPLAY.SLOT_INSET_Y * 2;
        const glow = createNode('NewSlot', this._slotBarNode, {
            w: slotW, h: cellH, x: this.slotOffsetX(newIndex), y: 0,
        });
        const gg = glow.addComponent(Graphics);
        // 描边先亮（朱红实线）、再收（淡出）—— 用同一条 fadeChain 表达
        strokeBox(gg, 0, 0, slotW, cellH, CFG.SHAPE.RADIUS_SLOT, CFG.COLOR.VERMILION, 3);
        glow.setScale(0, 1, 1);
        MotionFx.to(glow, { scale: v3(1, 1, 1) },
            { duration: M.ADD_SLOT_GROW, easing: EASE.POP, tag: TAG.FX });
        MotionFx.fadeChain(glow, [
            { to: 255, duration: M.ADD_SLOT_GROW * 0.5, easing: EASE.ENTER },
            { to: 0, duration: M.ADD_SLOT_GROW * 0.5, easing: EASE.MOVE },
        ], { tag: TAG.FADE });
        setTimeout(() => { if (glow.isValid) glow.destroy(); },
            MotionFx.unlockMs(M.ADD_SLOT_GROW));

        toast(this.root, `槽位扩展到 ${this._slotCapacity} 格`, 1.6);
        log(`[GamePage] 道具 加槽 已生效，容量 ${this._slotCapacity}`);
    }

    // ========================================================
    //  HUD 刷新
    // ========================================================
    /**
     * 把当前"可点牌"的牌面与坐标打到控制台。
     *
     * 这不只是排障：自动化冒烟测试（tools/web-smoke.mjs）就是靠这行拿到
     * 真实坐标去点击的 —— 牌局位置随机，脚本没有别的办法知道该点哪里。
     * 顺带它也是"遮挡判定是否按预期工作"最直接的证据。
     */
    private logPickable(): void {
        if (!CFG.DEBUG.LOG_STATE) return;
        const tiles = this._layout.tiles;
        const pk: string[] = [];
        for (let i = 0; i < tiles.length; i++) {
            if (!this._taken[i] && this._blocked[i] === 0) {
                pk.push(`${tiles[i].key}@${Math.round(tiles[i].x)},${Math.round(tiles[i].y)}`);
            }
        }
        // 一行内同时给出状态、槽内容与可点牌：既方便人读，也方便脚本解析。
        // 槽内列表是自动试玩脚本做决策的依据（优先补满槽里已有的牌面）。
        const slotKeys = this._slots.map((s) => s.key).join(',');
        const tempKeys = this._temp.map((s) => s.key).join(',');
        log(`[GamePage] 牌局 已清=${this._cleared} 槽=${this._slots.length}/${this._slotCapacity} `
            + `槽内=[${slotKeys}] 暂存=[${tempKeys}] 可点=${pk.length} ｜ ${pk.join(' ')}`);
    }

    private refreshHud(): void {
        const total = this._layout.tiles.length;

        this.drawProgress();

        if (this._countLabel) {
            this._countLabel.string = `已清 ${this._cleared} / ${total}`;
        }
        if (this._timeLabel) {
            this._timeLabel.string = this.timeText();
        }
    }

    /**
     * 重画顶部进度条。
     *
     * ⚠️ **不要在这里调 `layoutHeader()`**：计时文案从「05:00」倒数到「00:59」
     *    宽度是会变的（`estTextWidth` 口径下 5 个字符同宽，实际字形会有 1~2px 抖动），
     *    每秒钟重排一次会让「规则」钮**原地抖** —— 那比偏几像素难看得多。
     *    顶条只在"入场"那一刻排一次版（见 `layoutHeader` 的调用时机说明）。
     */
    private drawProgress(): void {
        const g = this._barG;
        if (!g) return;
        const L = CFG.GAME_LAYOUT;
        const total = this._layout ? this._layout.tiles.length : 0;
        const ratio = total > 0 ? this._cleared / total : 0;
        // 刻度 4 根（含两端）＝ 三段 —— 与「三张成组」的心算节奏对齐，
        // 比百分比刻度更贴玩法（设计稿就是 0/33.3/66.6/100 四根）。
        drawProgressBar(g, L.BAR_W, L.BAR_H, ratio, 4);
    }

    private timeText(): string {
        if (this._level.timeLimit <= 0) return '不限时';
        const t = Math.max(0, Math.floor(this._timeLeft));
        const mm = Math.floor(t / 60);
        const ss = t % 60;
        return `${mm < 10 ? '0' : ''}${mm}:${ss < 10 ? '0' : ''}${ss}`;
    }

    // ========================================================
    //  计时与胜负
    // ========================================================
    protected onEnter(): void {
        // ★ S19：**顶条弹性三段在这里定稿**。
        //  为什么必须放在 onEnter、而且要放在最前面：
        //   ① PageManager 是 `setTimeout(FADE_DURATION + 20ms)` 之后才调 onEnter 的，
        //      此时 Label 已经过渲染管线，`contentSize.width` 才是真值
        //      （构建期读到的可能是默认的 100 —— 而且**不报错**）；
        //   ② 下面的 A4「HUD 下落淡入」会把 node.position 整个 tween 到
        //      `v3(当前x, 目标y)` —— x 是**此刻**读的快照。如果排版发生在它之后，
        //      tween 会把规则钮拉回旧 x，读起来是"按钮自己滑回去了"。
        this.layoutHeader();

        // 入场动效必须先播：PageManager 是在转场结束（也就是本页完全可见）之后
        // 才调 onEnter 的，这里才是"观众已经就座"的时刻。
        //
        // ★ S18.4：入场变成**串行的两段**（用户拍板「先播开场动画，再出现牌堆涌现」）：
        //   第一段 开场（IntroAnim，1.5s）—— 负责"**舞台**"：
        //          页框 / 顶部信息 / 槽位条 / 道具栏（全部静态 HUD）淡入，**牌堆区是空的**；
        //   第二段 涌现（playSproutMotion，1.6s）—— 负责"**演员**"：
        //          牌堆从棋盘里成束升起、挤压、回弹。
        //  两段的内容边界刻意切开，所以同一件事不会被讲两遍。
        //  ⚠️ 计时**必须后移到涌现结束之后**（见 beginPlay 的注释）：
        //    否则玩家还在看动画，成绩已经在跑了。
        if (this._introOn) {
            this._busy = true;   // 开场期间锁输入（点击只用于"跳过"）
            IntroAnim.play({
                parent: this.root,
                title: `第 ${this._level.id} 关 · ${this._level.name}`,
                hudLayer: this._hudLayer,
                onDone: () => this.beginPlay(),
            });
        } else {
            this.beginPlay();
        }
    }

    /**
     * 进入"可玩"状态：牌堆亮相 → 涌现 → **这时才开始计时**。
     *
     * 【计时为什么必须后移】S18 之前它就在 onEnter 里，因为那时入场只有 1.6s 的涌现，
     * 玩家在动画期间也没法操作、但**看得见牌**。串行两段之后，开场那 1.5s 里
     * 画面上连牌都没有 —— 这段时间要是也算成绩，L4 的 720 秒会被白扣 3 秒，
     * 而且玩家会觉得"我还没开始玩就掉时间"。所以计时点跟着"牌出现"走。
     */
    private beginPlay(): void {
        // 牌堆组在此刻才亮相（开场期间它一直是全透明）
        MotionFx.setFade(this._stackLayer, 255);
        this.playSproutMotion();

        if (this._level.timeLimit > 0 && !this._timing) {
            this._timing = true;
            this.schedule(this.tickSecond, 1);
        }
    }

    protected onLeave(): void {
        this.unscheduleAllCallbacks();
        this._timing = false;

        // 特效池必须在离场时清掉：
        // 池里的节点是页面节点的子节点，会跟着页面一起销毁，
        // 但池子里的**引用**不会 —— 下次进游戏页时池子是新实例，
        // 真正会出事的是那些还在跑的 setTimeout（它们会在页面销毁后
        // 去碰已经失效的节点）。引擎的 destroy 会让 isValid 变 false，
        // 各回调里都有 `if (!this.node.isValid) return;` 兜底，这里再断一次引用。
        this._fx.clear();
        this._pending = null;
        // S12.1：同上，缓冲属于"局内"状态，离场一律归零。
        this._buffered = null;
    }

    private tickSecond(): void {
        if (this._over) return;
        this._timeLeft -= 1;
        this._usedTime += 1;
        this.refreshHud();
        if (this._timeLeft <= 0) {
            warn('[GamePage] 超时');
            this.finish(false, 'timeout');
        }
    }

    private finish(win: boolean, reason: FailReason = 'none'): void {
        if (this._over) return;
        this._over = true;
        this._busy = true;
        if (!win) this._failReason = reason;
        this.unscheduleAllCallbacks();
        this._timing = false;
        this._armedRemove = false;
        // S12.1：结算时必须清缓冲。缓冲点击是"这一局"里玩家手快存的意图，
        // 若跨局存活，重新开局/复活后的第一次落位会把它当成本局点击执行 ——
        // 凭空多消一张牌，且玩家根本没按过。
        this._buffered = null;

        if (CFG.DEBUG.LOG_STATE) {
            log(`[GamePage] 第 ${this._level.id} 关 ${win ? '通关' : '失败'}，`
                + `已清 ${this._cleared}/${this._layout.tiles.length}，用时 ${this._usedTime}s，`
                + `道具 消除${this._propUsed.remove}/移出${this._propUsed.move}/`
                + `洗牌${this._propUsed.shuffle}/加槽${this._propUsed.addslot}，复活${this._revives}`);
        }

        // 结算的声音与触感（S7.5）：通关与失败是两种完全不同的情绪，
        // 音色严格对偶 —— 通关是上行大调（明亮、结束），失败是下行（低沉、终止）。
        // 只有失败震（重档）：通关时玩家看的是"新纪录"的提示，
        // 这时候来一下重震会把注意力从屏幕上打散。
        if (win) {
            AudioService.play('win');
        } else {
            AudioService.play('fail');
            Haptics.heavy();
        }

        if (win) {
            // 【S7.9 显示口径】新通关规则是"场上清空即通关"，所以通关时槽里 /
            // 暂存架里**可能还留着** 1~2 张牌。它们不是"没清完"，而是"没来得及
            // 成型就赢了"，因此进度条按**已清完**显示 —— 否则会出现
            // 「已清 20 / 24」配「通关！」这种自相矛盾的观感。
            // ⚠️ 只动**显示**：上面那条日志打的是真实消除数，这里不覆盖它、
            //    也不掩盖数据（想核对真实值就看日志）。
            this._cleared = this._layout.tiles.length;
            this.refreshHud();
            // 屏幕上那几张牌也要一起收掉：进度满了、牌还挂着，一样矛盾。
            this.sweepLeftovers();

            const save = SaveService.instance;
            const best = save.getBestTime(this._level.id);
            save.markCleared(this._level.id, this._usedTime);
            const isRecord = best === 0 || this._usedTime < best;

            // ★ S18.5：通关的结算不再是一条 toast + 2 秒后跳页，而是
            //   **一枚朱砂「过」印砸在纸上**（见 ResultFx.stamp 的头注释）。
            //   toast 的问题是它和"印"在讲同一件事 —— 屏幕中央飘一行
            //   「通关！用时 12 秒」的同时砸下一枚写着「过」的印，信息重复，
            //   而且 toast 会被那枚 96×96 的印盖住一半（它俩都居中）。
            //   所以 toast 整个让位给印：**印负责"赢了"，面板负责"多快"**。
            //
            //   时序（全部可调，见 CFG.MOTION.STAMP）：
            //     0      → 印从上方砸下（110ms，过冲 1.32）
            //     90     → 纸面震四拍 + 纵向压到 86%
            //     410    → 外扩环 + 16 枚印泥颗粒向上飞
            //     900    → 印静止
            //     1600   → 结算条推入（340ms backOut）
            //     1940+  → 停留 PANEL_HOLD 后自动回首页
            ResultFx.stamp(this.root, this._frameNode, () => {
                if (!this.node.isValid) return;
                const panel = ResultFx.buildWinPanel(this.root, this._usedTime, best, isRecord);
                ResultFx.slidePanelIn(
                    panel,
                    CFG.MOTION.STAMP.PANEL_Y0, CFG.MOTION.STAMP.PANEL_Y1,
                    CFG.MOTION.STAMP.PANEL_IN,
                );
                // 回首页（★ S18.3：选关页已删除 → 这里原本回 levelSelect）。
                // 首页主按钮会自动变成「继 续 · 第 N 关」，所以"接着打下一关"
                // 依然是一步可达；不在这里再放按钮是为了守住 §5 一级重心只有 1 个。
                setTimeout(() => {
                    if (!this.node.isValid) return;
                    this.goto('menu');
                }, (CFG.MOTION.STAMP.PANEL_IN + CFG.MOTION.STAMP.PANEL_HOLD) * 1000);
            });
            return;
        }

        // ★ S18.5：失败先"揉纸 + 溅墨"，动效收束之后再推入结算面板。
        //  【为什么面板必须等】面板 520×420 一盖上就压掉了 6 段纸面带抖动的
        //  大半区域 —— 先弹面板等于把动效白做。所以 onPanel 回调里才建面板。
        ResultFx.crease(this.root, () => {
            if (!this.node.isValid) return;
            this.showFailPanel();
        });
    }

    /**
     * 【S7.9】通关清尾：把槽里 / 暂存架里**残留**的牌收掉（缩小 + 淡出）。
     *
     * 【触发时机只有一处】通关瞬间。它们不是被消除的（没凑成型、也没有碰撞），
     * 所以只做"缩小 + 淡出"：不给碎屑、不给冲击圆环、不给飘字 ——
     * 这不是庆祝动作，是收尾动作。错峰 SWEEP_STAGGER 让它们是"一张张被收走"，
     * 同时消失会读成"闪了一下"。
     *
     * ⚠️ 只动**视觉**：`_slots` / `_temp` 两个数组一个字节都不改。
     *    即使动效没跑完（玩家 2 秒内退到关卡页），游戏状态依然自洽 ——
     *    何况 `_over = true` 已经把后续所有操作入口封死了。
     */
    private sweepLeftovers(): void {
        const M = CFG.MOTION;
        const leftovers: Node[] = [];
        for (const e of this._slots) if (e.view.node.isValid) leftovers.push(e.view.node);
        for (const e of this._temp) if (e.view.node.isValid) leftovers.push(e.view.node);
        if (leftovers.length === 0) return;

        for (let k = 0; k < leftovers.length; k++) {
            const node = leftovers[k];
            const delay = k * M.SWEEP_STAGGER;
            MotionFx.to(node, { scale: v3(0, 0, 1) },
                { duration: M.SWEEP_OUT, easing: EASE.EXIT, tag: TAG.SLOT, delay });
            MotionFx.fade(node, 0, M.SWEEP_OUT,
                { easing: EASE.EXIT, tag: TAG.FADE, delay });
        }
        log(`[GamePage] 通关清尾：收掉残留牌 ${leftovers.length} 张`
            + `（槽 ${this._slots.length} + 暂存 ${this._temp.length}）`);
    }

    // --------------------------------------------------------
    //  失败面板（S6 的复活入口；S7 升级为正式结算页）
    // --------------------------------------------------------
    private showFailPanel(): void {
        const F = CFG.REWARD.FAIL;
        const reviveLeft = CFG.REWARD.REVIVE_PER_LEVEL - this._revives;
        // 原因取自**判负入口**写入的 _failReason，不再用 _timeLeft 反推
        // （不限时关卡的 _timeLeft 恒为 0，反推一定得到"时间到"）
        const why = this._failReason === 'timeout' ? '时间到' : '槽位满了';

        const mask = createNode('FailMask', this._modalLayer, { w: 2000, h: 2000 });
        const mg = mask.addComponent(Graphics);
        mg.fillColor = hex2color(CFG.COLOR.MASK, CFG.REWARD.GATE.MASK_ALPHA);
        mg.rect(-1000, -1000, 2000, 2000);
        mg.fill();
        mask.on(Node.EventType.TOUCH_END, (e: EventTouch) => { e.propagationStopped = true; });

        const panel = createPanel(mask, 'FailPanel', F.PANEL_W, F.PANEL_H, {
            x: 0, y: F.PANEL_Y, inner: true,
        });
        panel.on(Node.EventType.TOUCH_END, (e: EventTouch) => { e.propagationStopped = true; });

        createLabel(panel, why, {
            y: F.TITLE_DY, fontSize: F.TITLE_SIZE,
            color: CFG.COLOR.VERMILION, bold: true, serif: true,
        });
        createLabel(panel, `已清 ${this._cleared} / ${this._layout.tiles.length} · 还剩 ${this._left} 张`,
            { y: F.REASON_DY, fontSize: F.REASON_SIZE, color: CFG.COLOR.INK_MID });

        // ① 复活：可选的最优解，插在第一位，但**不是唯一出路**
        //    文案里的张数**从参数算**，不写死 4 —— 「加槽」后槽容量变 9，
        //    清掉一半就是 5，写死会与复活后的实际结果对不上（玩家会发现）。
        {
            const reviveClear = Math.ceil(CFG.GAMEPLAY.SLOT_CAPACITY
                * CFG.REWARD.REVIVE_CLEAR_RATIO);
            createButton(panel, 'ReviveBtn', {
                y: F.REVIVE_DY, w: F.BTN_W, h: F.BTN_H,
                tone: 'red',
                // 文案刻意短：初版「看广告复活（清空槽位 + 洗牌）」在 400px 按钮里
                // 放不下（末字被裁），加宽到 404 再配 BTN_FONT(26) 才留出安全边距。
                text: reviveLeft > 0
                    ? `看广告复活（消 ${reviveClear} 张 + 重排）`
                    : '本关复活机会已用完',
                fontSize: F.BTN_FONT, serif: true,
                enabled: reviveLeft > 0,
                // 禁用态由 createButton 统一走 LOCK 纸灰（不再需要 enabledFill）
                onClick: () => { void this.doRevive(); },
            });
        }

        // ② 重玩本关：永远免费的兜底
        //  ★ S18.3：文案从「重开本关」改成「重玩 · 第 k 关」——
        //  与首页那颗「重玩」小方**同词同义**（决议 3：重玩指向当前这一关），
        //  顺便把关号写出来，玩家不必回忆"刚才打的是第几关"。
        createButton(panel, 'RestartBtn', {
            y: F.RESTART_DY, w: F.BTN_W, h: F.BTN_H,
            tone: 'white',
            text: `重玩 · 第 ${this._level.id} 关`, fontSize: F.BTN_FONT,
            serif: true,
            onClick: () => { this.goto('game', { levelId: this._level.id }); },
        });

        // ③ 回首页
        //  ★ S18.3：文案从「返回关卡」改成「返回首页」（选关页已删除，
        //  "返回关卡"这个说法随之失去指代对象），路由改 `goto('menu')`。
        const backLabel = createLabel(panel, '返回首页', {
            y: F.BACK_DY, fontSize: F.BACK_SIZE, color: '#57503F',
            w: 240, h: 64,
        });
        backLabel.node.on(Node.EventType.TOUCH_END, () => { this.goto('menu'); });

        this._failPanel = mask;
        // ★ S18.5：面板"从下沿推上来"（形制 / 布局 / 文案一个字不动，只加进场）。
        //  从 -820 推入 = 与通关结算条**同一套进场语言**，两处结算读起来是一家人。
        //  ⚠️ 推的是 panel 而不是 mask：mask 是 2000×2000 的遮罩，
        //    推它会把遮罩也带偏、边缘露出底色。
        ResultFx.slidePanelIn(
            panel,
            CFG.MOTION.CREASE.PANEL_Y0, F.PANEL_Y,
            CFG.MOTION.CREASE.PANEL_IN,
        );
        log(`[GamePage] 失败面板已开 原因=${why} 可复活=${reviveLeft > 0}`);
    }

    /** 复活：看广告 → 槽位退回牌堆 + 自动洗牌 + 续命 */
    private async doRevive(): Promise<void> {
        this._modal = true;
        const ok = await RewardGate.request(this.root, '看广告复活');
        this._modal = false;
        if (!ok || !this.node.isValid) return;

        this._revives += 1;
        log(`[GamePage] 复活 第 ${this._revives} 次`);

        // 复活音（明亮上行）+ 中档震动：这是"雨过天晴"的情绪转折点，
        // 值得一次明确的感官确认 —— 玩家刚看完 15 秒广告，
        // 需要立刻知道"东西到手了"。
        AudioService.play('revive');
        Haptics.medium();

        // ① 关掉失败面板
        if (this._failPanel && this._failPanel.isValid) this._failPanel.destroy();
        this._failPanel = null;

        // ② 槽内**最后 N 张直接消除**（2026-10-01 需求 #2）
        //
        //  【用户口径】「看完广告后，要把槽清掉一半（槽内最后4张牌直接消除掉），
        //   而不是把牌又放回牌堆」
        //
        //  【旧做法（原样退回牌堆）为什么是坏的】
        //  旧实现让槽里的牌**守恒地退回场上**再重排。玩家看完 15 秒广告回到游戏，
        //  牌一张没少、槽位一张没空 —— 唯一的收获是"可以再点一次"。
        //  「付出了代价、局面却没变」是复活最不该有的手感。
        //  现在改成真的消掉一半：已清计数 +4 是**看得见、且留在账上**的进度。
        //
        //  【⚠️ 这里和本函数 2026-10-01 之前那条旧注释是矛盾的，说明一下为什么改】
        //  旧注释写着"把槽里的牌直接销毁会制造死局（牌不再守恒、清空条件达不成）"。
        //  那句话在**当时**成立，因为当时的前提是"每局都保证可解"。现在两条前提都变了：
        //    · 本作自 v3.0 起不再承诺"每局必定可通关"（见 CFG.STACK.MAX_RETRY）；
        //    · 消的是**连续的一段尾牌**，不是散着消 1 张。
        //  旧注释里那条铁律仍然有效、仍然必须遵守 —— 只是它现在管的是**剩下的**牌：
        //  **槽里留下的那几张必须留在槽里参与后续消除，绝不能一起销毁**，
        //  否则玩家攒了一半的进度被"世界重置"抹掉，比不放回牌堆还糟。
        //
        //  【为什么取"尾牌"而不是任意 N 张】
        //  槽位按入槽顺序从左往右排，尾 N 张正是玩家最后放进去的（他刚为它们腾过位置），
        //  消这一段最"解气"；而且剩下的会自然聚拢到左侧，形成"我已经攒了一半"的样子。
        const M = CFG.MOTION;
        const clearN = Math.min(
            this._slots.length,
            Math.ceil(this._slotCapacity * CFG.REWARD.REVIVE_CLEAR_RATIO),
        );
        const doomed = this._slots.slice(this._slots.length - clearN);
        this._slots = this._slots.slice(0, this._slots.length - clearN);
        // 数据先落地（铁律：状态流转走"必然执行"的路径，动效只负责好看）。
        // doomed 的 `_taken` 保持 true —— 它们本来就不在场上；且不再放回槽位，
        // 于是这几张牌从本局彻底消失。
        this._cleared += doomed.length;
        // ⚠️ 暂存架**不动**。那里的牌是玩家主动「移出」寄存的，既不属于牌堆也不属于槽；
        //    把它们的牌"放回去"才是真的踩了用户说的那件事。它们也不占槽位，不拖累续玩。

        // ③ 洗牌：把场上剩余的牌重新撒一遍
        //    【为什么复活仍然要洗牌 —— 用户只说别把槽里的牌放回去，没说取消洗牌】
        //    只"消 4 张 + 空出 4 格"还不够：玩家刚才是因为**牌堆表面全是不成组的牌**
        //    才把槽塞满的。不换一副面，他很可能在 20 秒内再塞满一次，
        //    而复活机会每关只有一次 —— 第二次失败等于白看了刚才那条广告。
        //
        //    ⚠️ 槽里留下的牌必须作为**既成事实**传给校验（第 4 个参数）。
        //       传空数组等于假设"槽是空的"，会把明明通不了的局判成能通 ——
        //       道具/复活的价值就建立在这个校验上，错了它就成了纯坑。
        const plan = planReshuffle(
            this._level, this._layout.tiles, this._taken,
            this._slots.map((e) => e.key), this._slotCapacity, [], undefined,
        );
        if (plan) {
            const ts = this._layout.tiles;
            for (const m of plan.moves) {
                const t = ts[m.id];
                if (!t) continue;
                t.x = m.x; t.y = m.y;
                t.depth = m.depth; t.row = m.row; t.col = m.col; t.floor = m.floor;
            }
            log(`[GamePage] 复活重排：第 ${plan.attempts} 次尝试，可解率 ${(plan.solveRate * 100).toFixed(0)}%`
                + `（槽内保留 ${this._slots.length} 张参与校验）`);
        }
        this._graph = buildBlockGraph(this._layout.tiles, this._taken);
        for (let i = 0; i < this._layout.tiles.length; i++) {
            this._blocked[i] = this._graph.above[i].length;
        }

        // ④ 视效 A：被消掉的那几张**在画面还亮着的时候**原地消失。
        //    这是复活里唯一"玩家看得见的收益"，所以必须放在黑幕之前 ——
        //    被黑幕盖住的话，玩家只会觉得"牌堆变了"，不会知道槽里少了 4 张。
        //    动效刻意复用「消除」道具的收割节奏（依次缩放 + 淡出 + 碎屑）：
        //    两者在语义上是同一件事（牌被永久移除），手感也该一致。
        const doomedViews: TileView[] = [];
        doomed.forEach((e, k) => {
            const v = e.view;
            if (!v || !v.node.isValid) return;
            doomedViews.push(v);
            const delay = k * M.HARVEST_STEP;
            MotionFx.to(v.node, { scale: v3(0.01, 0.01, 1) },
                { duration: M.HARVEST_ONE, easing: EASE.EXIT, tag: TAG.SLOT, delay });
            MotionFx.fadeChain(v.node, [
                { to: 255, duration: M.HARVEST_ONE * 0.3 },
                { to: 0, duration: M.HARVEST_ONE * 0.7, easing: EASE.EXIT },
            ], { delay, tag: TAG.FADE });
            setTimeout(() => {
                if (!this.node.isValid || !v.node.isValid) return;
                this.burstAtTile(v);
            }, MotionFx.unlockMs(delay));
        });
        const doomTotal = doomedViews.length > 0
            ? M.HARVEST_ONE + M.HARVEST_STEP * (doomedViews.length - 1)
            : 0;

        // 视图复位：还在场上的牌回到牌堆层并按新坐标归位。
        // ⚠️ 只处理**场上**的牌（`_taken` 为 false 的那些）。槽里留下的牌
        //    与暂存架的牌都不动 —— 它们不该被这次"世界重置"抹掉位置。
        const tiles = this._layout.tiles;
        for (let i = 0; i < tiles.length; i++) {
            if (this._taken[i]) continue;
            const v = this._views[i];
            if (!v || !v.node.isValid) continue;
            if (v.node.parent !== this._stackLayer) v.node.setParent(this._stackLayer);
            v.node.setPosition(tiles[i].x, tiles[i].y, 0);
            v.node.setScale(v3(1, 1, 1));
            MotionFx.stopAll(v.node);
            // 朝向也要复位：可能正卡在"移出"的旋转 tween 半途，
            // stopAll 只停动效、不会把角度写回去，不复位就会有一张牌歪着站
            // 在牌堆里（且日志完全看不出来）。
            v.node.angle = tiles[i].angle;
            // 牌视图中途转过父（槽位层 → 牌堆层），透明度可能被上一段动效改过，
            // 必须显式复位，否则会有牌永远停在半透明状态
            MotionFx.setFade(v.node, 255);
        }
        this.reorderStack();
        this.refreshStackStates();

        // ⑤ 视效 B：黑幕盖住"牌堆整体换位"这一下（原 D6 的"由暗转亮"）。
        //    它的作用不是好看：复活是一次"世界重置"，玩家需要一个**明确的时刻**
        //    来重建对局面的认知。没有它，牌会"啪"地一下全体换位置，玩家要重新数一遍。
        //    ⚠️ 解锁时刻 = 收割动效 + 黑幕淡出，两者串起来算（见下）。
        this._busy = true;
        setTimeout(() => {
            if (!this.node.isValid) return;
            // 收割结束：销毁残骸 + 让槽里剩下的牌滑到新位置（补位动画）
            for (const v of doomedViews) if (v.node.isValid) v.destroy();
            this.relayoutSlots();
            this.refreshSlotWarn();

            const veil = createNode('ReviveVeil', this._modalLayer, { w: 2000, h: 2000 });
            const vg = veil.addComponent(Graphics);
            vg.fillColor = hex2color(CFG.COLOR.MASK, 255);
            vg.rect(-1000, -1000, 2000, 2000);
            vg.fill();
            veil.on(Node.EventType.TOUCH_END, (e: EventTouch) => { e.propagationStopped = true; });
            MotionFx.fade(veil, 0, M.REVIVE_FADE, { easing: EASE.ENTER, tag: TAG.FADE });
            setTimeout(() => { if (veil.isValid) veil.destroy(); },
                MotionFx.unlockMs(M.REVIVE_FADE));
        }, MotionFx.unlockMs(doomTotal));

        // ⑥ 续命：原本"时间到"判负的至少再给一段时间，
        //    否则复活完立刻又超时 —— 玩家会觉得白看了一次广告
        this._over = false;
        // S12.1：复活 = 局面被大幅重排（收割 4 张 + 补位滑移），
        // 进复活流程前缓冲的那次点击指向的牌可能已经没了。
        // 这里一并清掉，让玩家复活后重新做决定。
        this._buffered = null;
        // ⚠️ 输入锁的解锁点必须晚于全部视觉复位（铁律：解锁用 setTimeout）。
        //    两段动效串起来：收割（看得见的收益）→ 黑幕（看不见的重排）。
        //    中间任何一段没跑完就放行，玩家都会点到"看不见的牌"。
        if (this._level.timeLimit > 0) {
            this._timeLeft = Math.max(this._timeLeft, CFG.REWARD.REVIVE_MIN_SECONDS);
            if (!this._timing) {
                this._timing = true;
                this.schedule(this.tickSecond, 1);
            }
        }
        setTimeout(() => {
            if (!this.node.isValid) return;
            this._busy = false;
        }, MotionFx.unlockMs(doomTotal + M.REVIVE_FADE));

        this.refreshSlotWarn();
        this.logPickable();
        this.refreshHud();
        this.refreshPropBar();
        log(`[GamePage] 复活生效：槽内消除 ${doomed.length} 张（${doomed.map((e) => e.key).join(',')}），`
            + `槽内保留 ${this._slots.length} 张，${plan ? '牌堆已重排' : '牌堆重排失败（保持原样）'}`);
        toast(this.root, `复活成功 · 槽内消除 ${doomed.length} 张 + 牌堆重排`, 2.2);
    }
}
