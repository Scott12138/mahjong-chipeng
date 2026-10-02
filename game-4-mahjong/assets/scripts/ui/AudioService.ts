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
 *  浏览器 / 微信的 autoplay 策略要求音频的**首次**播放必须发生在用户手势的
 *  调用栈里，否则被静默拦截（不报错、日志也看不出，只是没声音）。
 *
 *  ⚠️ 这里有一个**极易误判**的地方：同样是"页面打开时播放"，
 *     `onBuild` 与 `onEnter` 的处境**完全相反** ——
 *       · `onBuild` 由 PageManager.open **同步**调用，而 open 又由
 *         点击 → goto 同步触发  ⇒  **在手势栈内** ✅
 *       · `onEnter` 是 `setTimeout(duration + 20ms)` 之后才调的
 *         ⇒ **已经出栈**，在这里播什么都起不来 ❌
 *     所以 BGM 的起播点必须挑 `onBuild`（详见 playBgm 的注释）。
 *
 *  首屏（menu）的 open 发生在 GameRoot.onLoad 里 —— 那一次**确实**不在
 *  手势栈内，所以入场（A1）刻意不放任何声音；BGM 也因此不包括 menu 页。
 * ============================================================
 */

import { AudioClip, AudioSource, Node, log, resources, warn } from 'cc';
import { CFG } from '../CFG';

/**
 * BGM 的资源路径（相对 assets/resources）。
 * 不要写成 'audio/bgm.m4a' —— `resources.load` 的路径**不带扩展名**，
 * 带上就会走到"加载失败只 warn 不报错"的静默分支里。
 */
const BGM_PATH = 'audio/bgm';

/**
 * 全部音效 id。
 *
 * 【★ S18 决议 5：人声念白整体下线（2026-10-01）】
 *   以前这里有两段**人声念白** `peng` / `eat`（真人 TTS 念的「碰」「吃」，
 *   由 `tools/install-voice-lib.py` 从棋牌语音库灌进 assets）。
 *   它们读出来的就是**棋牌术语**，虽然"好听、有辨识度"，
 *   但和"个人主体 + 休闲益智类目、游戏内零棋牌语义"这条硬约束直接冲突
 *   （见 `MatchRule.ts` 头注释与 DESIGN §10），所以：
 *     · `peng.m4a` → **改名 `clash`** 并换成**合成音**（波形从 sfx_peng 继承，
 *        本来就是噪声瞬态 + 三音和弦，不含任何语义）；
 *     · `eat.m4a`  → **改用 `swish`**（新合成的纸 / 木质「唰」）；
 *     · 两个旧文件已从 assets 删除，`id` 也从下面这个联合类型里移除了。
 *   ⚠️ 从此**全工程不再有"人声"这一类音源**，`SfxId` 里全部是合成音，
 *      所以「改音效」这件事**只归 make-sfx.py 管**（不会再有两个脚本抢名字）。
 *
 * 【两张"出生证明"仍要分清（S12.2）】
 *   · 合成音（13 段）：与 tools/make-sfx.py 的 SFX 字典**一一对应**；
 *   · BGM 1 段：由 tools/make-bgm.py 生成，不走 SfxId。
 *   改音效前先看一眼它归哪个脚本管，改错脚本会让"重跑生成脚本"冲掉刚做的改动。
 *
 * 【`flow` 已退役（S12.2）】它原来是连号消除的"流水汇合"音。
 * 连号消除改成"咀嚼"之后没有调用方了，文件与 id 一并删除 ——
 * 留着一个永远加载不到的 id，只会让"怎么没声音"变成一桩悬案
 * （音频加载失败**只 warn 不报错**）。
 * 函数体仍在 make-sfx.py 里留作参考实现（但**不登记**进 SFX 字典）。
 */
export type SfxId =
    | 'tap' | 'pick' | 'land' | 'reject'
    | 'clash' | 'clear' | 'swish'
    | 'shuffle' | 'reward' | 'fail' | 'revive' | 'addslot' | 'win';

/** 与资源目录一致的清单（顺序无关，只用于遍历加载） */
const ALL_SFX: SfxId[] = [
    'tap', 'pick', 'land', 'reject',
    'clash', 'clear', 'swish',
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

    // ---- BGM（S14）------------------------------------------
    /**
     * BGM 的专用声道。
     * 🔴 它**不进 `_voices` 池** —— 池里的声道会被音效按"最久没用"抢占用掉，
     *    而 BGM 被掐断就是"整局没音乐"，跟"少一声点击音"完全不是一个量级的事故。
     */
    private static _bgm: AudioSource | null = null;
    private static _bgmClip: AudioClip | null = null;
    /** 业务侧的意图：「现在应该放 BGM」（由页面生命周期决定，与"是否真的响了"解耦） */
    private static _bgmWanted = false;
    /** 是否已经把 play() 发出去过（防止重复 play 把音乐从头打断） */
    private static _bgmStarted = false;
    /** 淡出链路上的定时器句柄（取消淡出时统一清掉） */
    private static _bgmFadeIds: number[] = [];

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

        // BGM 独占一条 AudioSource，挂在同一个宿主下。
        // loop 由 AudioSource 自己维持（不需要监听"播完了"再手动接上 ——
        // 那种写法在切后台/丢帧的瞬间会漏掉一次结尾，音乐就断了）。
        const bgmNode = new Node('AudioVoice_BGM');
        bgmNode.layer = host.layer;
        host.addChild(bgmNode);
        const bgm = bgmNode.addComponent(AudioSource);
        bgm.playOnAwake = false;
        bgm.loop = true;
        bgm.volume = 0;
        this._bgm = bgm;

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

    /** 预加载全部音效 + BGM。失败的单个资源只告警，不影响其它资源 */
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

        // BGM 单独打一条日志：它 281K，是最大的一个音频资源，加载失败的后果
        // 也最明显（整局没音乐）。命令行无头验证时要能一眼看出它到底就绪没有
        // —— 混在"音效就绪 13/13"里是看不出来的（那 13 是 ALL_SFX.length）。
        resources.load(BGM_PATH, AudioClip, (err, clip) => {
            if (err || !clip) {
                warn(`[AudioService] BGM 加载失败：${BGM_PATH}（${err ? String(err) : '空资源'}）`);
                return;
            }
            this._bgmClip = clip;
            log(`[AudioService] BGM 就绪：${BGM_PATH}（${clip.getDuration().toFixed(1)}s）`);
            // 资源到位时补试一次。在**微信**里这一步通常就能直接起播
            // （之前已经有过真实的用户交互）；浏览器会拦，那就等下一次点击借势。
            this.tryStartBgm();
        });
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

        // ★【借手势】BGM 的首次起播必须落在用户手势的调用栈里。
        //   音效 100% 由点击触发，所以"玩家点下的这一下"就是天然的时机 ——
        //   顺手把 BGM 带起来。这是一条兜底：页面 onBuild 那次若因为
        //   资源还没加载完而没能播成，第一下点牌一定会成。
        this.tryStartBgm();

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
    //  BGM（S14）
    // --------------------------------------------------------

    /**
     * 请求播放 BGM（**幂等**，重复调用是安全的，已在播则什么都不做）。
     *
     * ★【调用点必须在用户手势的调用栈里】
     *   浏览器 / 微信的 autoplay 策略只对**首次**播放严格：不在手势栈内就会被
     *   静默拦截 —— 不抛异常、日志也没有线索，表现只是"没声音"。
     *   本作的调用点是各页面的 `onBuild`（由 PageManager.open 同步调用，
     *   而 open 又由 点击 → goto 同步触发）⇒ 天然在手势栈内 ✅
     *   ⚠️ **绝对不要挪到 onEnter**：它是 setTimeout 之后才调的，已经出栈了。
     *
     * 【为什么"想要"（_bgmWanted）和"已经发过 play"（_bgmStarted）要分成两个】
     *   资源是异步加载的。玩家完全可能在世界还没就绪时就进了游戏页 ——
     *   正确的做法是**记住这个意图**，等资源到位或下一次点击时补上；
     *   而不是"没就绪就放弃，以后也不播了"。
     */
    public static playBgm(): void {
        if (!CFG.AUDIO.ENABLED || !CFG.AUDIO.BGM_ENABLED) return;
        // 先取消进行中的淡出：否则淡出链路末尾那句 stop() 会把刚起的 BGM 掐掉
        // （快速"回菜单 → 又进游戏"时最容易踩到）
        this.cancelFade();
        this._bgmWanted = true;
        this.tryStartBgm();
    }

    /**
     * 请求停止 BGM（带淡出）。
     * 语义是"业务侧不再需要 BGM"，所以会一并清掉 _bgmWanted。
     */
    public static stopBgm(): void {
        this._bgmWanted = false;

        const src = this._bgm;
        if (!src || !src.isValid || !this._bgmStarted) return;

        const total = Math.max(0, CFG.AUDIO.BGM_FADE_MS);
        this.cancelFade();
        if (total <= 0) {
            src.stop();
            src.volume = 0;
            this._bgmStarted = false;
            return;
        }

        const from = src.volume;
        const steps = 6;
        const stepMs = Math.max(16, Math.round(total / steps));
        for (let i = 1; i <= steps; i++) {
            const k = i / steps;
            this._bgmFadeIds.push(setTimeout(() => {
                if (!src.isValid || !this._bgmStarted) return;
                src.volume = i === steps ? 0 : from * (1 - k);
            }, stepMs * i) as unknown as number);
        }
        // 兜底：无论淡出链路有没有被打断，到点必须真的停下来。
        // 铁律同 PageManager —— 状态流转走"必然执行"的路径，动效只负责好看。
        this._bgmFadeIds.push(setTimeout(() => {
            if (!src.isValid || !this._bgmStarted) return;
            src.stop();
            src.volume = 0;
            this._bgmStarted = false;
        }, total + 140) as unknown as number);
    }

    /** 真正把 play() 发出去。资源未就绪 / 已静音 / 已在播 都会安静返回 */
    private static tryStartBgm(): void {
        if (!this._bgmWanted) return;

        const src = this._bgm;
        if (!src || !src.isValid) return;

        // 已在播：只把音量校正回该有的位置。
        // 这一条是"选关 ↔ 局内来回切不重启音乐"的关键 ——
        // 每次进页面都从头重播的话，音乐会不停从第 0 秒开始，非常廉价。
        if (this._bgmStarted) {
            if (!this._muted) src.volume = this.bgmVolume();
            return;
        }

        if (this._muted || !this._bgmClip) return;   // 还没就绪：等"借势"

        this._bgmStarted = true;
        this.cancelFade();
        src.stop();                 // 清掉可能残留的播放态，保证从第 0 秒干净开始
        src.clip = this._bgmClip;
        src.loop = true;            // 循环由 AudioSource 维持，不靠监听结束事件
        src.volume = this.bgmVolume();
        src.play();
        log('[AudioService] BGM 起播（茶馆电音）');
    }

    /** BGM 该有的音量（MASTER × BGM_GAIN，夹到 0~1） */
    private static bgmVolume(): number {
        return Math.max(0, Math.min(1, CFG.AUDIO.MASTER * CFG.AUDIO.BGM_GAIN));
    }

    /** 清掉淡出链路上的定时器（不动 _bgmStarted，那由 tryStartBgm / stopBgm 决定） */
    private static cancelFade(): void {
        for (const id of this._bgmFadeIds) clearTimeout(id);
        this._bgmFadeIds.length = 0;
    }

    /** 仅供测试/排查：BGM 是否已经起播 */
    public static get bgmPlaying(): boolean {
        return this._bgmStarted;
    }

    // --------------------------------------------------------
    //  静音（供后续设置页 / 顶部小喇叭按钮调用）
    // --------------------------------------------------------

    public static get muted(): boolean { return this._muted; }

    /** 静音。会立刻掐断所有正在播的声音，而不是等它们播完 */
    public static setMuted(m: boolean): void {
        this._muted = m;

        const bgm = this._bgm;
        if (m) {
            // 静音这个动作本身就该是**即时**的 —— 此时再给 BGM 做淡出，
            // 玩家会觉得"我按了静音它还在响"。所以这里硬停。
            for (const v of this._voices) {
                if (v && v.isValid && v.playing) v.stop();
            }
            this.cancelFade();
            if (bgm && bgm.isValid) {
                bgm.stop();
                bgm.volume = 0;
            }
            this._bgmStarted = false;
            return;
        }

        // 取消静音：若业务侧仍然"想要 BGM"，把它接回来。
        // ⚠️ 注意 _bgmWanted 是**页面生命周期**给的意图，不因静音而丢弃 ——
        //    否则"在局内点一下静音、再取消"，BGM 就再也回不来了。
        if (bgm && bgm.isValid) bgm.volume = this.bgmVolume();
        this.tryStartBgm();
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
