#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
============================================================
 build-s12-demo.py · 把「吃/碰」音效打进 S12 预览 demo
============================================================
 【为什么要有这一步】
 demo 要求**单文件、可离线双击打开**，所以音频不能走外链，只能 base64 内嵌。
 音效一变（S12.1 的加长 + 尾音），内嵌的数据就得整体重打 —— 手工替换
 一个 12 万字符的 base64 blob 显然不行，所以固定成"模板 + 注入"两步：

     docs/demo/S12-效果预览.src.html   ← 源文件（含 __AUDIO_JSON__ 占位符）
                   ↓ 本脚本注入音频
     docs/demo/S12-效果预览.html       ← 交付给用户的那一个

 【音频处理】统一降到 22050Hz 单声道再编码。
 人声的共振峰最高到 3kHz 左右，22.05kHz 采样（奈奎斯特 11kHz）绰绰有余；
 而它把体积压掉一半 —— 8 段音效内嵌后 HTML 约 300KB，仍然好传。

 ⚠️ **必须用 wave 模块写出完整的 44 字节 RIFF/WAVE 头。**
    第一版直接把 (samples).tobytes() 当音频塞进 data URI —— 那是裸 PCM，
    浏览器 onerror **静默失败**：页面看着一切正常，就是没有声音。
    是靠 CDP 逐条 new Audio(dataURI) 检查 duration 才发现的。

 用法：
     python3 tools/build-s12-demo.py
============================================================
"""

import base64
import io
import json
import os
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
VOICE_OUT = '/tmp/s12-voice/out'
SRC = os.path.join(ROOT, 'docs/demo/S12-效果预览.src.html')
DST = os.path.join(ROOT, 'docs/demo/S12-效果预览.html')
DEMO_SR = 22050

sys.path.insert(0, HERE)
from importlib import util as _util                              # noqa: E402

_spec = _util.spec_from_file_location('mv', os.path.join(HERE, 'make-voice.py'))
mv = _util.module_from_spec(_spec)
_spec.loader.exec_module(mv)


def to_sr(x, sr, target):
    """线性插值重采样。只用于把成品降到 demo 采样率，不参与任何音色塑造。"""
    n = max(2, int(len(x) * target / sr))
    return np.interp(np.arange(n) * sr / target, np.arange(len(x)), x), target


def encode(x, sr):
    """float [-1,1] → 完整 RIFF/WAVE 字节（⚠️ 见文件头注释）。"""
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype('<i2').tobytes())
    return buf.getvalue()


# 要打进 demo 的 8 段：每个字 1 段旧版（对照）+ 3 段新版（加长尾音）
PICKS = [
    # key        来源                                  说明
    ('chi_old', 'v1', 'chi-次-Yunxia-p-20-r100', '旧版 · 0.30s 干声', 'trim 6% 阈值把天然衰减一起切掉了'),
    ('chi_a', 'v2', 'chi_a', '新版 · 可爱', '拖长 + 房间尾音'),
    ('chi_b', 'v2', 'chi_b', '新版 · 低沉', '云希男声，同上加长'),
    ('chi_m', 'v2', 'chi_m', '新版 · 魔性档', '在加长版上做升调+失谐+软削波'),
    ('peng_old', 'v1', 'peng-捧-Yunxia-p+0-r82', '旧版 · 0.35s 干声', '同上'),
    ('peng_a', 'v2', 'peng_a', '新版 · 可爱', '拖长 + 房间尾音'),
    ('peng_b', 'v2', 'peng_b', '新版 · 低沉', '云希男声，同上加长'),
    ('peng_m', 'v2', 'peng_m', '新版 · 魔性档', '在加长版上做升调+失谐+软削波'),
]


def main():
    audio = {}
    print('打包音效（目标 22050Hz 单声道）：')
    for key, kind, tag, name, how in PICKS:
        if kind == 'v1':
            p = os.path.join(VOICE_OUT, tag + '.wav')
            x, sr = mv.read_wav_mono(p)
            x = mv.norm(mv.trim(x, sr))          # v1 = 老 trim 的成品，保持原样
        else:
            p = os.path.join(VOICE_OUT, 'v2', tag + '.wav')
            x, sr = mv.read_wav_mono(p)
        x, sr = to_sr(x, sr, DEMO_SR)
        x = mv.norm(x, 0.80)
        b64 = base64.b64encode(encode(x, sr)).decode()
        audio[key] = dict(name=name, how=how, dur=round(len(x) / sr, 3), sr=sr, b64=b64)
        print(f'  {key:9s} {name:14s} {len(x) / sr:5.3f}s  {len(b64) // 1024:4d}KB(base64)')

    total = sum(len(v['b64']) for v in audio.values()) // 1024
    print(f'  合计 base64 {total}KB')

    with open(SRC, encoding='utf-8') as f:
        html = f.read()
    if '__AUDIO_JSON__' not in html:
        raise SystemExit(f'✗ 模板里找不到 __AUDIO_JSON__ 占位符：{SRC}')

    # 去掉每段音频末尾的 ? 补位，json 里不需要
    payload = json.dumps(audio, ensure_ascii=False, separators=(',', ':'))
    html = html.replace('__AUDIO_JSON__', payload)

    with open(DST, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'\n已写出 {DST}（{len(html) // 1024}KB）')


if __name__ == '__main__':
    main()
