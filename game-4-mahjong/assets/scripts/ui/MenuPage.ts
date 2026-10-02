/**
 * ============================================================
 *  MenuPage.ts · 首页（S18.2 全量重写 · 方案 A「宣纸墨戏」；S19 底图化）
 * ============================================================
 *  设计源：`docs/design/game4-3d-refit/首页-优化后-1x.html`（S19 定稿）
 *  施工依据：`docs/design/game4-3d-refit/01-排版重排-规格.md`
 *
 * ------------------------------------------------------------
 *  【S18 为什么必须重写这一页】
 *  用户拍板「去掉选关页面，让用户直接开始，记录历史关卡进度」（决议 7）。
 *  于是首页要独自吞下原来由选关页承担的三件事，而**不许再加一个新页面、一个新浮层**：
 *
 *    从哪继续  →  底部主按钮的**三态文案**（存档算得出，不需要改存档结构）
 *    怎么重玩  →  主按钮右侧的小方（原地立刻再开一局，不跳页）
 *    怎么清空  →  **长按**右下角方印 1.5 秒（不可逆的操作配"慢"手势）
 *
 * ------------------------------------------------------------
 *  ★ S19 的分工**彻底变了** —— 改这一页之前必须先读这一段
 *  ------------------------------------------------------------
 *  首页的**全部装饰**现在都在底图里（`assets/resources/textures/bg-home.jpg`）：
 *      书名「麻麻大消除」/ 副标题「点牌 · 凑型 · 一路清」/ 三张实物牌 /
 *      「万·条·筒 三族各有各的图案」说明行 / 中轴竖缝 / 圆台 / 版本号 / 方印本体
 *  引擎只负责 **4 件会变的东西**：
 *      ① 右上角计数「已过 N / 4」（会随存档变）
 *      ② 主按钮（三态文案，朱红大件）
 *      ③ 「重玩」小方（纸白次级形制）
 *      ④ 提示行（三态文案，居中）+ 它的隐形热区、方印的长按热区与进度环
 *
 *  ⚠️ 所以 `buildSlit` / `buildPedestal` / `buildTicks` / 书名 Label / 主牌 TileView /
 *     版本号 Label / 方印本体 **全部删掉了**。删掉的东西**一样都不许"顺手加回来"**：
 *     底图上已经有一份，引擎再画一遍就是**重影**（两套线只差几个像素，
 *     看起来像"画毛了"，很难联想到是画了两遍 —— 这是换底图最容易踩的坑）。
 *
 *  ⚠️ 连带的第二个变化：**首页没有「?」入口了**。
 *     设计稿的底图与行内元素里都没有那枚小圆。现在**提示行整行**就是规则入口
 *     （热区 460×64，比原来 40 的小圆好按太多）。文案没变，入口反而更大了。
 *
 *  ⚠️ 第三个变化：「清空进度」的**视觉代理**换了。
 *     旧版是 4 枚刻度从右到左逐枚褪回未过态；刻度条已经烤进底图，
 *     首页不再有可逐枚褪色的对象 → 改成**计数行"闪一下再换字"**，表达同一件事。
 *
 * ------------------------------------------------------------
 *  【零棋牌语义（合规红线）】
 *  本页文案不得出现：碰 / 吃 / 杠 / 胡 / 番 / 筹码 / 得分 / 对战 / 连胜 / 排行 / 挑战。
 *  原「凑齐「碰 / 吃 / 杠」」这一行已换成属性语言的「点三张相同的牌，把它们送走」。
 * ============================================================
 */

import { _decorator, Graphics, Label, Node, Tween, UIOpacity, UITransform, tween, v3 } from 'cc';
import { CFG } from '../CFG';
import { SaveService } from '../core/SaveService';
import { AudioService } from './AudioService';
import { PageBase } from './PageBase';
import {
    createButton, createGraphicsNode, createLabel, createNode, createPaperBackground,
    strokePath,
} from './UIFactory';
import { RuleSheet } from './RuleSheet';

const { ccclass } = _decorator;

/** 秒 → mm:ss */
export function formatTime(sec: number): string {
    const s = Math.max(0, Math.round(sec));
    const mm = `${Math.floor(s / 60)}`.padStart(2, '0');
    const ss = `${s % 60}`.padStart(2, '0');
    return `${mm}:${ss}`;
}

@ccclass('MenuPage')
export class MenuPage extends PageBase {

    // --------------------------------------------------------
    //  状态
    // --------------------------------------------------------
    /** 右上角计数（存档变了要重写文案） */
    private _countLabel: Label | null = null;
    /** 主按钮文字（三态文案） */
    private _startLabel: Label | null = null;
    /** 提示行文字（三态文案） */
    private _tipLabel: Label | null = null;
    /** 方印长按：是否正在按住 */
    private _holding = false;
    /** 方印长按：按下时刻（毫秒）。用**墙钟**推进进度，不挂 tween 回调 */
    private _holdStart = 0;
    /** 方印长按的进度反馈画笔 */
    private _sealRing: Graphics | null = null;
    /** 方印热区节点（清空成功时弹一下 —— 印的本体在底图里，能弹的是这层热区） */
    private _sealNode: Node | null = null;

    // ========================================================
    //  构建
    // ========================================================
    protected onBuild(): void {
        const L = CFG.MENU_LAYOUT;
        const save = SaveService.instance;
        const total = CFG.LEVELS.length;
        const cleared = save.clearedCount;
        const curLevel = currentLevel(cleared, total);
        const allCleared = cleared >= total;

        // ---------- ① 底图（首页专用 R4：书名 / 三张牌 / 说明行 / 页框 / 方印 都在图里）----------
        //  `'home'` 这个参数就是"别拿通用底图" —— 两者视觉差一整页的内容。
        createPaperBackground(this.root, 'home');

        // ---------- ② 右上角计数（右对齐，右边界 = design +282）----------
        //  设计稿 `.gauge-txt{right:78px}` → 右边界 x = 720−78 = 642 → design 642−360 = 282。
        this._countLabel = createLabel(this.root, this.countText(allCleared, total), {
            x: L.COUNT_X, y: L.COUNT_Y, fontSize: L.COUNT_SIZE,
            color: '#57503F', bold: true,
        });
        this._countLabel.node.getComponent(UITransform)!.setAnchorPoint(1, 0.5);
        this._countLabel.node.setPosition(L.COUNT_X, L.COUNT_Y, 0);
        this._countLabel.horizontalAlign = Label.HorizontalAlign.RIGHT;

        // ---------- ③ 主按钮（三态文案；朱红大件 = 二级重心）----------
        const startBtn = createButton(this.root, 'StartButton', {
            w: L.START_BTN_W,
            h: L.START_BTN_H,
            x: L.START_BTN_X,
            y: L.START_BTN_Y,
            radius: CFG.SKIN.R3D.RADIUS_PILL,
            tone: 'redBig',                 // = GRAD.RED_MAIN + RED_DEPTH + DEPTH_BIG(9)
            text: this.startText(cleared, total),
            fontSize: L.START_BTN_FONT,
            serif: true,
            onClick: () => this.goto('game', { levelId: curLevel }),
        });
        this._startLabel = startBtn.getComponentInChildren(Label);

        // ---------- ④ 「重玩」小方（纸白次级形制，与主按钮同一排）----------
        //  【它与主按钮的分工（决议 3 + 规格 §二 修正②）】
        //  主按钮 = **进入**当前关（正常转场 + 开场动画）；
        //  小方   = **原地立刻再开一局**（`instant: true` ⇒ 跳过开场，直接发牌，
        //          见 GamePage.onEnter 对 params.instant 的处理）。
        //  本作存档里**没有局内进度**（只有 cleared[] / bestTime），所以当"这一关
        //  还没开始过"时两者行为等价 —— 这是可接受的：不多一个页面、不多一个浮层。
        createButton(this.root, 'ReplayButton', {
            w: L.REPLAY_BTN_W,
            h: L.REPLAY_BTN_H,
            x: L.REPLAY_BTN_X,
            y: L.REPLAY_BTN_Y,
            // 圆角方（radius 30），不是胶囊 —— 与主按钮的胶囊拉开形制
            radius: L.REPLAY_BTN_RADIUS,
            // 形制 = `.btn-sub{0 8px 0 #C3B89F, 0 8px 0 4px #22201C, 0 16px 22px .28}`
            //  ⚠️ 必须显式给 `depth: 8` —— `white` 色调的默认厚度是**结算页白钮**的 6，
            //  首页这颗设计稿写的是 8。
            //  ⚠️ 柔影也必须显式给 `SUB` —— `white` 色调默认挂的是**结算页白钮**的
            //  `WHITE`(18/13/.26)，而 `.btn-sub` 写的是 22/16/.28（越大的件投影越散）。
            //  （早期版本曾按 depth 线性外推柔影，被全量 CSS 推翻，见 CFG.R3D.SHADOW 的注释。）
            tone: 'white',
            depth: 8,
            shadow: CFG.SKIN.R3D.SHADOW.SUB,
            text: '重 玩',
            fontSize: L.REPLAY_BTN_FONT,
            serif: true,
            onClick: () => this.goto('game', { levelId: curLevel, instant: true }),
        });

        // ---------- ⑤ 提示行（三态，居中）+ 整行热区 = 规则入口 ----------
        this.buildTipRow(cleared, total, allCleared, save);

        // ---------- ⑥ 方印热区（长按 1.5 秒清空进度；印的本体在底图里）----------
        this.buildSeal(cleared);

        // ---------- 音频：主菜单属于"游戏外"，收掉 BGM（S14）----------
        // 【为什么写在这里，而不是写在各页的 onLeave 里】
        //  BGM 该不该响，是由"**要去哪**"决定的，所以写在目的地这一侧。
        //  如果改成"离开游戏页时停"，那么每多一条离场路径就要多记得停一次，
        //  漏掉任何一条，音乐就会跟着飘进主菜单。
        AudioService.stopBgm();
    }

    // ========================================================
    //  文案（三态，全部由存档算得出 —— 存档结构零改动）
    // ========================================================

    /** 主按钮三态文案 */
    private startText(cleared: number, total: number): string {
        if (cleared <= 0) return '开 始 · 第 1 关';
        if (cleared >= total) return `再 战 · 第 ${total} 关`;
        return `继 续 · 第 ${cleared + 1} 关`;
    }

    /** 右上角：平时是「已过 N / 4」，全通那天换成「最佳 mm:ss」 */
    private countText(allCleared: boolean, total: number): string {
        if (allCleared) return `最佳 ${formatTime(SaveService.instance.getBestTime(total))}`;
        return `已过 ${SaveService.instance.clearedCount} / ${total}`;
    }

    /** 提示行三态文案 */
    private tipText(cleared: number, total: number, allCleared: boolean, save: SaveService): string {
        if (allCleared) return `已全部通关 · 最佳 ${formatTime(save.getBestTime(total))}`;
        if (cleared <= 0) return '点三张相同的牌，把它们送走';
        return '长按右下角方印可清空进度';
    }

    // ========================================================
    //  提示行（三态）+ 规则入口
    // ========================================================
    /**
     * 提示行是**居中**的一行字（设计稿 `.abs` + `translate(-50%,-50%)` 的口径）。
     *
     * 【入口怎么进】整行就是一个热区（460×64）。旧版那枚「?」小圆只有 40×40，
     * 正好卡在单指点按的最小尺寸上，手指抖一点就点不中；把整行变成入口之后，
     * "点不中"这件事从设计上消失了。S19 底图上没有小圆，这一行**就是**入口。
     */
    private buildTipRow(cleared: number, total: number, allCleared: boolean, save: SaveService): void {
        const L = CFG.MENU_LAYOUT;
        this._tipLabel = createLabel(this.root, this.tipText(cleared, total, allCleared, save), {
            y: L.TIP_Y, w: L.TIP_HIT_W,
            fontSize: L.TIP_SIZE,
            // ★ S18 决议 5′：提示行是**信息**，必须用 INK_MID（6.70:1），不能用 INK_SOFT。
            color: CFG.COLOR.INK_MID,
        });

        const hit = createNode('RuleHitArea', this.root, { w: L.TIP_HIT_W, h: L.TIP_HIT_H });
        hit.setPosition(0, L.TIP_Y, 0);
        hit.on(Node.EventType.TOUCH_END, () => RuleSheet.open(this.root), hit);
    }

    // ========================================================
    //  方印热区 ＝ 清空进度入口（长按 1.5 秒）
    // ========================================================
    /**
     * 【为什么"清空进度"必须用长按】
     * 它是**不可逆**的破坏性操作，必须配一个"慢"的手势；
     * 而重玩是可逆的轻操作，就该快。手势的时长差异本身就是一次防误触设计，
     * 比弹一个"确定要清空吗？"的二次确认框更安静，也更符合这一页的气质。
     *
     * 【为什么进度反馈是四段折线而不是圆弧】S18 的硬直角体系里不该出现圆弧 ——
     * 长按期间方印四周长出的是「回纹极简版」的四段折线（与页框角花同一套语言）。
     * S19 换成 3D 圆角形制之后，这四段折线**保留**：它是"操作进度条"而不是装饰，
     * 直角让它与"转圈等待"这种系统语言区分开。
     *
     * 【为什么进度用墙钟推进，而不是挂 tween 回调】
     * 本项目铁律：**状态流转必须走"必然执行"的路径，动效只负责好看**。
     * 若把"清空"挂在 tween 的完成回调上，一旦链路被中断（页面切换、节点销毁、
     * 库的边界情况），回调不触发 → 状态就永久停在那里。
     * 这里改成 `schedule` + `Date.now()` 自己算进度：只有"时间到了"这一个出口。
     */
    private buildSeal(cleared: number): void {
        const L = CFG.MENU_LAYOUT;

        // ⚠️ **不画方印本体**（底图里有）。这里建的是一张与印等大的**透明热区** ——
        //    热区节点同时也是长按进度环的锚点，两者共用一个坐标来源。
        //    之所以让热区节点也承担"被 punch 缩放"的职责：底图是位图、缩不了，
        //    所以"印弹一下"这件事改成弹这层热区上的进度环与它自己的位置抖动 —— 见 doClearProgress。
        const seal = createNode('SealHit', this.root, { w: L.SEAL_SIZE, h: L.SEAL_SIZE });
        seal.setPosition(L.SEAL_X, L.SEAL_Y, 0);
        this._sealNode = seal;

        // 长按进度反馈层（独立节点，长按期间每 30ms 重绘一次）
        const ring = createGraphicsNode('SealRing', this.root, {
            w: L.SEAL_SIZE + (L.SEAL_RING_GAP + L.SEAL_RING_LEN) * 2,
            h: L.SEAL_SIZE + (L.SEAL_RING_GAP + L.SEAL_RING_LEN) * 2,
        });
        ring.node.setPosition(L.SEAL_X, L.SEAL_Y, 0);
        this._sealRing = ring.g;

        // 进度为 0 时此入口**锁死且不给任何提示** —— 没东西可清就不该有入口
        if (cleared <= 0) return;

        seal.on(Node.EventType.TOUCH_START, () => {
            this._holding = true;
            this._holdStart = Date.now();
            this.drawSealRing(0);
            this.schedule(this.tickHold, 0.03);
        }, seal);

        const cancel = (): void => {
            if (!this._holding) return;
            this._holding = false;
            this.unschedule(this.tickHold);
            this._sealRing?.clear();
        };
        seal.on(Node.EventType.TOUCH_END, cancel, seal);
        seal.on(Node.EventType.TOUCH_CANCEL, cancel, seal);
    }

    /** 长按计时（每 30ms 一次）：墙钟算进度 → 到 1 就执行清空 */
    private tickHold = (): void => {
        if (!this._holding) return;
        const p = Math.min(1, (Date.now() - this._holdStart) / (CFG.MENU_LAYOUT.SEAL_HOLD * 1000));
        this.drawSealRing(p);
        if (p >= 1) {
            // ⚠️ 先落状态、再停调度：顺序反了的话本帧之后还可能再进来一次
            this._holding = false;
            this.unschedule(this.tickHold);
            this.doClearProgress();
        }
    };

    /** 画长按进度：四段折线按顺序长出（每段两笔：先一笔、后一笔） */
    private drawSealRing(p: number): void {
        const g = this._sealRing;
        if (!g) return;
        g.clear();
        if (p <= 0) return;

        const L = CFG.MENU_LAYOUT;
        const half = L.SEAL_SIZE / 2 + L.SEAL_RING_GAP;
        const len = L.SEAL_RING_LEN;
        // 四个角的角点 + 两条边的端点（顺序：左上 → 右上 → 右下 → 左下）
        const corners: Array<{ px: number; py: number; ax: number; ay: number; bx: number; by: number }> = [
            { px: -half, py: half, ax: -half + len, ay: half, bx: -half, by: half - len },
            { px: half, py: half, ax: half - len, ay: half, bx: half, by: half - len },
            { px: half, py: -half, ax: half - len, ay: -half, bx: half, by: -half + len },
            { px: -half, py: -half, ax: -half + len, ay: -half, bx: -half, by: -half + len },
        ];
        for (let i = 0; i < corners.length; i++) {
            const q = Math.max(0, Math.min(1, p * corners.length - i));
            if (q <= 0) continue;
            const c = corners[i];
            // 第一笔：角点 → a（前半段进度）
            const qa = Math.min(1, q * 2);
            strokePath(g, [[c.px, c.py], [c.px + (c.ax - c.px) * qa, c.py + (c.ay - c.py) * qa]],
                CFG.COLOR.VERMILION, L.SEAL_RING_W);
            // 第二笔：角点 → b（后半段进度）
            const qb = Math.max(0, q * 2 - 1);
            if (qb > 0) {
                strokePath(g, [[c.px, c.py], [c.px + (c.bx - c.px) * qb, c.py + (c.by - c.py) * qb]],
                    CFG.COLOR.VERMILION, L.SEAL_RING_W);
            }
        }
    }

    /**
     * 真的清空进度：把热区"按一下" + 计数行闪一下换字 + 文案刷新。
     *
     * ⚠️ S19 起**不再有"刻度逐枚褪色"**：刻度条已经烤进底图，首页没有可逐枚
     *    褪色的对象了。改用「计数行淡出 → 换字 → 淡入」当代理 —— 它同样表达
     *    "存档被重置了"，而且落点就在玩家刚按住的那枚印的上方，视线不用跑。
     */
    private doClearProgress(): void {
        const L = CFG.MENU_LAYOUT;
        const total = CFG.LEVELS.length;

        // ① 方印（热区）缩到 SEAL_PUNCH 再弹回 1.0 —— 底图缩不了，
        //    所以这里弹的是热区节点上的进度环 + 一个轻微的位移抖动，
        //    "印被按下去"的错觉由进度环自己完成。
        const seal = this._sealNode;
        if (seal && seal.isValid) {
            Tween.stopAllByTarget(seal);
            tween(seal)
                .to(L.SEAL_PUNCH_IN * 0.34, { scale: v3(L.SEAL_PUNCH, L.SEAL_PUNCH, 1) }, { easing: 'quadOut' })
                .to(L.SEAL_PUNCH_IN * 0.66, { scale: v3(1, 1, 1) }, { easing: 'backOut' })
                .start();
        }
        this._sealRing?.clear();

        // ② 存档真的清掉（放在动效之前调用，让任何意外中断都不会留下
        //    "动画演完了、进度还在"的假象）
        SaveService.instance.reset();

        // ③ 计数行闪一下再换字（等价于旧版的"刻度褪回未过态"）
        const cnt = this._countLabel;
        if (cnt && cnt.node.isValid) {
            let op = cnt.node.getComponent(UIOpacity);
            if (!op) op = cnt.node.addComponent(UIOpacity);
            Tween.stopAllByTarget(op);
            tween(op)
                .delay(L.SEAL_PUNCH_IN)
                .to(0.10, { opacity: 0 })
                .call(() => { if (this.root.isValid) this.applyState(0, total); })
                .to(0.14, { opacity: 255 })
                .start();
        } else {
            this.applyState(0, total);
        }
    }

    /** 按给定进度重写所有依赖存档的文案（目前只有"清空后"这一条调用路径） */
    private applyState(cleared: number, total: number): void {
        const allCleared = cleared >= total;

        if (this._countLabel && this._countLabel.isValid) {
            this._countLabel.string = this.countText(allCleared, total);
        }
        if (this._startLabel && this._startLabel.isValid) {
            this._startLabel.string = this.startText(cleared, total);
        }
        // 提示行是**居中**的一行，换文案不需要重摆位置（旧版要跟着"文字 + 小圆"整体
        // 重算左边界，小圆删掉之后这段逻辑一并消失）
        if (this._tipLabel && this._tipLabel.isValid) {
            this._tipLabel.string = this.tipText(cleared, total, allCleared, SaveService.instance);
        }
    }

    // ========================================================
    //  入场 / 离场
    // ========================================================
    /**
     * ⚠️ S19 起**首页不再有自己的入场动效**，这是刻意的：
     *  旧版给"主牌"做了一个 0.96 → 1.00 的落定，因为主牌是引擎画的；
     *  现在书名、副标题、三张实物牌全部烤在底图里 —— 位图**整块**，动不了。
     *  只给引擎画的那 4 件（计数 / 主按钮 / 小方 / 提示行）做动效、其余不动，
     *  会读成"界面的一部分卡住了"，比全都不动更糟。
     *  页面级的淡入 + 推镜由 `PageManager` 统一负责（见 PageManager.open），
     *  那一层对整页生效，正好覆盖"底图 + 控件"这一整块。
     */
    protected onLeave(): void {
        // 页面被销毁前把长按调度收掉（否则计时器会挂在已销毁的组件上）
        this._holding = false;
        this.unschedule(this.tickHold);
    }
}

// ============================================================
//  模块级小工具
// ============================================================

/** 「当前关」＝ 已过 + 1，但不能越过最后一关 */
export function currentLevel(cleared: number, total: number): number {
    return Math.min(cleared + 1, total);
}
