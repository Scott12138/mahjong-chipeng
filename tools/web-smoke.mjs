#!/usr/bin/env node
/**
 * ============================================================
 *  web-smoke.mjs · 零依赖交互冒烟测试（Chrome DevTools Protocol）
 * ============================================================
 *  【为什么需要它】
 *  微信开发者工具里没有可编程的交互接口，而命令行下又看不到控制台。
 *  好在 Cocos 构建出的 web-desktop 版与微信小游戏版**共用同一份游戏逻辑**
 *  （同一套 TS 源码，只有平台适配层不同），所以在浏览器里点一遍，
 *  就能等价验证"页面切换 / 按钮点击 / 玩法流程"是否正常。
 *
 *  【为什么不用 playwright】
 *  playwright 需要全局安装 + 下载约 150MB 浏览器。本机已有 Chrome，
 *  且 Node 22 内置了 WebSocket，因此可以零依赖直连 CDP 完成同样的事。
 *
 *  【⚠️ 踩过的坑：web 模板写死 1280×960】
 *  Cocos 生成的 web-desktop/index.html 里 `#GameDiv` 被写死成
 *  `width:1280px; height:960px`。若浏览器窗口比它窄，canvas 就会溢出窗口，
 *  引擎读到的可见尺寸变成 720×540（横向），画面被裁成一条、点击坐标全偏。
 *  解决办法：本脚本注入 CSS 把 canvas 强制撑满视口，并用
 *  Emulation.setDeviceMetricsOverride 锁定 720×1280 竖屏视口，
 *  使 view.getVisibleSize() 恰好等于设计分辨率 → 设计坐标与屏幕坐标 1:1。
 *
 *  【用法】
 *    node tools/web-smoke.mjs <url> <输出目录> [坐标 ...]
 *  坐标两种写法（可混用，按顺序执行）：
 *    d:<x>,<y>  设计坐标（原点=屏幕中心，y 向上，与 Cocos 一致）★推荐
 *    <x>,<y>    屏幕坐标（左上角为原点，仅调试用）
 *  例：
 *    node tools/web-smoke.mjs http://127.0.0.1:8123/index.html /tmp/smoke d:0,-120
 *
 *  【产出】
 *    00-before.png / 01-click-*.png ... / console.log / metrics.json
 * ============================================================
 */

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// ------------------------------------------------------------
//  参数
// ------------------------------------------------------------
const CHROME = process.env.CHROME_BIN
    || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;
/** 设计分辨率：与 game-4-mahjong/settings/v2/packages/project.json 保持一致 */
const DESIGN_W = 720;
const DESIGN_H = 1280;

const URL_ = process.argv[2] || 'http://127.0.0.1:8123/index.html';
const OUT_DIR = process.argv[3] || '/tmp/smoke';
const ACTIONS = process.argv.slice(4).map((s) => {
    const design = s.startsWith('d:');
    const [x, y] = (design ? s.slice(2) : s).split(',').map(Number);
    return { x, y, design, label: s.replace(/[:.]/g, '_') };
});

mkdirSync(OUT_DIR, { recursive: true });

// ------------------------------------------------------------
//  注入 CSS：让 canvas 撑满视口、隐藏模板自带的页眉页脚
//  （在页面脚本执行前注入，保证引擎启动时读到的就是正确尺寸）
// ------------------------------------------------------------
const INJECT_CSS = `
  html, body { margin:0; padding:0; overflow:hidden; background:#000; }
  .header, .footer { display:none !important; }
  #GameDiv {
    width:100vw !important; height:100vh !important;
    margin:0 !important; border:0 !important;
    border-radius:0 !important; box-shadow:none !important;
  }
  #Cocos3dGameContainer, #GameCanvas { width:100% !important; height:100% !important; }
`;

// ------------------------------------------------------------
//  极简 CDP 客户端
// ------------------------------------------------------------
class CDP {
    constructor(ws) {
        this.ws = ws;
        this.seq = 0;
        this.pending = new Map();
        this.consoleLines = [];
        ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                const { resolve, reject } = this.pending.get(msg.id);
                this.pending.delete(msg.id);
                msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
                return;
            }
            // 收集页面控制台输出（这是命令行构建下拿不到的最关键信息）
            if (msg.method === 'Runtime.consoleAPICalled') {
                const text = (msg.params.args || [])
                    .map((a) => a.value ?? a.description ?? a.type)
                    .join(' ');
                this.consoleLines.push(`[${msg.params.type}] ${text}`);
            }
            if (msg.method === 'Log.entryAdded') {
                this.consoleLines.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
            }
            if (msg.method === 'Runtime.exceptionThrown') {
                const d = msg.params.exceptionDetails;
                const desc = d.exception?.description || d.text;
                this.consoleLines.push(`[exception] ${desc}`);
            }
        });
    }

    send(method, params = {}) {
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    /** 在页面里求值，返回 JSON 解析后的结果 */
    async evaluate(expression) {
        const r = await this.send('Runtime.evaluate', {
            expression, returnByValue: true, awaitPromise: false,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
    }

    async shot(name) {
        const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
        const p = `${OUT_DIR}/${name}.png`;
        writeFileSync(p, Buffer.from(data, 'base64'));
        return p;
    }

    /** 在指定屏幕坐标模拟一次"移动 → 按下 → 抬起"（Cocos 靠这套事件驱动按钮） */
    async clickAt(x, y) {
        const base = { x, y, button: 'left', clickCount: 1 };
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...base, button: 'none' });
        await sleep(60);
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
        await sleep(90);
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
    }
}

// ------------------------------------------------------------
//  启动 Chrome（窗口给足高度，真实视口由 setDeviceMetricsOverride 锁定）
// ------------------------------------------------------------
console.log(`==> 启动无头 Chrome 打开 ${URL_}`);
const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--window-size=${DESIGN_W},${DESIGN_H}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=/tmp/cocos-cdp-profile',
    // 本机 Chrome 的内嵌沙箱初始化会失败（sandbox initialization failed:
    // Operation not permitted）→ 渲染进程崩溃 → 页面级 CDP 连接被莫名关闭，
    // 表现为 "WebSocket 已连接" 之后立刻断开、所有 CDP 调用永久挂起。
    // 必须关掉沙箱；这不影响 WebGL（GPU 仍走 swiftshader）。
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',   // 无头环境用软件渲染跑 WebGL
    '--hide-scrollbars',
    URL_,
], { stdio: 'ignore' });

function cleanup(code) {
    try { chrome.kill('SIGKILL'); } catch { /* ignore */ }
    process.exit(code);
}

try {
    // ---- 等 CDP 端口就绪 ----
    let target = null;
    for (let i = 0; i < 40; i++) {
        await sleep(500);
        try {
            const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
            target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (target) break;
        } catch { /* 端口还没起来，继续等 */ }
    }
    if (!target) throw new Error('CDP 端口未就绪');
    console.log('==> CDP 已连接');

    // ---- 连上页面 ----
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
        ws.addEventListener('open', res);
        ws.addEventListener('error', rej);
    });
    const cdp = new CDP(ws);
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    // ---- 锁定竖屏视口 ----
    await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: DESIGN_W, height: DESIGN_H, deviceScaleFactor: 1, mobile: false,
    });
    // ---- 注入样式，让 canvas 撑满视口（必须在引擎启动前生效）----
    //  ⚠️ 踩过的坑：addScriptToEvaluateOnNewDocument 在"文档刚创建"时执行，
    //  此时 document.head / document.documentElement 都还是 null，
    //  直接 appendChild 会抛 TypeError 且静默失效。
    //  解法：用 MutationObserver 盯着 DOM 节点出现的那一刻立刻插入 <style>，
    //  保证样式早于 <canvas> 与引擎脚本生效。
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
            const CSS = ${JSON.stringify(INJECT_CSS)};
            const apply = () => {
                const root = document.head || document.documentElement;
                if (!root) return false;
                const s = document.createElement('style');
                s.textContent = CSS;
                root.appendChild(s);
                return true;
            };
            if (!apply()) {
                const mo = new MutationObserver(() => { if (apply()) mo.disconnect(); });
                mo.observe(document, { childList: true, subtree: true });
            }
        })();`,
    });
    await cdp.send('Page.reload', { ignoreCache: false });

    // ---- 等 Cocos 引擎与首屏渲染完成 ----
    console.log('==> 等待游戏加载渲染（9 秒）…');
    await sleep(9000);

    // ---- 校验尺寸：visible 必须等于设计分辨率，否则坐标换算不可信 ----
    const metrics = await cdp.evaluate(`(() => {
        const c = document.querySelector('canvas');
        const r = c ? c.getBoundingClientRect() : null;
        const out = {
            inner: [window.innerWidth, window.innerHeight],
            canvas: r ? { cssW: Math.round(r.width), cssH: Math.round(r.height),
                          left: Math.round(r.left), top: Math.round(r.top),
                          attrW: c.width, attrH: c.height } : null,
        };
        try {
            const v = window.cc && window.cc.view;
            if (v) {
                const vs = v.getVisibleSize();
                out.visible = [Math.round(vs.width), Math.round(vs.height)];
            }
        } catch (e) { out.ccErr = String(e); }
        return JSON.stringify(out);
    })()`);
    const m = typeof metrics === 'string' ? JSON.parse(metrics) : metrics;
    console.log('    视口/画布/引擎可见尺寸：', JSON.stringify(m));
    writeFileSync(`${OUT_DIR}/metrics.json`, JSON.stringify(m, null, 2));

    // 屏幕坐标 = 画布中心 + 设计坐标（因为 visible === design，缩放为 1，且 y 轴翻转）
    const cx = m.canvas.left + m.canvas.cssW / 2;
    const cy = m.canvas.top + m.canvas.cssH / 2;
    const sizeOk = m.visible && m.visible[0] === DESIGN_W && m.visible[1] === DESIGN_H;
    console.log(sizeOk
        ? `    ✅ 引擎可见尺寸 = 设计分辨率 ${DESIGN_W}×${DESIGN_H}，设计坐标 1:1 可用（中心 ${cx},${cy}）`
        : `    ⚠️ 引擎可见尺寸与设计分辨率不一致，坐标换算可能不准，请检查注入样式是否生效`);

    const before = await cdp.shot('00-before');
    console.log(`    已截图：${before}`);

    // ---- 依次点击并截图 ----
    let i = 1;
    for (const a of ACTIONS) {
        const sx = a.design ? Math.round(cx + a.x) : a.x;
        const sy = a.design ? Math.round(cy - a.y) : a.y;   // Cocos y 轴向上 → 屏幕 y 向下
        console.log(`==> 点击 ${a.design ? `设计坐标(${a.x}, ${a.y})` : `屏幕坐标(${a.x}, ${a.y})`} → 屏幕(${sx}, ${sy})`);
        await cdp.clickAt(sx, sy);
        await sleep(1600);
        const p = await cdp.shot(`${String(i).padStart(2, '0')}-click-${a.label}`);
        console.log(`    已截图：${p}`);
        i++;
    }

    // ---- 输出页面控制台（含我们自己的 [GameRoot]/[Diag] 日志）----
    console.log('\n===== 页面控制台输出 =====');
    if (cdp.consoleLines.length === 0) {
        console.log('  (无输出)');
    } else {
        // 只打印有信息量的行，过滤引擎噪音
        const noise = /Download the React|DevTools|deprecat/i;
        for (const line of cdp.consoleLines) {
            if (!noise.test(line)) console.log('  ' + line);
        }
    }
    writeFileSync(`${OUT_DIR}/console.log`, cdp.consoleLines.join('\n'));

    console.log('\n✅ 冒烟测试完成，产物目录：' + OUT_DIR);
    cleanup(0);
} catch (e) {
    console.error('❌ 冒烟测试失败：', e.message);
    cleanup(1);
}
