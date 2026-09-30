/**
 * ============================================================
 *  Haptics.ts · 震动反馈（S7.5）
 * ============================================================
 *  【为什么震动要单独一个模块、而不是随地调 wx.vibrateShort】
 *  因为"什么时候不该震"比"怎么震"重要得多：
 *    · 一局里震几十次 → 玩家会去系统里关掉震动，之后所有震动设计都白做；
 *    · 两次震动挨得太近 → 线性马达的起振/收尾还没走完，体感糊成一次更弱的震；
 *    · 在 web 预览环境下 wx 不存在 → 直接崩。
 *  这三条全部收敛在这个文件里，业务代码只写 Haptics.light() / medium() / heavy()，
 *  想改"哪里不震"只改一个开关，不需要满仓库搜 vibrateShort。
 *
 *  ------------------------------------------------------------
 *  【三档的语义分工】（与 CFG.HAPTIC 一一对应）
 *    light  —— 按下可点的牌。"我摸到它了"，最频繁，必须最轻。
 *    medium —— 碰 / 消除达成。全局唯一真正值得庆祝的瞬间。
 *    heavy  —— 失败 / 复活。情绪转折点。
 *  连消、洗牌、加槽、翻页一律**不震** —— 稀缺才有信号价值。
 * ============================================================
 */

import { CFG } from '../CFG';

/** 三档震动强度（与 CFG.HAPTIC 的三个字符串常量同名） */
type Strength = 'TAP' | 'MATCH' | 'HEAVY';

/** wx 是运行时注入的全局对象：浏览器预览 / 编辑器里根本不存在，必须容错 */
function getWx(): any {
    return (globalThis as any).wx ?? null;
}

export class Haptics {

    /** 上一次震动的时间戳（节流用） */
    private static _last = 0;

    /** 按下 / 选中牌：最轻 */
    public static light(): void { Haptics.fire('TAP'); }

    /** 碰 / 消除：中档 */
    public static medium(): void { Haptics.fire('MATCH'); }

    /** 失败 / 复活：重档 */
    public static heavy(): void { Haptics.fire('HEAVY'); }

    /**
     * 真正发起震动。
     *
     * 【为什么要有节流】手机上连续两次 vibrateShort 如果间隔小于约 60ms，
     * 马达来不及完成一次完整的起振-收尾，体感上不是"两下"而是"一下、但更闷"。
     * 与其让玩家感知成"震动变弱了"，不如干脆丢掉第二下。
     */
    private static fire(s: Strength): void {
        if (!CFG.HAPTIC.ENABLED) return;

        const now = Date.now();
        if (now - this._last < CFG.HAPTIC.MIN_GAP_MS) return;
        this._last = now;

        const wx = getWx();
        if (wx && typeof wx.vibrateShort === 'function') {
            // fail 回调必须给：部分老基础库不支持 type 参数会走到 fail，
            // 不打回调的话控制台会冒一条未捕获错误（真机上很难查）
            wx.vibrateShort({ type: CFG.HAPTIC[s], fail: () => { /* 静默：震动失败无关紧要 */ } });
            return;
        }

        // 浏览器兜底（web-desktop 验证环境）：navigator.vibrate 只吃时长
        const nav = (globalThis as any).navigator;
        if (nav && typeof nav.vibrate === 'function') {
            const ms = s === 'HEAVY' ? CFG.HAPTIC.WEB_HEAVY
                : s === 'MATCH' ? CFG.HAPTIC.WEB_MATCH
                    : CFG.HAPTIC.WEB_TAP;
            nav.vibrate(ms);
        }
        // 两者都没有（编辑器 / 桌面浏览器）→ 什么都不做。
        // 这里**不做任何降级提示**：震动是锦上添花，缺了不该打扰玩家。
    }
}
