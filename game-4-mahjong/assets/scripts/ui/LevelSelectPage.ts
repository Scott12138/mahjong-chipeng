/**
 * ============================================================
 *  LevelSelectPage.ts · 关卡选择页
 * ============================================================
 *  4 关「三堵墙」的选择入口（DESIGN §6）。布局照设计稿 §9 的关卡页稿：
 *  每关一张宣纸卡片 —— 左侧一张该关的"代表牌"，右侧关卡名 + 规模说明，
 *  右边角上标状态（已通关 ✓ / 可挑战 ▶ / 未解锁 锁）。
 *
 *  一处刻意的设计：**未解锁的关卡也画出来**，只是变灰 + 不画角花 + 标"锁"。
 *  这比"直接隐藏"更有驱动力 —— 玩家能看见后面还有 3 堵墙等着自己，
 *  这正是"难度断崖 + 分享求助"这套运营思路的视觉前提。
 * ============================================================
 */

import { _decorator, Graphics, Node, UITransform, Label } from 'cc';
import { CFG, LevelConfig } from '../CFG';
import { SaveService } from '../core/SaveService';
import { Family } from '../TileData';
import { AudioService } from './AudioService';
import { PageBase } from './PageBase';
import { TileView } from './TileRenderer';
import {
    createLabel, createNode, createPageFrame, createPaperBackground, drawCorners, fillBox,
    frameRect, hex2color, strokeBox,
} from './UIFactory';

const { ccclass } = _decorator;

/** 每关卡片上放哪张牌当"代表"（照设计稿：万一条四筒六万九） */
const CARD_TILE: Array<{ fam: Family; num: number }> = [
    { fam: 'wan', num: 1 },
    { fam: 'sou', num: 4 },
    { fam: 'ton', num: 6 },
    { fam: 'wan', num: 9 },
];

@ccclass('LevelSelectPage')
export class LevelSelectPage extends PageBase {

    protected onBuild(): void {
        const L = CFG.LEVEL_LAYOUT;
        const save = SaveService.instance;

        createPaperBackground(this.root);
        createPageFrame(this.root);

        // ---------- 标题 ----------
        createLabel(this.root, '选 关 卡', {
            y: L.TITLE_Y,
            fontSize: CFG.FONT.SIZE_H2,
            color: CFG.COLOR.INK,
            outline: CFG.COLOR.GOLD,
            outlineWidth: 4,
            bold: true,
            serif: true,
        });
        this.buildDivider(L.TITLE_Y - 46);

        // ---------- 关卡卡片 ----------
        CFG.LEVELS.forEach((lv, i) => {
            const y = L.FIRST_CARD_Y - i * (L.CARD_H + L.CARD_GAP);
            this.buildCard(lv, i, y, save.isUnlocked(lv.id), save.isCleared(lv.id));
        });

        // ---------- 返回 ----------
        const back = createNode('BackButton', this.root, { w: L.BACK_BTN_W, h: L.BACK_BTN_H });
        back.setPosition(0, L.BACK_BTN_Y, 0);
        const bg = back.addComponent(Graphics);
        fillBox(bg, 0, -CFG.SHAPE.CARD_DEPTH, L.BACK_BTN_W, L.BACK_BTN_H, CFG.SHAPE.RADIUS_BTN, CFG.COLOR.INK);
        fillBox(bg, 0, 0, L.BACK_BTN_W, L.BACK_BTN_H, CFG.SHAPE.RADIUS_BTN, CFG.COLOR.FACE);
        strokeBox(bg, 0, 0, L.BACK_BTN_W, L.BACK_BTN_H, CFG.SHAPE.RADIUS_BTN, CFG.COLOR.INK, 3);
        createLabel(back, '返 回', {
            fontSize: CFG.FONT.SIZE_BODY, color: CFG.COLOR.INK, bold: true,
        });
        back.on(Node.EventType.TOUCH_END, () => this.goto('menu'), back);

        // ---------- 音频：进入"游戏进行中"的范畴，起 BGM（S14）----------
        // ★ 必须在 onBuild 里调用，**不能**挪到 onEnter：
        //   · onBuild 由 PageManager.open **同步**执行，而 open 又由
        //     "点开始游戏 → goto" 同步触发 ⇒ **在手势栈内**，autoplay 放行 ✅
        //   · onEnter 是 setTimeout(duration+20ms) 之后才调的 ⇒ 已出栈，播不响 ❌
        // 幂等：从局内退回选关页时这里什么都不做，音乐不会从头重启。
        AudioService.playBgm();
    }

    /** 两段细墨线 + 中间朱红菱形（与菜单页同一套装饰语言） */
    private buildDivider(y: number): void {
        const node = createNode('Divider', this.root, { w: 440, h: 20 });
        node.setPosition(0, y, 0);
        const g = node.addComponent(Graphics);
        g.lineWidth = 1.2;
        g.strokeColor = hex2color(CFG.COLOR.INK, 77);
        g.moveTo(-220, 0); g.lineTo(-30, 0); g.stroke();
        g.moveTo(30, 0); g.lineTo(220, 0); g.stroke();
        g.fillColor = hex2color(CFG.COLOR.VERMILION);
        g.moveTo(0, 8); g.lineTo(8, 0); g.lineTo(0, -8); g.lineTo(-8, 0);
        g.close();
        g.fill();
    }

    /** 单张关卡卡片 */
    private buildCard(lv: LevelConfig, index: number, y: number, unlocked: boolean, cleared: boolean): void {
        const L = CFG.LEVEL_LAYOUT;
        const w = L.CARD_W;
        const h = L.CARD_H;

        const card = createNode(`LevelCard${lv.id}`, this.root, { w, h });
        card.setPosition(0, y, 0);
        const g = card.addComponent(Graphics);

        const body = unlocked ? CFG.COLOR.INK : CFG.COLOR.LOCK;

        // 厚度层（锁定卡的厚度也压淡，避免"锁着的卡还在飘"）
        fillBox(g, 0, -CFG.SHAPE.CARD_DEPTH, w, h, CFG.SHAPE.RADIUS_PANEL,
            CFG.COLOR.INK, unlocked ? 255 : 26);
        // 面层
        fillBox(g, 0, 0, w, h, CFG.SHAPE.RADIUS_PANEL,
            unlocked ? CFG.COLOR.FACE : CFG.COLOR.LOCK_BG);
        strokeBox(g, 0, 0, w, h, CFG.SHAPE.RADIUS_PANEL, body, 3);
        // 角花只给"可用"的卡 —— 角花就是"这块可以点"的信号
        if (unlocked) {
            drawCorners(g, 0, 0, w, h, 16, CFG.COLOR.VERMILION, 2);
        }

        // ---------- 左侧代表牌 ----------
        const t = CARD_TILE[index] ?? CARD_TILE[0];
        const tv = new TileView(card, `${t.fam}-${t.num}`, L.CARD_TILE_W);
        tv.node.setPosition(L.CARD_TILE_X, 0, 0);
        if (!unlocked) tv.setState('dim');

        // ---------- 关卡名 ----------
        const nameText = cleared
            ? `第 ${lv.id} 关 · ${lv.name}`
            : `第 ${lv.id} 关 · ${unlocked ? lv.name : '未解锁'}`;
        createLabel(card, nameText, {
            x: L.CARD_TEXT_X, y: L.CARD_NAME_DY, alignLeft: true, w: 360,
            fontSize: 34,
            color: unlocked ? CFG.COLOR.INK : CFG.COLOR.INK_SOFT,
            bold: true,
            serif: true,
        });

        // ---------- 规模说明 ----------
        const sub = unlocked
            ? `${lv.tileCount} 张 · ${lv.layers} 层 · ${lv.timeLimit > 0 ? `${lv.timeLimit} 秒` : '不限时'}`
            : `${lv.tileCount} 张 · ${lv.layers} 层`;
        createLabel(card, sub, {
            x: L.CARD_TEXT_X, y: L.CARD_SUB_DY, alignLeft: true, w: 360,
            fontSize: 23,
            color: unlocked ? CFG.COLOR.INK_MID : CFG.COLOR.INK_SOFT,
        });

        // ---------- 右上角状态标 ----------
        const markX = w / 2 - 44;
        if (!unlocked) {
            createLabel(card, '锁', {
                x: markX, y: 0, fontSize: 30, color: CFG.COLOR.INK_SOFT, serif: true,
            });
        } else if (cleared) {
            g.fillColor = hex2color(CFG.COLOR.VERMILION);
            g.circle(markX, 0, 24);
            g.fill();
            createLabel(card, '✓', {
                x: markX, y: 1, fontSize: 26, color: CFG.COLOR.FACE, bold: true,
            });
        } else {
            // 未通关：一个朱红三角，比圆点更"催人点"
            g.fillColor = hex2color(CFG.COLOR.VERMILION);
            g.moveTo(markX - 14, 12);
            g.lineTo(markX + 14, 0);
            g.lineTo(markX - 14, -12);
            g.close();
            g.fill();
        }

        // ---------- 点击 ----------
        if (unlocked) {
            card.on(Node.EventType.TOUCH_START, () => card.setScale(0.97, 0.97, 1), card);
            card.on(Node.EventType.TOUCH_CANCEL, () => card.setScale(1, 1, 1), card);
            card.on(Node.EventType.TOUCH_END, () => {
                card.setScale(1, 1, 1);
                this.goto('game', { levelId: lv.id });
            }, card);
        } else {
            card.on(Node.EventType.TOUCH_END, () => {
                // 未解锁：给一句"怎么解锁"的明确指引，而不是干巴巴的"未解锁"
                const prev = lv.id - 1;
                const name = CFG.LEVELS.find((l) => l.id === prev)?.name ?? '';
                this.showTip(`先通过第 ${prev} 关「${name}」`);
            }, card);
        }
    }

    /** 轻提示（借用 UITransform 的 Label 做即时反馈，不引入额外依赖） */
    private showTip(text: string): void {
        const node = createNode('LockTip', this.root, { w: 520, h: 70, y: -60 });
        const g = node.addComponent(Graphics);
        fillBox(g, 0, 0, 460, 66, 4, CFG.COLOR.INK, 235);
        const label = createLabel(node, text, {
            fontSize: CFG.FONT.SIZE_SMALL,
            color: CFG.COLOR.FACE,
            bold: true,
            w: 440,
        });
        label.node.setSiblingIndex(1);
        label.horizontalAlign = Label.HorizontalAlign.CENTER;
        void (label.node.getComponent(UITransform) as UITransform);

        // 1.2 秒后自己消失（用定时器，不挂 tween 回调）
        setTimeout(() => { if (node.isValid) node.destroy(); }, 1400);
    }
}
