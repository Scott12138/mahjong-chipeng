/**
 * ============================================================
 *  AudioService.ts · 音效播放（S7.5）
 * ============================================================
 *  职责：把"播一个音效"这件事收敛成一个静态方法调用，
 *        业务代码永远不需要知道：文件在哪、加载好没有、有没有静音、
 *        用哪条声道、上一次播是什么时候。
 *
 *  ------------------------------------------------------------
 *  【设计要点：为什么是"声道池"而不是 playOneShot】
 *  Cocos 的 AudioSource 有个很省事的 `playOneShot(clip, volume)`，
 *  一个组件就能并发播多个音效，但它给不了**抢占**：
 *  声道池可以明确地"先 stop 掉最老的那条、再播新的"，
 *  保证玩家当下这一下**永远有声音**（宁可掐掉一条音效尾巴，
 *  也不许点击没有反馈）。
 *
 *  ⚠️ 这个设计的**原始理由已经失效**（留在这里避免后人误解）：
 *  初版是为了「连章」需要"层数越高音调越高"的变速播放，当时以为必须
 *  绕开 playOneShot 的 playbackRate 限制才这么写。
 *
 *  **【术语】「连章」= 连击**（限时窗口内连续消除的计数）——它和「吃（顺子）」
 *  是两回事，本作**不需要连击**，那套机制已整体删除。
 *  声道池本身的价值（抢占 + 统一的静音/加载管理）与它无关，故保留。
 *
 *  ------------------------------------------------------------
 *  【设计要点：加载未完成时"静默跳过"，绝不补播】
 *  音效是异步加载的。第一次点击时如果正好还没加载完，
 *  正确做法是**放弃这一声**，而不是等加载完再补播 ——
 *  补播出来的是一个 300ms 前就该响的声音，玩家会觉得"声音和动作对不上"，
 *  比少一声更糟。这也是为什么着色器要在启动时就 preload：
 *  真等到玩家点牌，早就加载完了。
 *
 *  ------------------------------------------------------------
 *  【设计要点：所有播放在"用户交互之后"】
 *  浏览器的 autoplay 策略要求音频播放必须发生在用户手势的调用栈里，
 *  否则会被静默拦截。本作的音效全部由点击触发，天然满足；
 *  入场（A1）**刻意不放音效**，就是因为它在 onBuild 里、不在手势栈内。
 * ============================================================
 */

import { AudioClip, AudioSource, Node, log, resources, warn } from 'cc';
import { CFG } from '../CFG';

/** 全部音效 id。与 tools/make-sfx.py 的 SFX 字典一一对应 */
export type SfxId =
    | 'tap' | 'pick' | 'land' | 'reject'
    | 'peng' | 'clear' | 'flow'
    | 'shuffle' | 'reward' | 'fail' | 'revive' | 'addslot' | 'win';

/** 与资源目录一致的清单（顺序无关，只用于遍历加载） */
const ALL_SFX: SfxId[] = [
    'tap', 'pick', 'land', 'reject',
    'peng', 'clear', 'flow',
    'shuffle', 'reward', 'fail', 'revive', 'addslot', 'win',
];

/** 播放参数 */
export interface PlayOpts {
    /** 音量倍率（会再乘 CFG.AUDIO.MASTER 与 CFG.AUDIO.GAIN[id]） */
    gain?: number;
    /** 覆盖本音效的最短重放间隔（毫秒）。入场落牌声用它放宽到 130ms */
    gapMs?: number;
}

export class AudioService {

    private static _host: Node | null = null;
    private static _voices: AudioSource[] = [];
    private static _rr = 0;
    private static _clips: Partial<Record<SfxId, AudioClip>> = {};
    /** 每个音效上一次播放的时间戳（节流用） */
    private static _lastAt: Partial<Record<SfxId, number>> = {};
    private static _muted = false;
    /** 已发起过 preload（重复调用直接返回，避免重复请求同一批资源） */
    private static _loaded = false;
    /** 已成功加载的音效数量（全部就绪时打一条日志） */
    private static _readyCount = 0;

    // --------------------------------------------------------
    //  初始化
    // --------------------------------------------------------

    /**
     * 建立声道池并开始预加载。
     * 必须在**启动时**调用一次（GameRoot.onLoad），不要等玩家点牌才建 ——
     * 那样第一批音效一定播不出来。
     *
     * @param host 承载 AudioSource 的宿主节点。它应该挂在 UIRoot 下，
     *             这样页面来回切换时声道不会被销毁（音效不跟着页面走）。
     */
    public static init(host: Node): void {
        if (this._host && this._host.isValid) return;
        this._host = host;

        const n = Math.max(1, CFG.AUDIO.VOICES);
        for (let i = 0; i < n; i++) {
            const node = new Node(`AudioVoice_${i}`);
            node.layer = host.layer;
            host.addChild(node);
            const src = node.addComponent(AudioSource);
            // playOnAwake 默认是 true，会在组件 onEnable 时尝试播一次空 clip，
            // 虽然无害但会污染日志，明确关掉。
            src.playOnAwake = false;
            src.loop = false;
            src.volume = CFG.AUDIO.MASTER;
            this._voices.push(src);
        }

        this.pinMuteSwitch();
        this.preload();
    }

    /**
     * 钉死"跟随系统静音键"这个行为（S7.9）。
     *
     * ------------------------------------------------------------
     * 【为什么只写一行、而且行为不变】
     * 微信 `wx.setInnerAudioOption` 的 `obeyMuteSwitch` **默认就是 true**
     * （仅在 iOS 生效，官网原文："是否遵循静音开关，设置为 false 之后，
     * 即使是在静音模式下，也能播放声音"）。而且从基础库 2.3.0 起，
     * `InnerAudioContext.obeyMuteSwitch` 单独设置已失效，改由这个接口统一控制 ——
     * 也就是说"开静音拨杆 → 游戏静音"**本来就已经满足**，这一行不改变任何行为。
     *
     * 那为什么还要写？把这个**意图**写进代码。将来换引擎版本 / 换运行环境时，
     * 一旦默认值发生漂移，这里会立刻暴露成一次"声音行为异常"，
     * 而不是一次没人发现的行为静默变化（本工程已经在别处吃过这种亏）。
     *
     * ⚠️ 只在微信小游戏环境调用：浏览器 / 编辑器里没有 `wx`，
     *    静默跳过。这一行是锦上添花，绝不该有能力把启动搞崩 —— 故包 try/catch。
     * ------------------------------------------------------------
     */
    private static pinMuteSwitch(): void {
        const api = (globalThis as {
            wx?: { setInnerAudioOption?: (o: Record<string, unknown>) => void };
        }).wx;
        if (!api || typeof api.setInnerAudioOption !== 'function') return;
        try {
            api.setInnerAudioOption({ obeyMuteSwitch: true });
        } catch (e) {
            // 失败不影响玩法（音效照常走 Cocos 的音频通道），只留一条线索
            warn(`[AudioService] setInnerAudioOption 调用失败（不影响玩法）：${String(e)}`);
        }
    }

    /** 预加载全部音效。失败的单个资源只告警，不影响其它音效 */
    private static preload(): void {
        if (this._loaded) return;
        this._loaded = true;

        for (const id of ALL_SFX) {
            // 路径相对 assets/resources：assets/resources/audio/tap.m4a → 'audio/tap'
            resources.load(`audio/${id}`, AudioClip, (err, clip) => {
                if (err || !clip) {
                    warn(`[AudioService] 音效加载失败：${id}（${err ? String(err) : '空资源'}）`);
                    return;
                }
                this._clips[id] = clip;
                this._readyCount++;
                // 全部就绪时打一条日志。命令行无头验证时看不到调试器，
                // 这一行是"音频到底加载成功没有"的唯一线索 ——
                // 少了它，"怎么没声音"就只能靠猜。
                if (this._readyCount === ALL_SFX.length) {
                    log(`[AudioService] 音效就绪 ${this._readyCount}/${ALL_SFX.length}`);
                }
            });
        }
    }

    // --------------------------------------------------------
    //  播放
    // --------------------------------------------------------

    /**
     * 播一个音效。**永远不抛异常** —— 音效挂掉不该影响玩法。
     *
     * @param id   音效 id
     * @param opts 音量 / 速率 / 节流覆盖
     */
    public static play(id: SfxId, opts: PlayOpts = {}): void {
        if (!CFG.AUDIO.ENABLED || this._muted) return;

        const clip = this._clips[id];
        // 还没加载好 → 静默跳过（理由见文件头：补播比少一声更糟）
        if (!clip) return;

        // 节流：同一个音效短时间内只响一次
        const gap = opts.gapMs ?? CFG.AUDIO.MIN_GAP_MS;
        const now = Date.now();
        if (now - (this._lastAt[id] ?? -1e9) < gap) return;
        this._lastAt[id] = now;

        const src = this.pickVoice();
        if (!src) return;

        const perGain = CFG.AUDIO.GAIN[id] ?? 1;
        src.stop();                                   // 抢到的是"最老的一条"，先掐断它
        src.clip = clip;
        src.volume = Math.max(0, Math.min(1, CFG.AUDIO.MASTER * perGain * (opts.gain ?? 1)));
        src.play();
    }

    /**
     * 挑一条声道：优先空闲的；全忙则按轮转抢占（最久没被用过的那条）。
     * 抢占是有意的：宁可掐掉一个 400ms 前的音效尾巴，
     * 也不能让当前的点击没声音。
     */
    private static pickVoice(): AudioSource | null {
        const n = this._voices.length;
        if (n === 0) return null;
        for (let i = 0; i < n; i++) {
            const idx = (this._rr + i) % n;
            const v = this._voices[idx];
            if (v && v.isValid && !v.playing) {
                this._rr = (idx + 1) % n;
                return v;
            }
        }
        const v = this._voices[this._rr];
        this._rr = (this._rr + 1) % n;
        return (v && v.isValid) ? v : null;
    }

    // --------------------------------------------------------
    //  静音（供后续设置页 / 顶部小喇叭按钮调用）
    // --------------------------------------------------------

    public static get muted(): boolean { return this._muted; }

    /** 静音。会立刻掐断所有正在播的声音，而不是等它们播完 */
    public static setMuted(m: boolean): void {
        this._muted = m;
        if (!m) return;
        for (const v of this._voices) {
            if (v && v.isValid && v.playing) v.stop();
        }
    }

    public static toggleMuted(): boolean {
        this.setMuted(!this._muted);
        return this._muted;
    }

    /** 仅供测试/排查：当前已加载好的音效数量 */
    public static get loadedCount(): number {
        return this._readyCount;
    }
}
