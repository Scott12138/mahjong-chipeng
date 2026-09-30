/**
 * 探针：开个无头 Chrome，把页面加载期间的控制台输出与未捕获异常全部打出来。
 * 用途：冒烟脚本在"canvas 都还没建出来"时就会失败退出，
 *      那种情况下最需要看到的恰恰是被它吞掉的报错。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2];
const CHROME = process.argv[3] || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333 + Math.floor(Math.random() * 200);

const profile = mkdtempSync(join(tmpdir(), 'probe-'));
const chrome = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // ⚠️ 千万不要加 --disable-gpu：那会让 WebGL 直接不可用，
    //    页面报「This device does not support WebGL」，看起来像代码崩了。
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=720,1280',
    'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findWs() {
    for (let i = 0; i < 40; i++) {
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            const page = list.find((t) => t.type === 'page');
            if (page && page.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
        } catch { /* 还没起来 */ }
        await sleep(250);
    }
    throw new Error('Chrome 调试端口没起来');
}

let msgId = 0;
const pending = new Map();

function send(ws, method, params = {}) {
    const id = ++msgId;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
        const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, 20000);
        pending.set(id, { res, rej, timer });
    });
}

const logs = [];

try {
    const wsUrl = await findWs();
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            const { res, timer } = pending.get(m.id);
            clearTimeout(timer);
            pending.delete(m.id);
            if (m.error) logs.push(`[CDP-ERROR] ${JSON.stringify(m.error)}`);
            res(m.result);
            return;
        }
        if (m.method === 'Runtime.consoleAPICalled') {
            const text = (m.params.args || [])
                .map((a) => a.value ?? a.description ?? (a.preview ? JSON.stringify(a.preview) : a.type))
                .join(' ');
            logs.push(`[${m.params.type}] ${text}`);
        }
        if (m.method === 'Runtime.exceptionThrown') {
            const d = m.params.exceptionDetails;
            const desc = d.exception?.description || d.text;
            logs.push(`[EXCEPTION] ${desc}`);
        }
        if (m.method === 'Log.entryAdded') {
            const e = m.params.entry;
            logs.push(`[log:${e.level}] ${e.text}`);
        }
    };

    await send(ws, 'Runtime.enable');
    await send(ws, 'Log.enable');
    await send(ws, 'Page.enable');
    await send(ws, 'Emulation.setDeviceMetricsOverride', {
        width: 720, height: 1280, deviceScaleFactor: 1, mobile: false,
    });
    const nav = await send(ws, 'Page.navigate', { url: URL_ });
    console.log('navigate 返回：', JSON.stringify(nav));
    await sleep(Number(process.argv[4] || 12000));

    const info = await send(ws, 'Runtime.evaluate', {
        expression: 'JSON.stringify({href: location.href, title: document.title, '
            + 'bodyLen: document.body ? document.body.innerHTML.length : -1, '
            + 'scripts: document.scripts.length, '
            + 'canvas: document.querySelector("canvas") ? document.querySelector("canvas").width + "x" + document.querySelector("canvas").height : null})',
        returnByValue: true,
    });
    console.log('页面状态：', info.result?.value);

    console.log('\n===== 控制台 / 异常（共 ' + logs.length + ' 条）=====');
    for (const l of logs) console.log(l);
    ws.close();
} catch (e) {
    console.error('探针失败：', e.message);
    console.log('\n===== 已捕获日志 =====');
    for (const l of logs) console.log(l);
} finally {
    chrome.kill('SIGKILL');
}
