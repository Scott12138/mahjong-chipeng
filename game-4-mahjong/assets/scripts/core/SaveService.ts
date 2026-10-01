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
 *  已通关关卡 / 每关最佳用时。
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
}

/** 全新存档 */
function makeDefault(): SaveData {
    return { version: 1, cleared: [], bestTime: {} };
}

/**
 * 每日状态（与永久进度分开存）。
 * 为什么单开一个键：永久进度是"越玩越多"，每日计数是"每天清零"，
 * 混在一张表里会让"跨天怎么清"这件事污染掉进度逻辑，得不偿失。
 */
export interface DailyData {
    /** YYYY-MM-DD（本地时区）。与今天不同 → 视为新的一天，计数归零 */
    date: string;
    /** 今天已用掉的「分享换取道具/复活」次数 */
    shareCount: number;
}

function today(): string {
    const d = new Date();
    const mm = `${d.getMonth() + 1}`.padStart(2, '0');
    const dd = `${d.getDate()}`.padStart(2, '0');
    return `${d.getFullYear()}-${mm}-${dd}`;
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
    private _daily: DailyData = { date: '', shareCount: 0 };

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
            } else {
                const parsed = JSON.parse(raw) as Partial<SaveData>;
                // 逐字段校验：外部数据永远不可信，缺字段就补默认值
                this._data = {
                    version: parsed.version ?? 1,
                    cleared: Array.isArray(parsed.cleared) ? parsed.cleared.filter((n) => typeof n === 'number') : [],
                    bestTime: (parsed.bestTime && typeof parsed.bestTime === 'object') ? parsed.bestTime : {},
                };
            }
            if (CFG.DEBUG.LOG_STATE) log(`[SaveService] 读档成功，已通关 ${this._data.cleared.length} 关`);
        } catch (e) {
            warn('[SaveService] 读档失败，已重置为全新存档：', e);
            this._data = makeDefault();
        }
        this.loadDaily();
    }

    /** 读每日计数；跨天自动归零 */
    private loadDaily(): void {
        const fresh: DailyData = { date: today(), shareCount: 0 };
        try {
            const raw = sys.localStorage.getItem(CFG.SAVE.DAILY_KEY);
            const parsed = raw ? (JSON.parse(raw) as Partial<DailyData>) : null;
            if (parsed && typeof parsed.date === 'string' && parsed.date === fresh.date) {
                // 同一天才继承计数；日期不同 = 新的一天，从 0 开始
                this._daily = {
                    date: parsed.date,
                    shareCount: typeof parsed.shareCount === 'number' && parsed.shareCount >= 0
                        ? parsed.shareCount : 0,
                };
            } else {
                this._daily = fresh;
            }
        } catch (e) {
            warn('[SaveService] 每日计数读取失败，已重置：', e);
            this._daily = fresh;
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
    //  每日计数（分享上限）
    // --------------------------------------------------------

    /**
     * 今天还能用几次「分享换取」。
     * 这个上限是**防刷**用的，不是给玩家添堵：微信的分享没有成功回调
     * （点开面板就算一次），不设上限会被当成无限免费道具薅。
     */
    public shareLeft(): number {
        if (this._daily.date !== today()) return CFG.REWARD.SHARE_DAILY_LIMIT;
        return Math.max(0, CFG.REWARD.SHARE_DAILY_LIMIT - this._daily.shareCount);
    }

    /** 记一次分享。返回今天已用次数（含这一次） */
    public addShare(): number {
        if (this._daily.date !== today()) {
            this._daily = { date: today(), shareCount: 0 };
        }
        this._daily.shareCount += 1;
        try {
            sys.localStorage.setItem(CFG.SAVE.DAILY_KEY, JSON.stringify(this._daily));
        } catch (e) {
            warn('[SaveService] 每日计数写入失败：', e);
        }
        return this._daily.shareCount;
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

    /** 清空存档（调试用） */
    public reset(): void {
        this._data = makeDefault();
        this._daily = { date: today(), shareCount: 0 };
        this.flush();
        try {
            sys.localStorage.removeItem(CFG.SAVE.DAILY_KEY);
        } catch (e) {
            /* 忽略：清不掉也不影响主流程 */
        }
        if (CFG.DEBUG.LOG_STATE) log('[SaveService] 存档已清空');
    }
}
