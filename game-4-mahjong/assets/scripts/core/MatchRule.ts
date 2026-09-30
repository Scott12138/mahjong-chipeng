/**
 * ============================================================
 *  MatchRule.ts · 牌型判定（碰 / 吃 / 杠）
 * ============================================================
 *  纯函数，**不 import 'cc'** —— 这样 S4 的无头求解器可以复用同一份
 *  判定逻辑跑成千上万次模拟。判定规则一旦在游戏里和求解器里有两份实现，
 *  就一定会分叉，最后变成"求解器说有解、游戏里消不掉"这种最难查的 bug。
 *
 *  【规则】（DESIGN §2）
 *    碰：3 张完全相同
 *    吃：同花色连号 3 张（万 / 条 / 筒各自连号）
 *    杠：4 张完全相同（L3 起启用）
 *
 *  【优先级】
 *    ① 优先消除「包含最新入槽那张牌」的组合 —— 否则玩家刚放进去的牌
 *       不参与消除，会产生"我明明凑齐了却没消"的错觉；
 *    ② 仍并列时：杠 > 碰 > 吃（消得越多越优先）。
 *
 *  ⚠️ 合规红线：本文件只出现「碰 / 吃 / 杠」三个词，
 *     绝不出现「胡牌 / 番数 / 筹码」等棋牌博弈语义（见 DESIGN §2、§10）。
 * ============================================================
 */

import { Family, PatternKey, parsePattern } from '../TileData';

/** 命中的牌型 */
export type MatchType = 'peng' | 'chi' | 'gang';

/** 判定结果：类型 + 参与消除的槽位下标（升序） */
export interface MatchResult {
    type: MatchType;
    /** 参与消除的槽位下标 */
    indices: number[];
}

/** 各牌型的中文名（用于弹字与音效） */
export const MATCH_LABEL: Record<MatchType, string> = {
    peng: '碰',
    chi: '吃',
    gang: '杠',
};

/**
 * 一次「碰」需要几张牌。
 *
 * ⚠️ 这个常数不只用在判定里，还被「消除」道具用来**保持牌数守恒**：
 * 牌组是 3 张一组构造的，任何一次消除如果消掉的张数不是 3 的倍数，
 * 就会在场上留下永远凑不成型的散牌 —— 那一局直接变成死局。
 * 所以道具必须凑满 3 张一起消，而不是消掉 1 张。
 */
export const MATCH_SIZE = 3;

// ------------------------------------------------------------
//  内部工具
// ------------------------------------------------------------

/** 把槽内容按牌面分组：patternKey → 槽位下标数组 */
function groupByPattern(slots: PatternKey[]): Map<PatternKey, number[]> {
    const m = new Map<PatternKey, number[]>();
    for (let i = 0; i < slots.length; i++) {
        const k = slots[i];
        const arr = m.get(k);
        if (arr) arr.push(i);
        else m.set(k, [i]);
    }
    return m;
}

/** 找出「碰」：3 张完全相同。anchor 为 -1 时表示不限 */
function findPeng(slots: PatternKey[], anchor: number): MatchResult | null {
    const groups = groupByPattern(slots);
    for (const [, idx] of groups) {
        if (idx.length < 3) continue;
        if (anchor >= 0 && idx.indexOf(anchor) < 0) continue;
        return { type: 'peng', indices: idx.slice(0, 3) };
    }
    return null;
}

/** 找出「杠」：4 张完全相同 */
function findGang(slots: PatternKey[], anchor: number): MatchResult | null {
    const groups = groupByPattern(slots);
    for (const [, idx] of groups) {
        if (idx.length < 4) continue;
        if (anchor >= 0 && idx.indexOf(anchor) < 0) continue;
        return { type: 'gang', indices: idx.slice(0, 4) };
    }
    return null;
}

/**
 * 找出「吃」：同族连号 3 张（n, n+1, n+2）。
 * 同一张牌不能在一次「吃」里用两次，所以逐点取"最小下标"的那张。
 */
function findChi(slots: PatternKey[], anchor: number): MatchResult | null {
    // 按族收集：族 → (点数 → 槽位下标)
    for (const fam of ['wan', 'sou', 'ton'] as Family[]) {
        const byNum = new Map<number, number[]>();
        for (let i = 0; i < slots.length; i++) {
            const p = parsePattern(slots[i]);
            if (p.fam !== fam) continue;
            const arr = byNum.get(p.num);
            if (arr) arr.push(i);
            else byNum.set(p.num, [i]);
        }
        // 从 1 到 7 扫连续三元组
        for (let start = 1; start <= 7; start++) {
            const a = byNum.get(start);
            const b = byNum.get(start + 1);
            const c = byNum.get(start + 2);
            if (!a || !b || !c) continue;

            const picks = [a[0], b[0], c[0]];
            // 三元组之间不能重复用同一槽位（同族不同点数天然不会重复，
            // 这里只是防御性检查）
            if (new Set(picks).size !== 3) continue;
            if (anchor >= 0 && picks.indexOf(anchor) < 0) continue;

            return { type: 'chi', indices: picks };
        }
    }
    return null;
}

// ------------------------------------------------------------
//  对外入口
// ------------------------------------------------------------

/**
 * 扫描槽位，返回应消除的组合；没有则返回 null。
 *
 * @param slots     当前槽内容（顺序即显示顺序）
 * @param gangOn    是否启用「杠」（L3 起）
 * @param newest    最新入槽牌的槽位下标；-1 表示不特殊照顾
 */
export function findMatch(
    slots: PatternKey[], gangOn: boolean, newest = -1,
): MatchResult | null {
    if (slots.length < 3) return null;

    // ① 先找「包含最新入槽牌」的组合（优先级内：杠 > 碰 > 吃）
    if (newest >= 0 && newest < slots.length) {
        if (gangOn) {
            const g = findGang(slots, newest);
            if (g) return g;
        }
        const p = findPeng(slots, newest);
        if (p) return p;
        const c = findChi(slots, newest);
        if (c) return c;
    }

    // ② 兜底：全槽扫描（正常流程不会走到这里，因为每次入槽都检查过；
    //    留着是为了「移出」道具把牌放回槽里之类的后续扩展）
    if (gangOn) {
        const g = findGang(slots, -1);
        if (g) return g;
    }
    return findPeng(slots, -1) ?? findChi(slots, -1);
}

/**
 * 判断"把某张牌放进槽"之后是否可能形成消除（不真放，只做预测）。
 * 求解器用它挑更聪明的落子，避免纯随机瞎撞。
 */
export function wouldMatch(
    slots: PatternKey[], candidate: PatternKey, gangOn: boolean,
): boolean {
    const probe = slots.concat([candidate]);
    return findMatch(probe, gangOn, probe.length - 1) !== null;
}
