#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 make-voice.py · 「吃 / 碰」四川话人声候选生成 + 声学自检
============================================================
 【为什么要有这个脚本】
 S12 用户口径：「吃和碰的音效，使用四川话来说这两个字，不需要咀嚼或者碰撞的声音」。
 也就是说这两个音效 = **人声**，不是合成音效（和 make-sfx.py 那 13 段是两回事）。

 【为什么不能直接"下一个四川话 TTS"】2026-10-01 逐条验证过：
   ① macOS `say`      —— 中文只有普通话/粤语/台语，**无四川话**；
   ② edge-tts 免费端点 —— 音色表里**有** `zh-CN-sichuan-YunxiNeural`
      /`zh-CN-XiaoxiaoDialectsNeural`，但端点**不提供**它们（NoAudioReceived）；
   ③ Azure 官方       —— 确实有 `zh-CN-sichuan-YunxiNeural`，但要付费密钥；
   ④ TTSMaker 公共测试 Token —— 唯一四川话音色是「香莲-四川女声」(id=1200)，
      但公共 Token 配额已用尽（50090/50000，22 天后重置）；
   ⑤ sherpa-onnx      —— 有四川话模型，但那是 **ASR（识别）**，不是 TTS；
   ⑥ CosyVoice 本地   —— Apache-2.0、支持四川话，但要 Python3.10 + torch + 2GB 权重。

 所以本脚本走的是**第 ⑦ 条兜底路**（仅用于"出 demo 让用户拍板"）：
   **拿真人 TTS 的干声当素材，把声调重写成四川话的调值。**
   四川话（成都话）调值：**阴平44 / 阳平21 / 上声53 / 去声213**（五度制）。
     · 「吃」（中古入声，成渝片归阳平）→ **21**，低降
     · 「碰」（中古滂母去声）           → **213**，降升
   段音（声母韵母）选用普通话里的同音近音字来借：
     · 「吃」四川读 [tsʰɿ] —— 与普通话**「次」cì / 「瓷」cí 完全同段音**，只差声调 ⭐
     · 「碰」四川读 [pʰoŋ] —— 普通话没有 p+ong 这个音节，
       只能借**「捧」pěng**（/pʰɤŋ/，段音差在韵母 ɤ→o），声调形状 214≈213 ✅

 【本脚本做的事】
   ① 用 edge-tts 按 **音高网格**批量合成候选干声；
   ② 用 numpy 自写自相关基频跟踪，量出每个候选的 **F0 轮廓**；
   ③ 与目标调值轮廓做**半音域 RMSE** 打分，自动排序；
   ④ 输出 top-N 候选的 wav + 一份可核对的报告。

 ⚠️ **本脚本产出的音只用于"方案预览 demo"**。它依赖 edge-tts（微软消费级端点），
    该端点**不适用于商业产品**；正式入库前必须换成：真人录制 / TTSMaker 香莲 / Azure 密钥
    三者之一（音效 id 不变，换文件即可，代码零改动）。见 docs/ 里的音源决策卡。

 用法：
     python3 tools/make-voice.py             # 生成候选并评分
     python3 tools/make-voice.py --report    # 只重打印上一次的报告
============================================================
"""

import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import wave

import numpy as np

# ------------------------------------------------------------
#  常量
# ------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
WORK = '/tmp/s12-voice'
OUT = os.path.join(WORK, 'out')
EDGE_TTS = '/Users/consli/.workbuddy/binaries/python/envs/default/bin/edge-tts'

# 五度制 → 半音。相邻两级 ≈ 3 半音（一个五度系统总跨度约 12 半音）。
# 目标轮廓写成"相对本音平均音高的半音偏移"。
ST_PER_LEVEL = 3.0
LEVEL_REF = 3.0          # 以"中"（第 3 级）为参考点

# 目标调值（相对平均音高的半音轮廓，首 → 尾）
TARGETS = {
    # 四川话「吃」= 阳平 21：低降。以平均为 0 计，起 +1.5 → 终 -2.5
    'chi': dict(tone='21', contour=[+1.5, -2.5]),
    # 四川话「碰」= 去声 213：降升。起 +1.0 → 中 -1.5 → 终 +3.0
    'peng': dict(tone='213', contour=[+1.0, -1.5, +3.0]),
}

# 候选源（普通话借音字）+ 两种改造手段：
#   · pitch    —— 交给 TTS 做"整体音高平移"（只改音高，音色/时长/共振峰都不动）
#   · resample —— 本地重采样。**这是本脚本最关键的一招**：
#       重采样会同时缩放"音高"和"共振峰"，而「碰」需要的正是**韵母替换** ——
#       普通话 /ɤ/（F1≈500 F2≈1000）整体 ×0.82 →（410, 820）≈ 四川话的 /o/ ✅
#       而「捧」pěng 是**上声 214**，形状（降升）本来就与四川去声 213 同族 ✅
#       两个需求（韵母对 + 声调形状对）恰好被同一个操作一起满足。
#       ⚠️ 代价：时长 ×(1/0.82)=1.22，0.24s → 0.29s，对短音效可忽略。
CANDIDATES = {
    'chi': dict(srcs=['次', '瓷'], pitches=[0, -20, -40, -60], resamples=[1.0]),
    'peng': dict(srcs=['捧', '碰'], pitches=[0], resamples=[1.0, 0.86, 0.82, 0.78]),
}
VOICES = ['zh-CN-YunxiaNeural', 'zh-CN-YunxiNeural']


def vshort(voice):
    """zh-CN-YunxiaNeural → Yunxia（用于文件名；不能再拿 split('-')[1]，那是 'CN'）"""
    return voice.split('-')[-1].replace('Neural', '')


def resample(x, ratio):
    """线性插值重采样。ratio<1 = 降采样 → 音高与共振峰同时下降、时长变长。"""
    n_out = max(2, int(len(x) / ratio))
    return np.interp(np.arange(n_out) * ratio, np.arange(len(x)), x,
                     left=0.0, right=0.0)


# ============================================================
#  一、基频跟踪（自相关法，零依赖）
# ============================================================
def read_wav_mono(path, target_sr=None):
    """读 16bit PCM wav → float32 [-1,1] 单声道。target_sr 给了用 afconvert 先转。"""
    if target_sr is not None:
        tmp = path + f'.{target_sr}.wav'
        subprocess.run(['/usr/bin/afconvert', '-f', 'WAVE', '-d', f'LEI16@{target_sr}', '-c', '1',
                        path, tmp], check=True, capture_output=True)
        path = tmp
    with wave.open(path, 'rb') as w:
        n, sr, ch, sw = w.getnframes(), w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(n)
    assert sw == 2, '只支持 16bit'
    x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def track_f0(x, sr, hop_ms=5.0, win_ms=40.0, fmin=70.0, fmax=420.0, voiced_th=0.30):
    """自相关基频跟踪。返回 (f0[Hz], rms, voiced[bool])，逐 hop 一帧。"""
    win = int(sr * win_ms / 1000)
    hop = int(sr * hop_ms / 1000)
    if win % 2:
        win += 1
    if len(x) < win:
        x = np.pad(x, (0, win - len(x)))
    n = 1 + (len(x) - win) // hop
    lag_min, lag_max = max(2, int(sr / fmax)), int(sr / fmin)
    f0 = np.zeros(n, dtype=np.float64)
    rms = np.zeros(n, dtype=np.float64)
    voiced = np.zeros(n, dtype=bool)
    nfft = 1
    while nfft < 2 * win:
        nfft <<= 1
    for i in range(n):
        seg = x[i * hop: i * hop + win].astype(np.float64)
        rms[i] = math.sqrt(float(np.mean(seg * seg)))
        seg = seg - seg.mean()
        if rms[i] < 1e-5:
            continue
        S = np.fft.rfft(seg, nfft)
        ac = np.fft.irfft(S * np.conj(S), nfft)[:lag_max + 2]
        if ac[0] <= 1e-12:
            continue
        ac = ac / ac[0]
        hi = min(lag_max, len(ac) - 2)
        if hi <= lag_min:
            continue
        k = int(np.argmax(ac[lag_min:hi])) + lag_min
        if k < 1 or k >= len(ac) - 1:
            continue
        a, b, c = ac[k - 1], ac[k], ac[k + 1]
        den = a - 2 * b + c
        kk = k + (0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0)
        peak = float(np.interp(kk, np.arange(len(ac)), ac))
        if peak >= voiced_th and kk > 0:
            f0[i] = sr / kk
            voiced[i] = True
    return f0, rms, voiced


def contour_of(x, sr, n_points=3, rms_th=0.18):
    """
    取"有效发声段"的 F0 轮廓，重采样成 n_points 个点。
    返回 (轮廓[半音，相对平均], 平均 Hz, 有效帧数)

    【rms_th 能量门是 S12.1 加的，不加会得到假数据】
    trim2 把尾部阈值从 6% 放宽到 1.2% 之后，末尾那段**衰减中的轻声**也被算进来了。
    而轻声段的基频跟踪极不可靠（自相关的峰值会掉到噪声里，动辄八度出错），
    结果是「加长后调值 RMSE 从 1.38 涨到 6~22」——**看着像音效变差了，
    其实只是量到了一段本来就量不准的地方**。
    这里只保留能量 ≥ 峰值 18% 的帧，轮廓就只反映"真正在发音"的那一段。
    """
    f0, rms, voiced = track_f0(x, sr)
    if rms.max() <= 0:
        return None, 0.0, 0
    ok = voiced & (rms > rms.max() * rms_th)
    if ok.sum() < 4:
        return None, 0.0, 0
    idx = np.where(ok)[0]
    # 去掉头尾各 10% 的过渡帧（起音/收音不稳，会污染轮廓）
    lo = idx[0] + int((idx[-1] - idx[0]) * 0.10)
    hi = idx[-1] - int((idx[-1] - idx[0]) * 0.10)
    sel = np.array([i for i in idx if lo <= i <= hi], dtype=int)
    if len(sel) < 3:
        sel = idx
    f = f0[sel]
    mean_hz = float(np.mean(f))
    st = 12.0 * np.log2(f / mean_hz)          # 转半音
    # 线性重采样到 n_points
    xs = np.linspace(0, len(st) - 1, n_points)
    prof = np.interp(xs, np.arange(len(st)), st)
    return prof, mean_hz, len(sel)


def score(prof, target):
    """轮廓匹配分：半音域 RMSE，越小越像。"""
    if prof is None:
        return 1e9
    t = np.asarray(target, dtype=float)
    return float(np.sqrt(np.mean((prof - t) ** 2)))


def trim(x, sr, th_ratio=0.06, pad_ms=8.0):
    """按包络裁掉首尾静音，并留一点气口。"""
    env = np.abs(x)
    # 5ms 滑窗平滑
    k = max(1, int(sr * 0.005))
    env = np.convolve(env, np.ones(k) / k, mode='same')
    th = env.max() * th_ratio
    idx = np.where(env > th)[0]
    if len(idx) == 0:
        return x
    a = max(0, idx[0] - int(sr * pad_ms / 1000))
    b = min(len(x), idx[-1] + int(sr * pad_ms / 1000))
    return x[a:b]


def norm(x, peak=0.72):
    m = float(np.max(np.abs(x))) or 1.0
    return x * (peak / m)


def estimate_formants(x, sr, smooth_hz=150.0, lo=200.0, hi=3000.0):
    """
    粗略估计前两个共振峰（F1 / F2）。

    做法：取信号中部 50% 做一次长窗 FFT → 对 log 幅度谱做 150Hz 的移动平均，
    得到"声道包络"（谱包络 = 共振峰的痕迹；移动平均比倒谱 lifter 少一个维度陷阱，
    对这里的用途完全等价）→ 在 200~3000Hz 找局部极大。

    ⚠️ 它是**量级校验**用的，只回答一个问题：「碰」的某个 resample 档有没有把
       韵母从 /ɤ/ 搬到 /o/（F2 从 ~1000Hz 降到 ~800Hz）。不要拿它当精密数据。
    """
    n = len(x)
    a, b = int(n * 0.25), int(n * 0.75)
    seg = x[a:b].astype(np.float64)
    if len(seg) < 64:
        return 0.0, 0.0
    seg = seg * np.hanning(len(seg))
    nfft = 1
    while nfft < 4 * len(seg):
        nfft <<= 1
    freqs = np.fft.rfftfreq(nfft, 1.0 / sr)
    logS = np.log(np.abs(np.fft.rfft(seg, nfft)) + 1e-9)
    bw = max(3, int(smooth_hz / (sr / nfft)))
    envl = np.convolve(logS, np.ones(bw) / bw, mode='same')

    fi = np.where((freqs > lo) & (freqs < hi))[0]
    if len(fi) < 10:
        return 0.0, 0.0
    e, fr = envl[fi], freqs[fi]
    peaks = [(e[j], fr[j]) for j in range(1, len(e) - 1)
             if e[j] > e[j - 1] and e[j] >= e[j + 1]]
    if len(peaks) < 2:
        return 0.0, 0.0
    peaks.sort(reverse=True)                    # 按能量取最强的几个
    top = sorted(p[1] for p in peaks[:4])       # 再按频率排，低的两个就是 F1/F2
    return float(top[0]), float(top[1])


def write_wav(path, x, sr):
    y = np.clip(x, -1.0, 1.0)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((y * 32767.0).astype('<i2').tobytes())


# ============================================================
#  二、"魔性"后处理（全是时域运算，无相位风险）
# ============================================================
def detune_chorus(x, sr, cents=18.0, delay_ms=11.0, mix=0.30):
    """
    失谐合唱：把信号按 ±cents 重采样成两个副本再延迟叠加。
    效果 = 音高轻微摇晃 + 变厚 —— 这是"魔性"里最安全的一味料
    （它不会改变音素，只是让音色"毛"一点）。
    """
    ratio = 2 ** (cents / 1200.0)
    n_out = len(x)
    idx = np.arange(n_out) / ratio
    a = np.interp(idx, np.arange(len(x)), x, left=0, right=0)
    d = int(sr * delay_ms / 1000)
    y = x.copy()
    if n_out > d:
        y[d:] += a[:len(y) - d] * mix
    return y * (len(x) / max(1, len(y)))


def soft_clip(x, drive=1.8):
    """tanh 软削波：把"魔性"里那点粗糙感做出来，同时不会像硬削波那样爆。"""
    return np.tanh(x * drive) / math.tanh(drive)


def pitch_up(x, ratio=1.06):
    """整体音高上调（时长会缩短 ratio 倍，对 0.3s 的短音可忽略）。"""
    n_out = int(len(x) / ratio)
    return np.interp(np.arange(n_out) * ratio, np.arange(len(x)), x)


def magify(x, sr):
    """「魔性」档：升调 → 失谐 → 软削波 → 归一。"""
    y = pitch_up(x, 1.06)
    y = detune_chorus(y, sr, cents=22.0, delay_ms=12.0, mix=0.34)
    y = soft_clip(y, 1.7)
    return norm(y)


# ============================================================
#  四、S12.1「加长 + 尾音」（2026-10-01 用户第 2 条）
# ============================================================
#
# 【用户原话】"吃和碰的音效还可以，要延长一点，带点尾音，更像真人"。
#
# 【现状为什么不长 —— 三个原因，每条都有实测量】
#   ① trim() 的**尾部**阈值是 6%。真人收音是**渐弱**的，6% 会把这段当静音切掉：
#      实测「吃」在 6% 阈值下有效段 0.287s，在 1.2% 下是 0.337s ——
#      **白丢了 50ms 的天然衰减**。这是三段里最便宜的一段。
#   ② TTS 念单字**不拖长**（它念的是"次"，不是"次～"）。没有波浪号就没有尾音。
#   ③ 干声**没有空间感**。人对"像不像真人"的判断有一半来自"它在不在一个房间里"，
#      TTS 直出的声音是"贴着耳朵说的"，听起来就假。
#
# 【所以加长分三层，一一对应】
#   ① trim2()     —— 非对称裁剪：头 6% / 尾 1.2%，先把天然衰减留下来
#   ② sustain()   —— 按**周期对齐**重复元音尾，真的把字"拖长"
#   ③ room_tail() —— 合成房间尾音（指数衰减噪声 IR 卷积），补空间感
#   另加 vibrato() 给拖长的那一段一点音高摇曳 —— 真人的长音不是一条直线。
#
# ⚠️ 三层**全在时域**做，且都不碰谐波结构。
#    一旦改用频域改谐波（那才是"变调"的做法），听感会从"真人拖长"
#    变成"机器变调"—— 那正是我们要躲开的东西。


def trim2(x, sr, head_th=0.06, tail_th=0.012, head_pad_ms=8.0, tail_pad_ms=30.0):
    """
    非对称裁剪 —— 这是"尾音能不能留住"的关键一步。

    头的阈值给 6%：TTS 起手那段是**真静音**，必须切干净，否则音效会有前摇。
    尾的阈值只给 1.2%：人声收音是渐弱的，用 6% 会连衰减一起切掉（见上面 ①）。
    尾部再多留 tail_pad_ms 的气口，让衰减有地方落。
    """
    env = np.abs(x)
    k = max(1, int(sr * 0.005))
    env = np.convolve(env, np.ones(k) / k, mode='same')
    mx = float(env.max()) or 1.0

    head_idx = np.where(env > mx * head_th)[0]
    if len(head_idx) == 0:
        return x
    a = max(0, head_idx[0] - int(sr * head_pad_ms / 1000))

    # 尾部用低阈值，但必须**晚于**头部起点（否则整段静音会判成"有内容"）
    tail_idx = np.where(env[a:] > mx * tail_th)[0]
    b = len(x) if len(tail_idx) == 0 else min(
        len(x), a + tail_idx[-1] + int(sr * tail_pad_ms / 1000))
    return x[a:b]


def _acf_at(x, sr, at, win_ms=30.0, lo=70.0, hi=420.0):
    """
    在 at 处取一个短窗做自相关 → (周期性 r, 周期样本数)。

    ⚠️ **窗长必须自适应音高**：自相关要可靠，窗里至少得装下 3 个基音周期。
    固定 30ms 对女声（F0≈280Hz，周期 3.6ms）够装 8 个，
    但对低音男声（F0≈74Hz，周期 13.4ms）只装得下 2.2 个 ——
    峰值出不来，r 会假性偏低，于是"找不到稳态段"。
    实测：修之前 云希(低音) 两个候选都返回 r=0（判定为"没有稳态段"），
    修之后正常找到锚点。
    """
    n = len(x)
    # 先用 30ms 估一个粗略周期，再据此把窗放宽到 ≈4.5 个周期
    period0 = 0
    w0 = max(64, int(sr * win_ms / 1000.0))
    if n > w0:
        _, period0 = _acf_window(x[max(0, min(n - w0, at - w0 // 2)):][:w0], sr, lo, hi)
    w = max(w0, int(period0 * 4.5)) if period0 else w0
    w = min(w, n)
    a = max(0, min(n - w, at - w // 2))
    seg = x[a:a + w].astype(np.float64)
    if len(seg) < 64:
        return 0.0, 0
    seg = seg - seg.mean()
    nfft = 1 << (2 * len(seg)).bit_length()
    S = np.fft.rfft(seg, nfft)
    ac = np.fft.irfft(S * np.conj(S), nfft)[:int(sr / lo) + 2]
    if ac[0] <= 1e-12:
        return 0.0, 0
    ac = ac / ac[0]
    lmin, lmax = max(2, int(sr / hi)), min(len(ac) - 1, int(sr / lo))
    if lmax <= lmin:
        return 0.0, 0
    k = int(np.argmax(ac[lmin:lmax])) + lmin
    return float(ac[k]), int(k)


def _acf_window(seg, sr, lo, hi):
    """对给定的一段做自相关 → (r, 周期样本数)。上面那个函数的裸内核。"""
    if len(seg) < 64:
        return 0.0, 0
    s = seg.astype(np.float64)
    s = s - s.mean()
    nfft = 1 << (2 * len(s)).bit_length()
    S = np.fft.rfft(s, nfft)
    ac = np.fft.irfft(S * np.conj(S), nfft)[:int(sr / lo) + 2]
    if ac[0] <= 1e-12:
        return 0.0, 0
    ac = ac / ac[0]
    lmin, lmax = max(2, int(sr / hi)), min(len(ac) - 1, int(sr / lo))
    if lmax <= lmin:
        return 0.0, 0
    k = int(np.argmax(ac[lmin:lmax])) + lmin
    return float(ac[k]), int(k)


def steady_tail(x, sr, loud_ratio=0.25, r_min=0.70, lo=70.0, hi=420.0):
    """
    找**最后一个"还是稳态元音"的位置**，返回 (锚点样本号, 周期样本数, 周期性 r)。

    【为什么不能只看能量（第一版的错，现象极具迷惑性）】
    第一版取"包络 > 25% 峰值"的最后一个点当锚点。实测那个位置的自相关只有
    **0.48 ~ 0.64** —— 它已经滑进"字音正在消失"的衰减区，那里本来就不周期。
    拿它去重复 = 把一段非周期的东西复读，听感是**机器嗡声**而不是"字拖长了"。
    而时长、包络、电平全都正常，只有把 ACF 算出来才看得见。

    实测（吃·香妹）每 30ms 一格的周期性：
        0.17s r=0.89 ｜ 0.20s r=0.80 ｜ 0.23s r=0.73 ｜ 0.26s r=0.54 ｜ 0.29s r=0.27
    → 真正还能用到的位置比"能量还在"的位置**早约 50ms**。所以判据必须是两条同时满足。
    """
    n = len(x)
    if n < 64:
        return -1, 0, 0.0
    k = max(1, int(sr * 0.005))
    env = np.convolve(np.abs(x), np.ones(k) / k, mode='same')
    pk = float(env.max())
    if pk <= 1e-9:
        return -1, 0, 0.0

    # 从末尾往前每 10ms 一格地扫，取**最后一个**同时满足两条判据的位置
    step = max(1, int(sr * 0.010))
    best = (-1, 0, 0.0)
    for at in range(n - 1, step, -step):
        if env[at] < pk * loud_ratio:
            continue
        r, period = _acf_at(x, sr, at, lo=lo, hi=hi)
        if r >= r_min and period > 0:
            best = (at, period, r)
            break
    return best


def sustain(x, sr, extra_ms=260.0, hold=0.35, floor=0.20):
    """
    把元音的尾巴按**周期对齐**延长 extra_ms 毫秒。

    【为什么是"重复一个周期"而不是"拉伸时间轴"】
    稳态元音是准周期的：把一个完整周期原地重复，接缝处的相位天然连续，
    既不"啵"一声，也不改变音高 —— 听感就是"这个字被拖长了"。
    若改用 time-stretch（OLA 或相位声码器都算），低音区容易出"颤"或"机器人味"，
    而这两个字只有 0.3 秒左右，不值得为它冒这个险。

    【从**哪里**起重复】见 steady_tail：必须是"最后一个还属于稳态元音的位置"，
    光看能量不够（那会滑进衰减区，复读出来是嗡声）。
    锚点之后原本那段自然衰减**整段丢弃** —— 它的作用已经被"拖长 + 衰减"取代，
    留着只会变成一个小声的尾巴接在大声的拖长后面。

    【包络为什么是"先持平、再衰减、但**不衰减到 0**"】
    一路收到 0 的版本实测尾部出现 -70 ~ -96 dBFS 的真静音：
    听感是"字说完了，过一会儿还有点混响"，中间**断**了。人声收音不会这样。
    收到 floor(0.20 ≈ -14dB) 就停手，交给 room_tail 接住继续往下掉。
    """
    n = len(x)
    if n < 64:
        return x
    anchor, period, _ = steady_tail(x, sr)
    if anchor < 0 or period <= 0 or anchor < period:
        return x

    # 锚点吸附到最近的声门脉冲峰值（±半个周期内找 |x| 最大处）→ 相位对齐
    lo = max(period, anchor - period // 2)
    hi = min(n - 1, anchor + period // 2)
    at = int(lo + np.argmax(np.abs(x[lo:hi + 1]))) if hi > lo else anchor

    one = x[at - period:at].copy()
    reps = max(1, int(sr * extra_ms / 1000.0) // period)
    rep = np.tile(one, reps)

    u = np.arange(len(rep)) / float(len(rep))
    rel = np.clip((u - hold) / (1.0 - hold), 0.0, 1.0)
    rep = rep * (1.0 - (1.0 - floor) * rel ** 1.25)

    # 接缝处**不改幅度**：`one` 就是 at 前面那一整个周期，
    # 所以重复段与信号在接缝处的相位、幅度都天然连续。
    # 这里任何"淡入"反而会造出一个原本不存在的音量台阶。
    return np.concatenate([x[:at], rep])


def vibrato(x, sr, cents=10.0, hz=5.0, start=0.55, ramp=0.15):
    """
    给**后段**（start 之后）一点音高摇曳，模拟真人的长音。

    【为什么只给后段】起音阶段（声母与调值起点）是"这个字是什么"的信息，
    在那里加摇曳会把我们好不容易调准的声调轮廓搅浑。
    拖长的那一段加才有意义 —— 那是"气息在延续"的地方。
    """
    n = len(x)
    if n < 16:
        return x
    t = np.arange(n) / sr
    T = n / sr
    depth = np.clip((t / T - start) / max(1e-6, ramp), 0.0, 1.0)
    c = cents * depth * np.sin(2 * np.pi * hz * t)
    ratio = 2.0 ** (c / 1200.0)
    idx = np.cumsum(ratio)
    if idx[-1] <= 0:
        return x
    idx = idx / idx[-1] * (n - 1)          # 归一化 → 总时长不变
    return np.interp(idx, np.arange(n), x)


def room_tail(x, sr, decay_ms=280.0, wet=0.18, damp_ms=1.6, pre_ms=8.0, seed=7):
    """
    合成房间尾音：指数衰减噪声 IR 与信号做 FFT 卷积，再按 wet 混合。

    【为什么要有它】
    人对"像不像真人"的判断有一半来自"它在一个空间里"。TTS 干声是"贴着耳朵说的"，
    补一条 250~300ms 的短尾，耳朵立刻把它归到"一个人在一个房间里说话"。

    【damp_ms 是干什么的 —— 这条决定尾音是"闷下去"还是"嘶下去"】
    真实房间的高频衰减**快于**低频（空气与墙面吸收）。把 IR 做一次 ~1.6ms 的
    移动平均 = 给噪声尾加低通，高频先掉 → 尾音"闷"下去。
    不做这一步就是白噪声尾巴，听着像磁带底噪，比不加还假。

    【pre_ms 预延迟】直接声与第一个反射之间要有一个空档，
    否则混响会和原声糊在一起，听起来像"声音变厚了"而不是"有空间"。
    """
    n_ir = max(16, int(sr * decay_ms / 1000.0))
    T = decay_ms / 1000.0
    rng = np.random.default_rng(seed)
    t = np.arange(n_ir) / sr
    ir = rng.standard_normal(n_ir) * np.exp(-3.5 * t / T)

    k = max(1, int(sr * damp_ms / 1000.0))
    ir = np.convolve(ir, np.ones(k) / k, mode='same')

    npd = max(1, int(sr * pre_ms / 1000.0))
    if npd < n_ir:
        ir[:npd] *= np.linspace(0.0, 1.0, npd)
    e = float(np.sqrt(np.sum(ir * ir)))
    ir = ir / (e if e > 1e-12 else 1.0)

    L = len(x) + n_ir - 1
    nfft = 1 << (L - 1).bit_length()
    wetSig = np.fft.irfft(np.fft.rfft(x, nfft) * np.fft.rfft(ir, nfft), nfft)[:L]

    y = np.zeros(L)
    y[:len(x)] = x
    y += wetSig * wet
    return y


def lengthen(x, sr, extra_ms=260.0, wet=0.18, decay_ms=280.0, vib=True,
             peak=0.80):
    """
    S12.1 加长管线（顺序有讲究，别调）：

        sustain（时域重复，把字拖长）
          → vibrato（只给拖长段加摇曳）
          → room_tail（补空间）
          → 末尾裁剪（切掉混响落尽后的数字静音）
          → norm（归一）

    ⚠️ **尾音必须加在压缩之后**。若先加混响再软削波，
       tanh 会把混响的尾巴一起压平 —— 尾音就不见了，且现象上只表现为
       "加了混响但听不出空间"，完全看不出是顺序问题。
       所以本函数收的是**已经过完 magify 的信号**，这里只做加长。

    ⚠️ **末尾裁剪用的是 -0.4% 阈值，不是常规的 6%**。
       混响尾巴最后那一段在 -60dB 以下，人耳听不见、但会让文件的"时长"
       虚高，用户在编辑器里一看"0.70s"会以为声音有 0.7 秒长 ——
       而实际上 0.55s 之后就是数字静音了。**时长要诚实**。
    """
    y = sustain(x, sr, extra_ms=extra_ms)
    if vib:
        y = vibrato(y, sr, cents=10.0, hz=5.0, start=0.55)
    y = room_tail(y, sr, decay_ms=decay_ms, wet=wet)
    y = trim2(y, sr, head_th=0.03, tail_th=0.004, head_pad_ms=3.0, tail_pad_ms=22.0)
    return norm(y, peak=peak)


# ============================================================
#  三、主流程
# ============================================================
def tts(text, voice, pitch, out_mp3, rate=0):
    """
    @param rate 语速百分比。负数 = 放慢。
        ⚠️ 「放慢」不只是为了变长：TTS 把单字念得越快，听感越像播报，
           放慢 12% 之后它才像"一个人随口念了一个字"——这是"更像真人"的第一层。
    """
    cmd = [EDGE_TTS, '--voice', voice, '--text', text, '--write-media', out_mp3]
    if pitch:
        # ⚠️ 必须写成 --pitch=-40Hz（等号形式）。拆成两个参数时，
        #    '-40Hz' 会被 edge-tts 自己的 argparse 当成一个"选项"而报错，
        #    表现为静默合成失败 —— 第一版就是这么丢掉全部负音高候选的。
        cmd.append(f'--pitch={pitch:+d}Hz')
    if rate:
        cmd.append(f'--rate={rate:+d}%')
    subprocess.run(cmd, capture_output=True, text=True)
    return os.path.exists(out_mp3) and os.path.getsize(out_mp3) > 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--report', action='store_true')
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)
    rows = []

    for word, spec in CANDIDATES.items():
        tgt = TARGETS[word]['contour']
        print(f'\n===== {word}（目标调值 {TARGETS[word]["tone"]}，轮廓 {tgt} 半音）=====')
        for src in spec['srcs']:
            for voice in VOICES:
                for pit in spec['pitches']:
                    raw_mp3 = os.path.join(WORK, f'raw-{word}-{src}-{vshort(voice)}-{pit:+d}.mp3')
                    if not os.path.exists(raw_mp3):
                        if not tts(src, voice, pit, raw_mp3):
                            print(f'  ✗ 合成失败 {src}/{vshort(voice)}/{pit:+d}')
                            continue
                    try:
                        base, sr = read_wav_mono(raw_mp3, target_sr=44100)
                    except Exception as e:
                        print(f'  ✗ 读取失败 {src}/{vshort(voice)}: {e}')
                        continue
                    for rs in spec['resamples']:
                        tag = f'{word}-{src}-{vshort(voice)}-p{pit:+d}-r{int(round(rs * 100))}'
                        x = resample(base, rs) if rs != 1.0 else base.copy()
                        x = norm(trim(x, sr))
                        prof, mean_hz, nv = contour_of(x, sr, len(tgt))
                        sc = score(prof, tgt)
                        f1, f2 = estimate_formants(x, sr)
                        rows.append(dict(word=word, src=src, voice=vshort(voice), pitch=pit,
                                         resample=rs, tag=tag, score=sc, mean_hz=mean_hz, nv=nv,
                                         f1=f1, f2=f2,
                                         contour=(None if prof is None else [round(float(v), 2) for v in prof])))
                        write_wav(os.path.join(OUT, f'{tag}.wav'), x, sr)
        ok = [r for r in rows if r['word'] == word and r['contour']]
        ok.sort(key=lambda r: r['score'])
        print(f'  {"候选":32s} {"形状RMSE":>9s} {"平均F0":>8s} {"F1":>6s} {"F2":>6s}  轮廓')
        for r in ok:
            print(f'  {r["tag"]:32s} {r["score"]:9.2f} {r["mean_hz"]:8.1f} '
                  f'{r["f1"]:6.0f} {r["f2"]:6.0f}  {r["contour"]}')
        if ok:
            print(f'  → 形状最像：{ok[0]["tag"]}（RMSE {ok[0]["score"]:.2f} 半音）')
            print(f'  ⚠️ resample 只改"绝对音高+共振峰"，**不改轮廓形状**（半音差值在整体缩放后不变），')
            print(f'     所以「碰」的 resample 档要按 F2 选：四川话 /o/ 的 F2 目标 ≈ 800Hz。')

    with open(os.path.join(OUT, 'report.json'), 'w') as f:
        json.dump(rows, f, ensure_ascii=False, indent=2)
    print(f'\n候选 wav 与报告已写入 {OUT}')


# ============================================================
#  五、S12.1：把选定候选加长 + 加尾音
# ============================================================
#  【基座是怎么定的】就是 demo 里 chi_a/b、peng_a/b 那四条（用户听过的那版）：
#     · 吃 / 香妹·可爱：借「次」+ 降 20Hz           → chi-次-Yunxia-p-20-r100
#     · 吃 / 云希·低沉：借「次」+ 降 60Hz           → chi-次-Yunxi-p-60-r100
#     · 碰 / 香妹·可爱：借「捧」+ 重采样 0.82        → peng-捧-Yunxia-p+0-r82
#     · 碰 / 云希·低沉：借「捧」+ 重采样 0.82        → peng-捧-Yunxi-p+0-r82
#  加长**不改变**基座（用户已经认可了它们的音色与声调），只做 §四 那三层。
#
#  ⚠️ **必须从"原料"重建，不能拿 out/ 里已入库的那一版再加长。**
#     第一版就是踩了这个坑：out/ 里的 wav 已经被 trim() 用 6% 阈值裁过，
#     天然衰减早就没了，再加长只是在"已经很短的头上硬接一截"，
#     而尾音本身（真正的天然衰减）永远回不来。
#     这里改为：raw（TTS 直出）→ resample → trim2 → 加长。
BASES = {
    'chi': [('次', 'zh-CN-YunxiaNeural', -20, 1.00, '香妹 · 可爱'),
            ('次', 'zh-CN-YunxiNeural', -60, 1.00, '云希 · 低沉')],
    'peng': [('捧', 'zh-CN-YunxiaNeural', 0, 0.82, '香妹 · 可爱'),
             ('捧', 'zh-CN-YunxiNeural', 0, 0.82, '云希 · 低沉')],
}
# 加长量：用户说"延长一点"，不是"拖很长"。
#   吃 0.34s → ≈0.60s（含尾音）；碰 0.35s → ≈0.62s。
#   拆开看：核心 0.34 + 拖长 0.20（衰减到 -16dB）+ 混响尾 0.20 ≈ 0.60s，
#   全程**都有声音**，不是"说完之后跟一段静音"（第一版就是那样，已修）。
#   ⚠️ 上界由**动画**决定，不是由耳朵决定：「吃」整段只有 0.94s，
#      人声再长就会压到下一张牌的消除上，两个"吃"会叠在一起。
EXTRA_MS = {'chi': 240.0, 'peng': 210.0}
TAIL_MS = {'chi': 200.0, 'peng': 200.0}
WET = 0.26          # 混响湿度。0.18 太干（尾音只有 -45dB，等于听不见），0.35 开始发浑


def raw_wav(word, src, voice, pit):
    """TTS 直出的干声（未经任何裁剪）。文件名与 main() 里的约定一致。"""
    return os.path.join(WORK, f'raw-{word}-{src}-{vshort(voice)}-{pit:+d}.mp3.44100.wav')


def period_corr(x, sr, at, period, span=2):
    """
    "用**前一个周期**预测**后一个周期**"的归一化相关系数。

    【为什么这条指标才是关键】
    "重复一个周期"能不能成立，前提是**这段信号在这个位置确实是准周期的**。
    相关系数 ≈ 1 → 前一个周期能很好地预测下一个 → 重复它等价于把字拖长；
    掉到 0.7 以下 → 这里已经不是稳态元音了（可能已经进到辅音、气息或衰减噪声里），
    拿它复读出来的不是"拖长"，是**机器声**。

    【为什么不用"接缝跳变"当指标（第一版的做法，已废弃）】
    接缝跳变量与音高强相关：低音男声每个基音周期本身就有一次大跳变，
    窗口只要宽过半个周期，落进去的"正常跳变"就盖过接缝，
    量出来的数会随音高乱飘（实测同一份代码在 101Hz 与 280Hz 上差 10 倍）。
    换成本指标之后，它与音高无关，且直接回答"该不该在这里重复"。
    """
    period = max(8, int(period))
    a0, a1 = at, at + period * span
    b0, b1 = at - period * span, at
    if a0 < 0 or b1 < 0 or a1 > len(x) or b0 < 0:
        return 0.0
    a = x[a0:a1].astype(np.float64)
    b = x[b0:b1].astype(np.float64)
    if len(a) != len(b) or len(a) < 8:
        return 0.0
    na, nb = np.linalg.norm(a), np.linalg.norm(b)
    if na < 1e-9 or nb < 1e-9:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


def plot_compare(out_png, report, pairs=(('chi_a', '吃 · 香妹可爱'), ('peng_a', '碰 · 香妹可爱')),
                 width=1240, height=830):
    """
    画「加长前 / 加长后」的包络对照图 —— 这是"尾音到底加上没有"的可视证据。

    【为什么需要它】我听不到声音，用户也只能在 demo 里听一次。
    一张包络图能同时说清三件事：① 确实变长了 ② 尾音是**渐弱**的（不是被切一刀）
    ③ 加长的那一段是接着原声走的（没有位置错乱）。
    """
    from PIL import Image, ImageDraw, ImageFont

    def font(sz):
        for p, ix in (('/System/Library/Fonts/PingFang.ttc', 0),
                      ('/System/Library/Fonts/Hiragino Sans GB.ttc', 0),
                      ('/System/Library/Fonts/Supplemental/Songti.ttc', 0)):
            try:
                return ImageFont.truetype(p, sz, index=ix)
            except Exception:
                continue
        return ImageFont.load_default()

    BG, INK, DIM = (242, 234, 218), (40, 36, 32), (150, 142, 130)
    VERM, GOLD = (196, 54, 43), (201, 162, 39)
    img = Image.new('RGB', (width, height), BG)
    d = ImageDraw.Draw(img)

    f_t = font(30)
    f_s = font(19)
    f_m = font(15)
    d.text((34, 24), 'S12.1 「吃 / 碰」音效：加长 + 尾音前后对照', font=f_t, fill=INK)
    d.text((34, 62), '灰 = 现状入库版（0.30s 干声）｜红 = 加长尾音版　'
                     '数据由 tools/make-voice.py --v2 生成，可复现', font=f_m, fill=DIM)

    left, right = 96, width - 46
    top = 130
    rowH = 300
    T_MAX = 1.0                      # 时间轴统一到 0~1.0s，两行可直接比长度

    for r, (key, label) in enumerate(pairs):
        y0 = top + r * rowH
        h = 172
        word = 'chi' if key.startswith('chi') else 'peng'

        v2, sr2 = read_wav_mono(os.path.join(OUT, 'v2', f'{key}.wav'))
        # v1（现入库的那一版）与 v2 同名同人同字，直接就能叠着比
        v1_name = (report.get(key) or {}).get('v1_file', '')
        v1_path = os.path.join(OUT, v1_name) if v1_name else ''
        v1, sr1 = (read_wav_mono(v1_path) if v1_path and os.path.exists(v1_path)
                   else (None, sr2))

        d.text((left, y0 - 34), label, font=f_s, fill=INK)
        mv2 = (report.get(key) or {})
        d.text((left + 130, y0 - 31),
               f'加长 {mv2.get("dur_v1", 0):.2f}s → {mv2.get("dur_v2", 0):.2f}s'
               f'（+{(mv2.get("dur_v2", 0) - mv2.get("dur_v1", 0)) * 1000:.0f}ms）　'
               f'调值 RMSE {mv2.get("score", 0):.2f} 半音　'
               f'周期自相似 {mv2.get("preg", 0):.3f}（≈1 = 这个位置确实是稳态元音）',
               font=f_m, fill=DIM)

        # 坐标轴
        d.line([(left, y0 + h), (right, y0 + h)], fill=DIM, width=1)
        for ts in (0.0, 0.2, 0.4, 0.6, 0.8, 1.0):
            x = left + (right - left) * (ts / T_MAX)
            d.line([(x, y0 + h), (x, y0 + h + 5)], fill=DIM, width=1)
            d.text((x - 12, y0 + h + 8), f'{ts:.1f}', font=f_m, fill=DIM)
        d.text((left - 62, y0 + h + 8), '秒', font=f_m, fill=DIM)

        def envelope(sig, sr_):
            """把整段压成 560 个桶（每桶取绝对值峰值）—— 包络图就该这么画。"""
            if sig is None or len(sig) == 0:
                return None, 0
            step = max(1, len(sig) // 560)
            env = np.array([np.abs(sig[i:i + step]).max()
                            for i in range(0, len(sig) - step, step)])
            if len(env) == 0:
                return None, 0
            return env / (env.max() or 1.0), step

        def xs_of(env, step, sr_):
            return [left + (right - left) * (i * step / sr_ / T_MAX) for i in range(len(env))]

        # v2 画成红柱（填充），v1 画成灰的**顶部轮廓线**叠在上面 ——
        # v1 是 v2 的子集，两条都画成柱子的话灰的会被红的整根盖住，看不出差别。
        e2, s2 = envelope(v2, sr2)
        if e2 is not None:
            for x, v in zip(xs_of(e2, s2, sr2), e2):
                if x > right:
                    break
                d.line([(x, y0 + h - v * h), (x, y0 + h)], fill=VERM, width=2)

        e1, s1 = envelope(v1, sr1)
        if e1 is not None:
            pts = [(x, y0 + h - v * h) for x, v in zip(xs_of(e1, s1, sr1), e1)
                   if x <= right]
            if len(pts) > 1:
                d.line(pts, fill=(90, 84, 76), width=2, joint='curve')

        # 三个阶段的分界线：核心段 / 拖长段 / 混响尾落尽
        core_end = mv2.get('dur_v1', 0.0)
        for t, txt, col in ((core_end, '核心段结束', GOLD),
                            (core_end + EXTRA_MS[word] / 1000.0, '拖长结束', (47, 93, 140)),
                            (mv2.get('dur_v2', 0.0), '尾音落尽', DIM)):
            x = left + (right - left) * (t / T_MAX)
            if x <= right:
                d.line([(x, y0), (x, y0 + h)], fill=col, width=1)
                d.text((x + 4, y0 + 4), txt, font=f_m, fill=col)

    # 图例
    ly = height - 34
    d.line([(34, ly + 8), (66, ly + 8)], fill=(90, 84, 76), width=3)
    d.text((74, ly), '现状入库版（灰轮廓）', font=f_m, fill=(90, 84, 76))
    d.line([(230, ly + 8), (262, ly + 8)], fill=VERM, width=3)
    d.text((270, ly), '加长尾音版（红）', font=f_m, fill=VERM)
    d.text((420, ly), '两条曲线重合处 = 原始字音**一字未改**；红多出来的才是加长与尾音',
           font=f_m, fill=DIM)

    img.save(out_png)
    print(f'  包络对照图已写入 {out_png}')
    return out_png


def build_v2():
    os.makedirs(os.path.join(OUT, 'v2'), exist_ok=True)
    report = {}
    print('\n' + '=' * 72)
    print('  S12.1 加长 + 尾音（用户第 2 条：延长一点、带点尾音、更像真人）')
    print('=' * 72)

    for word, items in BASES.items():
        tgt = TARGETS[word]['contour']
        extra, tail = EXTRA_MS[word], TAIL_MS[word]
        for k, (src, voice, pit, rs, name) in enumerate(items):
            rp = raw_wav(word, src, voice, pit)
            if not os.path.exists(rp):
                print(f'  ✗ 缺原料 {rp}')
                continue
            raw, sr = read_wav_mono(rp)
            base = resample(raw, rs) if rs != 1.0 else raw
            out_key = f'{word}_{"ab"[k]}'

            # ---- v1（现入库的那一版）：老 trim，用来做加长前/后对照 ----
            v1 = norm(trim(base, sr))

            # ---- v2：trim2 → sustain → vibrato → room_tail → 末尾裁剪 ----
            core = trim2(base, sr)
            v2 = lengthen(core, sr, extra_ms=extra, wet=WET, decay_ms=tail)
            # 拼接点 / 周期 = sustain 用的那一组（同一个函数算出来的，保证对得上）
            seam_at, per, r0 = steady_tail(core, sr)
            corr = period_corr(core, sr, max(1, seam_at), per) if per else 0.0
            clip = int(np.sum(np.abs(v2) > 0.995))

            write_wav(os.path.join(OUT, 'v2', f'{out_key}.wav'), v2, sr)

            # ---- 声学复核：加长**不许**破坏辛苦调准的声调 ----
            prof, mean_hz, _ = contour_of(core, sr, len(tgt))
            sc = score(prof, tgt)
            f1, f2 = estimate_formants(core, sr)

            report[out_key] = dict(word=word, name=name, voice=vshort(voice),
                                   v1_file=f'{word}-{src}-{vshort(voice)}'
                                           f'-p{pit:+d}-r{int(round(rs * 100))}.wav',
                                   dur_v1=round(len(v1) / sr, 3),
                                   dur_v2=round(len(v2) / sr, 3),
                                   preg=round(corr, 3), clip=clip,
                                   score=round(sc, 2), mean_hz=round(mean_hz, 1),
                                   f1=round(f1), f2=round(f2))
            flag = '✅' if clip == 0 and corr >= 0.75 else '⚠️ '
            print(f'  {flag} {out_key:7s} {name:10s} '
                  f'{len(v1)/sr:.3f}s → {len(v2)/sr:.3f}s '
                  f'(+{(len(v2)/sr - len(v1)/sr)*1000:.0f}ms)  '
                  f'周期自相似 {corr:.3f}  削波{clip}  调值RMSE {sc:.2f}  F0 {mean_hz:.0f}Hz')

    # ---- 魔性档：在"加长后的可爱版"上做，保证三档的尾音长度一致 ----
    for word, key in (('chi', 'chi_a'), ('peng', 'peng_a')):
        p = os.path.join(OUT, 'v2', f'{key}.wav')
        if not os.path.exists(p):
            continue
        x, sr = read_wav_mono(p)
        y = magify(x, sr)
        mk = f'{word}_m'
        write_wav(os.path.join(OUT, 'v2', f'{mk}.wav'), y, sr)
        report[mk] = dict(word=word, name='香妹 · 魔性档', voice='Yunxia',
                          dur_v1=report[key]['dur_v1'], dur_v2=round(len(y) / sr, 3),
                          preg=0.0, clip=int(np.sum(np.abs(y) > 0.995)),
                          score=0.0, mean_hz=0.0, f1=0, f2=0)
        print(f'  ✅ {mk:7s} 香妹 · 魔性档（在 {key} 的加长版上做升调+失谐+软削波）'
              f' → {len(y)/sr:.3f}s')

    with open(os.path.join(OUT, 'v2', 'report.json'), 'w') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f'\n  v2 音效已写入 {os.path.join(OUT, "v2")}')
    print('  注：调值 RMSE 用**未加长的核心段**评分 —— 拖长段是持平的，')
    print('      把它算进去只会稀释分数，反而看不出加长有没有伤到声调。')
    return report


# ============================================================
#  六、入库：把**选定**的候选压成 m4a，落进游戏资源目录（S12.2）
# ============================================================
#  【为什么"入库"这一步也要写进脚本，而不是手动把 wav 拖进 assets】
#   ① 可复现 —— 音效是可重建的**产物**，不是"一次性素材"。
#      手拖文件等于把"它是怎么来的"从工程里删掉，下次没人能重跑。
#   ② 容器时间戳 —— `afconvert` 会往 m4a 的 mvhd / tkhd / mdhd 里写
#      "编码那一刻"，不清零则每次重跑文件 md5 全变（make-sfx.py 踩过这坑，
#      这里直接**复用它的 zero_container_times**，而不是复制一份实现 ——
#      复制出来的两份迟早分叉）。
#   ③ 参数一致性 —— 44.1kHz / 单声道 / AAC 64kbps 必须与既有 13 段完全一致，
#      否则「吃 / 碰」会比别的音效明显更亮或更闷，
#      而这种不一致**只能靠耳朵发现**（上了真机才发现就晚了）。
#
#  【用户拍板（2026-10-01）】音效选 **香妹 · 可爱**（`*_a`），手感选新版。
#
#  🔴🔴 【2026-10-01 同日更新 · 用完这段就作废】吃 / 碰 的音源**已换成外部**语音库
#       （「ChessCard 棋牌语音库 · 女声」），入库改由 **tools/install-voice-lib.py** 负责。
#       → **不要再对本节跑 --install**：那会把 assets 里的 eat.m4a / peng.m4a
#         覆盖回「香妹」候选，而这两个文件已经不是在库版本了。
#       本节保留价值 = 候选的**生成与声学自检**（--v2 那半段），入库那半段请当历史看。
#
#  用法：python3 tools/make-voice.py --v2 --install
#        ⚠️ --install 仅在对「香妹」候选做 A/B 时临时用；用完记得用
#           python3 tools/install-voice-lib.py 把外部语音库装回去。
CHOSEN = {'chi': 'a', 'peng': 'a'}
GAME_AUDIO = os.path.abspath(os.path.join(HERE, '..', 'assets', 'resources', 'audio'))
#  源 key → 游戏里的音效 id。
#  ⚠️ chi 落盘叫 **eat** 而不是 chi：CFG.AUDIO.GAIN 里早就以 `eat`
#     预留了这条（"「吃」的人声念白"），而且 `chi/peng` 是**玩法牌型**的名字、
#     `eat/peng` 是**音效**的名字 —— 两套命名各管各的，不要混。
INSTALL_AS = {'chi': 'eat', 'peng': 'peng'}
#  退役清单：m4a 与 .meta 一起删。
#  ⚠️ 必须与"代码里不再调用它"**同一个提交**里做。只删文件不改代码，
#     会留下一个永远加载不到文件的 SfxId —— 而加载失败**只 warn 不报错**，
#     于是"怎么没声音"会变成一桩悬案。
#  flow = 旧「吃」的流水汇合音；「吃」改成咀嚼之后它没有调用方了。
RETIRED = ['flow']


def _load_sfx_module():
    """按路径加载 make-sfx.py（文件名带连字符，`import make_sfx` 是语法错误）。"""
    import importlib.util
    p = os.path.join(HERE, 'make-sfx.py')
    spec = importlib.util.spec_from_file_location('make_sfx', p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _stable_uuid(name: str) -> str:
    """
    由资源名派生一个**固定** UUID。

    【为什么不随机生成】.meta 里的 uuid 是资源的身份证。随机生成的话，
    每次重建 assets 都"看起来全新"，就再也判断不出"这次提交动了哪些资源"。
    uuid5（名字哈希）保证同一个资源名永远得到同一个 uuid ——
    与 make-sfx.py 用固定随机种子是同一个道理。
    """
    import uuid
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'game4-mahjong://audio/{name}'))


def _meta_json(name: str) -> str:
    """与既有 13 段的 .meta **逐字段一致**（importer / files / userData 都一样）"""
    return json.dumps({
        'ver': '1.0.0',
        'importer': 'audio-clip',
        'imported': True,
        'uuid': _stable_uuid(name),
        'files': ['.json', '.m4a'],
        'subMetas': {},
        'userData': {'downloadMode': 0},
    }, indent=2) + '\n'


def install_to_game():
    """把 CHOSEN 指到的候选压成 m4a 落进 assets/resources/audio，并执行退役。"""
    if not os.path.isdir(GAME_AUDIO):
        print(f'  ✗ 找不到游戏音频目录：{GAME_AUDIO}')
        return 1
    sfx = _load_sfx_module()
    os.makedirs(os.path.join(WORK, 'install'), exist_ok=True)

    print('\n' + '=' * 72)
    print('  入库：把拍板的候选压成 m4a 落进游戏（S12.2）')
    print('=' * 72)

    total = 0
    for word, pick in CHOSEN.items():
        src = os.path.join(OUT, 'v2', f'{word}_{pick}.wav')
        if not os.path.exists(src):
            print(f'  ✗ 缺源文件 {src}（先跑 --v2）')
            return 1
        sid = INSTALL_AS[word]
        dst = os.path.join(GAME_AUDIO, f'{sid}.m4a')

        # -b 64000：与 make-sfx.py 的 13 段同参数（单声道 64kbps AAC）
        r = subprocess.run(
            ['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '64000', src, dst],
            capture_output=True,
        )
        if r.returncode != 0:
            print(f'  ✗ {sid} 转码失败：{r.stderr.decode()[:120]}')
            return 1
        sfx.zero_container_times(dst)

        # 落盘后立刻复验可解码性 —— "文件在"不等于"能播"。
        # afconvert 参数写错（比如 -d 打错）时它会安静地产出一个坏文件。
        info = subprocess.run(['afinfo', dst], capture_output=True)
        ok = info.returncode == 0 and b'audio' in info.stdout.lower()

        kb = os.path.getsize(dst) / 1024.0
        total += kb

        # .meta：**新资源才写**。覆盖已有资源时绝不重写 ——
        # 重写会把 uuid 换掉，等于在工程里凭空多一个资源、旧的变野指针。
        meta = os.path.join(GAME_AUDIO, f'{sid}.m4a.meta')
        if not os.path.exists(meta):
            with open(meta, 'w') as f:
                f.write(_meta_json(f'{sid}.m4a'))
            verb = f'新建（.meta uuid={_stable_uuid(f"{sid}.m4a")[:8]}…）'
        else:
            verb = '覆盖（保留原 .meta）'
        print(f'  {"✅" if ok else "⚠️ "} {sid}.m4a  {kb:5.1f}K  {verb}'
              f'{"   ← 解码复验失败！" if not ok else ""}')

    for name in RETIRED:
        for suffix in ('.m4a', '.m4a.meta'):
            p = os.path.join(GAME_AUDIO, name + suffix)
            if os.path.exists(p):
                os.remove(p)
                print(f'  🗑 退役 {name}{suffix}')

    print('-' * 72)
    print(f'  入库合计 {total:.1f}K')
    return 0


if __name__ == '__main__':
    ap2 = argparse.ArgumentParser()
    ap2.add_argument('--v2', action='store_true', help='跑 S12.1 加长+尾音')
    ap2.add_argument('--install', action='store_true',
                     help='把拍板的候选压成 m4a 落进游戏（隐含需要 out/v2 已存在）')
    ap2.add_argument('--plot', metavar='PNG', help='出包络对照图（需先跑 --v2）')
    a2 = ap2.parse_args()
    if a2.plot:
        with open(os.path.join(OUT, 'v2', 'report.json')) as f:
            plot_compare(a2.plot, json.load(f))
    elif a2.install:
        # 入库**不重新生成** —— 只消费 out/v2 里已经通过自检的那几条。
        # 重新生成再入库会让"入库的到底是哪一版"变得说不清。
        if not os.path.exists(os.path.join(OUT, 'v2', 'report.json')):
            print('✗ out/v2 不存在或为空，先跑：python3 tools/make-voice.py --v2')
            sys.exit(1)
        sys.exit(install_to_game())
    else:
        rpt = build_v2() if a2.v2 else main()
        plot_compare(os.path.join(OUT, 'v2', 'envelope.png'), rpt)
