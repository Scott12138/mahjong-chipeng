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
 *    node tools/page-shot.mjs <url> <输出png> [宽] [高] [选项]
 *
 *  选项：
 *    --full              显式要求整页（其实**默认就是整页**，此开关为兼容保留）
 *    --el <选择器>       只截某个元素（如 --el ".phone"、"svg[viewBox]"）
 *    --scale <n>         输出倍率，默认 1。配 --el 用 2~3 可以出高清稿
 *
 *  例：
 *    node tools/page-shot.mjs file:///path/to/design.html /tmp/out.png 1300 3200
 *    node tools/page-shot.mjs file:///path/to/mock.html  /tmp/phone.png 1300 900 --el ".phone" --scale 2
 *
 *  【⚠️ 本机必踩的坑 1：Chrome 内嵌沙箱初始化失败】
 *  报错 `sandbox initialization failed: Operation not permitted` →
 *  渲染进程崩溃 → 页面级 CDP 连接"连上就断"，
 *  表现为：WS 已连接 → 立刻关闭 → 所有 CDP 调用永久挂起（看不出是沙箱问题）。
 *  解法：加 `--no-sandbox --disable-dev-shm-usage`。
 *
 *  【⚠️ 本机必踩的坑 2：整页截图在"长页面"上必挂（本文件已修）】
 *  旧版一律用 `captureBeyondViewport: true` 且不给 clip —— 这会让 Chrome 把
 *  视口撑到整页高度再**整体重新光栅化**。页面一旦高过约 **7.8K px**，
 *  这个调用就永久挂起（不是慢，是再也回不来；8s 超时看着像"CDP 超时"）。
 *  实测：7291 / 7692 / 7847px 全部 0.6s 成功，8108px 必挂（S18 三份提案实测）。
 *
 *  修法（两步，都不依赖"超出视口"的那条路径）：
 *    ① 先量出 `documentElement.scrollHeight`；
 *    ② 把**设备指标**直接设成"整页那么大"（W × pageHeight），于是整页
 *       本来就落在视口内 → 之后用 captureBeyondViewport:false 截即可。
 *  这等价于开一个 1300×13000 的窗口，是浏览器的常规路径，不会挂。
 * ============================================================
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = process.env.CHROME_BIN
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9335;

// ---- 参数解析（位置参数 2 个 + 2 个可选数字 + 若干开关）----
const argv = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--el' || a === '--scale') { flags[a.slice(2)] = argv[++i]; }
    else if (a === '--full') { flags.full = true; }
    else positional.push(a);
}

const URL_ = positional[0];
const OUT = positional[1] || '/tmp/page-shot.png';
const W = Number(positional[2] || 1300);
const H = Number(positional[3] || 1600);
/** 视口高度上限：再高就分不出意义了，且显存吃紧 */
const MAX_VIEWPORT_H = 22000;

if (!URL_) {
    console.error('用法：node tools/page-shot.mjs <url> <输出png> [宽] [高] [--el <选择器>] [--scale <n>] [--full]');
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
setTimeout(() => bail('整体超时（180s）'), 180000);

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

    // 用定时器把"静默挂起"变成"可读的报错"。
    // timeoutMs 可按调用指定：截图那条给足时间，其余的短超时快速暴露问题。
    const send = (method, params = {}, timeoutMs = 8000) => new Promise((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`CDP 调用超时：${method}`));
        }, timeoutMs);
        pending.set(id, {
            resolve: (v) => { clearTimeout(timer); resolve(v); },
            reject: (e) => { clearTimeout(timer); reject(e); },
        });
        ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
        width: W, height: H, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(1500);   // 等字体与排版稳定

    // ---- 关键修复：整页高度超过光栅化上限时，改走"分段截图" ----
    // 根因不是"慢"，是**渲染面尺寸上限**：Chrome 一次能光栅化的图面约 8192px，
    // 而旧写法（captureBeyondViewport 且不带 clip）要求把整页做成一张图面
    // → 一旦超过就永久挂起，8s 超时看着像"CDP 超时"，其实永远回不来。
    // 实测阈值（S18 三份提案）：7692 / 7847px 成功，8108px 必挂。
    // 所以：≤ 8000 直接整页截；> 8000 就按 4000px 一段滚动着截，输出 -1/-2/… 多张。
    const SURFACE_MAX = 8000;
    const SLICE_H = 4000;

    /** 量一个选择器的位置（页面坐标，含滚动）；量不到返回 null */
    const measure = async (sel) => {
        const { result } = await send('Runtime.evaluate', {
            returnByValue: true,
            expression: `(() => {
                const e = document.querySelector(${JSON.stringify(sel)});
                if (!e) return null;
                const r = e.getBoundingClientRect();
                return { x: r.x + window.scrollX, y: r.y + window.scrollY, w: r.width, h: r.height };
            })()`,
        });
        const v = result && result.value;
        return (v && v.w > 0 && v.h > 0) ? v : null;
    };

    const setMetrics = (h, dsf = 1) => send('Emulation.setDeviceMetricsOverride', {
        width: W, height: h, deviceScaleFactor: dsf, mobile: false,
    });

    // ---------- 模式一：只截某个元素（最常用，也最稳） ----------
    if (flags.el) {
        const r = await measure(flags.el);
        if (!r) bail(`选择器没量到元素：${flags.el}`);
        const scale = Number(flags.scale || 1);
        const clip = { x: r.x, y: r.y, width: r.w, height: r.h, scale };
        if (clip.height * scale > SURFACE_MAX) {
            bail(`元素高 ${Math.round(clip.height)}px × ${scale}x 超过光栅化上限 ${SURFACE_MAX}px，请降低 --scale`);
        }
        console.log(`ℹ️  元素 ${flags.el} → ${Math.round(r.w)}×${Math.round(r.h)} @ ${scale}x`);
        const shot = await send('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: false, clip,
        }, 60000);
        writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
        console.log(`✅ 已截图：${OUT}（元素 ${Math.round(r.w)}×${Math.round(r.h)} @${scale}x）`);
        chrome.kill('SIGKILL');
        process.exit(0);
    }

    // ---------- 模式二：整页（先量高度，再决定一张还是多张） ----------
    // ⚠️ 注意取值层级：CDP 回的是 {result:{type,value}}，
    //    少写一层 .value 会拿到一个对象 → Math.ceil 得 NaN →
    //    setDeviceMetricsOverride 报 "Failed to deserialize params.height"（看不出是取值写错）。
    const pageResp = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: 'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)',
    });
    const pageH = pageResp && pageResp.result ? pageResp.result.value : 0;
    const measured = Number.isFinite(pageH) && pageH > 0 ? Math.ceil(pageH) : H;

    if (measured <= SURFACE_MAX) {
        await setMetrics(Math.max(H, measured));
        await sleep(600);   // 重新布局后等一拍再量/截
        const clip = flags.scale
            ? { x: 0, y: 0, width: W, height: Math.max(H, measured), scale: Number(flags.scale) }
            : undefined;
        const shot = await send('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: false, ...(clip ? { clip } : {}),
        }, 60000);
        writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
        console.log(`✅ 已截图：${OUT}（视口 ${W}×${Math.max(H, measured)}，整页）`);
        chrome.kill('SIGKILL');
        process.exit(0);
    }

    // 超过上限 → 分段。视口本身压到段高，靠滚动换段，
    // 这样每次光栅化的图面都只有 W × SLICE_H，永远在上限内。
    const total = Math.min(MAX_VIEWPORT_H, measured);
    const n = Math.ceil(total / SLICE_H);
    const base = OUT.replace(/\.png$/i, '');
    await setMetrics(SLICE_H);
    await sleep(600);
    // 视口变小后页面可能重排（响应式），重新量一次总高
    const reResp = await send('Runtime.evaluate', {
        returnByValue: true,
        expression: 'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)',
    });
    const reH = reResp && reResp.result && Number.isFinite(reResp.result.value)
        ? Math.ceil(reResp.result.value) : total;
    const n2 = Math.ceil(Math.min(reH, MAX_VIEWPORT_H) / SLICE_H);
    console.log(`⚠️  整页高 ${measured}px 超过光栅化上限 ${SURFACE_MAX}px，改为分段输出 ${n2} 张`);

    for (let i = 0; i < n2; i++) {
        await send('Runtime.evaluate', {
            returnByValue: true,
            expression: `window.scrollTo(0, ${i * SLICE_H}); 0`,
        });
        await sleep(350);
        const shot = await send('Page.captureScreenshot', {
            format: 'png', captureBeyondViewport: false,
        }, 60000);
        const path = `${base}-${i + 1}.png`;
        writeFileSync(path, Buffer.from(shot.data, 'base64'));
        console.log(`   ✅ ${path}（第 ${i + 1}/${n2} 段，起点 y=${i * SLICE_H}）`);
    }
    console.log(`✅ 分段截图完成：${base}-1.png … ${base}-${n2}.png`);
    chrome.kill('SIGKILL');
    process.exit(0);
} catch (e) {
    bail('截图失败：' + e.message);
}
