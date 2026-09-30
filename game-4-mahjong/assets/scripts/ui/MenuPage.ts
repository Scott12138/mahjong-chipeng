/**
 * ============================================================
 *  MenuPage.ts · 菜单页
 * ============================================================
 *  游戏的第一屏。内容从简（DESIGN §8：页面切换用节点树 + Tween 转场）：
 *  桌布背景 + 游戏名 + 副标题 + 开始按钮 + 版本号。
 *
 *  这一屏承担的设计任务：
 *   · 3 秒内让人知道"这是什么游戏"（名称 + 一句玩法slogan）；
 *   · 只留一个主按钮，不制造选择困难。
 * ============================================================
 */

import { _decorator, Node, tween, v3 } from 'cc';
import { CFG } from '../CFG';
import { PageBase } from './PageBase';
import { createButton, createLabel, createTableBackground } from './UIFactory';

const { ccclass } = _decorator;

@ccclass('MenuPage')
export class MenuPage extends PageBase {

    /** 标题节点引用（入场动效用） */
    private _titleNode: Node | null = null;

    protected onBuild(): void {
        const L = CFG.MENU_LAYOUT;

        // ---------- 背景：麻将桌布 ----------
        createTableBackground(this.root);

        // ---------- 游戏名 ----------
        const title = createLabel(this.root, CFG.GAME.NAME, {
            y: L.TITLE_Y,
            fontSize: CFG.FONT.SIZE_TITLE,
            color: CFG.COLOR.GOLD,
            bold: true,
            outline: CFG.COLOR.GOLD_DEEP,
            outlineWidth: 5,
        });
        this._titleNode = title.node;

        // ---------- 副标题（一句讲清玩法）----------
        createLabel(this.root, CFG.GAME.SUBTITLE, {
            y: L.SUBTITLE_Y,
            fontSize: CFG.FONT.SIZE_SUBTITLE,
            color: CFG.COLOR.TEXT_LIGHT,
        });

        // ---------- 开始按钮 ----------
        createButton(this.root, 'StartButton', {
            w: L.START_BTN_W,
            h: L.START_BTN_H,
            y: L.START_BTN_Y,
            text: '开 始 游 戏',
            fontSize: 46,
            depth: 8,                                   // 立体厚度，按压更有实感
            depthColor: CFG.COLOR.BTN_PRIMARY_EDGE,
            fill: CFG.COLOR.BTN_PRIMARY,
            onClick: () => this.goto('levelSelect'),
        });

        // ---------- 玩法一句话提示 ----------
        createLabel(this.root, '点击牌 → 进槽位 → 凑齐「碰 / 吃 / 杠」自动消除', {
            y: L.TIP_Y,
            fontSize: CFG.FONT.SIZE_SMALL,
            color: CFG.COLOR.TEXT_DIM,
        });

        // ---------- 左下角版本号 ----------
        createLabel(this.root, `${CFG.GAME.VERSION} · 内部开发版`, {
            x: L.VERSION_X,
            y: L.VERSION_Y,
            fontSize: CFG.FONT.SIZE_SMALL,
            color: CFG.COLOR.TEXT_DIM,
        });
    }

    protected onEnter(): void {
        // 标题入场：从下方轻微上浮 + 放大回正，做出"推近落定"的层次感
        // （页面整体的淡入由 PageManager 负责，这里只加标题这一层的细节）
        const t = this._titleNode;
        if (!t) return;
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
}
