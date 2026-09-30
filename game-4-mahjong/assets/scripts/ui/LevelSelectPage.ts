/**
 * ============================================================
 *  LevelSelectPage.ts · 关卡选择页
 * ============================================================
 *  4 关「三堵墙」的选择入口（DESIGN §6）。
 *
 *  一处刻意的设计：**未解锁的关卡也画出来**，只是变灰 + 标注"未解锁"。
 *  这比"直接隐藏"更有驱动力 —— 玩家能看见后面还有 3 堵墙等着自己，
 *  这正是"难度断崖 + 分享求助"这套运营思路的视觉前提。
 *
 *  S1 阶段点击关卡只弹提示占位；S2 起改为进入 GamePage。
 * ============================================================
 */

import { _decorator } from 'cc';
import { CFG } from '../CFG';
import { SaveService } from '../core/SaveService';
import { PageBase } from './PageBase';
import { createButton, createLabel, createTableBackground, toast } from './UIFactory';

const { ccclass } = _decorator;

@ccclass('LevelSelectPage')
export class LevelSelectPage extends PageBase {

    protected onBuild(): void {
        const L = CFG.LEVEL_LAYOUT;
        const save = SaveService.instance;

        // ---------- 背景 ----------
        createTableBackground(this.root);

        // ---------- 标题 ----------
        createLabel(this.root, '选 择 关 卡', {
            y: L.TITLE_Y,
            fontSize: 56,
            color: CFG.COLOR.GOLD,
            bold: true,
            outline: CFG.COLOR.GOLD_DEEP,
            outlineWidth: 4,
        });

        // ---------- 关卡按钮（自上而下排列）----------
        CFG.LEVELS.forEach((lv, i) => {
            const unlocked = save.isUnlocked(lv.id);
            const cleared = save.isCleared(lv.id);
            const y = L.FIRST_BTN_Y - i * (L.BTN_H + L.BTN_GAP);

            // 按钮文案：已通关标 ✅ 语义（用文字而非 emoji，避免字体差异）、
            // 未解锁显示"未解锁"、已解锁未通关显示关卡名
            const label = cleared
                ? `第 ${lv.id} 关 · ${lv.name}（已通关）`
                : `第 ${lv.id} 关 · ${unlocked ? lv.name : '未解锁'}`;

            createButton(this.root, `LevelBtn${lv.id}`, {
                w: L.BTN_W,
                h: L.BTN_H,
                y,
                radius: 20,
                text: label,
                fontSize: CFG.FONT.SIZE_BUTTON,
                depth: 6,
                // 已解锁用绿色系（与麻将桌协调），未解锁用灰色
                fill: unlocked ? CFG.COLOR.BTN_SECONDARY : CFG.COLOR.LOCKED,
                depthColor: unlocked ? CFG.COLOR.BTN_SECONDARY_EDGE : CFG.COLOR.LOCKED,
                textColor: unlocked ? CFG.COLOR.TEXT_LIGHT : CFG.COLOR.LOCKED_TEXT,
                enabled: unlocked,
                onClick: () => this.onLevelTap(lv.id, lv.name),
            });
        });

        // ---------- 返回 ----------
        createButton(this.root, 'BackButton', {
            w: L.BACK_BTN_W,
            h: L.BACK_BTN_H,
            y: L.BACK_BTN_Y,
            radius: 16,
            text: '返回',
            fontSize: CFG.FONT.SIZE_BODY,
            depth: 5,
        // 次要按钮（深绿）—— 视觉权重低于关卡按钮，不抢注意力
            fill: CFG.COLOR.TABLE_DARK,
            depthColor: '#000000',
            onClick: () => this.goto('menu'),
        });
    }

    /**
     * 点击关卡。
     * S1：玩法尚未实现，先弹提示占位（S2 起替换为 this.goto('game', { levelId })）。
     */
    private onLevelTap(id: number, name: string): void {
        toast(this.root, `第 ${id} 关「${name}」· 玩法将在 S2 实装`, 1.6);
    }
}
