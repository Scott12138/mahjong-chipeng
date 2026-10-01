#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把「外部棋牌语音库」的 mp3 落进游戏音效目录（macOS 专用，无 ffmpeg 依赖）。

================================================================================
 为什么要单独写一个脚本，而不是手工拖文件
================================================================================
① **电平一致性**（本轮最重要的发现）
   外部语音库的原始电平**远低于**本工程自产的 13 段音效：
       ChessCard 女声 chi 峰值 0.304（−10.3 dBFS）／peng 0.398（−8.0 dBFS）
       本工程既有 11 段      峰值 0.628 ~ 0.749（中位 0.705，约 −3 dBFS）
   差了 **5~7 dB**。不归一化就入库 → 玩的时候「吃/碰」被人声之外的所有音效盖住，
   而这类问题**上真机用耳朵才发现就晚了**（肉眼看波形图也不直观）。
   → 统一归一到 **PEAK_TARGET = 0.70**（与工程中位数齐平）。

② **可复现**
   `afconvert` 会把「编码那一刻」的时间戳写进 m4a 容器的 3 个 box
   （mvhd / tkhd / mdhd）→ 同一段音频重跑两次 md5 都不一样。
   必须调 make-sfx.py 的 `zero_container_times()` 清零，否则「这次提交动了哪些资源」无法判断。

③ **绝不重写 .meta**
   .meta 里的 uuid 是资源的身份证。覆盖已有资源时重写 .meta = 换掉 uuid
   = 在工程里凭空多一个资源、旧的变野指针（Cocos 里表现为"图片/音频莫名为空"）。

================================================================================
 用法
================================================================================
    python3 tools/install-voice-lib.py            # 按下面的 SOURCES 表入库
    python3 tools/install-voice-lib.py --dry      # 只分析、不落盘（先看电平差多少）

 换库时只改 SOURCES / LIB_ROOT 两处，其余不用动。
"""

import importlib.util
import json
import os
import subprocess
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
GAME_AUDIO = os.path.abspath(os.path.join(HERE, '..', 'assets', 'resources', 'audio'))

# 语音候选库根目录（在**另一个工作区**里，是「试听对比」那轮产出的）
LIB_ROOT = '/Users/consli/WorkBuddy/2026-08-14-10-46-17/音频候选/麻将语音候选'

# ★ 用户拍板（2026-10-01）：用「ChessCard 棋牌语音库 · 女声」替换 吃 / 碰。
#   左边 = 游戏里的音效 id（注意「吃」的音效 id 是 `eat` 而不是 `chi`：
#   `chi` 是**玩法牌型**的名字，`eat` 是**音效**的名字，两套命名各管各的）。
SOURCES = {
    'eat':  ('03_ChessCard_女声', 'chi.mp3'),
    'peng': ('03_ChessCard_女声', 'peng.mp3'),
}

# 归一化目标峰值：取工程既有 11 段的中位数 0.705，向下取整到 0.70。
PEAK_TARGET = 0.70
# 头部静音裁剪：超过「峰值 × 该比例」的第一个样点之前的部分视为静音
SILENCE_RATIO = 0.03
HEAD_PAD_MS = 5.0      # 裁完保留一点头，避免起音被切出"咔"声
TAIL_PAD_MS = 20.0


def _load_sfx_module():
    """按路径加载 make-sfx.py（文件名带连字符，`import make_sfx` 是语法错误）。"""
    p = os.path.join(HERE, 'make-sfx.py')
    spec = importlib.util.spec_from_file_location('make_sfx', p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _stable_uuid(name: str) -> str:
    """由资源名派生固定 uuid（与 make-sfx.py 的固定随机种子同理：保证可复现）。"""
    import uuid
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f'game4-mahjong://audio/{name}'))


def _meta_json(name: str) -> str:
    """与既有 13 段的 .meta 逐字段一致。"""
    return json.dumps({
        'ver': '1.0.0',
        'importer': 'audio-clip',          # ★ 必须是 audio-clip，否则构建后不是 AudioClip
        'imported': True,
        'uuid': _stable_uuid(name),
        'files': ['.json', '.m4a'],
        'subMetas': {},
        'userData': {'downloadMode': 0},
    }, indent=2) + '\n'


def decode_mono(path: str, tmp_dir: str) -> tuple:
    """用 afconvert 把任意音频解成 16bit 44.1k 单声道，返回 (float32 数组, 采样率)。"""
    os.makedirs(tmp_dir, exist_ok=True)
    wav = os.path.join(tmp_dir, os.path.basename(path) + '.dec.wav')
    r = subprocess.run(['afconvert', '-f', 'WAVE', '-d', 'LEI16@44100', '-c', '1', path, wav],
                       capture_output=True)
    if r.returncode != 0:
        raise RuntimeError(f'afconvert 解码失败：{r.stderr.decode()[:200]}')
    w = wave.open(wav)
    n, sr = w.getnframes(), w.getframerate()
    x = np.frombuffer(w.readframes(n), dtype=np.int16).astype(np.float32) / 32768.0
    w.close()
    return x, sr


def trim_silence(x: np.ndarray, sr: int) -> np.ndarray:
    """裁掉首尾静音（判据：超过峰值 3% 的第一个/最后一个样点）。"""
    if x.size == 0:
        return x
    th = float(np.abs(x).max()) * SILENCE_RATIO
    idx = np.where(np.abs(x) > th)[0]
    if idx.size == 0:
        return x
    head = max(0, idx[0] - int(sr * HEAD_PAD_MS / 1000.0))
    tail = min(x.size, idx[-1] + 1 + int(sr * TAIL_PAD_MS / 1000.0))
    return x[head:tail]


def normalize(x: np.ndarray, peak: float = PEAK_TARGET) -> np.ndarray:
    """等比缩放到目标峰值。等比缩放**不改变音色**（只改音量），是安全的处理。"""
    m = float(np.abs(x).max())
    if m < 1e-6:
        return x
    return x * (peak / m)


def write_wav16(path: str, x: np.ndarray, sr: int) -> None:
    """★ 必须用 wave 模块写完整 RIFF 头 —— 裸 PCM 少了 44 字节头会**静默失败**
    （文件在、时长看着对，但播放器不出声）。"""
    clip = np.clip(x, -1.0, 1.0)
    pcm = (clip * 32767.0).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def main() -> int:
    dry = '--dry' in sys.argv
    if not os.path.isdir(GAME_AUDIO):
        print(f'✗ 找不到游戏音频目录：{GAME_AUDIO}')
        return 1

    sfx = _load_sfx_module()
    tmp = '/private/tmp/voicelib-install'      # ⚠️ 不要用 /tmp（软链接），afconvert 会挑剔

    print('=' * 76)
    print(f'  入库外部语音库 → {GAME_AUDIO}')
    print(f'  归一化目标峰值 {PEAK_TARGET}（工程既有 11 段中位数 0.705）')
    print('=' * 76)

    for sid, (lib_dir, fname) in SOURCES.items():
        src = os.path.join(LIB_ROOT, lib_dir, fname)
        if not os.path.exists(src):
            print(f'✗ 缺音源：{src}')
            return 1

        x, sr = decode_mono(src, tmp)
        raw_peak = float(np.abs(x).max())
        x = normalize(trim_silence(x, sr))
        new_peak = float(np.abs(x).max())

        wav = os.path.join(tmp, f'{sid}.norm.wav')
        write_wav16(wav, x, sr)

        print(f'\n[{sid}]  ← {lib_dir}/{fname}')
        print(f'    原始：峰值 {raw_peak:.3f}（{20 * np.log10(max(raw_peak, 1e-6)):.1f} dBFS）'
              f'  时长 {len(x) / sr:.4f}s')
        print(f'    归一：峰值 {new_peak:.3f}（{20 * np.log10(max(new_peak, 1e-6)):.1f} dBFS）'
              f'  增益 ×{PEAK_TARGET / max(raw_peak, 1e-6):.2f}'
              f'（{20 * np.log10(PEAK_TARGET / max(raw_peak, 1e-6)):+.1f} dB）')

        if dry:
            print('    （--dry：不落盘）')
            continue

        dst = os.path.join(GAME_AUDIO, f'{sid}.m4a')
        # -c 1 强制单声道；-b 64000 与既有 13 段同参数
        r = subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '64000', '-c', '1', wav, dst],
                           capture_output=True)
        if r.returncode != 0:
            print(f'    ✗ 转码失败：{r.stderr.decode()[:160]}')
            return 1
        sfx.zero_container_times(dst)

        # 落盘后立刻复验 —— "文件在" ≠ "能播"（afconvert 参数错会安静地产出坏文件）
        info = subprocess.run(['afinfo', dst], capture_output=True)
        ok = info.returncode == 0 and b'audio' in info.stdout.lower()
        dur = 0.0
        for line in info.stdout.decode(errors='ignore').splitlines():
            if 'estimated duration' in line:
                try:
                    dur = float(line.split(':')[1].strip().split()[0])
                except Exception:
                    pass

        # .meta：**新资源才写**；覆盖已有资源绝不重写（重写会换 uuid）
        meta = os.path.join(GAME_AUDIO, f'{sid}.m4a.meta')
        if os.path.exists(meta):
            verb = '覆盖（保留原 .meta，uuid 不变）'
        else:
            with open(meta, 'w') as f:
                f.write(_meta_json(f'{sid}.m4a'))
            verb = f'新建 .meta（uuid={_stable_uuid(f"{sid}.m4a")[:8]}…）'

        kb = os.path.getsize(dst) / 1024.0
        print(f'    {"✅" if ok else "⚠️ "} {sid}.m4a  {kb:5.1f}K  {dur:.4f}s  {verb}'
              f'{"   ← 解码复验失败！" if not ok else ""}')

    print('\n' + '=' * 76)
    print('  完成。下一步：bash tools/wechat-preview.sh（出真机试玩码）')
    print('=' * 76)
    return 0


if __name__ == '__main__':
    sys.exit(main())
