#!/usr/bin/env node
/**
 * ============================================================
 *  page-shot.mjs · 把任意页面渲染成 PNG（零依赖 CDP 截图）
 * ============================================================
 *  【用途】
 *  给设计稿 / 静态页面做"自检截图"：出稿后先自己看一眼，再交给别人评审。
 *  和 web-smoke.mjs 是同一套底层（Chrome + CDP），但只做截图、不点击、
 *  不注入任何样式，因此也能用来截 UI 设计稿、对比图、落地页。
 *
 *  【用法】
 *    node tools/page-shot.mjs <url> <输出png> [宽] [高] [--full]
 *  例：
 *    node tools/page-shot.mjs file:///path/to/design.html /tmp/out.png 1300 3200
 *
 *  【⚠️ 本机必踩的坑：Chrome 内嵌沙箱初始化失败】
 *  报错 `sandbox initialization failed: Operation not permitted` →
 *  渲染进程崩溃 → 页面级 CDP 连接"连上就断"，
 *  表现为：WS 已连接 → 立刻关闭 → 所有 CDP 调用永久挂起（看不出是沙箱问题）。
 *  解法：加 `--no-sandbox --disable-dev-shm-usage`。
 * ============================================================
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_BIN
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9335;

const URL_ = process.argv[2];
const OUT = process.argv[3] || '/tmp/page-shot.png';
const W = Number(process.argv[4] || 1300);
const H = Number(process.argv[5] || 1600);

if (!URL_) {
    console.error('用法：node tools/page-shot.mjs <url> <输出png> [宽] [高]');
    process.exit(2);
}

const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--window-size=${W},${H}`,
    '--user-data-dir=/tmp/cocos-cdp-shot',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox',              // 见文件头：本机沙箱初始化失败，必须关
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--hide-scrollbars',
    URL_,
], { stdio: 'ignore' });

const bail = (msg) => { console.error('❌ ' + msg); chrome.kill('SIGKILL'); process.exit(1); };
setTimeout(() => bail('整体超时（40s）'), 40000);

try {
    // ---- 等 CDP 端口就绪 ----
    let target = null;
    for (let i = 0; i < 30; i++) {
        await sleep(400);
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (target) break;
        } catch { /* 端口还没起来 */ }
    }
    if (!target) bail('CDP 端口未就绪');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    });

    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && pending.has(m.id)) {
            const { resolve, reject } = pending.get(m.id);
            pending.delete(m.id);
            m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
        }
    });

    // 用定时器把"静默挂起"变成"可读的报错"
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`CDP 调用超时：${method}`));
        }, 8000);
        pending.set(id, {
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
        width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(1500);   // 等字体与排版稳定

    const { data } = await send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: true,
    });
    writeFileSync(OUT, Buffer.from(data, 'base64'));
    console.log('✅ 已截图：' + OUT);
    chrome.kill('SIGKILL');
    process.exit(0);
} catch (e) {
    bail('截图失败：' + e.message);
}
