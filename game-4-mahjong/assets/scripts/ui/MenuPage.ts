/**
 * ============================================================
 *  MenuPage.ts · 菜单页
 * ============================================================
 *  游戏的第一屏。布局照 `docs/design/guochao-tiles.html` §9 的菜单页稿：
 *  标题（墨字金边）→ 副标题 → 分隔线 → 三族展示牌 → 主按钮 → 提示 → 版本号。
 *
 *  这一屏承担的设计任务：
 *   · 3 秒内让人知道"这是什么游戏"（名称 + 一句话玩法）；
 *   · 顺手把三族牌面亮一遍 —— 玩家进第一关前就见过 万/条/筒 各一张；
 *   · 只留一个主按钮，不制造选择困难。
 * ============================================================
 */

import { _decorator, Graphics, Node, tween, v3 } from 'cc';
import { CFG } from '../CFG';
import { PageBase } from './PageBase';
import { TileView } from './TileRenderer';
import {
    createButton, createLabel, createNode, createPageFrame, createPaperBackground, fillBox,
    hex2color, strokePath,
} from './UIFactory';

const { ccclass } = _decorator;

@ccclass('MenuPage')
export class MenuPage extends PageBase {

    /** 标题节点引用（入场动效用） */
    private _titleNode: Node | null = null;
    /** 三张展示牌（入场时依次落位） */
    private _showcase: TileView[] = [];

    protected onBuild(): void {
        const L = CFG.MENU_LAYOUT;

        // ---------- 背景与页框 ----------
        createPaperBackground(this.root);
        createPageFrame(this.root);

        // ---------- 游戏名（墨字 + 金描边 + 衬线）----------
        const title = createLabel(this.root, CFG.GAME.NAME, {
            y: L.TITLE_Y,
            fontSize: CFG.FONT.SIZE_TITLE,
            color: CFG.COLOR.INK,
            outline: CFG.COLOR.GOLD,
            outlineWidth: CFG.FONT.TITLE_OUTLINE,
            bold: true,
            serif: true,
        });
        this._titleNode = title.node;

        // ---------- 副标题 ----------
        createLabel(this.root, CFG.GAME.SUBTITLE, {
            y: L.SUBTITLE_Y,
            fontSize: CFG.FONT.SIZE_BODY,
            color: CFG.COLOR.INK_MID,
        });

        // ---------- 分隔线（两侧细墨线 + 中间朱红菱形）----------
        this.buildDivider(L.DIVIDER_Y);

        // ---------- 三族展示牌 ----------
        const keys = ['wan-1', 'sou-1', 'ton-1'] as const;
        keys.forEach((k, i) => {
            const x = (i - 1) * L.SHOWCASE_GAP;
            const v = new TileView(this.root, k, L.SHOWCASE_TILE_W);
            v.node.setPosition(x, L.SHOWCASE_Y, 0);
            this._showcase.push(v);
        });

        createLabel(this.root, '万 · 条 · 筒　三族各有各的图案', {
            y: L.CAPTION_Y,
            fontSize: CFG.FONT.SIZE_SMALL,
            color: CFG.COLOR.INK_SOFT,
        });

        // ---------- 主按钮 ----------
        createButton(this.root, 'StartButton', {
            w: L.START_BTN_W,
            h: L.START_BTN_H,
            y: L.START_BTN_Y,
            radius: CFG.SHAPE.RADIUS_BTN,
            text: '开 始 游 戏',
            fontSize: CFG.FONT.SIZE_BUTTON,
            depth: 8,
            fill: CFG.COLOR.VERMILION,
            stroke: CFG.COLOR.INK,
            depthColor: CFG.COLOR.INK,
            serif: true,
            onClick: () => this.goto('levelSelect'),
        });

        // ---------- 玩法一句话 ----------
        createLabel(this.root, '点击牌 → 进槽位 → 凑齐「碰 / 吃 / 杠」', {
            y: L.TIP_Y,
            fontSize: CFG.FONT.SIZE_SMALL,
            color: CFG.COLOR.INK_MID,
        });

        // ---------- 左下角版本号 ----------
        createLabel(this.root, `${CFG.GAME.VERSION} · 内部开发版`, {
            x: L.VERSION_X,
            y: L.VERSION_Y,
            alignLeft: true,
            w: 300,
            fontSize: CFG.FONT.SIZE_SMALL,
            color: CFG.COLOR.INK_SOFT,
        });

        // ---------- 右下角朱红方印 ----------
        this.buildSeal(L.SEAL_X, L.SEAL_Y, L.SEAL_SIZE);
    }

    /** 分隔线：两段细墨线 + 中间一颗朱红菱形 */
    private buildDivider(y: number): void {
        const node = createNode('Divider', this.root, { w: 480, h: 20 });
        node.setPosition(0, y, 0);
        const g = node.addComponent(Graphics);
        const ink = hex2color(CFG.COLOR.INK, 90);
        strokePath(g, [[-240, 0], [-30, 0]], CFG.COLOR.INK, 1.2);
        strokePath(g, [[30, 0], [240, 0]], CFG.COLOR.INK, 1.2);
        void ink;
        // 菱形
        g.fillColor = hex2color(CFG.COLOR.VERMILION);
        g.moveTo(0, 8);
        g.lineTo(8, 0);
        g.lineTo(0, -8);
        g.lineTo(-8, 0);
        g.close();
        g.fill();
    }

    /** 右下角的朱红方印（一个「麻」字的极简印章，国潮页面的收尾件） */
    private buildSeal(x: number, y: number, size: number): void {
        const node = createNode('Seal', this.root, { w: size, h: size });
        node.setPosition(x, y, 0);
        const g = node.addComponent(Graphics);
        fillBox(g, 0, 0, size, size, 4, CFG.COLOR.VERMILION);

        const label = createLabel(node, '麻', {
            fontSize: size * 0.46,
            color: CFG.COLOR.FACE,
            bold: true,
            serif: true,
        });
        label.node.setSiblingIndex(1);
    }

    protected onEnter(): void {
        // 标题入场：从下方轻微上浮 + 放大回正，做出"推近落定"的层次感
        // （页面整体的淡入由 PageManager 负责，这里只加细节）
        const t = this._titleNode;
        if (t) {
            t.setScale(v3(0.86, 0.86, 1));
            const { x, y, z } = t.position;
            t.setPosition(x, y - 40, z);
            tween(t)
                .parallel(
                    tween().to(0.34, { scale: v3(1, 1, 1) }, { easing: 'backOut' }),
                    tween().to(0.34, { position: v3(x, y, z) }, { easing: 'quadOut' }),
                )
                .start();
        }

        // 三张展示牌依次落下，把"这是麻将消除"这件事在 1 秒内讲完
        this._showcase.forEach((v, i) => {
            const { x, y, z } = v.node.position;
            v.node.setPosition(x, y + 60, z);
            v.node.setScale(v3(0.8, 0.8, 1));
            tween(v.node)
                .delay(0.08 + i * 0.08)
                .parallel(
                    tween().to(0.28, { position: v3(x, y, z) }, { easing: 'backOut' }),
                    tween().to(0.28, { scale: v3(1, 1, 1) }, { easing: 'backOut' }),
                )
                .start();
        });
    }
}
