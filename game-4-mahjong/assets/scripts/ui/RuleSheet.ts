/**
 * ============================================================
 *  RuleSheet.ts · 「怎么消」规则浮层（S18 新增 / S19 改 3D 形制）
 * ============================================================
 *  设计源：`docs/design/game4-3d-refit/规则浮层-优化后-1x.html`（S19 定稿）
 *  施工依据：`docs/design/game4-3d-refit/01-排版重排-规格.md`
 *
 * ------------------------------------------------------------
 *  【它取代了什么】
 *  原首页那行「点击牌 → 进槽位 → 凑齐「碰 / 吃 / 杠」」——
 *  一句话里塞了两个棋牌术语，是把本作推向"棋牌类"判定的最直接证据。
 *  用户拍板：**统一改掉，做成一个规则按钮，什么情况下可以消除，给出牌组合的案例**。
 *  于是「碰 / 吃 / 杠」这三个字从玩家可见的界面里彻底消失，
 *  换成一个**按需展开**的浮层（想玩的人不用读，不会玩的人有处可查）。
 *
 * ------------------------------------------------------------
 *  【三条案例不是随便挑的】
 *  它们与 `MatchRule.findMatch()` 的判定**一一对应**：
 *    案例① 三张一模一样       → findPeng
 *    案例② 同一族里号码连着三张 → findChi
 *    案例③ 四张一模一样       → findGang（第 3 关起启用）
 *  不多不少。脚注「万 · 条 · 筒　三族各自成串 · 不跨族」是**必须有的** ——
 *  `findChi()` 按族分组扫连号，一萬 · 二条 · 三筒 永远消不掉；不写清楚，玩家一定会试。
 *
 * ------------------------------------------------------------
 *  【S19 形制变化：从"硬直角 + 角花"变成"3D 厚描边 + 细线内框"】
 *  卡片直接走 `createPanel`（radius 26 / border 5 / depth 14 / inner），
 *  与失败结算、首页弹层是**同一套形制**。
 *  · 删掉了面板内的「×」：设计稿没有 —— **关法是点遮罩**。
 *    遮罩就是"面板之外的全部区域"，是手机上最大的一块热区，比 56×56 的方钮好按。
 *  · 删掉了标题下的分隔线、页脚上的分隔线：3D 卡片靠"细线内框 + 字号落差"分层，
 *    再加两条横线会与内框的边框打架，读成"表格"。
 *  · 三组案例牌**统一 88 宽**（旧稿 ① ② 用 80、③ 用 72）：
 *    旧稿 96 宽时案例③（四张）会把页脚压出重叠 —— 那正是上一版的 bug。
 *
 * ------------------------------------------------------------
 *  【零棋牌术语（本文件是全工程要求最严的一处）】
 *  禁：碰 / 吃 / 杠 / 刻子 / 顺子 / 对子 / 胡 / 番 / 筹码 / 得分 / 连击 / 对局。
 *  一律改用**属性语言**：「一模一样」「号码连着三张」「同一族」「不跨族」。
 *  改这个文件的任何一句文案前，先对着上面这张清单核一遍。
 * ============================================================
 */

import { Node, UIOpacity, UITransform, tween, v3 } from 'cc';
import { CFG } from '../CFG';
import { PatternKey } from '../TileData';
import { TileView } from './TileRenderer';
import {
    createGraphicsNode, createLabel, createPanel, hex2color,
} from './UIFactory';

/** 三条案例的牌面（真牌面，不是示意图 —— 零新资产、零新贴图） */
const CASE1_TILES: PatternKey[] = ['ton-5', 'ton-5', 'ton-5'];
const CASE2_TILES: PatternKey[] = ['wan-1', 'wan-2', 'wan-3'];
const CASE3_TILES: PatternKey[] = ['ton-6', 'ton-6', 'ton-6', 'ton-6'];

export class RuleSheet {

    /** 当前打开的浮层（同一时刻只允许一个 —— 连点两下不该叠出两张卡） */
    private static _open: Node | null = null;

    /** 是否已经打开（GamePage 用它决定要不要吞掉这次点击） */
    public static get isOpen(): boolean {
        return !!RuleSheet._open && RuleSheet._open.isValid;
    }

    /**
     * 打开浮层。
     * @param parent 挂到哪（一般是页面的 root —— 追加为最后一个子节点即"最上层"）
     */
    public static open(parent: Node): void {
        if (RuleSheet.isOpen) return;

        const S = CFG.RULE_SHEET;

        // ---------- ① 全屏遮罩：点它即关闭，同时吞掉底下页面的一切点击 ----------
        const root = new Node('RuleSheet');
        root.layer = parent.layer;
        parent.addChild(root);
        const rootUI = root.addComponent(UITransform);
        rootUI.setAnchorPoint(0.5, 0.5);
        // 比屏幕大一圈：超长屏（20:9）上可视高度大于设计高度，写死设计分辨率会露缝
        rootUI.setContentSize(CFG.SCREEN.W * 1.6, CFG.SCREEN.H * 1.6);
        const rootOp = root.addComponent(UIOpacity);
        rootOp.opacity = 0;
        RuleSheet._open = root;

        const mask = createGraphicsNode('Mask', root, {
            w: CFG.SCREEN.W * 1.6, h: CFG.SCREEN.H * 1.6,
        });
        mask.g.fillColor = hex2color(CFG.COLOR.INK, S.MASK_ALPHA * 255);
        mask.g.rect(-CFG.SCREEN.W * 0.8, -CFG.SCREEN.H * 0.8, CFG.SCREEN.W * 1.6, CFG.SCREEN.H * 1.6);
        mask.g.fill();
        mask.node.on(Node.EventType.TOUCH_END, () => RuleSheet.close(), mask.node);

        // ---------- ② 卡片（3D 厚描边 + 细线内框，与失败结算同一形制）----------
        // `inner: true` 画的是 CSS `.panel .inner` 那圈 inset:15px 的细线框。
        const card = createPanel(root, 'RuleCard', S.W, S.H, { inner: true });
        card.setScale(v3(S.ENTER_SCALE_FROM, S.ENTER_SCALE_FROM, 1));

        // ---------- ③ 标题区 ----------
        createLabel(card, S.TITLE_TEXT, {
            y: S.TITLE_Y, fontSize: S.TITLE_SIZE,
            color: CFG.COLOR.VERMILION, bold: true, serif: true,
        });
        createLabel(card, S.SUB_TEXT, {
            y: S.SUB_Y, fontSize: S.SUB_SIZE, color: CFG.COLOR.INK_MID,
        });

        // ---------- ④ 三条案例 ----------
        //  【为什么说明文字在牌的上方、牌阵居中】设计稿就是"小标题左对齐在 −199，
        //  牌阵以 x=0 居中"——标题贴左、实物居中，读起来是"条目 → 例证"，
        //  比"文字压在牌下面"更像一张图鉴卡。
        this.buildCase(card, CASE1_TILES, S.CASE1_LABEL, S.CASE1_LABEL_Y, S.CASE1_Y);
        this.buildCase(card, CASE2_TILES, S.CASE2_LABEL, S.CASE2_LABEL_Y, S.CASE2_Y);
        this.buildCase(card, CASE3_TILES, S.CASE3_LABEL, S.CASE3_LABEL_Y, S.CASE3_Y);

        // ---------- ⑤ 脚注 ----------
        createLabel(card, S.FOOT_TEXT, {
            y: S.FOOT_Y, fontSize: S.FOOT_SIZE,
            // 这是**信息**（讲清了"什么消不掉"），所以用 INK_MID 而不是 INK_SOFT
            color: CFG.COLOR.INK_MID,
        });

        // ---------- ⑥ 出现动效 ----------
        //  ⚠️ 淡入挂在 root 上、缩放挂在 card 上：两者分开，卡片"推近"时遮罩不会跟着缩。
        tween(rootOp).to(S.ENTER_IN, { opacity: 255 }).start();
        tween(card).to(S.ENTER_IN, { scale: v3(1, 1, 1) }, { easing: 'backOut' }).start();
    }

    /** 关闭并销毁（遮罩点击 / 页面切走都会走这里） */
    public static close(): void {
        const root = RuleSheet._open;
        RuleSheet._open = null;
        if (!root || !root.isValid) return;
        // 直接销毁，不等动画 —— 页面可能已经在切走了，这时候留着节点只会变成幽灵
        root.destroy();
    }

    /**
     * 一条案例 = 「左对齐小标题」+「居中牌阵」。
     * 两个 y 分别来自 CFG（`*_LABEL_Y` 与 `*_Y`），**不要在这里算相对偏移** ——
     * 三组之间是等距的（212/36/−140 与 128/−48/−224 各差 176），
     * 但把这个 176 写进代码就等于把"设计稿的行距"藏起来了，改版时找不到。
     */
    private static buildCase(
        card: Node, keys: PatternKey[], label: string, labelY: number, rowY: number,
    ): void {
        const S = CFG.RULE_SHEET;
        createLabel(card, label, {
            x: S.LABEL_X, y: labelY, alignLeft: true, w: S.W,
            fontSize: S.LABEL_SIZE, color: '#4A4436', bold: true,
        });
        this.buildRow(card, keys, S.CASE_TILE_W, S.CASE_TILE_GAP, rowY);
    }

    /**
     * 一行牌（按**牌体中心**等间距排开）。
     *
     * ⚠️ 这里用牌体中心而不是视觉框中心是**故意的**：一行牌并排时，
     * 立体侧壁向右下溢出、投影只在下沿，若按视觉框居中，整行会被推得
     * 越来越靠左上（每多一张就多偏一点）。同一行里所有牌的错位量相同，
     * 所以按牌体对齐才是视觉上对齐的那一个。
     */
    private static buildRow(
        card: Node, keys: PatternKey[], tileW: number, gap: number, y: number,
    ): void {
        const n = keys.length;
        keys.forEach((k, i) => {
            const x = (i - (n - 1) / 2) * gap;
            const tv = new TileView(card, k, tileW);
            tv.node.setPosition(x, y, 0);
        });
    }
}
