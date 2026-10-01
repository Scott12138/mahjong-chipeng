#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 make-bgm.py · 程序化合成候选 BGM（零素材依赖）
============================================================
 为什么要"合成"而不是"下一条曲子"：
   ① 版权干净 —— 本作上线主体是**个人开发者**，BGM 若来自曲库/下载，
      授权链极难自证；自己合成则"来源 = 本仓库这 1 个脚本"，
      和既有 13 段音效同一份出生证明。
   ② 家法一致 —— 采样率、电平标准、afconvert 参数、容器时间清零，
      全部与 make-sfx.py 对齐，不放两条产线在仓库里。
   ③ 参数可调 —— 速度/调式/配器/循环长度全是脚下几行数字。
      拍板后想"再快一点""鼓再轻一点""多两小节"，改参数重跑即可，
      不用回头去求第 12 个素材网站。

 5 段候选：
   A 跳跳糖   128BPM C大调   轻快电子   —— 最贴《抓大鹅》（轻快电子旋律/欢快治愈）
   B 鹅步快跑 140BPM G大调   高速电子   —— 动感最强（四四底鼓 + 侧链泵动）
   C 茶馆电音 112BPM D宫五声 国风×电子 —— 最贴麻将题材（古筝拨弦 + 电子鼓）
   D 牌桌弹珠 124BPM F大调   木琴玩具感 —— 最 Q 萌（马林巴 + 玩具钢琴 + 拍手）
   E 夜灯摇摆 118BPM A小调   轻电子摇摆 —— 久听不累（电钢 + 摇摆八分）

 ★【用户拍板（2026-10-01）】**选 C · 茶馆电音**（`CHOSEN = 'C'`），
   已作为局内 BGM 落进 `assets/resources/audio/bgm.m4a`。
   换曲只改下面的 `CHOSEN` 一行，再跑 `--install` —— 别手工拷文件
   （手工拷会丢 `.meta` 的 uuid，Cocos 里表现为"资源莫名为空"）。

 合成链：Python 直出 16bit/44.1kHz 单声道 WAV
         → 系统 afconvert 转 AAC 64kbps（m4a）
         → 调 make-sfx.py 的 zero_container_times() 清容器时间戳
         → docs/verify/S13/bgm/（试听页消费的就是这一份）
         →（--install）直接搬进 assets/resources/audio/bgm.m4a

 用法：
     python3 tools/make-bgm.py                 # 合成 5 段
     python3 tools/make-bgm.py --only A,C      # 只出指定段
     python3 tools/make-bgm.py --wav-only      # 只出 wav（调试波形用）
     python3 tools/make-bgm.py --stems         # 打印各声部"活跃段 RMS"，校验配器平衡
     python3 tools/make-bgm.py --no-trim       # 关掉自动配平，听原始写法的平衡
     python3 tools/make-bgm.py --page          # 顺带生成试听页 HTML
     python3 tools/make-bgm.py --install       # 把 CHOSEN 那段装进游戏（bgm.m4a）

 ⚠️ `--install` **不重新合成**，而是直接搬 `OUT_DIR` 里那份已通过自检的 m4a。
    这是有意的：**用户拍板时听的就是那个文件** —— 重新渲染一次等于
    "拍板的和上线的是两个东西"，哪怕参数没变也不该冒这个险。

 ⚠️ 【循环无缝】每条轨道的总长**恰好**是 bars×16 个十六分音符，
    音符尾巴超出末尾的部分**回绕到开头**（见 Song.put 的 wrap）。
    所以它天生可循环：末小节第 4 拍的吊镲余音会接进第 1 小节开头。
    这也意味着**不能**在首尾做淡入淡出 —— 那会在循环点上砍出一个豁口。

 ⚠️ 【随机数用固定种子 + 每次 new 一个 Random】
    噪声（军鼓/踩镲/沙锤）是"合成素材"的一部分，必须逐字节可复现。
    每个音色内部各自 random.Random(固定种子)，**不共用全局 random** ——
    否则改动一处调用顺序就会让所有噪声音色全部变化。
============================================================
"""

import base64
import importlib.util
import json
import math
import os
import random
import shutil
import struct
import subprocess
import sys
import wave

# ------------------------------------------------------------
#  全局参数
# ------------------------------------------------------------
SR = 44100              # 采样率。与 make-sfx.py 一致
TAU = math.pi * 2.0
PEAK = 0.70             # 归一化峰值。与既有 13 段音效同一标准，方便公平 A/B
LIMIT = 1.35            # 软削波驱动量：压掉瞬态波峰，让整轨听起来更"满"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.abspath(os.path.join(HERE, '..', '..', 'docs', 'verify', 'S13', 'bgm'))
WAV_DIR = '/tmp/game4-bgm-wav'
GAME_AUDIO = os.path.abspath(os.path.join(HERE, '..', 'assets', 'resources', 'audio'))

# ★ 用户拍板（2026-10-01）：**C · 茶馆电音**。
CHOSEN = 'C'
# 装进游戏后的资源名 —— 这个名字同时决定
# ① 落盘路径 assets/resources/audio/<INSTALL_AS>.m4a
# ② AudioService 里的加载路径 'audio/<INSTALL_AS>'
INSTALL_AS = 'bgm'


# ============================================================
#  〇、借用 make-sfx.py 的容器时间清零
# ============================================================
#  文件名带连字符，`import make-sfx` 是语法错误，只能按路径加载。
#  （make-voice.py 已经踩过这个坑，这里照抄同一个做法。）
# ============================================================

def _load_zero_times():
    path = os.path.join(HERE, 'make-sfx.py')
    spec = importlib.util.spec_from_file_location('make_sfx_shared', path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.zero_container_times


# ============================================================
#  一、基元：振荡器与包络
# ============================================================

def _n(sec: float) -> int:
    """秒 → 样点数（至少 1）"""
    return max(1, int(round(sec * SR)))


def env(n: int, *, atk=0.005, dec=0.0, sus=1.0, rel=0.05, curve=3.0) -> list:
    """
    通用包络：atk 线性起音 → dec 指数衰减到 sus → rel 线性收尾。

    · 只要 `dec=0 / sus=1`，中间段就是平的（持续音用这个）。
    · 收尾的起点取衰减段的**末值**，否则会在接缝处跳一下（爆音）。
    """
    out = [0.0] * n
    na = min(n, max(1, int(atk * SR)))
    nr = min(max(0, n - na), max(1, int(rel * SR)))
    nd = max(0, n - na - nr)
    start = sus if nd > 0 else 1.0
    for i in range(n):
        if i < na:
            g = i / na
        elif nd and i < na + nd:
            x = (i - na) / nd
            g = sus + (1.0 - sus) * math.exp(-curve * x)
        else:
            k = (i - na - nd) / nr if nr else 1.0
            g = start * (1.0 - min(1.0, k))
        out[i] = g
    return out


def _osc(ratios, amps, taus, f0, n, *, bend=0.0, bend_tau=0.05, duty=None):
    """
    加法合成一批分音（ratio 相对基频）。
    衰减用**乘性递推**而不是每样点调 exp —— 这是整条渲染链上最大的一笔开销。
    duty 给了就用脉冲波（方波族）替换正弦，用于主奏的"电"味。
    """
    h = len(ratios)
    ph = [0.0] * h
    g = [amps[k] for k in range(h)]
    dk = [math.exp(-1.0 / max(1e-6, taus[k] * SR)) for k in range(h)]
    inv = 1.0 / SR
    out = [0.0] * n
    for i in range(n):
        f = f0 * (1.0 + bend * math.exp(-i * inv / bend_tau)) if bend else f0
        s = 0.0
        for k in range(h):
            ph[k] += ratios[k] * f * inv
            if ph[k] >= 1.0:
                ph[k] -= 1.0
            s += ((1.0 if ph[k] < duty else -1.0) if duty else math.sin(TAU * ph[k])) * g[k]
            g[k] *= dk[k]
        out[i] = s
    return out


def _tail(sig, ms=10.0):
    """
    统一收尾淡出 —— 每个音色都强制做一次。

    【为什么每个音色都必须有】
      合成音色大多是"指数衰减 + 到点截断"，而**截断那一刻的幅度并不为零**。
      实测：i_bass 走到 dur 时包络还剩 21%、开镲甚至还剩 63% ——
      直接截断就是一个"咔"的爆音；低音每小节八下，就是八次爆音。
      10ms 的线性收尾，人耳听不出"淡出"，但足以把那个跳变抹平。

      放在 memoized 里统一做，是为了**保证没有任何一个音色被漏掉**：
      漏一个就是一处随机的爆音，而且极难定位（它不在报错里，只在耳朵里）。
    """
    n = len(sig)
    f = min(n, max(1, int(round(SR * ms / 1000.0))))
    out = list(sig)
    for i in range(f):
        out[n - f + i] *= 1.0 - (i + 1) / f
    return out


def memoized(fn):
    """
    按参数缓存渲染结果 + 统一收尾淡出。
    编曲里同一音高会重复出现几百次，缓存是刚需（渲染时间降两个数量级）。
    """
    cache = {}

    def wrapper(*a, **k):
        key = (a, tuple(sorted(k.items())))
        if key not in cache:
            cache[key] = _tail(fn(*a, **k))
        return cache[key]
    wrapper.__name__ = fn.__name__
    return wrapper


def active_rms(buf, frame=0.020, thresh=0.20, stride=3):
    """
    活跃段 RMS —— **只在"这个声部真的在响"的帧上**求 RMS。

    【为什么不能用整轨 RMS 做配平】
      吊镲整曲只响 2 次。若按整轨 RMS 衡量，它会被算得极低，
      配平时就被狂补 +20dB —— 而它一响就是全曲最响的一下，直接炸掉。
      所以要看的是"响的时候有多响"，这才是乐器之间的真实音量比。

    实现按 stride 抽样（每 3 个样点取 1），30 秒的曲子误差 <0.2dB，
    但省掉 2/3 的运算量。
    """
    f = _n(frame)
    vals = []
    for i in range(0, len(buf) - f, f):
        seg = buf[i:i + f]
        s = sum(v * v for v in seg[::stride])
        vals.append(math.sqrt(s / max(1, len(seg[::stride]))))
    if not vals:
        return 0.0
    mx = max(vals)
    if mx < 1e-9:
        return 0.0
    act = [v for v in vals if v > mx * thresh]
    return math.sqrt(sum(v * v for v in act) / len(act)) if act else 0.0


# ============================================================
#  二、打击乐
# ============================================================

@memoized
def i_kick(dur=0.34, f0=128.0, f1=44.0, tau=0.105, pitch_t=0.055, click=0.55):
    """底鼓：正弦从 128Hz 扫到 44Hz + 4ms 的高频击打瞬态"""
    n = _n(dur)
    out = [0.0] * n
    ph = 0.0
    k = math.log(f1 / f0)
    for i in range(n):
        t = i / SR
        f = f0 * math.exp(k * min(1.0, t / pitch_t))
        ph += f / SR
        if ph >= 1.0:
            ph -= 1.0
        s = math.sin(TAU * ph) * math.exp(-t / tau)
        if click and t < 0.014:
            s += math.sin(TAU * 1750.0 * t) * math.exp(-t / 0.0035) * click
        out[i] = s
    return out


@memoized
def i_snare(dur=0.24, tone=196.0, tau=0.090, hp_hz=1400.0, seed=11):
    """军鼓：高通噪声 + 一个中频膜音"""
    n = _n(dur)
    out = [0.0] * n
    rnd = random.Random(seed)
    a = 1.0 - math.exp(-TAU * hp_hz / SR)
    hp = 0.0
    px = 0.0
    for i in range(n):
        t = i / SR
        x = rnd.uniform(-1.0, 1.0)
        hp = a * (hp + x - px)
        px = x
        out[i] = hp * math.exp(-t / tau) * 2.6 + math.sin(TAU * tone * t) * math.exp(-t / 0.055) * 0.5
    return out


@memoized
def i_clap(dur=0.30, hp_hz=1100.0, seed=33):
    """拍手：3 簇极短噪声（模拟多只手不同时到）+ 一条尾巴"""
    n = _n(dur)
    out = [0.0] * n
    rnd = random.Random(seed)
    a = 1.0 - math.exp(-TAU * hp_hz / SR)
    hp = 0.0
    px = 0.0
    offs = (0.000, 0.010, 0.020)
    for i in range(n):
        t = i / SR
        x = rnd.uniform(-1.0, 1.0)
        hp = a * (hp + x - px)
        px = x
        g = 0.0
        for o in offs:
            if t >= o:
                g = max(g, math.exp(-(t - o) / 0.006))
        g = max(g, math.exp(-t / 0.16) * 0.45)
        out[i] = hp * g * 2.2
    return out


@memoized
def i_hat(dur=0.07, open_=False, hp_hz=7000.0, seed=22):
    """踩镲：高通噪声。open_=True 给开镲（长尾，"呲——"）"""
    n = _n(dur)
    out = [0.0] * n
    rnd = random.Random(seed)
    a = 1.0 - math.exp(-TAU * hp_hz / SR)
    hp = 0.0
    px = 0.0
    tau = 0.150 if open_ else 0.026
    for i in range(n):
        x = rnd.uniform(-1.0, 1.0)
        hp = a * (hp + x - px)
        px = x
        out[i] = hp * math.exp(-(i / SR) / tau) * 2.4
    return out


@memoized
def i_shaker(dur=0.05, seed=44):
    """沙锤：更柔的高频噪声，用来把十六分音符网格铺满"""
    n = _n(dur)
    out = [0.0] * n
    rnd = random.Random(seed)
    a = 1.0 - math.exp(-TAU * 5200.0 / SR)
    hp = 0.0
    px = 0.0
    for i in range(n):
        t = i / SR
        x = rnd.uniform(-1.0, 1.0)
        hp = a * (hp + x - px)
        px = x
        g = math.exp(-t / 0.030) * (1.0 - math.exp(-t / 0.002))
        out[i] = hp * g * 2.0
    return out


@memoized
def i_wood(dur=0.10, freq=1180.0, tau=0.020, seed=55):
    """木块/木鱼：带音高的短促敲击（三度、五度分音各一点）"""
    n = _n(dur)
    out = [0.0] * n
    rnd = random.Random(seed)
    body = _osc([1.0, 2.76, 5.4], [1.0, 0.32, 0.10], [tau, tau * 0.6, tau * 0.4], freq, n)
    for i in range(n):
        t = i / SR
        out[i] = body[i] + rnd.uniform(-1.0, 1.0) * math.exp(-t / 0.004) * 0.35
    return out


@memoized
def i_tom(dur=0.30, freq=150.0, tau=0.11):
    """手鼓/通鼓：低中频膜音，给国风段做「咚 · 哒」的骨架"""
    n = _n(dur)
    out = [0.0] * n
    ph = 0.0
    for i in range(n):
        t = i / SR
        f = freq * (1.0 + 0.35 * math.exp(-t / 0.03))
        ph += f / SR
        if ph >= 1.0:
            ph -= 1.0
        out[i] = math.sin(TAU * ph) * math.exp(-t / tau)
    return out


@memoized
def i_crash(dur=1.10, hp_hz=3600.0, tau=0.34, seed=77):
    """吊镲：高通噪声长衰减，用在乐段开头"""
    n = _n(dur)
    out = [0.0] * n
    rnd = random.Random(seed)
    a = 1.0 - math.exp(-TAU * hp_hz / SR)
    hp = 0.0
    px = 0.0
    for i in range(n):
        t = i / SR
        x = rnd.uniform(-1.0, 1.0)
        hp = a * (hp + x - px)
        px = x
        out[i] = hp * math.exp(-t / tau) * 2.2
    return out


@memoized
def i_riser(dur=1.90, f0=280.0, f1=3600.0, seed=88):
    """上行音效（riser）：乐段切换前铺一条"要来了"的斜坡"""
    n = _n(dur)
    out = [0.0] * n
    rnd = random.Random(seed)
    ph = 0.0
    k = math.log(f1 / f0)
    for i in range(n):
        t = i / SR
        x = i / n
        f = f0 * math.exp(k * x)
        ph += f / SR
        if ph >= 1.0:
            ph -= 1.0
        saw = 2.0 * ph - 1.0
        out[i] = (saw * 0.5 + rnd.uniform(-1.0, 1.0) * 0.5) * (x ** 1.6)
    return out


# ============================================================
#  三、旋律类音色
# ============================================================

@memoized
def i_bass(freq, dur, *, c0=1500.0, c1=260.0, sweep_t=0.09, tau=None, drive=1.45):
    """合成贝斯：锯齿 + 方波 → 软削波 → 一阶低通（截止往下滑）。电子乐的低音脊梁"""
    n = _n(dur)
    out = [0.0] * n
    tau = tau if tau else dur * 0.65
    ph = 0.0
    y = 0.0
    a0 = 1.0 - math.exp(-TAU * c0 / SR)
    a1 = 1.0 - math.exp(-TAU * c1 / SR)
    k = math.log(c1 / c0)
    for i in range(n):
        t = i / SR
        ph += freq / SR
        if ph >= 1.0:
            ph -= 1.0
        saw = 2.0 * ph - 1.0
        sq = 1.0 if ph < 0.5 else -1.0
        x = math.tanh((saw * 0.72 + sq * 0.42) * drive)
        a = a0 + (a1 - a0) * min(1.0, t / sweep_t)
        y += a * (x - y)
        g = math.exp(-t / tau)
        if t < 0.004:
            g *= t / 0.004
        out[i] = y * g
    return out


@memoized
def i_pluck(freq, dur, *, bright=0.55, bend=0.012, seed=101):
    """拨弦/古筝：少量分音、高次衰减更快、带一点起音上滑"""
    n = _n(dur)
    body = _osc(
        [1.0, 2.0, 3.0, 4.02, 5.4],
        [1.0, bright * 0.62, bright * 0.34, bright * 0.22, bright * 0.12],
        [dur * 0.55, dur * 0.30, dur * 0.20, dur * 0.13, dur * 0.09],
        freq, n, bend=bend, bend_tau=0.035,
    )
    return body


@memoized
def i_marimba(freq, dur, *, tau=None):
    """马林巴/木琴：基音 + 4 倍分音 + 10 倍分音（琴板振型），高次衰减更快"""
    n = _n(dur)
    tau = tau if tau else dur * 0.45
    return _osc([1.0, 3.95, 9.2], [1.0, 0.30, 0.10], [tau, tau * 0.45, tau * 0.22], freq, n)


@memoized
def i_toy(freq, dur, *, tau=None):
    """玩具钢琴：正弦为主 + 一点点三倍分音，圆头圆脑"""
    n = _n(dur)
    tau = tau if tau else dur * 0.40
    body = _osc([1.0, 2.0, 3.01], [1.0, 0.16, 0.06], [tau, tau * 0.5, tau * 0.3], freq, n)
    e = env(n, atk=0.003, dec=dur * 0.6, sus=0.32, rel=0.05, curve=2.2)
    return [body[i] * e[i] for i in range(n)]


@memoized
def i_lead(freq, dur, *, duty=0.32, vib=5.4, vib_depth=0.005, seed=66):
    """主奏：脉冲波（方波族）+ 颤音。电子乐里最"抓耳"的一种音色"""
    n = _n(dur)
    out = [0.0] * n
    ph = 0.0
    e = env(n, atk=0.008, dec=dur * 0.85, sus=0.72, rel=min(0.09, dur * 0.35), curve=1.6)
    for i in range(n):
        t = i / SR
        f = freq * (1.0 + vib_depth * math.sin(TAU * vib * t) * min(1.0, t / 0.12))
        ph += f / SR
        if ph >= 1.0:
            ph -= 1.0
        out[i] = (1.0 if ph < duty else -1.0) * e[i]
    return out


@memoized
def i_flute(freq, dur, *, vib=5.0, vib_depth=0.008):
    """吹管（近似笛/箫）：正弦为主 + 三次分音一点点 + 明显颤音，慢起音"""
    n = _n(dur)
    out = [0.0] * n
    ph = 0.0
    ph3 = 0.0
    e = env(n, atk=min(0.10, dur * 0.3), dec=dur * 0.9, sus=0.8, rel=min(0.12, dur * 0.35), curve=1.4)
    for i in range(n):
        t = i / SR
        f = freq * (1.0 + vib_depth * math.sin(TAU * vib * t) * min(1.0, t / 0.25))
        ph += f / SR
        ph3 += 3.0 * f / SR
        if ph >= 1.0:
            ph -= 1.0
        if ph3 >= 1.0:
            ph3 -= 1.0
        out[i] = (math.sin(TAU * ph) * 0.85 + math.sin(TAU * ph3) * 0.15) * e[i]
    return out


@memoized
def i_epiano(freq, dur, *, idx=1.7, ratio=3.0, tau=None):
    """电钢：FM 合成（载波 + 快速衰减的调制器），有种"叮"的铃感"""
    n = _n(dur)
    out = [0.0] * n
    tau = tau if tau else dur * 0.85
    cph = 0.0
    mph = 0.0
    gi = idx
    dm = math.exp(-1.0 / (0.05 * SR))
    dk = math.exp(-1.0 / (tau * SR))
    e = env(n, atk=0.004, dec=dur * 0.9, sus=0.55, rel=0.06, curve=1.7)
    for i in range(n):
        cph += freq / SR
        mph += ratio * freq / SR
        if cph >= 1.0:
            cph -= 1.0
        if mph >= 1.0:
            mph -= 1.0
        out[i] = math.sin(TAU * cph + gi * math.sin(TAU * mph)) * dk * e[i]
        gi *= dm
    return out


@memoized
def i_pad(freqs, dur, *, cutoff=820.0, detune=0.0032, atk=0.28, rel=0.20):
    """
    铺底：每个音符 3 把失谐锯齿（左/中/右各偏 ±0.32%），一阶低通。
    失谐是"宽"的来源 —— 单把锯齿听起来是干的。
    """
    n = _n(dur)
    voices = []
    for f in freqs:
        for d in (-detune, 0.0, detune):
            voices.append(f * (1.0 + d))
    h = len(voices)
    ph = [0.0] * h
    inv = 1.0 / SR
    a = 1.0 - math.exp(-TAU * cutoff * inv)
    y = 0.0
    e = env(n, atk=atk, rel=rel, sus=1.0)
    out = [0.0] * n
    for i in range(n):
        s = 0.0
        for k in range(h):
            ph[k] += voices[k] * inv
            if ph[k] >= 1.0:
                ph[k] -= 1.0
            s += 2.0 * ph[k] - 1.0
        y += a * (s / h - y)
        out[i] = y * e[i]
    return out


# ============================================================
#  四、编曲引擎
# ============================================================

_PC = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def nf(name: str) -> float:
    """音名 → 频率。'C4' / 'F#3' / 'Bb5'，A4 = 440Hz"""
    s = name.strip()
    pc = _PC[s[0].upper()]
    i = 1
    while i < len(s) and s[i] in '#b':
        pc += 1 if s[i] == '#' else -1
        i += 1
    midi = (int(s[i:]) + 1) * 12 + pc
    return 440.0 * 2.0 ** ((midi - 69) / 12.0)


def shift(name: str, semis: int) -> str:
    """把音名整体移调若干半音"""
    s = name.strip()
    pc = _PC[s[0].upper()]
    i = 1
    while i < len(s) and s[i] in '#b':
        pc += 1 if s[i] == '#' else -1
        i += 1
    midi = (int(s[i:]) + 1) * 12 + pc + semis
    names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    return f'{names[midi % 12]}{midi // 12 - 1}'


class Song:
    """
    网格：一拍 = 4 个十六分音符；step 越小越早。
    声部（stem）分开存，便于 --stems 打印 RMS 校验配器平衡 ——
    没有听感的情况下，"军鼓比主奏响 20dB"这种事只能靠数字抓出来。
    """

    def __init__(self, name, bpm, bars):
        self.name = name
        self.bpm = bpm
        self.bars = bars
        self.step_s = 60.0 / (bpm * 4.0)      # 一个十六分音符的秒数
        self.steps = bars * 16
        self.n = _n(self.steps * self.step_s)  # 恰好一圈，不留尾巴（见文件头）
        self._stems = {}
        self.kick_steps = []

    # ---- 缓冲 ----
    def stem(self, key):
        if key not in self._stems:
            self._stems[key] = [0.0] * self.n
        return self._stems[key]

    def put(self, key, sig, step, gain=1.0):
        """把 sig 叠加到第 step 个十六分音符处；**超出末尾的部分回绕到开头**"""
        buf = self.stem(key)
        at = int(round(step * self.step_s * SR))
        at %= self.n
        ln = len(sig)
        for i in range(ln):
            buf[(at + i) % self.n] += sig[i] * gain

    # ---- 便捷写法 ----
    def hit(self, key, sig, step, gain=1.0):
        self.put(key, sig, step, gain)

    def drumline(self, key, pat, bar, maker, gain=1.0):
        """按一小节的 16 格字符串铺鼓：'x' 常规 / 'X' 重音 / '.' 空"""
        for i, ch in enumerate(pat):
            if ch == '.':
                continue
            g = gain * (1.25 if ch == 'X' else 1.0)
            self.put(key, maker(), bar * 16 + i, g)

    def melody(self, key, notes, bar0, maker, gain=1.0, extra_steps=0.9):
        """notes: [(step_in_phrase, 音名, 占几格)]；maker(频率, 秒) → 波形"""
        for st, note, ln in notes:
            dur = ln * self.step_s * extra_steps
            self.put(key, maker(nf(note), dur), bar0 * 16 + st, gain)

    # ---- 侧链泵动 ----
    def duck(self, key, *, depth=0.42, release=0.13, attack=0.004):
        """
        给某声部加"泵动"（sidechain）：每次底鼓落下时把该声部压下去，再指数恢复。
        这是"有动感"最直接的来源 —— 踢一下、气一收，整首歌就跟着呼吸。
        """
        buf = self.stem(key)
        eg = [1.0] * self.n
        span = _n(release * 3.2)
        for s in self.kick_steps:
            at = int(round(s * self.step_s * SR)) % self.n
            for i in range(min(span, self.n)):
                t = i / SR
                if t < attack:
                    v = depth * (t / attack) + 1.0 - depth
                else:
                    v = 1.0 - (1.0 - depth) * math.exp(-(t - attack) / release)
                j = (at + i) % self.n
                if v < eg[j]:
                    eg[j] = v
        for i in range(self.n):
            buf[i] *= eg[i]

    # ---- 导出 ----
    def stems(self):
        return self._stems

    def render(self):
        out = [0.0] * self.n
        for buf in self._stems.values():
            for i in range(self.n):
                out[i] += buf[i]
        return out


# ============================================================
#  五、5 段候选的配方
# ============================================================
#  共同原则：
#   · 每小节一个和弦，4 小节一循环（16 小节 = 主题走 4 遍）。
#   · 旋律只用和弦音 + 经过音，宁可简单也不写"半音撞车"。
#   · 鼓永远把"一、二、三、四"钉死，旋律再花也踩得稳。
# ============================================================

def track_A():
    """A · 跳跳糖 —— 128BPM / C大调 / 轻快电子（最贴《抓大鹅》）"""
    s = Song('A-跳跳糖', 128, 16)
    ch = {
        'C':  (['C3', 'E3', 'G3'], 'C2'),
        'G':  (['B2', 'D3', 'G3'], 'G2'),
        'Am': (['A2', 'C3', 'E3'], 'A2'),
        'F':  (['A2', 'C3', 'F3'], 'F2'),
    }
    order = ['C', 'G', 'Am', 'F']

    # 主旋律：4 小节一句，走 I-V-vi-IV
    lead = [
        (0, 'E5', 2), (2, 'G5', 2), (4, 'A5', 2), (6, 'G5', 2),
        (8, 'E5', 3), (11, 'D5', 1), (12, 'E5', 4),
        (16, 'D5', 2), (18, 'E5', 2), (20, 'G5', 2), (22, 'E5', 2),
        (24, 'D5', 4), (28, 'B4', 4),
        (32, 'E5', 2), (34, 'G5', 2), (36, 'A5', 2), (38, 'C6', 2),
        (40, 'A5', 3), (43, 'G5', 1), (44, 'A5', 4),
        (48, 'G5', 2), (50, 'E5', 2), (52, 'D5', 2), (54, 'E5', 2),
        (56, 'C5', 6), (62, 'G5', 2),
    ]
    # 每小节的八分音符低音（第 7、15 格翻八度，就是那点"弹"）
    bass_pat = [(0, 0), (2, 0), (4, 0), (6, 12), (8, 0), (10, 0), (12, 0), (14, 12)]

    for b in range(s.bars):
        bar = b % 4
        key = order[bar]
        tones, root = ch[key]

        # 鼓
        s.drumline('kick', 'x.....x.x.....x.', b, i_kick, 0.95)
        s.drumline('snare', '....x.......x...', b, i_snare, 0.62)
        s.drumline('hat', 'x.x.x.x.x.x.x.x.', b, i_hat, 0.30)
        if b % 4 == 3:                                  # 每 4 小节来一个过门
            s.drumline('snare', '.............xxx', b, i_snare, 0.50)
        if b in (0, 8):
            s.hit('crash', i_crash(), b * 16, 0.42)

        # 低音
        for st, semi in bass_pat:
            s.hit('bass', i_bass(nf(shift(root, semi)), 0.20), b * 16 + st, 0.80)

        # 八分琶音（和弦音 + 高八度，来回跑）
        arp = [tones[0], tones[1], tones[2], shift(tones[0], 12), tones[2], tones[1]]
        for j in range(8):
            s.hit('arp', i_pluck(nf(arp[j % 6]), 0.13, bright=0.40), b * 16 + j * 2, 0.26)

        # 铺底（整小节）
        s.hit('pad', i_pad(tuple(nf(x) for x in tones), 1.0 * 4 * 60.0 / s.bpm), b * 16, 0.30)

    # 主旋律：4 小节一句，整曲走 4 遍。
    # ★ 必须放在上面"每小节"的循环**外面** —— 放里面的话同一句会在相邻 4 个小节里
    #   各铺一层，主奏被叠成 4 倍响（实测 lead 声部 max 冲到 1.36 = 0.34×4）。
    #   这个 bug 编译过、跑得通、波形也正常，只有量声部 RMS 才看得出来。
    for pb in range(0, s.bars, 4):
        s.melody('lead', lead, pb, i_lead, 0.34)

    s.duck('pad', depth=0.50, release=0.16)
    return s


def track_B():
    """B · 鹅步快跑 —— 140BPM / G大调 / 高速电子（动感最强）"""
    s = Song('B-鹅步快跑', 140, 16)
    ch = {
        'G':  (['G3', 'B3', 'D4'], 'G2'),
        'D':  (['F#3', 'A3', 'D4'], 'D2'),
        'Em': (['E3', 'G3', 'B3'], 'E2'),
        'C':  (['C3', 'E3', 'G3'], 'C2'),
    }
    order = ['G', 'D', 'Em', 'C']

    lead = [
        (0, 'G5', 2), (2, 'B5', 2), (4, 'D6', 2), (6, 'B5', 2),
        (8, 'G5', 2), (10, 'A5', 2), (12, 'B5', 4),
        (16, 'A5', 2), (18, 'F#5', 2), (20, 'A5', 2), (22, 'D6', 2),
        (24, 'A5', 4), (28, 'F#5', 4),
        (32, 'G5', 2), (34, 'B5', 2), (36, 'E6', 2), (38, 'B5', 2),
        (40, 'G5', 2), (42, 'F#5', 2), (44, 'E5', 4),
        (48, 'E5', 2), (50, 'G5', 2), (52, 'C6', 2), (54, 'G5', 2),
        (56, 'E5', 4), (60, 'D5', 4),
    ]
    # 后 8 小节加一串十六分音跑句，把"快"顶上去
    lead_fast = [
        (0, 'G5', 1), (1, 'A5', 1), (2, 'B5', 1), (3, 'D6', 1),
        (4, 'B5', 1), (5, 'A5', 1), (6, 'G5', 1), (7, 'E5', 1),
        (8, 'D5', 1), (9, 'E5', 1), (10, 'G5', 1), (11, 'B5', 1),
        (12, 'D6', 2), (14, 'B5', 2),
        (16, 'F#5', 1), (17, 'A5', 1), (18, 'D6', 1), (19, 'A5', 1),
        (20, 'F#5', 1), (21, 'A5', 1), (22, 'C#6', 1), (23, 'A5', 1),
        (24, 'D6', 4), (28, 'A5', 4),
        (32, 'B5', 1), (33, 'G5', 1), (34, 'E5', 1), (35, 'G5', 1),
        (36, 'B5', 1), (37, 'E6', 1), (38, 'B5', 1), (39, 'G5', 1),
        (40, 'E5', 4), (44, 'G5', 2), (46, 'B5', 2),
        (48, 'C6', 1), (49, 'G5', 1), (50, 'E5', 1), (51, 'G5', 1),
        (52, 'C6', 1), (53, 'E6', 1), (54, 'C6', 1), (55, 'G5', 1),
        (56, 'E5', 6), (62, 'D5', 2),
    ]

    for b in range(s.bars):
        bar = b % 4
        tones, root = ch[order[bar]]

        # 四四底鼓（EDM）+ 反拍开镲 —— "跑"的感觉全靠这两条
        s.drumline('kick', 'x...x...x...x...', b, i_kick, 1.0)
        s.drumline('clap', '....x.......x...', b, i_clap, 0.46)
        s.drumline('hat', 'x.x.x.x.x.xxx.x.', b, i_hat, 0.26)
        s.drumline('ohat', '..o...o...o...o.', b, lambda: i_hat(0.30, open_=True), 0.16)
        if b % 4 == 3:
            s.drumline('snare', '............x.xx', b, i_snare, 0.52)
        if b in (0, 8):
            s.hit('crash', i_crash(), b * 16, 0.40)
        if b == 7:
            s.hit('riser', i_riser(), b * 16, 0.44)

        # 十六分音八度低音（最"推"的一条）
        for j in range(16):
            semi = 0 if j % 2 == 0 else 12
            s.hit('bass', i_bass(nf(shift(root, semi)), 0.11, c0=1800.0, drive=1.6), b * 16 + j, 0.60)

        # 十六分琶音
        arp = [tones[0], tones[1], tones[2], shift(tones[1], 12)]
        for j in range(16):
            s.hit('arp', i_pluck(nf(arp[j % 4]), 0.10, bright=0.35), b * 16 + j, 0.17)

        s.hit('pad', i_pad(tuple(nf(x) for x in tones), 1.0 * 4 * 60.0 / s.bpm), b * 16, 0.42)

    # 主题 4 小节一句；奇偶块交替"原句 / 十六分快句"（第 9 小节起提速）
    for pb in range(0, s.bars, 4):
        phrase = lead if (pb // 4) % 2 == 0 else lead_fast
        s.melody('lead', phrase, pb, i_lead, 0.30, extra_steps=0.85)

    s.duck('pad', depth=0.30, release=0.115)     # 强泵动：B 的动感就来自这里
    s.duck('bass', depth=0.72, release=0.075)
    return s


def track_C():
    """C · 茶馆电音 —— 112BPM / D宫五声 / 国风×电子（最贴麻将题材）"""
    s = Song('C-茶馆电音', 112, 16)
    ch = {
        'D':  (['D3', 'F#3', 'A3'], 'D2'),
        'A':  (['C#3', 'E3', 'A3'], 'A2'),
        'Bm': (['B2', 'D3', 'F#3'], 'B2'),
        'G':  (['G2', 'B2', 'D3'], 'G2'),
    }
    order = ['D', 'A', 'Bm', 'G']

    # 五声旋律（D E F# A B），没有 fa/si，天然"国风"
    lead = [
        (0, 'A4', 3), (4, 'B4', 3), (8, 'D5', 4), (12, 'A4', 2), (14, 'B4', 2),
        (16, 'A4', 3), (20, 'F#4', 3), (24, 'E4', 6), (30, 'F#4', 2),
        (32, 'B4', 3), (36, 'D5', 3), (40, 'F#5', 4), (44, 'E5', 4),
        (48, 'D5', 3), (52, 'B4', 3), (56, 'A4', 6), (62, 'B4', 2),
    ]

    for b in range(s.bars):
        bar = b % 4
        tones, root = ch[order[bar]]

        s.drumline('kick', 'x.......x.......', b, i_kick, 0.85)     # 只在 1、3 拍，留白给民乐
        s.drumline('tom', '....x.......x.x.', b, i_tom, 0.42)
        s.drumline('wood', '..x...x...x...x.', b, i_wood, 0.20)     # 木鱼/木块打反拍
        s.drumline('shaker', 'xxxxxxxxxxxxxxxx', b, i_shaker, 0.09)
        if b % 4 == 3:
            s.drumline('wood', '...........x.xxx', b, i_wood, 0.18)
        if b in (0, 8):
            s.hit('crash', i_crash(), b * 16, 0.30)

        # 古筝式低音：根音 + 五度
        for st, semi in [(0, 0), (3, 0), (6, 7), (8, 0), (11, 7), (14, 0)]:
            s.hit('bass', i_bass(nf(shift(root, semi)), 0.30, c0=900.0, c1=200.0, drive=1.1),
                  b * 16 + st, 0.62)

        # 古筝拨弦：每小节的刮奏（下行）
        guz = [shift(tones[2], 12), tones[2], tones[1], tones[0], shift(tones[0], -12)]
        for j in range(5):
            s.hit('guzheng', i_pluck(nf(guz[j]), 0.55, bright=0.70, bend=0.02), b * 16 + j, 0.22)
        # 反拍再来两下点缀
        s.hit('guzheng', i_pluck(nf(tones[1]), 0.45, bright=0.70), b * 16 + 10, 0.16)
        s.hit('guzheng', i_pluck(nf(tones[2]), 0.45, bright=0.70), b * 16 + 13, 0.16)

        s.hit('pad', i_pad(tuple(nf(x) for x in tones), 1.0 * 4 * 60.0 / s.bpm, cutoff=650.0),
              b * 16, 0.28)

    for pb in range(0, s.bars, 4):
        s.melody('flute', lead, pb, i_flute, 0.30, extra_steps=0.88)

    s.duck('pad', depth=0.62, release=0.20)
    return s


def track_D():
    """D · 牌桌弹珠 —— 124BPM / F大调 / 木琴玩具感（最 Q 萌）"""
    s = Song('D-牌桌弹珠', 124, 16)
    ch = {
        'F':  (['F3', 'A3', 'C4'], 'F2'),
        'C':  (['C3', 'E3', 'G3'], 'C2'),
        'Dm': (['D3', 'F3', 'A3'], 'D2'),
        'Bb': (['D3', 'F3', 'Bb3'], 'Bb2'),
    }
    order = ['F', 'C', 'Dm', 'Bb']

    lead = [
        (0, 'C5', 2), (2, 'F5', 2), (4, 'A5', 2), (6, 'F5', 2),
        (8, 'C5', 3), (11, 'D5', 1), (12, 'E5', 4),
        (16, 'C5', 2), (18, 'E5', 2), (20, 'G5', 2), (22, 'E5', 2),
        (24, 'D5', 4), (28, 'C5', 4),
        (32, 'D5', 2), (34, 'F5', 2), (36, 'A5', 2), (38, 'F5', 2),
        (40, 'D5', 3), (43, 'E5', 1), (44, 'F5', 4),
        (48, 'D5', 2), (50, 'F5', 2), (52, 'A#5', 2), (54, 'A5', 2),
        (56, 'F5', 4), (60, 'C5', 4),
    ]

    for b in range(s.bars):
        bar = b % 4
        tones, root = ch[order[bar]]

        s.drumline('kick', 'x..x..x...x..x..', b, i_kick, 0.72)     # 弹跳型底鼓
        s.drumline('clap', '....x.......x...', b, i_clap, 0.40)
        s.drumline('shaker', 'x.x.x.x.x.x.xxx.', b, i_shaker, 0.16)
        if b % 4 == 3:
            s.drumline('clap', '.............xxx', b, i_clap, 0.34)
        if b in (0, 8):
            s.hit('crash', i_crash(), b * 16, 0.28)

        for st, semi in [(0, 0), (3, 12), (6, 0), (8, 0), (11, 12), (14, 0)]:
            s.hit('bass', i_bass(nf(shift(root, semi)), 0.22, c0=1200.0, c1=240.0), b * 16 + st, 0.66)

        # 木琴反拍和弦（每拍的后半拍"嗒"一下）
        for j in (2, 6, 10, 14):
            for n in tones:
                s.hit('marimba', i_marimba(nf(shift(n, 12)), 0.36), b * 16 + j, 0.13)
        s.hit('marimba', i_marimba(nf(shift(tones[0], 12)), 0.5), b * 16, 0.16)

        s.hit('pad', i_pad(tuple(nf(x) for x in tones), 1.0 * 4 * 60.0 / s.bpm, cutoff=900.0),
              b * 16, 0.22)

    for pb in range(0, s.bars, 4):
        s.melody('toy', lead, pb, i_toy, 0.32, extra_steps=0.9)

    s.duck('pad', depth=0.55, release=0.17)
    return s


def track_E():
    """E · 夜灯摇摆 —— 118BPM / A小调 / 轻电子摇摆（久听不累）"""
    s = Song('E-夜灯摇摆', 118, 16)
    ch = {
        'Am': (['A2', 'C3', 'E3'], 'A2'),
        'F':  (['F2', 'A2', 'C3'], 'F2'),
        'C':  (['C3', 'E3', 'G3'], 'C2'),
        'G':  (['G2', 'B2', 'D3'], 'G2'),
    }
    order = ['Am', 'F', 'C', 'G']
    SW = 0.14     # 摇摆量：后半拍往后挪 0.14 格（十六分音符的 14%）

    lead = [
        (0, 'E5', 3), (3, 'A4', 3), (6, 'C5', 4), (10, 'B4', 2), (12, 'A4', 4),
        (16, 'A4', 3), (19, 'C5', 3), (22, 'F5', 4), (26, 'E5', 2), (28, 'C5', 4),
        (32, 'G4', 3), (35, 'C5', 3), (38, 'E5', 4), (42, 'D5', 2), (44, 'C5', 4),
        (48, 'B4', 3), (51, 'D5', 3), (54, 'G5', 4), (58, 'D5', 2), (60, 'B4', 4),
    ]

    for b in range(s.bars):
        bar = b % 4
        tones, root = ch[order[bar]]

        s.drumline('kick', 'x.......x.......', b, i_kick, 0.62)
        s.drumline('rim', '....x.......x...', b, i_snare, 0.30)      # 轻军鼓当边击
        for j in (0, 1, 2, 3, 4, 5, 6, 7):
            # 摇摆八分：正拍在 j*2，反拍往后挪 SW 格
            s.hit('hat', i_hat(0.055), b * 16 + j * 2, 0.20)
            s.hit('hat', i_hat(0.045), b * 16 + j * 2 + 1 + SW, 0.13)
        if b % 4 == 3:
            s.drumline('rim', '..........x.x.xx', b, i_snare, 0.26)
        if b in (0, 8):
            s.hit('crash', i_crash(1.3, tau=0.42), b * 16, 0.22)

        # 摇摆贝斯：根音走"长-短"，第 3 拍给五度
        for st, semi, ln in [(0, 0, 0.24), (2 + SW, 0, 0.16), (4, 0, 0.24), (6 + SW, 7, 0.16),
                             (8, 0, 0.24), (10 + SW, 0, 0.16), (12, 0, 0.24), (14 + SW, 12, 0.18)]:
            s.hit('bass', i_bass(nf(shift(root, semi)), ln, c0=800.0, c1=190.0, drive=1.0),
                  b * 16 + st, 0.60)

        # 电钢和弦：2、4 拍的后半拍切一下（爵士的"切分"）
        for j in (6, 14):
            for n in tones:
                s.hit('epiano', i_epiano(nf(shift(n, 12)), 0.55), b * 16 + j, 0.14)
        s.hit('epiano', i_epiano(nf(tones[1]), 0.9), b * 16, 0.13)

        s.hit('pad', i_pad(tuple(nf(x) for x in tones), 1.0 * 4 * 60.0 / s.bpm, cutoff=700.0),
              b * 16, 0.20)

    for pb in range(0, s.bars, 4):
        s.melody('lead', lead, pb, i_lead, 0.26, extra_steps=0.9)
        # 低八度电钢跟着主奏走，做"厚"而不是"响"
        s.melody('lead', lead, pb, lambda f, d: i_epiano(f / 2, d, idx=1.0), 0.10)

    s.duck('pad', depth=0.60, release=0.22)
    return s


TRACKS = [track_A, track_B, track_C, track_D, track_E]

# ------------------------------------------------------------
#  自动配平（没有耳朵时的替代方案）
# ------------------------------------------------------------
#  各声部"该有多响"的目标（**活跃段** RMS，dBFS）。
#  这张表就是"混音师的手"：把它当成"谁该压着谁"的关系表来读 ——
#    · 旋律三件（lead / toy / flute）在最前，但它不是一个"独奏"，
#      而是一段可以长时间循环的背景音乐，所以不吃满；
#    · 底鼓与贝斯是地基，压过旋律一点点，曲子才"踩得实"；
#    · 和声类（pad / arp / epiano / guzheng / marimba）退到旋律后面；
#    · 打击乐按"打击乐就该在后面"的次序排，吊镲/上行音效是效果音，最低。
#  为什么需要它：i_bass 经过低通后单音峰值只剩 0.50、i_clap 经过高通后
#  整轨 RMS 只有 -35dB —— 这类"音色天然偏轻"的声部靠一个个手调增益是猜，
#  而有目标值就能**量出来再补回去**。拍板之后想改平衡，改这张表即可。
# ------------------------------------------------------------
TRIM_TARGET = {
    'lead': -13.0, 'toy': -13.5, 'flute': -13.5,
    'bass': -14.0, 'kick': -13.5,
    'clap': -17.0, 'epiano': -17.0, 'guzheng': -17.0,
    'snare': -18.0, 'rim': -19.0, 'tom': -19.0,
    'arp': -19.0, 'marimba': -19.0,
    'pad': -20.0, 'wood': -22.0,
    'hat': -24.0, 'crash': -25.0, 'riser': -25.0,
    'ohat': -27.0, 'shaker': -29.0,
}
TRIM_LIMIT = 12.0     # 单次配平最多 ±12dB，防止某声部被拉到离谱


def auto_balance(song, verbose=False):
    """
    按 TRIM_TARGET 逐声部补增益。
    上限 ±12dB —— 真需要补更多的，说明音色本身写坏了，该去改音色而不是硬拉。
    """
    log = []
    for k, buf in song.stems().items():
        tgt = TRIM_TARGET.get(k)
        if tgt is None:
            continue
        a = active_rms(buf)
        if a < 1e-9:
            continue
        db = tgt - 20.0 * math.log10(a)
        db = max(-TRIM_LIMIT, min(TRIM_LIMIT, db))
        if abs(db) < 0.05:
            continue
        g = 10.0 ** (db / 20.0)
        for i in range(len(buf)):
            buf[i] *= g
        log.append((k, db, db >= TRIM_LIMIT - 1e-6 or db <= -TRIM_LIMIT + 1e-6))
    if verbose:
        for k, db, hit in log:
            flag = '  ⚠️ 撞上限' if hit else ''
            print(f'      {k:<9}{db:+6.1f}dB{flag}')
    return log


#  每段候选的"说明书"（试听页直接用）
META = {
    'A': dict(
        tag='轻快电子 · 最贴抓大鹅',
        desc='方波主奏 + 弹跳贝斯 + 四四鼓组，I-V-vi-IV 走 4 遍。'
             '抓大鹅那条"轻快的电子旋律"就是这一路：旋律一条线抓耳，鼓把拍子钉死，'
             '不抢消除音效的戏。',
        fit='最稳的默认选择。想要"就是抓大鹅那个味道"就选它。',
        risk='副歌感较弱，循环久了略平（没有大段落对比）。',
    ),
    'B': dict(
        tag='高速电子 · 动感最强',
        desc='140BPM、四四底鼓 + 反拍开镲 + 十六分八度贝斯，铺底和贝斯都挂了侧链泵动。'
             '第 9 小节有 riser + 吊镲的段落切换。',
        fit='想强调"快节奏、爽"，或者搭配高难度关卡。',
        risk='最吵的一档，长期循环容易累；也会和"碰"的撞击音效抢注意力。',
    ),
    'C': dict(
        tag='国风×电子 · 最贴麻将题材',
        desc='D 宫五声（没有 fa/si），古筝式拨弦刮奏 + 木鱼/手鼓打点，底鼓只留 1、3 拍。'
             '国风的旋律骨架 + 电子的低频支撑。',
        fit='想让 BGM 和"麻将/四川话"的题材自洽 —— 这是唯一一段"一听就知道是中国牌桌"的。',
        risk='律动比 A/B 慢半档，"动感"不是它的强项。',
    ),
    'D': dict(
        tag='木琴玩具感 · 最 Q 萌',
        desc='马林巴反拍和弦 + 玩具钢琴主奏 + 拍手，底鼓走弹跳型。'
             '音色都是圆头圆脑的短衰减打击音，几乎没有"电"。',
        fit='想让整体气质更"轻松减压"、更贴近抓大鹅的"治愈"一面。',
        risk='低频最薄，手机小喇叭上可能显得"轻飘"。',
    ),
    'E': dict(
        tag='轻电子摇摆 · 久听不累',
        desc='电钢和弦 + 摇摆八分贝斯 + 轻边击，A 小调（vi-IV-I-V，唯一的小调色彩）。'
             '摇摆量 14%，有律动但不吵。',
        fit='打算做长局（无尽/多关连打），需要一条"听一小时也不烦"的。',
        risk='小调偏忧郁，和"欢快治愈"的定位有一点点偏差。',
    ),
}


# ============================================================
#  六、渲染、导出与体检
# ============================================================

def polish(sig, peak=PEAK, drive=LIMIT):
    """
    总线处理：归一化 → 软削波 → 再归一化。
    软削波压掉瞬态波峰，波峰因数下降 → 同样的峰值下**听感更响更满**。
    """
    m = max((abs(v) for v in sig), default=0.0)
    if m < 1e-9:
        return sig
    sig = [v / m for v in sig]
    k = math.tanh(drive)
    sig = [math.tanh(v * drive) / k for v in sig]
    m2 = max((abs(v) for v in sig), default=1.0)
    return [v * peak / m2 for v in sig]


def write_wav(path, sig):
    """写 16bit 单声道 WAV（与 make-sfx.py 同一格式）"""
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(b''.join(
            struct.pack('<h', max(-32768, min(32767, int(v * 32767))))
            for v in sig
        ))


def analyze(sig, bar_samples):
    """
    体检指标。听不到声音的时候，这些数字就是眼睛：
      · 每秒音头数 —— "动感密度"，直接对应"有没有律动"
      · 零交叉率   —— 高频占比的廉价代理，对应"亮不亮/吵不吵"
      · 波峰因数   —— 越高越"动态"，越低越"压得死"
      · 接缝       —— 循环点的跳变 ÷ 曲内强拍跳变中位数（见下方长注释）
    """
    bar_samples = max(1, int(round(bar_samples)))
    n = len(sig)
    dur = n / SR
    peak = max((abs(v) for v in sig), default=0.0)
    rms = math.sqrt(sum(v * v for v in sig) / max(1, n))
    zc = 0
    prev = sig[0] if n else 0.0
    for v in sig:
        if (v >= 0) != (prev >= 0):
            zc += 1
        prev = v

    step = _n(0.010)
    onsets = 0
    prev_e = 0.0
    for i in range(0, n - step, step):
        seg = sig[i:i + step]
        e = math.sqrt(sum(v * v for v in seg) / step)
        if e > prev_e * 1.9 and e > 0.02:
            onsets += 1
        prev_e = 0.88 * prev_e + 0.12 * e

    # 50ms 一格的 RMS 包络，给试听页画波形
    envstep = _n(0.050)
    points = []
    for i in range(0, n, envstep):
        seg = sig[i:i + envstep]
        if not seg:
            break
        points.append(round(math.sqrt(sum(v * v for v in seg) / len(seg)), 4))

    # ---- 循环接缝 ----
    #  ⚠️ 别用「循环点跳变 / 峰值」这种比值 —— 它会把你带沟里：
    #     那个数在 A/E 上高达 0.32/0.27，看着像"循环爆音"，
    #     实际测的是**循环点正好落在强拍上、底鼓+吊镲攻击的那一下跳变**。
    #     正确口径是拿它跟"曲内其它强拍的跳变"比：
    #     强拍的鼓攻击本来就该跳，只要循环点不比别的强拍更跳，就算接得上。
    dj = []
    b = 1
    while b * bar_samples < n:
        i = b * bar_samples
        dj.append(abs(sig[i] - sig[i - 1]))
        b += 1
    dj.sort()
    med = dj[len(dj) // 2] if dj else 0.0
    seam = abs(sig[0] - sig[-1]) / max(med, 1e-9)
    seam_max = dj[-1] / max(med, 1e-9) if dj else 0.0

    return dict(
        dur=round(dur, 3),
        peak=round(peak, 4),
        peak_db=round(20 * math.log10(max(peak, 1e-6)), 1),
        rms=round(rms, 4),
        rms_db=round(20 * math.log10(max(rms, 1e-6)), 1),
        crest=round(peak / max(rms, 1e-6), 2),
        seam=round(seam, 2),
        seam_max=round(seam_max, 2),
        onsets=onsets,
        onsets_per_s=round(onsets / max(dur, 1e-6), 2),
        zcr=round(zc / max(dur, 1e-6)),
        env=points,
    )


# ============================================================
#  八、入库（--install）：把拍板那一段装进游戏
# ============================================================
#  为什么要有这一步，而不是"手工把 m4a 拖进 assets/resources/audio"：
#   ① `.meta` 是资源的身份证。Cocos 靠 uuid 引用资源 —— 手工拖文件要么
#      没有 `.meta`（编辑器补一个随机 uuid，不可复现），要么覆盖时把 uuid
#      换了（工程里凭空多一个资源、旧的变野指针，表现为"音频莫名为空"）。
#      这里用 uuid5（名字哈希）派生固定值，跑多少次都一样。
#   ② `afconvert` 会把"编码那一刻"的时间戳写进容器 → 同一段音频重跑两次
#      md5 都不一样。搬完必须再调一次 zero_container_times()。
#   ③ "文件在" ≠ "能播"：参数写错的 afconvert 会**安静地**产出坏文件，
#      所以落盘后立刻 afinfo 复验。
#  这套家法与 install-voice-lib.py / make-voice.py --install 完全一致，
#  仓库里不能有第二条"资源是怎么进来的"产线。
# ============================================================

def _stable_uuid(name: str) -> str:
    """由资源名派生固定 uuid（与"固定随机种子"同理：保证可复现）。"""
    import uuid
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'game4-mahjong://audio/{name}'))


def _meta_json(name: str) -> str:
    """与工程既有 13 段音效的 .meta 逐字段一致。"""
    return json.dumps({
        'ver': '1.0.0',
        'importer': 'audio-clip',      # ★ 必须是 audio-clip，否则构建后不是 AudioClip
        'imported': True,
        'uuid': _stable_uuid(name),
        'files': ['.json', '.m4a'],
        'subMetas': {},
        'userData': {'downloadMode': 0},
    }, indent=2) + '\n'


def install_to_game() -> int:
    """把 CHOSEN 指的那段 BGM 装进 assets/resources/audio/<INSTALL_AS>.m4a"""
    pick = next((f for f in TRACKS if f.__name__[-1] == CHOSEN.upper()), None)
    if pick is None:
        print(f'✗ CHOSEN={CHOSEN!r} 不对应任何轨道（可选 A~E）')
        return 1

    song_name = pick().name                       # 例：'C-茶馆电音'
    src = os.path.join(OUT_DIR, f'{song_name}.m4a')
    if not os.path.exists(src):
        print(f'✗ 找不到已合成的产物：{src}')
        print('  先跑一次：python3 tools/make-bgm.py --page')
        return 1

    dst = os.path.join(GAME_AUDIO, f'{INSTALL_AS}.m4a')
    meta = dst + '.meta'
    existed = os.path.exists(dst)

    zero_times = _load_zero_times()
    shutil.copyfile(src, dst)
    zero_times(dst)                               # 清容器时间戳 → 可复现

    # 落盘后立刻复验
    info = subprocess.run(['afinfo', dst], capture_output=True)
    ok = info.returncode == 0 and b'audio' in info.stdout.lower()
    dur, fmt = 0.0, ''
    for line in info.stdout.decode(errors='ignore').splitlines():
        if 'estimated duration' in line:
            try:
                dur = float(line.split(':')[1].strip().split()[0])
            except Exception:
                pass
        if 'Data format' in line:
            fmt = line.split(':', 1)[1].strip()

    # .meta：新建才写；覆盖已有资源**绝不重写**（重写会换 uuid）
    if os.path.exists(meta):
        verb = '覆盖（保留原 .meta，uuid 不变）'
    else:
        with open(meta, 'w', encoding='utf-8') as f:
            f.write(_meta_json(f'{INSTALL_AS}.m4a'))
        verb = f'新建 .meta（uuid={_stable_uuid(f"{INSTALL_AS}.m4a")[:8]}…）'

    kb = os.path.getsize(dst) / 1024.0
    print('=' * 72)
    print(f'  BGM 入库：{song_name}  →  audio/{INSTALL_AS}.m4a')
    print('=' * 72)
    print(f'  源     {src}')
    print(f'  目标   {dst}{"" if existed else "（新资源）"}')
    print(f'  参数   {fmt}')
    print(f'  时长   {dur:.3f}s   体积 {kb:.1f}K')
    print(f'  meta   {verb}')
    print(f'  复验   {"✅ afinfo 通过" if ok else "⚠️  解码复验失败！"}')
    print()
    print('  下一步：bash tools/wechat-preview.sh   # 构建 + 出真机试玩码')
    print('=' * 72)
    return 0 if ok else 1


def main() -> int:
    argv = sys.argv[1:]

    # --install 是"另一件事"：不合成，只把拍板那段搬进游戏。
    # 放在最前面短路，免得跟着合成流程白跑一遍 5 段（每段 2~3 秒）。
    if '--install' in argv:
        return install_to_game()

    wav_only = '--wav-only' in argv
    want_page = '--page' in argv
    show_stems = '--stems' in argv
    no_trim = '--no-trim' in argv
    only = None
    if '--only' in argv:
        only = set(argv[argv.index('--only') + 1].upper().replace(',', ''))

    os.makedirs(WAV_DIR, exist_ok=True)
    os.makedirs(OUT_DIR, exist_ok=True)
    zero_times = _load_zero_times()

    picks = [fn for fn in TRACKS if not only or fn.__name__[-1] in only]
    if not picks:
        print('没有匹配的轨道')
        return 1

    print(f'{"候选":<14}{"时长":>8}{"峰值dB":>9}{"RMS dB":>9}{"波峰":>7}{"音头/秒":>9}{"m4a":>9}')
    print('-' * 68)

    report = []
    for fn in picks:
        song = fn()
        if not no_trim:
            auto_balance(song, verbose=False)
        raw = song.render()
        sig = polish(raw)
        body = song.name.split('-')[0]

        if show_stems:
            print(f'  [{body}] 活跃段 RMS（实测 / 目标）：')
            for k, buf in song.stems().items():
                a = active_rms(buf)
                tgt = TRIM_TARGET.get(k)
                now = 20.0 * math.log10(max(a, 1e-9))
                t = f'{tgt:+.1f}' if tgt is not None else '  —'
                print(f'      {k:<9}{now:7.1f}dB  目标 {t}')

        wav_path = os.path.join(WAV_DIR, f'{song.name}.wav')
        write_wav(wav_path, sig)

        a = analyze(sig, 16.0 * song.step_s * SR)
        size_kb = 0.0
        if not wav_only:
            m4a_path = os.path.join(OUT_DIR, f'{song.name}.m4a')
            r = subprocess.run(
                ['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '64000', wav_path, m4a_path],
                capture_output=True,
            )
            if r.returncode != 0:
                print(f'{song.name} 转码失败：{r.stderr.decode()[:160]}')
                return 1
            zero_times(m4a_path)      # 清容器时间戳，否则每次重跑 md5 全变
            size_kb = os.path.getsize(m4a_path) / 1024.0

        print(f'{song.name:<14}{a["dur"]:7.2f}s{a["peak_db"]:9.1f}{a["rms_db"]:9.1f}'
              f'{a["crest"]:7.2f}{a["onsets_per_s"]:9.2f}{size_kb:8.1f}K')

        report.append(dict(
            id=body, name=song.name, bpm=song.bpm, bars=song.bars,
            size_kb=round(size_kb, 1), **a,
            **META.get(body, {}),
        ))

    with open(os.path.join(OUT_DIR, 'candidates.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print('-' * 68)
    print(f'输出目录 {OUT_DIR}')

    if want_page and not wav_only:
        page = os.path.join(OUT_DIR, 'BGM候选-试听.html')
        build_page(report, page)
        print(f'试听页   {page}')
    return 0


# ============================================================
#  七、试听页（音频 base64 内嵌，不依赖任何外部路径）
# ============================================================
#  为什么不写 <audio src="./A-跳跳糖.m4a">：
#    预览面板对相对路径的支持不确定（file:// 下的媒体加载各浏览器策略不同），
#    内嵌成 data URI 是唯一"一定能播"的写法。代价是 HTML 大了 1.3 倍。
# ============================================================

def build_page(report, out_path):
    rows = []
    for r in report:
        m4a = os.path.join(OUT_DIR, r['name'] + '.m4a')
        b64 = base64.b64encode(open(m4a, 'rb').read()).decode('ascii')
        rows.append((r, b64))

    cards = []
    for i, (r, b64) in enumerate(rows, 1):
        # 包络按自身峰值归一化后再开 0.6 次方 —— 直接按绝对值画，5 段的柱子
        # 会几乎一样高（RMS 都落在 0.15 上下），看不出段落起伏。
        mx = max(r['env']) or 1.0
        bars = ''.join(
            f'<i style="height:{max(3, int((v / mx) ** 0.6 * 40))}px"></i>' for v in r['env']
        )
        cards.append(f'''
  <section class="card" id="c{r['id']}">
    <div class="hd">
      <span class="no">{i}</span>
      <div class="ttl">
        <h2>{r['name'].split('-', 1)[1]}</h2>
        <span class="tag">{r.get('tag', '')}</span>
      </div>
      <button class="pick" data-id="{r['id']}">就选它</button>
    </div>
    <div class="stats">
      <b>{r['bpm']}</b><span>BPM</span>
      <b>{r['dur']:.1f}s</b><span>时长</span>
      <b>{r['size_kb']:.0f}K</b><span>体积</span>
      <b>{r['onsets_per_s']:.2f}</b><span>音头/秒</span>
      <b>{r['zcr']}</b><span>零交叉率</span>
      <b>{r['crest']:.2f}</b><span>波峰因数</span>
    </div>
    <div class="wave">{bars}</div>
    <audio controls loop preload="metadata" src="data:audio/mp4;base64,{b64}"></audio>
    <p class="desc">{r.get('desc', '')}</p>
    <p class="fit"><em>适合</em>{r.get('fit', '')}</p>
    <p class="risk"><em>代价</em>{r.get('risk', '')}</p>
  </section>''')

    html = f'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>《麻麻大消除》BGM 候选试听</title>
<style>
  :root {{
    --bg:#f6f5f2; --card:#fff; --ink:#1c1b19; --sub:#6b6862;
    --line:#e4e1da; --accent:#b23a2e; --wave:#c9c4ba;
  }}
  * {{ box-sizing:border-box; }}
  body {{ margin:0; background:var(--bg); color:var(--ink);
    font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }}
  header {{ padding:34px 24px 18px; max-width:920px; margin:0 auto; }}
  h1 {{ margin:0 0 6px; font-size:24px; letter-spacing:.5px; }}
  .lead {{ color:var(--sub); margin:0; }}
  .lead b {{ color:var(--ink); }}
  main {{ max-width:920px; margin:0 auto; padding:0 24px 60px; }}
  .card {{ background:var(--card); border:1px solid var(--line); border-radius:14px;
    padding:18px 20px 16px; margin:16px 0; }}
  .hd {{ display:flex; align-items:center; gap:12px; }}
  .no {{ width:30px; height:30px; flex:0 0 30px; border-radius:50%;
    background:var(--ink); color:#fff; display:grid; place-items:center;
    font-size:15px; font-weight:600; }}
  .ttl {{ flex:1; display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }}
  .ttl h2 {{ margin:0; font-size:19px; }}
  .tag {{ font-size:12px; color:var(--accent); border:1px solid currentColor;
    border-radius:999px; padding:1px 9px; }}
  .pick {{ border:1px solid var(--line); background:#fff; color:var(--ink);
    border-radius:999px; padding:6px 14px; font-size:13px; cursor:pointer; }}
  .pick:hover {{ border-color:var(--accent); color:var(--accent); }}
  .pick.on {{ background:var(--accent); border-color:var(--accent); color:#fff; }}
  .stats {{ display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 16px;
    margin:12px 0 10px; font-size:13px; }}
  .stats b {{ font-size:15px; }}
  .stats span {{ color:var(--sub); margin-left:-12px; }}
  .wave {{ display:flex; align-items:flex-end; gap:1px; height:44px;
    margin:2px 0 12px; padding:0 1px; }}
  .wave i {{ flex:1; background:var(--wave); border-radius:1px; min-width:1px; }}
  audio {{ width:100%; height:34px; }}
  .desc {{ margin:12px 0 6px; }}
  .fit, .risk {{ margin:4px 0; font-size:13.5px; color:var(--sub); }}
  .fit em, .risk em {{ font-style:normal; display:inline-block; min-width:34px;
    color:var(--ink); font-weight:600; margin-right:6px; }}
  footer {{ max-width:920px; margin:0 auto; padding:0 24px 60px;
    color:var(--sub); font-size:13px; }}
  #bar {{ position:sticky; bottom:0; background:rgba(246,245,242,.94);
    backdrop-filter:blur(6px); border-top:1px solid var(--line); }}
  #bar div {{ max-width:920px; margin:0 auto; padding:10px 24px; font-size:14px; }}
  #bar b {{ color:var(--accent); }}
</style>
</head>
<body>
<header>
  <h1>《麻麻大消除》— BGM 候选试听</h1>
  <p class="lead">5 段均为<b>程序化合成的纯音乐</b>（零素材依赖、无版权风险），
     可<b>无缝循环</b>。参考对象是《抓大鹅》的「轻快电子旋律 · 欢快治愈」。
     点开听，选一段告诉我编号即可。</p>
</header>
<main>{"".join(cards)}</main>
<footer>
  <p>合成脚本 <code>game-4-mahjong/tools/make-bgm.py</code>；
     所有参数（速度 / 调式 / 配器 / 循环长度）都在这一个文件里，拍板后想微调改数字重跑即可。</p>
  <p>注意：这几段是<b>拍板用的合成 demo</b>，不是最终混音成品 —— 选定后我会再做一遍总线处理、
     并把音量按「人声 &gt; 消除音效 &gt; BGM」的次序压到合适位置。</p>
</footer>
<div id="bar"><div>当前选择：<b id="sel">还没选</b></div></div>
<script>
  document.querySelectorAll('.pick').forEach(function (b) {{
    b.addEventListener('click', function () {{
      document.querySelectorAll('.pick').forEach(function (o) {{ o.classList.remove('on'); }});
      b.classList.add('on');
      document.getElementById('sel').textContent = b.closest('.card').querySelector('h2').textContent
        + '（编号 ' + b.dataset.id + '）';
    }});
  }});
</script>
</body>
</html>
'''
    with open(out_path, 'w', encoding='utf-8') as f:
        f.write(html)


if __name__ == '__main__':
    sys.exit(main())
