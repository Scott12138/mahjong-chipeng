#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 make-sfx.py · 程序化合成游戏音效（零素材依赖）
============================================================
 为什么要"合成"而不是"下载素材"：
   ① 版权干净 —— 本作是要上架的微信小游戏，音效素材的来源必须可追溯；
   ② 体积可控 —— 首包红线 4MB，下载来的 mp3 动辄几百 KB，
      自己合成的短音效压成 m4a 后每段只有 2~5KB；
   ③ 参数可调 —— "碰"的和弦音高、"消除"的扫频范围全是脚下这几行数字，
      想换手感改参数重跑即可，不用去找第 12 个素材网站。

 合成链：Python 直出 16bit/44.1kHz 单声道 WAV
         → 系统 afconvert 转 AAC（m4a）
         → 落进 assets/resources/audio/
 输出体积：13 段合计约 80KB（AAC 64kbps 单声道，每段 4~7KB）。
   音效分工：`clash` + `clear` = 「咚—唰」（消除的那一刻），
             `swish` = 纸 / 木质的「唰」（连号消除的咀嚼），
             `shuffle` = 「哗啦」（洗牌）。

 ============================================================================
  ⚠️⚠️ 命名冲突史（S18 决议 5，2026-10-01）—— 动手改音效之前必读 ⚠️⚠️
 ============================================================================
  `assets/resources/audio/peng.m4a` 与 `eat.m4a` 这两个文件，
  **装的不是本脚本合成的音**，而是 `tools/install-voice-lib.py` 从
  「ChessCard 棋牌语音库 · 女声」灌进去的**人声念白「碰」「吃」**。
  两个脚本写同一对文件名，谁最后跑谁赢 —— 这是一个长期埋着的踩坑点
  （改了合成参数却听不出变化，因为文件早被人声覆盖了）。

  S18 的处置（**人声念白这条链路整体下线**）：
   · `peng.m4a` / `eat.m4a` **文件删除**，id 从 `AudioService.SfxId` 移除；
   · 本脚本里原来的 `sfx_peng` 改名 `sfx_clash`，波形不变（它本无语义），
     输出改名 `clash.m4a`，从此不再有人声与它抢名字；
   · 新增 `swish.m4a` 顶替原来的人声「吃」；
   · ⚠️ **不要再跑 `install-voice-lib.py`**，也**不要**把 `peng` / `eat`
     重新加回下面的 SFX 字典 —— 会把新做的 clash / swish 直接覆盖掉。

 用法：
     python3 tools/make-sfx.py            # 生成全部音效
     python3 tools/make-sfx.py --wav-only # 只出 wav（调试波形用）

 ⚠️ 随机数用固定种子：噪声是"合成素材"的一部分，
    换一台机器重跑必须得到逐字节相同的结果（否则每次重打包
    assets 的 md5 都在变，没法判断"这次提交到底改了什么"）。

 ⚠️ 光有固定种子**不够**，还有两层坑（都在 2026-10-01 补上）：
    ① **种子必须按音效名分开播**（见 `seed_for()`）。只播一次全局种子，
       随机数流就按 SFX 字典顺序被各音效依次消耗 ——
       **改一个音效会扰动它后面所有音效**的字节。
       S18 插入 `swish` 时，`shuffle.m4a` 与 `addslot.m4a` 当场就变了
       （它们自己的代码一个字没动）。现在每个音效独立播种，改 A 不影响 B。
    ② 「重跑两次结果不同」的另一个原因是 `afconvert` 会往 m4a 容器里写
       "编码那一刻"的时间戳。因此写完 m4a 后必须调 `zero_container_times()`
       把容器时间清零。这条以前缺失，等于文件头的承诺是假的。
============================================================
"""

import math
import os
import random
import struct
import subprocess
import sys
import wave

# ------------------------------------------------------------
#  全局参数
# ------------------------------------------------------------
SR = 44100              # 采样率。高频音效（"叮"）需要足够带宽，22050 会出现金属感的折叠失真
SEED = 20260930         # 固定种子，见文件头说明
PEAK = 0.72             # 归一化峰值（留 3dB 余量，避免 AAC 编码削波）
OUT_M4A_DIR = os.path.join(os.path.dirname(__file__), '..', 'assets', 'resources', 'audio')
TMP_WAV_DIR = '/tmp/game4-sfx-wav'

# 模块级播种：只为"直接在 REPL / 单测里调用某个 sfx_xxx()"这种用法兜底。
# ★ 真正跑批量生成时走的是 main() 里的**逐音效播种**（见下），这个种子会被覆盖。
random.seed(SEED)


def seed_for(name: str) -> None:
    """
    ★ **按音效名**播种 —— 生成某个音效之前必须调用它。

    【为什么不能只用一个全局种子（2026-10-01 修正）】
    合成噪声用的是 `random.uniform`，它是一条**全局的随机数流**。
    只播一次全局种子的话，"流"是按 `SFX` 字典顺序被各个音效依次消耗的 ——
    于是**改一个音效会扰动它后面所有音效**：
      S18 把 `swish` 插到 `clear` 之后，`shuffle.m4a` 和 `addslot.m4a`
      的 md5 当场就变了（它们自己的代码一个字没动）。
    这在"每次修改都能回溯"的要求下是灾难：一次无关的 diff 里混进两个
    听不出区别、也解释不清的二进制变化，回溯的人会以为改坏了什么。

    【为什么用名字而不是数字下标】下标会随字典顺序漂移，
    而名字是稳定的 —— 加/删/移动任何一项，都不会改变其余音效的字节。

    【为什么是确定的】`random.seed(str)` 内部走 sha512，跨机器、跨进程、
    跨 Python 版本都是同一个结果（不像 `hash()` 受 PYTHONHASHSEED 影响）。
    """
    random.seed(f'{SEED}:{name}')


# ============================================================
#  一、基元（primitive）：所有音效都由这几种波形叠加而成
# ============================================================

def _attack_gain(t: float, attack_ms: float) -> float:
    """
    起音斜坡。**必须要有**：直接从 0 跳到峰值会产生一个瞬态 "啪"，
    在 AAC 里还会被编码器涂抹成一段刺耳的前回声。
    3ms 已经短到人耳听不出"渐入"，但足以让波形连续。
    """
    if attack_ms <= 0:
        return 1.0
    a = attack_ms / 1000.0
    return min(1.0, t / a) if t < a else 1.0


def bell(n: int, freq: float, decay: float, amp: float = 1.0,
         partials=((1.0, 1.0), (2.01, 0.34), (3.02, 0.16), (4.95, 0.07)),
         attack_ms: float = 3.0) -> list:
    """
    钟 / 铃类音色（"碰"、"消除"、"奖励"都用它打底）。

    【为什么泛音用 2.01 / 3.02 / 4.95 而不是整数倍】
    整数倍泛音叠加出来是"风琴"（谐波完全对齐，听起来很干净但很呆）。
    真实金属体（钟、铃、麻将牌本身）的泛音是**非整数倍**的，
    偏移一点点（2.01 而不是 2.00）就会产生缓慢的拍频，
    那种"轻轻晃动"的质感是"高级感"的来源 —— 这也是所有打击乐合成器的标准做法。
    """
    out = []
    for i in range(n):
        t = i / SR
        e = math.exp(-t / decay) * _attack_gain(t, attack_ms)
        v = 0.0
        for mult, pa in partials:
            v += pa * math.sin(2 * math.pi * freq * mult * t)
        out.append(amp * e * v)
    return out


def tone(n: int, freq: float, decay: float, amp: float = 1.0,
         attack_ms: float = 2.0, square: float = 0.0) -> list:
    """
    纯正弦 / 轻微方波化的单音（木质感打底）。
    square > 0 时把正弦"削平"一点，得到更硬的木质敲击感（用于 tap / pick）。
    注意这里的削平不是符号函数（那会产生无限谐波、编码后发毛），
    而是 tanh 软削波 —— 谐波随强度自然衰减，听起来是"硬"而不是"炸"。
    """
    out = []
    for i in range(n):
        t = i / SR
        e = math.exp(-t / decay) * _attack_gain(t, attack_ms)
        v = math.sin(2 * math.pi * freq * t)
        if square > 0:
            v = math.tanh(v * (1 + square * 6.0)) / math.tanh(1 + square * 6.0)
        out.append(amp * e * v)
    return out


def sweep(n: int, f0: float, f1: float, decay: float, amp: float = 1.0,
          attack_ms: float = 3.0, log: bool = True) -> list:
    """
    扫频（"消除"的上行、'失败'的下行）。

    【为什么默认用对数扫频】
    人耳对音高的感知是对数的：100→200Hz 与 1000→2000Hz 是"同样的距离"。
    线性扫频在低频段听着"半天不动"、高频段"唰一下就过去"，
    对数扫频才是听觉上"匀速上升"。
    """
    out = []
    phase = 0.0
    for i in range(n):
        t = i / SR
        k = i / max(1, n - 1)
        f = f0 * ((f1 / f0) ** k) if log else f0 + (f1 - f0) * k
        phase += 2 * math.pi * f / SR
        e = math.exp(-t / decay) * _attack_gain(t, attack_ms)
        out.append(amp * e * math.sin(phase))
    return out


def noise(n: int, decay: float, amp: float = 1.0,
          lp: float = 0.30, hp: float = 0.0,
          attack_ms: float = 1.0, humps: int = 0) -> list:
    """
    噪声（"洗牌"的摩擦、"碰"的冲击瞬态）。
    lp / hp 是一阶低通 / 高通系数（0~1），用来把白噪声塑形成"纸张"或"金属"。
    humps > 0 时给包络叠加起伏（洗牌是"哗—啦—啦"三下，不是一声闷响）。
    """
    out = []
    y = 0.0
    yh = 0.0
    prev = 0.0
    for i in range(n):
        t = i / SR
        x = random.uniform(-1.0, 1.0)
        y += lp * (x - y)                       # 低通
        if hp > 0:
            yh = hp * (yh + y - prev)           # 高通（y 与它的前一采样之差）
            prev = y
            v = yh
        else:
            v = y
        e = math.exp(-t / decay)
        if humps > 0:
            k = i / max(1, n - 1)
            e *= 0.55 + 0.45 * abs(math.sin(math.pi * humps * k))
        out.append(amp * e * v * _attack_gain(t, attack_ms))
    return out


# ============================================================
#  二、混音工具
# ============================================================

def buf(ms: float) -> list:
    """按毫秒申请一段空缓冲"""
    return [0.0] * max(1, int(SR * ms / 1000.0))


def mix(dst: list, src: list, at_ms: float = 0.0, gain: float = 1.0) -> list:
    """把 src 叠加到 dst 的 at_ms 处（越界部分丢弃）"""
    off = int(SR * at_ms / 1000.0)
    for i, v in enumerate(src):
        j = off + i
        if 0 <= j < len(dst):
            dst[j] += v * gain
    return dst


def normalize(sig: list, peak: float = PEAK) -> list:
    """峰值归一化 + 首尾各 2ms 淡入淡出（防止播放头尾的爆音）"""
    m = max((abs(v) for v in sig), default=0.0)
    if m > 1e-9:
        k = peak / m
        sig = [v * k for v in sig]
    fade = int(SR * 0.002)
    for i in range(min(fade, len(sig))):
        g = i / fade
        sig[i] *= g
        sig[-1 - i] *= g
    return sig


def write_wav(path: str, sig: list) -> None:
    """写 16bit 单声道 WAV"""
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b''.join(
            struct.pack('<h', max(-32768, min(32767, int(v * 32767))))
            for v in sig
        ))


# ============================================================
#  三、逐个音效的配方
# ============================================================
#  设计原则（与 CFG.MOTION 里的时长一一对应）：
#   · 反馈音必须 **短于** 对应的动画 —— 动画还在跑、声音已经收尾，
#     观感是"动作干脆"；反过来的话每次操作都拖着一条声尾。
#   · 同一族动作（点击类）共用一个音高中心，靠音色区分，
#     玩家才会把它们听成"同一套语言"。
# ============================================================

def sfx_tap() -> list:
    """B1 按下：极短的木质 '哒'。60ms 的动画，音效给 70ms"""
    s = buf(70)
    mix(s, tone(int(SR * 0.055), 1750, 0.011, 0.75, square=0.55), 0)
    mix(s, noise(int(SR * 0.020), 0.004, 0.35, lp=0.75), 0)       # 击打的瞬态
    return normalize(s)


def sfx_pick() -> list:
    """B3 起飞：'呲' 一声离手音"""
    s = buf(110)
    mix(s, sweep(int(SR * 0.09), 900, 1500, 0.030, 0.55), 0)
    mix(s, noise(int(SR * 0.05), 0.012, 0.22, lp=0.55, hp=0.20), 0)
    return normalize(s)


def sfx_land() -> list:
    """B4 落位：牌入槽的 '咔'（比 tap 闷、比 pick 实）"""
    s = buf(120)
    mix(s, tone(int(SR * 0.09), 520, 0.028, 0.80, attack_ms=1.0), 0)
    mix(s, tone(int(SR * 0.07), 780, 0.018, 0.42), 0)
    mix(s, noise(int(SR * 0.030), 0.006, 0.30, lp=0.45), 0)
    return normalize(s)


def sfx_reject() -> list:
    """B6 拒绝：低沉下滑 '咚'。必须不悦耳，但不刺耳（这是"提示"不是"惩罚"）"""
    s = buf(170)
    mix(s, sweep(int(SR * 0.15), 240, 150, 0.045, 0.85, log=False), 0)
    mix(s, tone(int(SR * 0.10), 120, 0.035, 0.45), 0)
    return normalize(s, 0.62)


def sfx_clash() -> list:
    """
    C 撞击：**本作的核心音效**（★ S18 由 `sfx_peng` 更名而来，波形一字未改）。

    结构 = 冲击瞬态（撞上去的那一下）+ 三音和弦（C-E-G，大三和弦 = 明亮、正向）。
    为什么是"和弦"而不是单音：一次消除是三张牌合成一件事，
    三个音同时响在听觉上就是"三合一"，单个音反而显得单薄。
    为什么 C-E-G 而不是别的：大三和弦在音乐心理学里天然被解读为"完成 / 达成"。

    【⚠️ 为什么改名（S18 决议 5）】
      原来这个文件叫 `peng`，而 `assets/resources/audio/peng.m4a` 里装的
      **不是这段合成音**，是 `install-voice-lib.py` 灌进去的**人声念白「碰」**
      —— 两者同名，谁最后写盘谁赢。人声念白是**听得见的棋牌术语**，
      本次整体下线（详见文件头的"命名冲突"红框）。
      于是：合成音改名 `clash`，人声文件删除，两个名字从此各归各家。
      波形本身**一个好参数都没动** —— 它本来就不带任何语义，
      当初的问题只在于"它被一个叫 peng 的人声文件顶掉了"。
    """
    s = buf(320)
    # 撞击瞬态：极短的高频噪声 + 低频冲击
    mix(s, noise(int(SR * 0.035), 0.010, 0.60, lp=0.80, hp=0.28), 0)
    mix(s, tone(int(SR * 0.06), 160, 0.022, 0.55, attack_ms=1.0), 0)
    # 三音和弦（略微错开 6ms，避免相位完全对齐导致的"数字化"感）
    for k, f in enumerate((523.25, 659.25, 783.99)):
        mix(s, bell(int(SR * 0.28), f, 0.115, 0.42, attack_ms=2.0), 6 * k)
    return normalize(s)


def sfx_clear() -> list:
    """
    C 消散：上行扫频 + 明亮泛音尾 —— "散开"的听感。
    与撞击的分工：`clash` 负责"撞上了"，`clear` 负责"散了"。
    两者在消除流程里间隔 70ms（CFG.MOTION.POP_HOLD），听觉上正好是"咚—唰"。
    """
    s = buf(360)
    mix(s, sweep(int(SR * 0.30), 620, 1680, 0.085, 0.50), 0)
    for k, f in enumerate((1046.5, 1318.5, 1568.0)):
        mix(s, bell(int(SR * 0.26), f, 0.075, 0.26, attack_ms=1.5), 14 * k + 10)
    mix(s, noise(int(SR * 0.12), 0.030, 0.22, lp=0.62, hp=0.22), 0)
    return normalize(s)


def sfx_swish() -> list:
    """
    D 连号消除的**咀嚼音**：一记纸 / 木质的「唰」（★ S18 新增）。

    【它替换掉了什么】原来这一段播的是 `eat.m4a` —— 真人 TTS 念的「吃」。
      那是**听得见的棋牌术语**，且"吃"在麻将里是专有动作名，必须下线。
      ⚠️ 但**不能简单地把这一段静音**：连号消除与同张消除在画面上走的
      是两条不同的动效路径（`onEatStart` 的逐口咬合 vs `onClash` 的三牌对撞），
      两条路径的**视觉**差异（一张张被咬 vs 一起撞）只在 200ms 内看得清；
      如果听觉完全一致，玩家在第二眼之后就把两者读成同一件事了。
      所以这里换的**不是"要不要声音"，而是"换成什么声音"** ——
      去掉语义、保留"这是一条不同的路径"这个信息。

    【音色选择：纸 / 木，不用金属】
      本作的材质体系是"纸 + 墨 + 牌"，**没有金属**（唯一的金色是通关印的描边）。
      金属感（长衰减的高频 bell）会立刻把声音拉去另一个游戏。
      所以主体是**宽带噪声**（纸牌擦过、木头摩擦都是噪声型），
      只给两处极短的木质音高让它不沦为"故障杂音"。

    【为什么起音只有 3ms（对比 `flow` 的 14ms）】
      `flow` 是"水在流过去"，所以把 attack 抹平；这里对应的是
      **"一叠牌被抽走 / 咬合"** —— 是一个有明确起点的动作，
      起音必须站得住脚，否则会读成"什么东西淡出了"。

    【为什么是 330ms】必须**短于**同张路径的 `clash`(320ms) + `clear`(70ms 后的 360ms)
      这条二连的总感知长度（约 430ms）。
      咀嚼路径是"轻快"的，同张路径是"厚重"的；如果这里也拉到 400ms+，
      两条路径就成了同一个重量级，"轻快 vs 厚重"这组对比会消失。

    【为什么结尾给一个极短的上行 sweep】纯噪声收尾在手机外放上
      经常被听成"卡了一下"。一个 60ms 的轻扫频给它一个明确的"收住了"。
    """
    s = buf(330)
    # ① 主体：宽带噪声。lp=0.66 / hp=0.30 = 中高频，是"纸"的频段
    #    （对比 shuffle 的 lp=0.24 —— 那是"一叠牌哗啦"，更低更闷）
    #    humps=2：两下，对应"咬合"的两拍，而不是 shuffle 的三下起伏
    mix(s, noise(int(SR * 0.22), 0.075, 0.62, lp=0.66, hp=0.30, humps=2), 12)
    # ② 起手瞬态：极短的一下，让"抽走"有起点（3ms 起音，见上面第 3 条）
    mix(s, noise(int(SR * 0.030), 0.009, 0.34, lp=0.74, hp=0.34, attack_ms=3.0), 0)
    # ③ 木质音高：两个极短的低频衰减，只做"材质"不做"旋律"
    mix(s, tone(int(SR * 0.045), 233.08, 0.016, 0.20, attack_ms=2.0), 8)
    mix(s, tone(int(SR * 0.045), 349.23, 0.014, 0.13, attack_ms=2.0), 26)
    # ④ 收尾：60ms 上行轻扫（见上面第 5 条）
    mix(s, sweep(int(SR * 0.060), 700, 1180, 0.022, 0.16, attack_ms=4.0), 250)
    return normalize(s, 0.62)


def sfx_flow() -> list:
    """
    ⛔ **已退役（S12.2），不登记进 SFX 字典** —— 保留函数体仅作参考实现。

    C 连号消除的旧版音效：**流水汇合**的音。
    后来连号消除改成了「咀嚼」（逐口咬合，见 `GameFrame.onEatStart`），
    一条连续滑音和"一口一口咬"的画面对不上，于是换成 `swish`。
    这里的写法仍有参考价值：它示范了**同一族音效之间怎么用 attack 做对比**
    ——下面的设计原则整段仍成立，只是不再出文件。

    【术语】`chi`（MatchRule 里的内部键）= **同一族号码连着三张**。
       注意别和"连击"混称：连击（限时窗口内连续消除的计数）是初版误做的机制，
       已整体删除，本作不需要。

    【这段音效的设计原则：处处与 `clash` 相反】
    `clash` 的听感靠两件东西撑起来：① `noise(attack_ms=1.0)` 的**冲击瞬态**；
    ② `tone(attack_ms=1.0)` 的极短起音。两者都靠"起的那一下听不见"来制造撞击。
    这里整个反过来：**所有成分的 attack 都拉到 9~14ms**（clash 是 1~3ms），
    于是"起"被抹平了，只剩下"流过去"—— 声画一致：
    动画走的是 sineInOut（首尾速度为零），声音走的是长渐入渐出。

    上行（而不是下行）：它仍是"达成"，语义上与 reward / revive 同族；
    只是比它们**更含蓄**——不靠琶音的节奏点，靠一段连续滑音。
    """
    s = buf(470)
    # 主体：上行滑音（水在流）。12ms 渐入 —— clash 的扫频是 3ms，这里慢 4 倍
    mix(s, sweep(int(SR * 0.36), 523.25, 1046.50, 0.170, 0.42,
                 attack_ms=12.0, log=True), 20)
    # 水的质感：低通噪声。lp=0.40 让它是"沙沙"而不是"唰"（clash 的 lp 是 0.80）
    mix(s, noise(int(SR * 0.34), 0.165, 0.22, lp=0.40, hp=0.14,
                 attack_ms=14.0), 50)
    # 收尾：一个柔和泛音。整段唯一带音高感的部分，所以给了最长的 attack(9ms)
    mix(s, bell(int(SR * 0.30), 880.0, 0.110, 0.28, attack_ms=9.0), 150)
    return normalize(s, 0.68)


def sfx_shuffle() -> list:
    """E1 洗牌：'哗啦' —— 噪声 + 三个起伏（纸牌摩擦是断断续续的）"""
    s = buf(470)
    mix(s, noise(int(SR * 0.44), 0.150, 0.75, lp=0.24, hp=0.12, humps=3), 0)
    mix(s, noise(int(SR * 0.10), 0.020, 0.35, lp=0.70, hp=0.30), 0)   # 起手的"抽牌"声
    mix(s, bell(int(SR * 0.20), 392.0, 0.050, 0.16), 20)              # 一点音高，避免纯噪声听着像故障
    return normalize(s, 0.62)


def sfx_reward() -> list:
    """D1 奖励到账：C-E-G-C 四音上行琶音（比「吃」的流水更长更亮 = "这是好东西"）"""
    s = buf(430)
    for k, f in enumerate((523.25, 659.25, 783.99, 1046.50)):
        mix(s, bell(int(SR * 0.32), f, 0.105, 0.36, attack_ms=2.0), 62 * k)
    return normalize(s)


def sfx_fail() -> list:
    """失败：下行两音（G→C 下行 = 明确的"结束"语义），刻意压低明亮度"""
    s = buf(520)
    mix(s, bell(int(SR * 0.42), 392.00, 0.145, 0.55, attack_ms=3.0), 0)
    mix(s, bell(int(SR * 0.44), 261.63, 0.185, 0.60, attack_ms=3.0), 165)
    mix(s, tone(int(SR * 0.12), 98.0, 0.040, 0.35), 0)
    return normalize(s, 0.66)


def sfx_revive() -> list:
    """D6 复活：明亮上行 + 闪亮泛音（雨过天晴），与 fail 严格对偶"""
    s = buf(460)
    mix(s, sweep(int(SR * 0.40), 330, 990, 0.130, 0.40), 0)
    for k, f in enumerate((659.25, 987.77)):
        mix(s, bell(int(SR * 0.32), f, 0.100, 0.40, attack_ms=2.0), 90 * k)
    return normalize(s)


def sfx_addslot() -> list:
    """D3 加槽：'咔哒—外扩' —— 金属件被装上的机械感"""
    s = buf(280)
    mix(s, tone(int(SR * 0.09), 420, 0.026, 0.62, attack_ms=1.0), 0)
    mix(s, bell(int(SR * 0.22), 880.0, 0.070, 0.34), 70)
    mix(s, noise(int(SR * 0.05), 0.010, 0.25, lp=0.72, hp=0.25), 0)
    return normalize(s)


def sfx_win() -> list:
    """通关：C-E-G-C 大调上行 + 尾音，比 reward 更长（这是整局的句号）"""
    s = buf(700)
    for k, f in enumerate((523.25, 659.25, 783.99, 1046.50)):
        mix(s, bell(int(SR * 0.55), f, 0.155, 0.34, attack_ms=3.0), 110 * k)
    mix(s, bell(int(SR * 0.60), 1567.98, 0.120, 0.22), 480)
    return normalize(s)


# 文件名 → 生成函数。字典顺序 = 生成顺序，也方便核对
#
# ⚠️⚠️ **这个字典直接决定 assets/resources/audio/ 里有哪些 .m4a** ⚠️⚠️
#   `main()` 会无条件写盘**字典里的每一个键**。所以：
#     · 想停用某个音效，必须**把它从本字典删掉**，光删调用点没用
#       ——文件还在、还会被加载；
#     · ⚠️ **`peng` / `eat` 两个键已经从本字典删除（S18 决议 5）**。
#       它们原来指向的是**人声念白**（由 install-voice-lib.py 写盘），
#       本脚本里同名的合成函数如果重新登记进来，重跑就会把资产目录里
#       新做的 clash / swish 覆盖掉 —— **不要把它们加回来**。
#     · `flow` 也**不在这里**：S12.2 退役（「吃」改咀嚼后没有调用方）。
#       函数体 `sfx_flow()` 保留作为参考实现，但不再登记、不再生成文件。
SFX = {
    'tap': sfx_tap,
    'pick': sfx_pick,
    'land': sfx_land,
    'reject': sfx_reject,
    'clash': sfx_clash,
    'clear': sfx_clear,
    'swish': sfx_swish,
    'shuffle': sfx_shuffle,
    'reward': sfx_reward,
    'fail': sfx_fail,
    'revive': sfx_revive,
    'addslot': sfx_addslot,
    'win': sfx_win,
}


# ============================================================
#  四、入口
# ============================================================

def _iter_boxes(data: bytes, start: int, end: int):
    """
    按 MP4 box 结构逐个产出 (type, payload_start, box_end)。
    遇到畸形长度直接停止（宁可少清一个字段，也不要越界写坏文件）。

    MP4 的 box 布局：[size(4)][type(4)][payload...]
      size == 1 → 后面还有 8 字节的 64 位长度（payload 从 +16 开始）
      size == 0 → 这个 box 一直延伸到文件末尾
    """
    p = start
    while p + 8 <= end:
        size = int.from_bytes(data[p:p + 4], 'big')
        btype = bytes(data[p + 4:p + 8])
        payload = p + 8
        if size == 1:
            if p + 16 > end:
                return
            size = int.from_bytes(data[p + 8:p + 16], 'big')
            payload = p + 16
        elif size == 0:
            size = end - p
        if size < payload - p or p + size > end:
            return
        yield btype, payload, p + size
        p += size


def _zero_times(data: bytearray, payload: int) -> None:
    """清零某个 header box 的 creation_time / modification_time"""
    span = 16 if data[payload] == 1 else 8      # version 1 → 各 8 字节
    for j in range(payload + 4, payload + 4 + span):
        data[j] = 0


def zero_container_times(path: str) -> int:
    """
    把 m4a 容器里的**创建/修改时间戳**清零，让输出逐字节可复现。

    【为什么必须做这一步 —— 不写的话文件头的承诺就是假的】
    `afconvert` 会在 mvhd（movie header）与 mdhd（media header）两个 box 里
    写入"编码发生的那一刻"。于是**同一个脚本、同一个种子、不改一行**，
    两次运行的 m4a 的 md5 都不一样（实测确认：WAV 两次完全一致，
    差异全部来自容器时间戳）。

    后果不是"音质变了"，而是**版本控制被污染**：
    每重新生成一次，13 个二进制文件全部显示为"已修改"，
    于是"这次到底改了哪段音效"永远看不出来 —— 对一个要求"每次修改都能回溯"
    的项目来说，这比多几个字节严重得多。

    时间戳在 mvhd / mdhd 里的位置：
        'mvhd' 之后依次是 version(1) + flags(3)，然后就是
        creation_time 与 modification_time。
          version 0 → 各 4 字节（QuickTime 时间，起点 1904-01-01）
          version 1 → 各 8 字节
    时间戳不影响解码与播放，清零是安全的（main() 之后用 afinfo 复验可解码性）。

    ⚠️ 【必须按 box 结构解析，不能用 data.find(b'mvhd') 盲搜】
    'mvhd' 这 4 个字节**完全可能恰好出现在压缩后的音频数据里** ——
    盲搜到那里去清零就会**直接破坏音频**，而且是那种"大多数机器上没事、
    偶尔某段音效变噪音"的隐蔽故障。本文件踩过的坑已经够多了。
    """
    with open(path, 'rb') as f:
        data = bytearray(f.read())

    n = 0
    for t, pl, end in _iter_boxes(data, 0, len(data)):
        if t != b'moov':
            continue
        for t2, pl2, end2 in _iter_boxes(data, pl, end):
            if t2 == b'mvhd':
                _zero_times(data, pl2)
                n += 1
            elif t2 == b'trak':
                # trak 里**有两个**带时间戳的 box，一个都不能漏：
                #   tkhd（track header）—— 直接挂在 trak 下
                #   mdhd（media header）—— 藏在 trak → mdia 里
                # 实测教训：只清了 mvhd + mdhd 时，重跑两次仍然有 2 个字节在变
                # （tkhd 的 creation/modification 的末字节），diff 定位到偏移
                # 167/171 才发现的。所以下面逐个判别。
                for t3, pl3, end3 in _iter_boxes(data, pl2, end2):
                    if t3 == b'tkhd':
                        _zero_times(data, pl3)
                        n += 1
                    elif t3 == b'mdia':
                        for t4, pl4, _ in _iter_boxes(data, pl3, end3):
                            if t4 == b'mdhd':
                                _zero_times(data, pl4)
                                n += 1

    with open(path, 'wb') as f:
        f.write(bytes(data))
    return n


def main() -> int:
    wav_only = '--wav-only' in sys.argv
    os.makedirs(TMP_WAV_DIR, exist_ok=True)
    out_dir = os.path.abspath(OUT_M4A_DIR)
    os.makedirs(out_dir, exist_ok=True)

    total = 0
    print(f'{"名称":<10} {"时长":>7}  {"wav":>8}  {"m4a":>8}')
    print('-' * 42)
    for name, fn in SFX.items():
        # ★ 逐音效播种：保证"改 A 不影响 B"，详见 seed_for 的注释
        seed_for(name)
        sig = fn()
        wav_path = os.path.join(TMP_WAV_DIR, f'{name}.wav')
        write_wav(wav_path, sig)
        wav_kb = os.path.getsize(wav_path) / 1024.0

        if wav_only:
            print(f'{name:<10} {len(sig)/SR*1000:6.0f}ms  {wav_kb:7.1f}K  {"-":>8}')
            continue

        m4a_path = os.path.join(out_dir, f'{name}.m4a')
        # -b 64000：单声道 64kbps。音效是短促瞬态，再高的码率在手机外放上听不出差别
        r = subprocess.run(
            ['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '64000', wav_path, m4a_path],
            capture_output=True,
        )
        if r.returncode != 0:
            print(f'{name} 转码失败：{r.stderr.decode()[:120]}')
            return 1
        # 清零容器时间戳，否则每次生成 13 个文件全部 md5 变化（见函数注释）
        zero_container_times(m4a_path)
        m4a_kb = os.path.getsize(m4a_path) / 1024.0
        total += m4a_kb
        print(f'{name:<10} {len(sig)/SR*1000:6.0f}ms  {wav_kb:7.1f}K  {m4a_kb:7.1f}K')

    if not wav_only:
        print('-' * 42)
        print(f'合计 {total:.1f}KB（{len(SFX)} 段），输出目录 {out_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
