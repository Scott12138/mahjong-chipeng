#!/usr/bin/env node
/**
 * S12.1 demo 验收：
 *   ① 8 段内嵌音频是否都能解码（裸 PCM 会静默 onerror，必须逐条验 duration）
 *   ② 三档手感的「点击 → 牌开始移动」实测延迟 + 连点丢不丢
 * （CDP 直连，零依赖；headless 要加 --no-sandbox，否则渲染进程起来就崩）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9345;
const URL_ = process.argv[2];

const proc = spawn(CHROME, [
    `--remote-debugging-port=${PORT}`, '--headless=new', '--no-sandbox',
    '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1280,900',
    '--autoplay-policy=no-user-gesture-required', URL_,
], { stdio: 'ignore' });

let ws, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
});

let fail = 0;
try {
    let target = null;
    for (let i = 0; i < 40 && !target; i++) {
        await sleep(250);
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
        } catch { /* 还没起来 */ }
    }
    if (!target) throw new Error('拿不到 CDP target');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pending.has(m.id)) {
            const { res, rej } = pending.get(m.id); pending.delete(m.id);
            m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
        }
    };
    await send('Runtime.enable');
    await sleep(1500);

    const evalJs = async (expr) => {
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
        return r.result.value;
    };

    // ---------------- ① 音频解码 ----------------
    console.log('===== ① 内嵌音频解码自检 =====');
    const audio = await evalJs(`(async () => {
        const keys = Object.keys(AUDIO);
        const out = [];
        for (const k of keys) {
            const a = new Audio('data:audio/wav;base64,' + AUDIO[k].b64);
            const r = await new Promise(res => {
                a.addEventListener('loadedmetadata', () => res('ok'));
                a.addEventListener('error', () => res('ERR'));
                setTimeout(() => res('TIMEOUT'), 3000);
            });
            out.push({ k, r, dur: +a.duration.toFixed(3), want: AUDIO[k].dur, name: AUDIO[k].name });
        }
        return out;
    })()`);
    for (const a of audio) {
        const bad = a.r !== 'ok' || Math.abs(a.dur - a.want) > 0.02;
        if (bad) fail++;
        console.log(`  ${bad ? '❌' : '✅'} ${a.k.padEnd(9)} ${a.name.padEnd(14)} ${a.r}  duration=${a.dur}s（表里 ${a.want}s）`);
    }

    // ---------------- ② 三档手感 ----------------
    console.log('\n===== ② 点牌入槽：三档实测 =====');
    const read = () => evalJs(`JSON.stringify({
        placed:+document.getElementById('sPlaced').textContent,
        drop:+document.getElementById('sDrop').textContent,
        queue:+document.getElementById('sQueue').textContent,
        lat: FEEL.lat, mode: FEEL.mode })`).then(JSON.parse);

    const burst = async (gapMs, n = 6) => {
        for (let i = 0; i < n; i++) {
            await evalJs(`document.querySelectorAll('#pile .ftile:not(.dead)')[0]?.click()`);
            await sleep(gapMs);
        }
    };

    const res = {};
    for (const [btn, label] of [['mLock', '现状：单张锁'], ['mQueue', 'B 档：飞行队列'], ['mNew', 'B+ 新版：跟手']]) {
        await evalJs(`document.getElementById('${btn}').click()`);
        await sleep(250);
        // 单点一次，量「点击 → 牌开始移动」的真实延迟
        await evalJs(`document.querySelector('#pile .ftile:not(.dead)').click()`);
        await sleep(700);
        const one = await read();
        // 再快连点 6 次，看丢不丢
        await evalJs(`document.getElementById('fReset').click()`);
        await sleep(250);
        await burst(60);
        await sleep(2000);
        const many = await read();
        res[btn] = { one, many };
        console.log(`  ${label}`);
        console.log(`     点击 → 牌开始移动：${one.lat === null ? '—' : one.lat + ' ms'}`);
        console.log(`     60ms 连点 6 次：已落位 ${many.placed} ｜ 被丢弃 ${many.drop} ｜ 入队 ${many.queue}`);
    }

    // ---------------- 判定 ----------------
    console.log('\n===== 判定 =====');
    const checks = [
        ['音频 8 段全部可解码', audio.length === 8 && audio.every(a => a.r === 'ok')],
        ['新版延迟显著低于现状', res.mNew.one.lat !== null && res.mLock.one.lat !== null
                                 && res.mNew.one.lat < res.mLock.one.lat / 2],
        ['现状档确实丢点击', res.mLock.many.drop > 0],
        ['新版档一次不丢', res.mNew.many.drop === 0 && res.mNew.many.placed >= 6],
    ];
    for (const [name, ok] of checks) {
        if (!ok) fail++;
        console.log(`  ${ok ? '✅' : '❌'} ${name}`);
    }
    console.log(fail ? `\n❌ 有 ${fail} 项未通过` : '\n✅ 全部通过');
    process.exit(fail ? 1 : 0);
} catch (e) {
    console.error('测试失败：', e.message);
    process.exit(2);
} finally {
    try { ws && ws.close(); } catch { /* ignore */ }
    proc.kill('SIGKILL');
}
