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
    BlockGraph, Layout, ReshufflePlan, TileInst, boxOf, buildBlockGraph, generateLevel,
    pickableIds, planReshuffle, tileSizeOf,
} from '../core/Generator';
import { MATCH_LABEL, MATCH_SIZE, MatchResult, findMatch } from '../core/MatchRule';
import { SaveService } from '../core/SaveService';
import { PatternKey } from '../TileData';
import { PageBase } from './PageBase';
import { TileView } from './TileRenderer';
import {
    createButton, createLabel, createNode, createPageFrame, createPaperBackground,
    fillBox, frameRect, hex2color, strokeBox, toast,
} from './UIFactory';
import { RewardGate } from './RewardGate';
import { AudioService } from './AudioService';
import { Haptics } from './Haptics';
import {
    EASE, FxPool, MotionFx, TAG, spawnDebris, spawnPulse, spawnRectFlash,
} from './MotionFx';

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

    // ---- 节点引用 ----
    private _stackLayer!: Node;
    private _slotLayer!: Node;
    private _tempLayer!: Node;
    private _fxLayer!: Node;
    private _modalLayer!: Node;
    private _slotBarG!: Graphics;
    private _tempRackG!: Graphics;
    private _barG!: Graphics;
    private _timeLabel!: Label;
    private _countLabel!: Label;

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
    /** 返回按钮（A3 与槽位条一起滑入，否则"槽位上来了按钮没上来"很怪） */
    private _backBtnNode!: Node;
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
        createPaperBackground(this.root);
        createPageFrame(this.root);

        // ---------- 3. 分层容器 ----------
        // 层序（从下到上）：牌堆 → UI → 槽内牌 → 暂存牌 → 特效 → 弹窗
        //  · 槽内牌必须单独一层，否则飞向槽位的牌会被槽位条盖住；
        //  · 飞牌与临时特效放 FxLayer（S7）：它们在视觉上要压过槽位条与暂存架，
        //    但绝不能进入弹窗之上（弹窗必须永远在最上面，否则会被穿透点击）。
        this._stackLayer = createNode('StackLayer', this.root, { w: CFG.SCREEN.W, h: CFG.SCREEN.H });
        const uiLayer = createNode('UILayer', this.root, { w: CFG.SCREEN.W, h: CFG.SCREEN.H });
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
    }

    // --------------------------------------------------------
    //  顶部信息（关卡名 / 计时 / 进度 / 提示）
    // --------------------------------------------------------
    private buildHeader(parent: Node): void {
        const L = CFG.GAME_LAYOUT;
        const F = CFG.FONT;

        // 顶部信息条的极浅墨色底，把"状态"和"牌局"在视觉上分开
        const header = createNode('Header', parent, { w: CFG.SCREEN.W, h: 130 });
        const hg = header.addComponent(Graphics);
        const fr = frameRect();
        fillBox(hg, 0, L.HEADER_Y - 20, fr.w, 96, 0, CFG.COLOR.INK, 13);

        const titleLabel = createLabel(parent, `第 ${this._level.id} 关 · ${this._level.name}`, {
            x: L.HEADER_TITLE_X, y: L.HEADER_Y, alignLeft: true, w: 400,
            fontSize: F.SIZE_LABEL, color: CFG.COLOR.INK, bold: true, serif: true,
        });

        // 计时：右对齐（锚点移到右边，位置就代表"右边界"）
        this._timeLabel = createLabel(parent, this.timeText(), {
            x: L.HEADER_TIME_X, y: L.HEADER_Y,
            fontSize: F.SIZE_LABEL, color: CFG.COLOR.VERMILION, bold: true, serif: true,
        });
        const tui = this._timeLabel.node.getComponent(UITransform)!;
        tui.setAnchorPoint(1, 0.5);
        this._timeLabel.node.setPosition(L.HEADER_TIME_X, L.HEADER_Y, 0);
        this._timeLabel.horizontalAlign = Label.HorizontalAlign.RIGHT;

        // 细墨线分隔
        const line = createNode('HeaderLine', parent, { w: fr.w, h: 2 });
        const lg = line.addComponent(Graphics);
        lg.lineWidth = 1.6;
        lg.strokeColor = hex2color(CFG.COLOR.INK, 128);
        lg.moveTo(-fr.w / 2, 0);
        lg.lineTo(fr.w / 2, 0);
        lg.stroke();
        line.setPosition(0, L.HEADER_LINE_Y, 0);

        // 进度条
        const progressRoot = createNode('Progress', parent, { w: L.BAR_W, h: L.BAR_H });
        progressRoot.setPosition(0, L.BAR_Y, 0);
        this._barG = progressRoot.addComponent(Graphics);

        this._countLabel = createLabel(parent, '', {
            x: -L.BAR_W / 2, y: L.COUNT_Y, alignLeft: true, w: 300,
            fontSize: F.SIZE_TINY, color: CFG.COLOR.INK_SOFT,
        });

        // 教学提示
        const tip = createLabel(parent, this._level.teach, {
            y: L.TIP_Y, w: frameRect().w - 20,
            fontSize: F.SIZE_BODY - 4, color: CFG.COLOR.INK_SOFT,
        });

        // ---------- S7 · A4：状态条整体"从上方落下 + 淡入"----------
        // 为什么是"下落"而不是"淡入"：这些元素在视觉上是**从上往下读**的
        // （关卡名 → 进度 → 已清计数 → 提示），让它们错落地"落"下来，
        // 视线会被自然地带到牌堆上；纯粹淡入则没有方向感。
        // 这里只登记「节点 + 它的目标 y」，真正的动画在 onEnter 里播
        // （构建期页面还不可见，播了也白播）。
        this._hudItems = [
            { node: header, y: 0 },
            { node: titleLabel.node, y: L.HEADER_Y },
            { node: this._timeLabel.node, y: L.HEADER_Y },
            { node: line, y: L.HEADER_LINE_Y },
            { node: progressRoot, y: L.BAR_Y },
            { node: this._countLabel.node, y: L.COUNT_Y },
            { node: tip.node, y: L.TIP_Y },
        ];
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
            fontSize: CFG.FONT.SIZE_TINY, color: CFG.COLOR.INK_SOFT,
        });
        this._tempLabelNode = label.node;

        this.drawTempRack();
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

        // 底部返回
        const back = createNode('BackBtn', parent, { w: L.BACK_BTN_W, h: L.BACK_BTN_H });
        back.setPosition(0, L.BACK_BTN_Y, 0);
        this._backBtnNode = back;
        const bg = back.addComponent(Graphics);
        fillBox(bg, 0, -CFG.SHAPE.CARD_DEPTH, L.BACK_BTN_W, L.BACK_BTN_H, CFG.SHAPE.RADIUS_BTN, CFG.COLOR.INK, 150);
        fillBox(bg, 0, 0, L.BACK_BTN_W, L.BACK_BTN_H, CFG.SHAPE.RADIUS_BTN, CFG.COLOR.FACE);
        strokeBox(bg, 0, 0, L.BACK_BTN_W, L.BACK_BTN_H, CFG.SHAPE.RADIUS_BTN, CFG.COLOR.INK, 2.6);
        createLabel(back, '返 回', {
            fontSize: CFG.FONT.SIZE_BODY, color: CFG.COLOR.INK, bold: true,
        });
        back.on(Node.EventType.TOUCH_END, () => {
            if (this._modal) return;
            this.goto('levelSelect');
        }, back);
    }

    /**
     * 重画槽位条。
     * 「加槽」道具会改变容量，所以这个方法必须能在运行中被再调一次 ——
     * 槽格的宽度是**按容量算出来的**，容量一变整条都要重画。
     */
    private drawSlotBar(): void {
        const L = CFG.GAME_LAYOUT;
        const g = this._slotBarG;
        if (!g) return;
        g.clear();
        fillBox(g, 0, 0, L.SLOT_BAR_W, L.SLOT_BAR_H, 4, CFG.COLOR.FACE);
        strokeBox(g, 0, 0, L.SLOT_BAR_W, L.SLOT_BAR_H, 4, CFG.COLOR.INK, 2.6);

        // 空槽位：只画描边，不填色 —— 空与满一眼可分
        const slotW = this.slotWidth();
        const cellH = L.SLOT_BAR_H - CFG.GAMEPLAY.SLOT_INSET_Y * 2;
        for (let i = 0; i < this._slotCapacity; i++) {
            strokeBox(g, this.slotOffsetX(i), 0, slotW, cellH,
                CFG.SHAPE.RADIUS_SLOT, CFG.COLOR.INK, 1.1, 115);
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

    /** 画警戒层：只描剩余空位的框 */
    private drawSlotWarn(fromIndex: number): void {
        const g = this._warnG;
        if (!g) return;
        const L = CFG.GAME_LAYOUT;
        g.clear();
        const slotW = this.slotWidth();
        const cellH = L.SLOT_BAR_H - CFG.GAMEPLAY.SLOT_INSET_Y * 2;
        for (let i = fromIndex; i < this._slotCapacity; i++) {
            strokeBox(g, this.slotOffsetX(i), 0, slotW, cellH,
                CFG.SHAPE.RADIUS_SLOT, CFG.COLOR.VERMILION, CFG.MOTION.WARN_LINE);
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
            const btn = createNode(`Prop_${def.id}`, parent, { w: L.PROP_BTN_W, h: L.PROP_BTN_H, x, y: L.PROP_BAR_Y });
            const depthNode = createNode('Depth', btn, { w: L.PROP_BTN_W, h: L.PROP_BTN_H, y: -CFG.SHAPE.BTN_DEPTH });
            const dg = depthNode.addComponent(Graphics);
            fillBox(dg, 0, 0, L.PROP_BTN_W, L.PROP_BTN_H, CFG.SHAPE.RADIUS_BTN, CFG.COLOR.INK, 150);

            const face = createNode('Face', btn, { w: L.PROP_BTN_W, h: L.PROP_BTN_H });
            const fg = face.addComponent(Graphics);
            this._propFaces[def.id] = fg;

            // D2 的"图标亮度提升"：一张只填白色的圆角层，平时全透明，
            // 按下时短暂亮起。用叠白而不是改底色，是因为底色还要承担
            // "可用 / 就绪（金）/ 不可用（灰）"三种语义，不能被按压态污染。
            const glow = createNode('Glow', face, { w: L.PROP_BTN_W, h: L.PROP_BTN_H });
            const glowG = glow.addComponent(Graphics);
            fillBox(glowG, 0, 0, L.PROP_BTN_W, L.PROP_BTN_H, CFG.SHAPE.RADIUS_BTN, CFG.COLOR.FACE);
            const glowOp = glow.addComponent(UIOpacity);
            glowOp.opacity = 0;
            this._propGlows[def.id] = glowOp;

            const name = createLabel(face, def.name, {
                y: L.PROP_NAME_DY, fontSize: CFG.FONT.SIZE_BODY + 2,
                color: CFG.COLOR.FACE, bold: true, serif: true,
            });
            const sub = createLabel(face, '', {
                y: L.PROP_SUB_DY, fontSize: CFG.FONT.SIZE_TINY, color: CFG.COLOR.FACE, w: L.PROP_BTN_W - 16,
            });
            this._propNames[def.id] = name;
            this._propSubs[def.id] = sub;

            this._propNodes[def.id] = btn;

            // D2：按压反馈。**与 B1 共用同一组常量**（CFG.MOTION.TAP_DOWN /
            // TAP_DOWN_SCALE / EASE）—— 道具按钮与牌如果按压手感不一致，
            // 玩家会觉得"有两套物理规则"，那是最廉价的不精致。
            const press = () => {
                if (this._modal) return;
                MotionFx.to(btn, { scale: v3(CFG.MOTION.TAP_DOWN_SCALE, CFG.MOTION.TAP_DOWN_SCALE, 1) },
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

    /** 重画某个道具按钮的面（可用 = 朱红 + 角花；不可用 = 纸灰 + 无角花） */
    private drawPropFace(id: PropId, enabled: boolean, armed: boolean): void {
        const g = this._propFaces[id];
        if (!g) return;
        const L = CFG.GAME_LAYOUT;
        g.clear();
        if (enabled) {
            // 就绪态用金色：与"已被按下、正在等玩家下一步"区分开
            fillBox(g, 0, 0, L.PROP_BTN_W, L.PROP_BTN_H, CFG.SHAPE.RADIUS_BTN,
                armed ? CFG.COLOR.GOLD : CFG.COLOR.VERMILION);
            strokeBox(g, 0, 0, L.PROP_BTN_W, L.PROP_BTN_H, CFG.SHAPE.RADIUS_BTN, CFG.COLOR.INK, 2.6);
            this.drawFaceCorners(g, L.PROP_BTN_W, L.PROP_BTN_H);
        } else {
            fillBox(g, 0, 0, L.PROP_BTN_W, L.PROP_BTN_H, CFG.SHAPE.RADIUS_BTN, CFG.COLOR.LOCK_BG);
            strokeBox(g, 0, 0, L.PROP_BTN_W, L.PROP_BTN_H, CFG.SHAPE.RADIUS_BTN, CFG.COLOR.LOCK, 2);
        }
        const nc = enabled ? CFG.COLOR.FACE : CFG.COLOR.INK_SOFT;
        const nameLabel = this._propNames[id];
        if (nameLabel) nameLabel.color = hex2color(nc);
        const subLabel = this._propSubs[id];
        if (subLabel) subLabel.color = hex2color(enabled ? CFG.COLOR.FACE : CFG.COLOR.INK_SOFT);
    }

    /** 按钮内的四角浅色角花（与 createButton 保持同一形制，只是不透明地画在这里） */
    private drawFaceCorners(g: Graphics, w: number, h: number): void {
        const len = CFG.SHAPE.CORNER_LEN * 0.6;
        const x0 = -w / 2;
        const x1 = w / 2;
        const y0 = -h / 2;
        const y1 = h / 2;
        g.lineWidth = 1.6;
        g.strokeColor = hex2color(CFG.COLOR.FACE, 200);
        const seg = (pts: number[][]) => {
            g.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
            g.stroke();
        };
        seg([[x0, y1 - len], [x0, y1], [x0 + len, y1]]);
        seg([[x1 - len, y1], [x1, y1], [x1, y1 - len]]);
        seg([[x1, y0 + len], [x1, y0], [x1 - len, y0]]);
        seg([[x0 + len, y0], [x0, y0], [x0, y0 + len]]);
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
            // A1/A2 改版（S7.5）：起始态 = 屏幕外正上方 + 随机横移 + 随机角度 + 全透明。
            //
            // 【为什么在 build 期就摆好，而不是等 onEnter 再摆出去】
            // 页面是"先淡入、再播入场动画"的。如果这里仍把牌摆在自己的位置上、
            // 等到 onEnter 才挪到天上，玩家会看到"牌先在正确位置闪一帧，
            // 然后集体跳上去再飞下来" —— 这是最典型的入场瑕疵。
            // 起始态必须在**它第一次被看见之前**就摆好。
            //
            // 【随机值也在这里定死】
            // playEnterMotion 会直接复用这个位置当起点（不再重新随机）。
            // 重新随机一次的后果是**起点跳变**：牌在可见的第一帧瞬移一下。
            view.node.setPosition(
                t.x + (Math.random() * 2 - 1) * M.FLY_IN_SPREAD_X,
                t.y + M.FLY_IN_FROM_Y,
                0,
            );
            view.node.angle = (Math.random() * 2 - 1) * M.FLY_IN_ANGLE;
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

        // ⚠️ S7.5 起牌堆层**不再整体缩放 / 淡出**。
        //    入场改成逐张飞入后，每张牌自己负责自己的淡入；
        //    如果这里还保留整体淡入，先飞进来的那几张会被"淡上再淡"，
        //    看起来比后面的牌更透明 —— 一条时间轴上出现两种淡入速度。
        //    （旧值 ENTER_SCALE_FROM / 整层 setFade(0) 已随之废弃。）
    }

    // ========================================================
    //  动效：入场（A1 / A2 / A3 / A4 / A5）
    // ========================================================
    /**
     * 入场总编排（S7.5 改版：牌堆由「整体浮现」改为「**逐张飞入**」）。
     *
     * 【用户原话】"入场时逐张飞入"
     *
     * 【为什么旧版不算"飞入"】
     * 旧版的牌**从头到尾都在自己的位置上**，只改了透明度和缩放 ——
     * 玩家看到的是"一张一张亮起来"，不是"一张一张飞进来"。
     * 差别不在"有没有动画"，而在**有没有空间轨迹**：
     * 轨迹产生了"牌从别处来、落到这里"的叙事，入场这才变成"发牌"。
     *
     * 【时间轴】
     *   t=0          底部三件套滑入 + 槽格描边依次点亮（A3）
     *                顶部状态条下落淡入（A4）
     *   0 ~ 1.05s    每张牌按**深度升序**从屏幕上方飞入（A1/A2 合并）：
     *                  · 位移用 backOut（到位瞬间有过冲 = "啪"地扣上去）
     *                  · 旋转从随机角度归零（"翻正"与"落下"必须是同一件事）
     *                  · 淡入只占前半程（后程要能看清落下来的是什么牌）
     *                  · 落位挤压（squash & stretch）+ 落牌声（节流）
     *   末尾         首层可点牌做一次上浮提示（仅第 1 关，A5）
     *
     * 【为什么按深度升序（底层先落）】
     * 底下的牌先落、上面的牌后压上去，顺序与"谁压住谁"的视觉逻辑一致。
     * 反过来（顶层先落）会出现"上面的牌已经就位了、下面的牌还在天上飞"，
     * 看起来像穿模。
     *
     * 【为什么入场期间仍然要锁输入】
     * 飞行中每张牌的位置都在变，而命中测试用的是**数据坐标**；
     * 这时候点下去，玩家点的是"他看见的位置"，判定却按落点算 —— 必然错位。
     * 锁 1 秒的代价，远小于"点了没反应 / 点错牌"的代价。
     * ⚠️ 解锁必须走 setTimeout（铁律），不能用 tween 回调。
     */
    private playEnterMotion(): void {
        const M = CFG.MOTION;
        const L = CFG.GAME_LAYOUT;
        const tiles = this._layout.tiles;
        const n = tiles.length;

        // ---------- A1 / A2：逐张飞入 ----------
        // 飞入顺序：深度升序（底层的先落到）
        const order: number[] = [];
        for (let i = 0; i < n; i++) order.push(i);
        order.sort((a, b) => tiles[a].depth - tiles[b].depth);

        // 错峰预算：牌多时**压缩间隔**，而不是把入场拉长到 2 秒。
        // （第 4 关 24 张 × 28ms = 644ms，仍在 1.05s 预算内，不会真的被压缩；
        //   这条兜底是为将来"牌数再翻倍"准备的。）
        const budget = Math.max(0, M.FLY_IN_TOTAL_MAX - M.FLY_IN);
        const stagger = n > 1 ? Math.min(M.FLY_IN_STAGGER, budget / (n - 1)) : 0;

        for (let k = 0; k < n; k++) {
            const id = order[k];
            const v = this._views[id];
            const t = tiles[id];
            if (!v || !v.node.isValid) continue;

            const delay = k * stagger;

            // 起点**不重新随机** —— 直接沿用 buildStack 里摆好的那个点。
            // 重新随机一次的后果是"起点跳变"：牌在它可见的第一帧瞬移一下。
            MotionFx.to(v.node, { position: v3(t.x, t.y, 0) },
                { duration: M.FLY_IN, delay, easing: EASE.POP, tag: TAG.STACK });
            // 旋转归位：与位移同长同期，视觉上"摆正"和"落下"是一件事。
            // ⚠️ 归的是**这张牌自己的目标朝向** t.angle（0/90/180/270），不是 0 ——
            //    入场时牌带着随机小角度飞过来，落定必须回到它在牌堆里的摆放方向。
            // 用独立通道 TAG.SPIN —— 它和 TAG.STACK 改的是不同属性，
            // 共用一个 tag 只会互相打断（后起的把先起的 stop 掉）。
            MotionFx.to(v.node, { angle: t.angle },
                { duration: M.FLY_IN, delay, easing: EASE.POP, tag: TAG.SPIN });
            // 淡入只占前半程（0.55）。后程必须完全不透明：
            // 牌在最后 150ms 是要被"看清是什么牌"的，那时还半透明就是废动作。
            MotionFx.fade(v.node, 255, M.FLY_IN * 0.55,
                { delay, easing: EASE.ENTER, tag: TAG.FADE });

            // 落位挤压 + 落牌声：各自一个定时器（不走 tween 回调）
            setTimeout(() => this.onFlyInLand(v, t.x, t.y, t.angle),
                MotionFx.unlockMs(delay + M.FLY_IN));
        }
        const flyDone = stagger * Math.max(0, n - 1) + M.FLY_IN + M.FLY_IN_SQUASH;

        // ---------- A3：底部（槽位条 / 暂存架 / 返回）滑入 + 槽格依次点亮 ----------
        // 只做"底部三件套"一起滑：单独滑槽位条会让暂存架悬在半空，
        // 那一帧的排版是错的（玩家会看到"东西错位了一下"）。
        const bottomNodes: Array<{ node: Node; y: number }> = [
            { node: this._slotBarNode, y: L.SLOT_BAR_Y },
            { node: this._tempRackNode, y: L.TEMP_RACK_Y },
            { node: this._tempLabelNode, y: L.TEMP_RACK_Y },
            { node: this._backBtnNode, y: L.BACK_BTN_Y },
        ];
        for (const b of bottomNodes) {
            if (!b.node || !b.node.isValid) continue;
            b.node.setPosition(b.node.position.x, b.y + M.SLOT_IN_FROM_Y, 0);
            MotionFx.to(b.node, { position: v3(b.node.position.x, b.y, 0) },
                { duration: M.SLOT_IN, easing: EASE.POP, tag: TAG.ENTER });
        }
        this.playSlotCellLightUp();

        // ---------- A4：顶部状态条下落淡入（与 A3 并行）----------
        for (const item of this._hudItems) {
            if (!item.node || !item.node.isValid) continue;
            MotionFx.setFade(item.node, 0);
            item.node.setPosition(item.node.position.x, item.y + M.HUD_IN_FROM_Y, 0);
            MotionFx.to(item.node, { position: v3(item.node.position.x, item.y, 0) },
                { duration: M.HUD_IN, easing: EASE.ENTER, tag: TAG.ENTER });
            MotionFx.fade(item.node, 255, M.HUD_IN, { easing: EASE.ENTER, tag: TAG.FADE });
        }

        // ---------- 解锁输入 ----------
        // 取"最慢的一条 + 余量"：逐张飞入、槽位滑入、HUD 下落里最长的那个。
        const total = Math.max(flyDone, M.SLOT_IN + M.SLOT_IN_STAGGER * this._slotCapacity, M.HUD_IN);
        this._busy = true;
        setTimeout(() => {
            if (!this.node.isValid) return;
            // 兜底复位：无论动效链路是否正常，终值一定要写死到位。
            // 入场这里尤其关键 —— 一旦某条 tween 丢了，那张牌会**永久停在屏幕外**，
            // 表现为"这张牌凭空消失了"，而玩家完全不知道发生了什么。
            // 所以位置也要按数据坐标复位，不能只复位 scale / opacity。
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
     * 单张牌落位（逐张飞入的收尾）：兜底复位 → 挤压 → 落牌声。
     *
     * 【为什么每张牌都要"兜底复位"】
     * 这个 setTimeout 是"必然执行"路径上的一环。哪怕位移补间因为任何原因
     * 没跑到终点，这里也会把牌写回精确坐标 —— 玩家永远不会看到一张
     * 卡在半空的牌。铁律的另一半：复位走定时器，不依赖 tween 回调。
     */
    private onFlyInLand(v: TileView, x: number, y: number, angle: number): void {
        if (!this.node.isValid || !v.node.isValid) return;
        const M = CFG.MOTION;

        v.node.setPosition(x, y, 0);
        v.node.angle = angle;
        MotionFx.setFade(v.node, 255);
        MotionFx.setScale(v.node, 1);

        // 落位挤压：横向一撑、纵向一压，再弹回 1.0。
        // 两条独立 tween 抢 scale 会有重叠帧，所以必须走 to2 的一条链。
        MotionFx.to2(v.node,
            { props: { scale: v3(M.SQUASH_X, M.SQUASH_Y, 1) },
              duration: M.FLY_IN_SQUASH * 0.35, easing: EASE.EXIT },
            { props: { scale: v3(1, 1, 1) },
              duration: M.FLY_IN_SQUASH * 0.65, easing: EASE.POP },
            { tag: TAG.SLOT });

        // 落牌声。gapMs 放宽到 FLY_IN_LAND_GAP_MS：
        // 24 张牌在 1 秒内落地，不节流会糊成一段白噪声；
        // 错开到 130ms 一声才是"哒、哒、哒"的落牌感。
        AudioService.play('land', {
            gain: M.FLY_IN_LAND_GAIN,
            gapMs: M.FLY_IN_LAND_GAP_MS,
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
     * B1 触摸按下：牌**立刻**缩到 0.96 并下压 2px。
     *
     * 【为什么必须在 TOUCH_START 而不是 TOUCH_END】
     * 这是"手感"里唯一一条不能商量的：人对"我按到了"的判定发生在手指落下的
     * 那一瞬间，超过 ~80ms 没有反馈就会被读成"这点不动"。
     * 而 TOUCH_END 要等抬手，抬手本身就有几十到几百毫秒的随机延迟 ——
     * 反馈的不确定性比反馈的幅度更伤人。
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
        MotionFx.to(v.node,
            { position: v3(t.x, t.y - CFG.MOTION.TAP_DOWN_DY, 0),
              scale: v3(CFG.MOTION.TAP_DOWN_SCALE, CFG.MOTION.TAP_DOWN_SCALE, 1) },
            { duration: CFG.MOTION.TAP_DOWN, easing: EASE.MOVE, tag: TAG.PRESS });
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

        if (this._busy || this._over || this._modal) return;

        // 「消除」就绪时，本页进入"只认槽内牌"的子模式
        if (this._armedRemove) {
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
            if (tempHit.where === 'temp') this.takeFromTemp(tempHit.index);
            return;
        }

        // ② 从上往下扫：一次点击只认最上面那张
        const id = this.hitStackTile(local);
        if (id < 0) return;

        if (this._blocked[id] > 0) {
            // B6：命中的是被压住的牌 → **必须给出拒绝反馈**。
            // 不"穿透"去找下面那张 —— 玩家点的是他看见的那张。
            // 但"点了没反应"是绝对不能接受的：玩家会以为游戏卡了。
            this.rejectBlocked(id);
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
            // 命中区必须用**这张牌旋转后的视觉包围盒**：
            // 横躺的牌是"宽 114 × 高 85"，拿竖放尺寸去判会点不中两端、又误中上下。
            const b = boxOf(t);
            if (Math.abs(local.x - t.x) > b.hw || Math.abs(local.y - t.y) > b.hh) continue;
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
        // 用**这张牌自己的旋转后包围盒**，不是全局的 TILE.W/H：
        // 牌现在可以躺倒（宽 = 牌高 114），拿竖放尺寸去判会"点不中两端、
        // 又误中上下"，撤销就变成了碰运气。
        const t = this._layout.tiles[p.id];
        const b = t ? boxOf(t) : { hw: CFG.TILE.W / 2, hh: CFG.TILE.H / 2 };
        return Math.abs(local.x - p.ox) <= b.hw && Math.abs(local.y - p.oy) <= b.hh;
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
                + ` 选中 ${Math.round(M.PICK_SELECT * 1000)}ms + 飞行 ${Math.round(flySec * 1000)}ms`
                + ` → 落位倒计时 ${Math.round(MotionFx.unlockMs(M.PICK_SELECT + flySec))}ms`);
        }

        // 起飞音：'pick' 是"呲"的一声上行扫频，对应"牌离手"这个动作。
        // 它和落位音 'land'（"咔"）是一对，两者相隔一次飞行的时间（约 300ms），
        // 听觉上正好是"呲——咔"，把"离手→到位"这条因果链补全。
        AudioService.play('pick');

        // ⑥ B2 选中：上浮 + 放大 + 朱红描边到 3px（描边由 TileView 的 pick 态绘制）
        view.setState('pick');
        // ⑦ B3 飞行：两段式的一条链，选中段与飞行段的交界严格首尾相接
        MotionFx.to2(view.node,
            { props: { position: v3(fromFx.x, fromFx.y + M.PICK_LIFT, 0),
                       scale: v3(M.PICK_SCALE, M.PICK_SCALE, 1) },
              duration: M.PICK_SELECT, easing: EASE.POP },
            { props: { position: targetFx, scale: v3(scale, scale, 1) },
              duration: flySec, easing: EASE.MOVE },
            { tag: TAG.FLY });

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

        // ④ 聚拢走完再判定（这就是"先聚拢、后消除"的落地方式）
        setTimeout(() => {
            if (!this.node.isValid) return;
            this._busy = false;
            this.afterInsert(insertAt);
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
     * 播放消除。**按牌型分两套动效**（S7.5，2026-09-30 修正）。
     *
     *   碰 / 杠 → 撞击（playClashClear）：三张/四张**碰在一起**，然后消除
     *   吃      → 流水汇合（playFlowClear）：三张**依次柔顺滑拢**，然后淡出
     *
     * 【为什么要分两套 —— 用户原话就是这个意思】
     *   "碰的效果是三张牌碰在一起，然后消除，
     *    连章是使用一个丝滑的动效来表示"
     *   〔术语订正〕用户当时说的「连章」指的是「吃」= **顺子**
     *   （234条 / 456万）= MatchRule 里的 `chi`。这与本节实现一致。
     *
     * ⚠️ 【术语，务必读】「连章」现在的定义是**连击**（限时窗口内连续消除的
     *    计数），和「吃」是两回事，本作**不需要**。初版把它误当成"用户想要
     *    的新玩法"，做了一整套流光带 + 「连章 ×N」层数 + 4 档递增音高；
     *    而真正的「吃」当时和「碰」**共用同一套撞击动效**。结果是用户要的
     *    两样东西，一样做错了、另一样根本没做。那套连击机制已整体删除
     *    （动机与痕迹见 CFG.MOTION §十五）。**别再让「连章」进入玩法/动效/音效。**
     */
    private playClear(m: MatchResult): void {
        // 这一行是**验证两套动效的唯一线索**：它同时说明"消的是哪种牌型"和
        // "走了哪套动效"。没有它，无头跑完一关只能看到"已清 N/M"，
        // 根本不知道中间有没有出现过「吃」—— 而「吃」在 L1/L2 里**根本不可能
        // 出现**（pickPatterns 给那两关的同族连号少于 3 个，凑不出顺子），
        // 所以"没看到吃"到底是"没触发"还是"没实现"，只能靠这行区分。
        if (CFG.DEBUG.LOG_STATE) {
            const keys = m.indices.map((i) => this._slots[i].key).join(' ');
            log(`[GamePage] 消除 牌型=${m.type}(${MATCH_LABEL[m.type]}) 张数=${m.indices.length}`
                + ` → 动效=${m.type === 'chi' ? '流水汇合' : '撞击'} ｜ ${keys}`);
        }

        if (m.type === 'chi') this.playFlowClear(m);
        else this.playClashClear(m);
    }

    /**
     * 碰 / 杠的**撞击**：蓄力 → 冲刺 → 撞上 → 停一拍 → 一起炸开。
     *
     * 【旧版为什么不够"碰"】
     * 旧版的三张牌**从头到尾都待在自己的槽格里**：上浮、放大、再缩到 0。
     * 也就是说，它们之间从来没有发生过任何**空间关系** ——
     * 玩家看到的是"三张牌各自胀了一下"，而不是"三张牌撞到了一起"。
     * 差距全在下面这条时间轴上，而不在"幅度够不够大"。
     *
     * 【时间轴】（碰 / 杠。「吃」走的是另一套，见 playFlowClear）
     *   t=0           蓄力：三张牌朝**远离中心**的方向各退 12px（攒势）
     *   t=90ms        冲刺：quadIn 加速，朝中心猛冲，最终中心间距压到槽格宽的 45%
     *   t=200ms       ★ 撞击帧：挤压(squash & stretch) + 冲击圆环 + 碎屑
     *                            + 牌堆上踢 + "碰"音 + 中档震动
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
        // 碰 / 杠的三、四张牌**牌面完全相同** → 允许叠得很狠（叠了也不丢信息，
        // 看到的就是"一张变厚了的牌"，那正是"三合一"的观感）。
        // ⚠️ 「吃」不走这条路 —— 它的三张牌面各不相同，另有 playFlowClear。
        const span = slotW * M.CLASH_OVERLAP_PENG;

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

        // ① 声音与触感 —— 这是全局唯一"值得震"的瞬间
        AudioService.play('peng');
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
        //    理由见 CFG.MOTION.CLASH_KICK 的注释）
        this.kickStack();

        // ⑥ 飘字：把牌型名说出来（碰 / 吃 / 杠）。
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
     * 消除之后的**数据收尾** —— 撞击（碰/杠）与流水汇合（吃）两条动效路径共用。
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
        // 于是连锁里出现的「吃」也会正确地走流水汇合动效。
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
     * 「吃」的**流水汇合**（S7.5，2026-09-30 修正）。
     *
     * 【术语】「吃」= **顺子**（234条 / 456万）= MatchRule 里的 `chi`。
     *        用户原话："连章是使用一个丝滑的动效来表示"
     *        —— 此处用户说的「连章」就是指「吃」，本节照此实现。
     *        ⚠️ 但「连章」另有定义 = **连击**（限时窗口内连续消除的计数），
     *        本作不需要，那套机制已整体删除，与本节无关。
     *
     * 【时间轴】
     *   t = 0              三张牌**依次**起步（错峰 FLOW_STAGGER = 70ms）
     *   每张：sineInOut 柔顺滑向中心，耗时 FLOW_SLIDE = 300ms
     *   全部到齐（≈ 440ms）后停 FLOW_HOLD = 50ms，把"汇成一处"看清
     *   然后               一起轻微上浮 + 淡出（FLOW_LIFT / FLOW_FADE）
     *
     * 【与撞击互为反面 —— 这是"丝滑"的全部内容】
     *   ① **没有蓄力** —— 蓄力是"攒势准备撞"，与"水流"的语义正好相反；
     *   ② 全程 sineInOut：首尾速度为零，起步和停下都看不见棱角
     *      （撞击用 quadIn，越冲越快，故意有棱角）；
     *   ③ **没有挤压 / 冲击环 / 碎屑 / 牌堆上踢** ——
     *      这些元素本身就携带"冲击"的语义，加上去就不丝滑了；
     *   ④ 结束**不缩放**，只上浮 + 淡出（缩放是"炸开"的语言）。
     *   音效同理：不用 peng（撞击）而用 flow（水流）。
     *
     * ★ 一句话：**丝滑是减出来的，不是加出来的。**
     */
    private playFlowClear(m: MatchResult): void {
        const M = CFG.MOTION;
        this._busy = true;

        for (const i of m.indices) this._slots[i].view.setState('clear');

        const doomed = m.indices.map((i) => this._slots[i].view);
        const n = doomed.length;
        const centerX = this.clashCenterX(m.indices);
        const centerY = CFG.GAME_LAYOUT.SLOT_BAR_Y;
        const span = this.slotWidth() * M.FLOW_OVERLAP;

        // 依次汇入，**只有一段**（没有"蓄力 → 冲刺"的分解）——
        // 那段分解里的急停，正是"撞击感"的来源。
        for (let k = 0; k < n; k++) {
            const v = doomed[k];
            if (!v.node.isValid) continue;
            const tx = centerX + (k - (n - 1) / 2) * span;
            // ⚠️ `MotionFx.to` 的第二参是**属性表**（{position}），不是 chain 的 step
            //    形状（{props, duration, easing}）。传错不会报"未知属性"，
            //    而是每帧在引擎里抛 TypeError —— 详见 MotionFx.to 的 JSDoc。
            MotionFx.to(v.node,
                { position: v3(tx, centerY, 0) },
                { duration: M.FLOW_SLIDE, easing: EASE.IDLE,
                  tag: TAG.SLOT, delay: k * M.FLOW_STAGGER });
        }

        // 音效在**第一张起步时**就响，让它覆盖整段滑行。
        // 若等汇齐才响，听起来就是"撞上了"—— 又变回碰的听感。
        AudioService.play('flow');

        // 震动仍是中档：它表达的是"你消成了"，与视觉的软硬无关。
        // （想让"吃"更轻，把这里换成 Haptics.light() 即可，一行的事。）
        Haptics.medium();

        const allIn = M.FLOW_SLIDE + Math.max(0, n - 1) * M.FLOW_STAGGER;
        setTimeout(() => {
            if (!this.node.isValid) return;
            this.releaseFlow(doomed, m, centerY);
        }, MotionFx.unlockMs(allIn + M.FLOW_HOLD));
    }

    /**
     * 流水汇合的收束：三张一起**轻微上浮 + 淡出**（全程不缩放），
     * 然后交给 finalizeClear 做数据收尾。
     *
     * 【为什么上浮而不是原地淡出】
     * 纯原地淡出看起来像"被删掉了"（程序感）；上浮 22px 给出方向，
     * 才像"水流走了"。方向感是"流水"这个意象的必要组成部分。
     */
    private releaseFlow(doomed: TileView[], m: MatchResult, centerY: number): void {
        const M = CFG.MOTION;

        for (const v of doomed) {
            if (!v.node.isValid) continue;
            MotionFx.to(v.node,
                { position: v3(v.node.position.x, centerY + M.FLOW_LIFT, 0) },
                { duration: M.FLOW_FADE, easing: EASE.IDLE, tag: TAG.SLOT });
            MotionFx.fade(v.node, 0, M.FLOW_FADE, { easing: EASE.IDLE, tag: TAG.FADE });
        }

        setTimeout(() => {
            if (!this.node.isValid) return;
            this.finalizeClear(doomed, m);
        }, MotionFx.unlockMs(M.FLOW_FADE));
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
     */
    private kickStack(): void {
        const M = CFG.MOTION;
        if (!this._stackLayer || !this._stackLayer.isValid) return;
        MotionFx.to2(this._stackLayer,
            { props: { position: v3(0, M.CLASH_KICK, 0) },
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
     * C6 飘字：从消除位置上浮 40px 并淡出，「碰 / 吃 / 杠」大字。
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
    private popMatchLabel(type: keyof typeof MATCH_LABEL): void {
        const layer = this._fxLayer;
        if (!layer || !layer.isValid) return;
        const M = CFG.MOTION;

        // 起点取槽位条上方一点：飘字是"从消除的位置长出来的"，
        // 从屏幕正中冒出来会失去它和槽位的空间联系。
        const startY = CFG.GAME_LAYOUT.SLOT_BAR_Y + 130;
        const label = createLabel(layer, MATCH_LABEL[type], {
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

        if (this._barG) {
            const g = this._barG;
            const L = CFG.GAME_LAYOUT;
            g.clear();
            fillBox(g, 0, 0, L.BAR_W, L.BAR_H, 0, CFG.COLOR.INK, 30);
            const ratio = total > 0 ? this._cleared / total : 0;
            if (ratio > 0) {
                g.fillColor = hex2color(CFG.COLOR.VERMILION);
                g.rect(-L.BAR_W / 2, -L.BAR_H / 2, L.BAR_W * ratio, L.BAR_H);
                g.fill();
            }
        }

        if (this._countLabel) {
            this._countLabel.string = `已清 ${this._cleared} / ${total}`;
        }
        if (this._timeLabel) {
            this._timeLabel.string = this.timeText();
        }
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
        // 入场动效必须先播：PageManager 是在转场结束（也就是本页完全可见）之后
        // 才调 onEnter 的，这里才是"观众已经就座"的时刻。
        this.playEnterMotion();

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
            toast(this.root, `通关！用时 ${this._usedTime} 秒${isRecord ? ' · 新纪录' : ''}`, 2.2);
            // 结算后延迟一点回关卡页（S7 会换成正式的结算面板）
            setTimeout(() => {
                if (!this.node.isValid) return;
                this.goto('levelSelect');
            }, 2000);
            return;
        }

        this.showFailPanel();
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

        const panel = createNode('FailPanel', mask, { w: F.PANEL_W, h: F.PANEL_H, y: F.PANEL_Y });
        const pg = panel.addComponent(Graphics);
        fillBox(pg, 0, 0, F.PANEL_W, F.PANEL_H, CFG.SHAPE.RADIUS_PANEL, CFG.COLOR.FACE);
        strokeBox(pg, 0, 0, F.PANEL_W, F.PANEL_H, CFG.SHAPE.RADIUS_PANEL, CFG.COLOR.INK, 3);
        panel.on(Node.EventType.TOUCH_END, (e: EventTouch) => { e.propagationStopped = true; });

        createLabel(panel, why, {
            y: F.TITLE_DY, fontSize: CFG.FONT.SIZE_TITLE - 8,
            color: CFG.COLOR.VERMILION, bold: true, serif: true,
        });
        createLabel(panel, `已清 ${this._cleared} / ${this._layout.tiles.length} · 还剩 ${this._left} 张`,
            { y: F.REASON_DY, fontSize: CFG.FONT.SIZE_SMALL, color: CFG.COLOR.INK_SOFT });

        // ① 复活：可选的最优解，插在第一位，但**不是唯一出路**
        //    文案里的张数**从参数算**，不写死 4 —— 「加槽」后槽容量变 9，
        //    清掉一半就是 5，写死会与复活后的实际结果对不上（玩家会发现）。
        {
            const reviveClear = Math.ceil(CFG.GAMEPLAY.SLOT_CAPACITY
                * CFG.REWARD.REVIVE_CLEAR_RATIO);
            createButton(panel, 'ReviveBtn', {
                y: F.REVIVE_DY, w: F.BTN_W, h: F.BTN_H,
                // 文案刻意短：初版「看广告复活（清空槽位 + 洗牌）」在 400px 按钮里
                // 放不下（末字被裁），加宽到 448 再配 SIZE_BUTTON−12 才留出安全边距。
                text: reviveLeft > 0
                    ? `看广告复活（消 ${reviveClear} 张 + 重排）`
                    : '本关复活机会已用完',
                fontSize: CFG.FONT.SIZE_BUTTON - 12, serif: true,
                enabled: reviveLeft > 0,
                enabledFill: CFG.COLOR.LOCK_BG,
                onClick: () => { void this.doRevive(); },
            });
        }

        // ② 重开本关：永远免费的兜底
        createButton(panel, 'RestartBtn', {
            y: F.RESTART_DY, w: F.BTN_W, h: F.BTN_H,
            text: '重开本关', fontSize: CFG.FONT.SIZE_BUTTON - 8,
            fill: CFG.COLOR.FACE, textColor: CFG.COLOR.INK, stroke: CFG.COLOR.INK,
            onClick: () => { this.goto('game', { levelId: this._level.id }); },
        });

        // ③ 返回关卡页
        const backLabel = createLabel(panel, '返回关卡', {
            y: F.BACK_DY, fontSize: CFG.FONT.SIZE_BODY, color: CFG.COLOR.INK_SOFT,
            w: 240, h: 64,
        });
        backLabel.node.on(Node.EventType.TOUCH_END, () => { this.goto('levelSelect'); });

        this._failPanel = mask;
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
