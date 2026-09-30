/**
 * ============================================================
 *  SaveService.ts · 本地存档
 * ============================================================
 *  【为什么用 sys.localStorage 而不是直接调 wx.setStorageSync】
 *  sys.localStorage 是 Cocos 的平台抽象层：微信小游戏上会自动桥接到
 *  wx.setStorageSync / getStorageSync，浏览器预览时落到 localStorage，
 *  真机原生则写本地文件。同一份代码三端通用，且都能在微信开发者工具里
 *  的 Storage 面板直接查看。
 *
 *  【首版存什么】（DESIGN §7）
 *  已通关关卡 / 每关最佳用时 / 最高连击。
 *  明确不做：排行榜、每日任务、道具商店 —— 留给后续版本。
 * ============================================================
 */

import { log, sys, warn } from 'cc';
import { CFG } from '../CFG';

/** 存档数据结构 */
export interface SaveData {
    /** 存档格式版本。日后结构变更时靠它做迁移或丢弃旧档 */
    version: number;
    /** 已通关的关卡 id 列表 */
    cleared: number[];
    /** 每关最佳用时（秒），键 = 关卡 id */
    bestTime: Record<string, number>;
    /** 历史最高连击（S3 起统计） */
    bestCombo: number;
}

/** 全新存档 */
function makeDefault(): SaveData {
    return { version: 1, cleared: [], bestTime: {}, bestCombo: 0 };
}

export class SaveService {

    // --------------------------------------------------------
    //  单例
    // --------------------------------------------------------
    private static _instance: SaveService | null = null;
    public static get instance(): SaveService {
        if (!SaveService._instance) {
            SaveService._instance = new SaveService();
        }
        return SaveService._instance;
    }

    private _data: SaveData = makeDefault();

    private constructor() {
        this.load();
    }

    // --------------------------------------------------------
    //  读 / 写
    // --------------------------------------------------------

    /** 从本地读档。任何异常都退化为全新存档，绝不因存档损坏而白屏 */
    public load(): void {
        try {
            const raw = sys.localStorage.getItem(CFG.SAVE.KEY);
            if (!raw) {
                this._data = makeDefault();
                return;
            }
            const parsed = JSON.parse(raw) as Partial<SaveData>;
            // 逐字段校验：外部数据永远不可信，缺字段就补默认值
            this._data = {
                version: parsed.version ?? 1,
                cleared: Array.isArray(parsed.cleared) ? parsed.cleared.filter((n) => typeof n === 'number') : [],
                bestTime: (parsed.bestTime && typeof parsed.bestTime === 'object') ? parsed.bestTime : {},
                bestCombo: typeof parsed.bestCombo === 'number' ? parsed.bestCombo : 0,
            };
            if (CFG.DEBUG.LOG_STATE) log(`[SaveService] 读档成功，已通关 ${this._data.cleared.length} 关`);
        } catch (e) {
            warn('[SaveService] 读档失败，已重置为全新存档：', e);
            this._data = makeDefault();
        }
    }

    /** 写入本地 */
    public flush(): void {
        try {
            sys.localStorage.setItem(CFG.SAVE.KEY, JSON.stringify(this._data));
            if (CFG.DEBUG.LOG_STATE) log('[SaveService] 存档已写入');
        } catch (e) {
            warn('[SaveService] 存档写入失败：', e);
        }
    }

    // --------------------------------------------------------
    //  查询
    // --------------------------------------------------------

    /** 该关是否已通关 */
    public isCleared(id: number): boolean {
        return this._data.cleared.indexOf(id) >= 0;
    }

    /**
     * 该关是否已解锁。
     * 规则：第 1 关永远解锁，其余需要上一关通关。
     * CFG.DEBUG.UNLOCK_ALL 为 true 时全部解锁（调试期方便直接进任意关）。
     */
    public isUnlocked(id: number): boolean {
        if (CFG.DEBUG.UNLOCK_ALL) return true;
        if (id <= 1) return true;
        return this.isCleared(id - 1);
    }

    /** 该关最佳用时（秒）；无记录返回 0 */
    public getBestTime(id: number): number {
        return this._data.bestTime[String(id)] ?? 0;
    }

    /** 已通关关卡数量 */
    public get clearedCount(): number {
        return this._data.cleared.length;
    }

    // --------------------------------------------------------
    //  写入
    // --------------------------------------------------------

    /**
     * 标记某关通关，并记录用时。
     * 用时只在刷新纪录时覆盖（保留最快的一次）。
     */
    public markCleared(id: number, timeSec: number): void {
        if (!this.isCleared(id)) {
            this._data.cleared.push(id);
        }
        const key = String(id);
        const prev = this._data.bestTime[key];
        if (prev === undefined || timeSec < prev) {
            this._data.bestTime[key] = Math.round(timeSec);
        }
        this.flush();
    }

    /** 更新最高连击 */
    public setBestCombo(combo: number): void {
        if (combo > this._data.bestCombo) {
            this._data.bestCombo = combo;
            this.flush();
        }
    }

    /** 清空存档（调试用） */
    public reset(): void {
        this._data = makeDefault();
        this.flush();
        if (CFG.DEBUG.LOG_STATE) log('[SaveService] 存档已清空');
    }
}
