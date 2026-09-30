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
 *    node tools/web-smoke.mjs <url> <输出目录> [动作 ...]
 *  动作三种写法（可混用，按顺序执行）：
 *    d:<x>,<y>  设计坐标点击（原点=屏幕中心，y 向上，与 Cocos 一致）★推荐
 *    <x>,<y>    屏幕坐标点击（左上角为原点，仅调试用）
 *    auto:<n>   自动试玩 n 步 —— 从控制台里读游戏自己打印的「可点牌」坐标，
 *               优先连点同一个牌面（凑「碰」）。牌位是随机的，
 *               没有这个就只能靠肉眼看截图猜坐标。
 *    dirty:<n>  故意凑不成 n 步 —— auto 的反面：专挑槽内张数最少的牌面点，
 *               绝不凑成 3 张。用来**稳定逼出败局**，回归「失败 / 复活 / 兜底」
 *               这条在真实游玩里很难复现的负向链路。
 *  例：
 *    node tools/web-smoke.mjs http://127.0.0.1:8123/index.html /tmp/smoke d:0,-118 d:0,275 auto:18
 *    node tools/web-smoke.mjs http://127.0.0.1:8123/index.html /tmp/fail d:0,-118 d:0,275 auto:40 d:0,85 dirty:24
 *
 *  【产出】
 *    00-before.png / 01-click-*.png / console.log / metrics.json
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
    if (s.startsWith('auto')) {
        const n = Number(s.split(':')[1] ?? 12);
        return { kind: 'auto', steps: Number.isFinite(n) ? n : 12, label: s.replace(/[:.]/g, '_') };
    }
    if (s.startsWith('dirty')) {
        const n = Number(s.split(':')[1] ?? 12);
        return { kind: 'dirty', steps: Number.isFinite(n) ? n : 12, label: s.replace(/[:.]/g, '_') };
    }
    const design = s.startsWith('d:');
    const [x, y] = (design ? s.slice(2) : s).split(',').map(Number);
    return { kind: 'click', x, y, design, label: s.replace(/[:.]/g, '_') };
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
//  自动试玩：靠游戏自己打印的「可点牌」日志定位
// ------------------------------------------------------------
//  牌位是随机的（格点加权采样 + 抖动），脚本没有视觉识别能力，
//  所以让游戏在 DEBUG 模式把可点牌与坐标打出来，脚本照着点。
//  策略很朴素但够用：优先连点同一个牌面，因为那才有机会凑成「碰」。
// ------------------------------------------------------------

/** 取最近一条「可点」日志 */
function latestPickableLine(cdp) {
    for (let i = cdp.consoleLines.length - 1; i >= 0; i--) {
        if (cdp.consoleLines[i].includes('牌局 已清=')) return cdp.consoleLines[i];
    }
    return null;
}

/** 解析 'wan-1@-238,146 sou-3@-170,60' 这种串 */
function parsePickable(line) {
    const out = [];
    if (!line) return out;
    const re = /([a-z]+-\d+)@(-?\d+),(-?\d+)/g;
    let m;
    while ((m = re.exec(line)) !== null) {
        out.push({ key: m[1], x: Number(m[2]), y: Number(m[3]) });
    }
    return out;
}

async function autoPlay(cdp, cx, cy, steps, outDir, shotIndex) {
    let clicked = 0;
    let clears = 0;

    for (let s = 0; s < steps; s++) {
        const line = latestPickableLine(cdp);
        const list = parsePickable(line);
        if (list.length === 0) {
            console.log('    （已无可点牌，自动试玩结束）');
            break;
        }

        // 决策顺序（越靠前越优先）：
        //   ① 槽里已有 2 张同牌面 → 补第 3 张，立刻消
        //   ② 槽里已有 1 张同牌面 → 补到 2 张
        //   ③ 可点牌里数量最多的牌面 → 有富余才敢开始凑
        //   ④ 都没有就随便点一张
        const slotKeys = parseSlotKeys(line);
        const slotCnt = new Map();
        for (const k of slotKeys) slotCnt.set(k, (slotCnt.get(k) || 0) + 1);

        let target = null;
        const bySlot = [...slotCnt.entries()].sort((a, b) => b[1] - a[1]);
        for (const [k] of bySlot) {
            const hit = list.find((t) => t.key === k);
            if (hit) { target = hit; break; }
        }

        if (!target) {
            const cnt = new Map();
            for (const t of list) cnt.set(t.key, (cnt.get(t.key) || 0) + 1);
            let bestKey = null;
            let bestN = 0;
            for (const [k, n] of cnt) if (n > bestN) { bestN = n; bestKey = k; }
            target = (bestN >= 3 ? list.find((t) => t.key === bestKey) : null) || list[0];
        }

        const sx = Math.round(cx + target.x);
        const sy = Math.round(cy - target.y);
        const before = latestState(cdp);
        console.log(`    [${s + 1}] 点 ${target.key} @设计(${target.x}, ${target.y})`);
        await cdp.clickAt(sx, sy);
        clicked++;
        await sleep(800);

        const after = latestState(cdp);
        if (before !== after) {
            clears++;
            console.log(`       状态：${after ?? '(无)'}`);
        }
    }

    // 通关/失败后游戏会延迟 2 秒跳回关卡页，这里等它跳完再继续
    await sleep(2200);
    const p = await cdp.shot(`${String(shotIndex).padStart(2, '0')}-auto`);
    console.log(`    已截图：${p}（点击 ${clicked} 次，状态变化 ${clears} 次）`);
}

// ------------------------------------------------------------
//  故意凑不成（dirty）：专门用来逼出「败局」的负向测试
// ------------------------------------------------------------
//  auto 是"聪明地玩"，永远在凑同牌面 → 永远通关，测不到失败分支。
//  失败分支（槽位满了 / 时间到）恰恰是最需要回归的：复活、结算、兜底文案
//  全挂在这条链路上，而它在真实游玩里很难稳定复现。
//
//  dirty 的策略与 auto **完全相反**：专挑"槽内该牌面张数最少"的牌点，
//  且跳过任何会让槽内某牌面凑到 3 张的牌（那会消掉，白费）。
//  结果就是槽里堆满单张散牌 → 槽位一满立刻判负。
// ------------------------------------------------------------
async function dirtyPlay(cdp, cx, cy, steps, outDir, shotIndex) {
    let clicked = 0;

    for (let s = 0; s < steps; s++) {
        const line = latestPickableLine(cdp);
        const list = parsePickable(line);
        if (list.length === 0) {
            console.log('    （已无可点牌，结束）');
            break;
        }

        const slotCnt = new Map();
        for (const k of parseSlotKeys(line)) slotCnt.set(k, (slotCnt.get(k) || 0) + 1);

        // 选槽内该牌面张数最少的一张；张数 ≥2 的直接跳过（点了会消）
        let best = null;
        let bestN = Number.POSITIVE_INFINITY;
        for (const t of list) {
            const n = slotCnt.get(t.key) || 0;
            if (n >= 2) continue;
            if (n < bestN) { bestN = n; best = t; }
        }
        if (!best) {
            console.log('    （剩下的牌一点就会消，无负数路径可走，结束）');
            break;
        }

        const sx = Math.round(cx + best.x);
        const sy = Math.round(cy - best.y);
        console.log(`    [${s + 1}] 故意点 ${best.key}（槽内已有 ${bestN} 张）@设计(${best.x}, ${best.y})`);
        await cdp.clickAt(sx, sy);
        clicked++;
        await sleep(700);
    }

    // 判负后游戏会延迟 2 秒弹面板，等它出来再截图
    await sleep(2400);
    const p = await cdp.shot(`${String(shotIndex).padStart(2, '0')}-dirty`);
    console.log(`    已截图：${p}（点击 ${clicked} 次）`);
}

/** 解析槽内牌面：'槽内=[wan-7,wan-7,ton-5]' → ['wan-7','wan-7','ton-5'] */
function parseSlotKeys(line) {
    if (!line) return [];
    const m = line.match(/槽内=\[([^\]]*)\]/);
    if (!m || !m[1].trim()) return [];
    return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}

/** 取最近一条状态行里的「已清 / 槽」摘要（用来判断刚才那一下有没有真的消掉） */
function latestState(cdp) {
    const line = latestPickableLine(cdp);
    if (!line) return null;
    const m = line.match(/已清=(\d+) 槽=(\d+)\/(\d+)/);
    return m ? `已清${m[1]} 槽${m[2]}/${m[3]}` : null;
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
        if (a.kind === 'auto') {
            console.log(`==> 自动试玩 ${a.steps} 步（坐标取自控制台里的「牌局」日志）`);
            await autoPlay(cdp, cx, cy, a.steps, OUT_DIR, i);
            i++;
            continue;
        }
        if (a.kind === 'dirty') {
            console.log(`==> 故意凑不成 ${a.steps} 步（负向测试：逼出槽位满的败局）`);
            await dirtyPlay(cdp, cx, cy, a.steps, OUT_DIR, i);
            i++;
            continue;
        }
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
