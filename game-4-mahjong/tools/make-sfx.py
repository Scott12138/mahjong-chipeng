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
 输出体积：10 段合计约 25KB（AAC 64kbps 单声道）。

 用法：
     python3 tools/make-sfx.py            # 生成全部音效
     python3 tools/make-sfx.py --wav-only # 只出 wav（调试波形用）

 ⚠️ 随机数用固定种子：噪声是"合成素材"的一部分，
    换一台机器重跑必须得到逐字节相同的结果（否则每次重打包
    assets 的 md5 都在变，没法判断"这次提交到底改了什么"）。
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

random.seed(SEED)


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


def sfx_peng() -> list:
    """
    C 碰：**本作的核心音效**。
    结构 = 冲击瞬态（撞上去的那一下）+ 三音和弦（C-E-G，大三和弦 = 明亮、正向）。
    为什么是"和弦"而不是单音：碰是三张牌合成一件事，
    三个音同时响在听觉上就是"三合一"，单个音反而显得单薄。
    为什么 C-E-G 而不是别的：大三和弦在音乐心理学里天然被解读为"完成 / 达成"。
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
    C 消除：上行扫频 + 明亮泛音尾 —— "散开"的听感。
    与碰的分工：碰负责"撞上了"，clear 负责"散了"。
    两者在碰的流程里间隔 70ms（CFG.MOTION.POP_HOLD），听觉上正好是"咚—唰"。
    """
    s = buf(360)
    mix(s, sweep(int(SR * 0.30), 620, 1680, 0.085, 0.50), 0)
    for k, f in enumerate((1046.5, 1318.5, 1568.0)):
        mix(s, bell(int(SR * 0.26), f, 0.075, 0.26, attack_ms=1.5), 14 * k + 10)
    mix(s, noise(int(SR * 0.12), 0.030, 0.22, lp=0.62, hp=0.22), 0)
    return normalize(s)


def sfx_combo(rate: float = 1.0) -> list:
    """
    C 连章：上行三音琶音，音高由 rate 缩放。
    ⚠️ 这里预生成 **4 个音高**（根音 / 大三度 / 五度 / 八度）而不是运行时变速，
       原因是 **Cocos Creator 3.8 的 AudioSource 没有 playbackRate**
       （2.x 有，3.x 重写音频系统时移除了；d.ts 里逐成员查过，确实不存在）。
       运行时变速这条路不存在，就只能在合成阶段把音高做出来：
       多 3 个文件一共 +18KB，换来的是"连章层数越高、音越亮"的明确听感。
       每层 5KB 是可接受的代价（首包余量 1MB）。
    """
    s = buf(300)
    for k, f in enumerate((783.99, 987.77, 1174.66)):
        mix(s, bell(int(SR * 0.22), f * rate, 0.070, 0.38, attack_ms=2.0), 55 * k)
    return normalize(s)


def sfx_shuffle() -> list:
    """E1 洗牌：'哗啦' —— 噪声 + 三个起伏（纸牌摩擦是断断续续的）"""
    s = buf(470)
    mix(s, noise(int(SR * 0.44), 0.150, 0.75, lp=0.24, hp=0.12, humps=3), 0)
    mix(s, noise(int(SR * 0.10), 0.020, 0.35, lp=0.70, hp=0.30), 0)   # 起手的"抽牌"声
    mix(s, bell(int(SR * 0.20), 392.0, 0.050, 0.16), 20)              # 一点音高，避免纯噪声听着像故障
    return normalize(s, 0.62)


def sfx_reward() -> list:
    """D1 奖励到账：C-E-G-C 四音上行琶音（比连章更长更亮 = "这是好东西"）"""
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


# 连章音高阶梯：根音 → 大三度 → 五度 → 八度（等比，比值 = 2^(n/3) 的近似整数化）
# 第 2 层用 combo（基准），第 3 层 combo2，依此类推；超过 4 层沿用最高音。
COMBO_RATES = [1.0, 1.122, 1.260, 1.414]

# 文件名 → 生成函数。字典顺序 = 生成顺序，也方便核对
SFX = {
    'tap': sfx_tap,
    'pick': sfx_pick,
    'land': sfx_land,
    'reject': sfx_reject,
    'peng': sfx_peng,
    'clear': sfx_clear,
    'combo': lambda: sfx_combo(COMBO_RATES[0]),
    'combo2': lambda: sfx_combo(COMBO_RATES[1]),
    'combo3': lambda: sfx_combo(COMBO_RATES[2]),
    'combo4': lambda: sfx_combo(COMBO_RATES[3]),
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

def main() -> int:
    wav_only = '--wav-only' in sys.argv
    os.makedirs(TMP_WAV_DIR, exist_ok=True)
    out_dir = os.path.abspath(OUT_M4A_DIR)
    os.makedirs(out_dir, exist_ok=True)

    total = 0
    print(f'{"名称":<10} {"时长":>7}  {"wav":>8}  {"m4a":>8}')
    print('-' * 42)
    for name, fn in SFX.items():
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
        m4a_kb = os.path.getsize(m4a_path) / 1024.0
        total += m4a_kb
        print(f'{name:<10} {len(sig)/SR*1000:6.0f}ms  {wav_kb:7.1f}K  {m4a_kb:7.1f}K')

    if not wav_only:
        print('-' * 42)
        print(f'合计 {total:.1f}KB（{len(SFX)} 段），输出目录 {out_dir}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
