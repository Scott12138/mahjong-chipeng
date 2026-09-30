/**
 * ============================================================
 *  RewardGate.ts · 激励门禁（看广告 / 分享 换取一次道具机会）
 * ============================================================
 *  【它解决什么问题】
 *  道具不能白送（否则没有留存钩子），也不能直接收费（本作无经济系统）。
 *  DESIGN §5 定的是「每次使用看 1 条广告，或分享给朋友」。
 *  这个类就是那道门：**先选渠道，等渠道真正走完，才放行**。
 *
 *  ------------------------------------------------------------
 *  【统一的完成回调 —— 本文件最重要的设计】
 *  真实激励视频、模拟广告占位页，两条完全不同的链路，
 *  **最终都收敛到同一个 settle()**。上层（GamePage）只认
 *  `Promise<boolean>`，完全不知道底下走的是哪条。
 *  "上线开通流量主后填个广告位 ID 就出真广告、玩法代码零改动"
 *  靠的就是这个结构，而不是靠"记得改这里"。
 *
 *  ⚠️ 一个容易写错的地方（初版就踩了）：
 *     **不能在"玩家选了渠道"的时刻放行**，必须在"渠道真正走完"的时刻放行。
 *     否则玩家关掉广告照样拿到道具 —— 门等于不存在。
 *     所以面板只是把 `done` 转交给渠道，自己不放行。
 *
 *  ------------------------------------------------------------
 *  【两条链路的触发条件】
 *  · 真广告：`wx.createRewardedVideoAd` 存在 **且** AD_UNIT_ID 非空。
 *    拉取失败（未开通流量主 / 无库存 / 工具环境）→ **自动降级**到模拟广告，
 *    绝不让玩家卡在一个"点了什么都不发生"的按钮上。
 *  · 分享：`wx.shareAppMessage` 存在则调真分享。
 *    ⚠️ 微信**没有"分享成功"回调**（success 只代表面板被拉起），
 *       所以只能"点开即发放" + 每日上限防刷 —— 见 DESIGN §5.2。
 *
 *  ------------------------------------------------------------
 *  【合规红线（DESIGN §5.2）】
 *  ① 广告与分享是**并列的可选后备**，不是强制条件；
 *  ② 文案不许出现"必须分享才能继续/获得"；
 *  ③ 分享的每日上限纯粹是**防刷**，不是"逼你明天再来"的钩子。
 *
 *  ------------------------------------------------------------
 *  【自动化测试怎么过这道门】
 *  `tools/web-smoke.mjs` 的 `auto` 动作靠"读日志 → 点设计坐标"。
 *  所以这里每一步都打日志，且按钮坐标全部取自 CFG（读代码即可写测试）：
 *    [RewardGate] 渠道面板已开
 *    [RewardGate] 模拟广告开始 3s
 *    [RewardGate] 渠道=ad 放行 ok=true
 * ============================================================
 */

import { Graphics, Node, UIOpacity, log, tween } from 'cc';

import { CFG } from '../CFG';
import { SaveService } from '../core/SaveService';
import { createButton, createLabel, createNode, createPanel, hex2color } from './UIFactory';

/** 可选的获取渠道 */
export type RewardChannel = 'ad' | 'share';

/** wx 是运行时注入的全局对象：浏览器预览 / 编辑器里根本不存在，必须容错 */
function getWx(): any {
    return (globalThis as any).wx ?? null;
}

export class RewardGate {

    // ========================================================
    //  对外入口
    // ========================================================

    /**
     * 请求一次「使用道具 / 复活」的权限。
     *
     * @param parent 挂在哪个节点下（一般传页面 root）
     * @param reason 面板标题，说明这次为什么道具要权限，避免玩家莫名其妙
     * @returns true = 拿到权限，可以执行；false = 玩家取消 或 渠道没走完
     */
    public static request(parent: Node, reason: string): Promise<boolean> {
        return new Promise<boolean>((resolve) => {
            RewardGate.openChannelPanel(parent, reason, resolve);
        });
    }

    // ========================================================
    //  第一步：渠道选择面板
    // ========================================================
    private static openChannelPanel(
        parent: Node, reason: string, done: (ok: boolean) => void,
    ): void {
        const G = CFG.REWARD.GATE;
        const mask = RewardGate.makeMask(parent, 'GateMask');
        const panel = createPanel(mask, 'GatePanel', G.PANEL_W, G.PANEL_H, {
            y: G.PANEL_Y, stroke: CFG.COLOR.INK, lineWidth: 3, corners: true,
        });

        createLabel(panel, reason, {
            y: G.TITLE_DY, fontSize: CFG.FONT.SIZE_H2 - 8,
            color: CFG.COLOR.INK, bold: true, serif: true,
        });
        // 合规说明：广告与分享是并列的两条路，不诱导、不绑定
        createLabel(panel, '广告 与 分享 是并列的两条路，任选其一', {
            y: G.SUB_DY, fontSize: CFG.FONT.SIZE_SMALL, color: CFG.COLOR.INK_SOFT,
        });

        // 分享还剩几次：让玩家自己决定走哪条，而不是被引导
        const left = SaveService.instance.shareLeft();

        // 面板只负责"收起自己 + 把 done 转交出去"，**不放行**
        let panelGone = false;
        const handOver = (): boolean => {
            if (panelGone) return false;
            panelGone = true;
            RewardGate.fadeOut(mask);
            return true;
        };
        const cancel = () => {
            if (!handOver()) return;
            log('[RewardGate] 渠道面板取消');
            done(false);
        };

        // ---- 渠道 A：看激励视频 ----
        createButton(panel, 'AdBtn', {
            y: G.AD_BTN_DY, w: G.BTN_W, h: G.BTN_H,
            text: '看广告 获得', fontSize: CFG.FONT.SIZE_BUTTON - 4, serif: true,
            onClick: () => {
                if (!handOver()) return;
                log('[RewardGate] 渠道面板选择=ad');
                RewardGate.runAd(parent, done);
            },
        });

        // ---- 渠道 B：分享给朋友 ----
        createButton(panel, 'ShareBtn', {
            y: G.SHARE_BTN_DY, w: G.BTN_W, h: G.BTN_H,
            text: left > 0 ? `分享给朋友（今日还剩 ${left} 次）` : '分享给朋友（今日已用完）',
            fontSize: CFG.FONT.SIZE_BUTTON - 10,
            fill: CFG.COLOR.FACE, textColor: CFG.COLOR.INK, stroke: CFG.COLOR.INK,
            enabled: left > 0,
            enabledFill: CFG.COLOR.LOCK_BG,
            onClick: () => {
                if (!handOver()) return;
                log('[RewardGate] 渠道面板选择=share');
                RewardGate.runShare(parent, done);
            },
        });

        // ---- 放弃 ----
        // 只用文字，不画按钮，也不画角花：门是软的，不拦人。
        const cancelLabel = createLabel(panel, '暂不使用', {
            y: G.CANCEL_DY, fontSize: CFG.FONT.SIZE_BODY, color: CFG.COLOR.INK_SOFT,
            w: 200, h: 64,
        });
        cancelLabel.node.on(Node.EventType.TOUCH_END, cancel);

        log('[RewardGate] 渠道面板已开');
    }

    // ========================================================
    //  第二步 A：激励视频
    // ========================================================

    /**
     * 播一条激励视频。真广告与模拟广告在这里分流，
     * 但**完成之后走同一个出口**（见类头注释）。
     */
    private static runAd(parent: Node, done: (ok: boolean) => void): void {
        const wx = getWx();
        const unitId = CFG.REWARD.AD_UNIT_ID;

        /** 唯一出口。真广告与模拟广告都从这里进，且只进一次 */
        let settled = false;
        const settle = (ok: boolean) => {
            if (settled) return;
            settled = true;
            log(`[RewardGate] 渠道=ad 放行 ok=${ok}`);
            done(ok);
        };

        if (wx && typeof wx.createRewardedVideoAd === 'function' && unitId) {
            try {
                const ad = wx.createRewardedVideoAd({ adUnitId: unitId });
                ad.onClose((res: any) => settle(!!(res && res.isEnded)));
                ad.onError((e: any) => {
                    log('[RewardGate] 真广告出错，降级到模拟广告：', e && e.errMsg);
                    RewardGate.playMockAd(parent, settle);
                });
                ad.load()
                    .then(() => ad.show())
                    .catch(() => RewardGate.playMockAd(parent, settle));
                return;
            } catch (e) {
                log('[RewardGate] 真广告创建失败，降级到模拟广告：', e);
            }
        }

        // 未配置广告位 / 没有 wx / 初始化抛错 —— 全部落到模拟广告。
        // 这条路径**必须存在**：没有它，开发期与审核期都没法验证完整流程。
        RewardGate.playMockAd(parent, settle);
    }

    /**
     * 模拟广告占位页：3 秒倒计时 + 可跳过。
     * 之所以真做出来而不是"直接放行"，是为了让开发期的节奏与线上一致 ——
     * 玩家在这 3 秒里的耐心与误触，本身就是需要提前看到的数据。
     */
    private static playMockAd(parent: Node, settle: (ok: boolean) => void): void {
        const A = CFG.REWARD.AD_MOCK;
        const secs = CFG.REWARD.MOCK_AD_SECONDS;

        const mask = RewardGate.makeMask(parent, 'AdMockMask');
        const panel = createPanel(mask, 'AdMockPanel', A.PANEL_W, A.PANEL_H, {
            y: A.PANEL_Y, stroke: CFG.COLOR.INK, lineWidth: 3,
        });

        createLabel(panel, '模拟广告', {
            y: A.TITLE_DY, fontSize: CFG.FONT.SIZE_H2 - 6,
            color: CFG.COLOR.INK, bold: true, serif: true,
        });
        // 明确写出"这是占位页"：自测与审核时都不会被误认成真广告
        const hint = createLabel(panel, `开发者环境占位页 · ${secs} 秒后自动完成`, {
            y: A.HINT_DY, fontSize: CFG.FONT.SIZE_SMALL, color: CFG.COLOR.INK_SOFT,
            w: A.PANEL_W - 60,
        });

        log(`[RewardGate] 模拟广告开始 ${secs}s`);

        let settled = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        const finish = (ok: boolean) => {
            if (settled) return;
            settled = true;
            if (timer !== null) { clearTimeout(timer); timer = null; }
            log(`[RewardGate] 模拟广告完成 ok=${ok}`);
            RewardGate.fadeOut(mask);
            settle(ok);
        };

        // 倒计时（1 秒一跳，给玩家"进度确实在走"的确定感）
        let left = secs;
        const tick = () => {
            if (settled) return;
            left -= 1;
            if (left <= 0) { finish(true); return; }
            hint.string = `开发者环境占位页 · ${left} 秒后自动完成`;
            timer = setTimeout(tick, 1000);
        };
        timer = setTimeout(tick, 1000);

        if (CFG.REWARD.MOCK_AD_SKIPPABLE) {
            createButton(panel, 'SkipBtn', {
                y: A.SKIP_BTN_DY, w: A.BTN_W, h: A.BTN_H,
                text: '跳过', fontSize: CFG.FONT.SIZE_BUTTON - 8,
                fill: CFG.COLOR.FACE, textColor: CFG.COLOR.INK, stroke: CFG.COLOR.INK,
                onClick: () => finish(true),
            });
        }
    }

    // ========================================================
    //  第二步 B：分享
    // ========================================================

    /**
     * 分享给朋友。
     * ⚠️ 微信的 `shareAppMessage` **没有成功回调** —— success 只表示
     *    "分享面板被拉起来了"。所以只能"点开即发放"，靠每日上限防刷。
     *    这是全行业的通行做法，也是唯一可行的做法。
     */
    private static runShare(parent: Node, done: (ok: boolean) => void): void {
        const wx = getWx();
        const save = SaveService.instance;

        if (wx && typeof wx.shareAppMessage === 'function') {
            try {
                wx.shareAppMessage({
                    title: `${CFG.GAME.NAME}：${CFG.GAME.SUBTITLE}`,
                    // 分享文案刻意不带"帮我""求"这类诱导措辞（微信运营规范）
                    query: 'from=share',
                });
                const used = save.addShare();
                log(`[RewardGate] 渠道=share 放行 ok=true（真分享，今日第 ${used} 次）`);
                done(true);
                return;
            } catch (e) {
                log('[RewardGate] 真分享失败，降级到模拟分享：', e);
            }
        }

        // 开发环境：给一个短暂的"模拟分享"提示，不假装成功得太廉价
        const A = CFG.REWARD.AD_MOCK;
        const mask = RewardGate.makeMask(parent, 'ShareMockMask');
        const panel = createPanel(mask, 'ShareMockPanel', A.PANEL_W, A.PANEL_H, {
            y: A.PANEL_Y, stroke: CFG.COLOR.INK, lineWidth: 3,
        });
        createLabel(panel, '模拟分享', {
            y: A.TITLE_DY, fontSize: CFG.FONT.SIZE_H2 - 6,
            color: CFG.COLOR.INK, bold: true, serif: true,
        });
        createLabel(panel, '开发者环境不拉起分享面板，1 秒后直接放行', {
            y: A.HINT_DY, fontSize: CFG.FONT.SIZE_SMALL, color: CFG.COLOR.INK_SOFT,
            w: A.PANEL_W - 60,
        });

        log('[RewardGate] 模拟分享开始 1s');
        setTimeout(() => {
            const used = save.addShare();
            log(`[RewardGate] 渠道=share 放行 ok=true（模拟，今日第 ${used} 次）`);
            RewardGate.fadeOut(mask);
            done(true);
        }, 1000);
    }

    // ========================================================
    //  工具
    // ========================================================

    /**
     * 全屏半透明遮罩。
     * 除了挡视觉，它还负责**吃掉所有点击** —— 弹窗下面就是牌堆，
     * 不挡的话玩家能隔着弹窗点到牌。那种 bug 极难复现，也极难描述。
     */
    private static makeMask(parent: Node, name: string): Node {
        const mask = createNode(name, parent, { w: 2000, h: 2000 });
        const g = mask.addComponent(Graphics);
        const half = 1000;
        g.fillColor = hex2color(CFG.COLOR.MASK, CFG.REWARD.GATE.MASK_ALPHA);
        g.rect(-half, -half, half * 2, half * 2);
        g.fill();
        mask.addComponent(UIOpacity);   // 供淡出使用

        // 遮罩自带 UITransform(2000×2000) 就已参与命中测试，会吃掉下面的点击。
        // 这里再显式挂一个空监听：老版本引擎里"有 UITransform 无监听"不一定会吞事件，
        // 显式挂上就没有平台差异了。
        mask.on(Node.EventType.TOUCH_END, () => { /* 吞掉，不做事 */ });
        return mask;
    }

    /** 淡出并销毁（直接 destroy 会有一帧硬切，很廉价） */
    private static fadeOut(node: Node): void {
        if (!node.isValid) return;
        const op = node.getComponent(UIOpacity);
        if (op) {
            tween(op).to(0.12, { opacity: 0 }).call(() => {
                if (node.isValid) node.destroy();
            }).start();
        } else {
            node.destroy();
        }
    }
}
