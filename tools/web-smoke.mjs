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
 *               ⚠️ 它也是**唯一能造出「吃」（顺子 / 234条 / 456万）的玩法**：
 *               auto 永远优先凑「碰」，而 dirty 拿的全是互不相同的单张，
 *               反而会撞上顺子。所以「吃」的动效验收必须用 dirty + 连拍
 *               （dirty:<n>@<gap>!<ms,...>，触发时见 dirtyPlay 的 wouldChi）。
 *    fill:<n>   **安全地把槽塞到 n 张**。
 *               ⚠️ dirty 填不满槽 —— 它只避开"同牌面已有 2 张"，槽里凑出 3 个
 *               能连号的牌面就会立刻消掉一组，槽永远到不了 8 张。
 *               fill 会把"这一步会不会消"完整预判一遍（碰 / 杠 / 吃都算），
 *               只点不会引发消除的牌，因此能**必定**逼出「槽满判负」，
 *               是验证「看广告复活」这条链路的唯一可靠手段。
 *    d:<x>,<y>@<ms>  点击 + **自定义截图延迟**。
 *               默认是点击后 1600ms 截图（等一切稳定）；
 *               但动效验收要看的恰恰是"动效中间的那一帧"，
 *               所以用 @ 把延迟压到 100~700ms，就能抓到飞行/撞击/入场的半途。
 *    wait:<ms>  **不点击，只等 ms 毫秒后截图**。
 *               抓动画中间帧的关键：`d:` 之间必然隔着上一次点击的等待，
 *               时间线是断的，而 wait 能把时间线连续推下去。
 *
 *    unlock:<n>  **直写存档**把第 1..n 关标记为已通关，然后重载页面。
 *               ⚠️ 想验证「吃」必须走到 L3（L1/L2 的牌型里凑不出顺子），
 *               而 L2 是刻意设计的"第一堵墙"（可解通过率仅 12%），
 *               auto 大概率会输 —— 没有 unlock，每次验证都得赌一次通关。
 *               有了它就能稳定跳到任意一关（仅对 web-desktop 有效）。
 *  例：
 *    node tools/web-smoke.mjs http://127.0.0.1:8123/index.html /tmp/smoke d:0,-118 d:0,275 auto:18
 *    node tools/web-smoke.mjs http://127.0.0.1:8123/index.html /tmp/fail d:0,-118 d:0,275 auto:40 d:0,85 dirty:24
 *    （抓入场动画的连续五帧）
 *    node tools/web-smoke.mjs … d:0,-118 d:0,275@150 wait:200 wait:200 wait:250 wait:400 auto:60
 *    （跳到 L3 专门抓「吃」的流水汇合中间帧）
 *    node tools/web-smoke.mjs … unlock:3 d:0,-118 d:0,-105 'dirty:24@700!150,300,450,700'
 *    （塞满槽位 → 看广告复活：填槽后点「复活」→「看广告」→「跳过」）
 *    node tools/web-smoke.mjs … unlock:0 d:0,-118 d:0,275 wait:1400 fill:8 wait:1500 \
 *      d:0,60 wait:1600 d:0,112 wait:2600 d:0,-96 wait:2600
 *
 *  【产出】
 *    00-before.png / 01-click-*.png / console.log / metrics.json
 * ============================================================
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
/**
 * 存档键 / 结构，必须与 game-4-mahjong/assets/scripts/CFG.ts 的 CFG.SAVE.KEY
 * 以及 core/SaveService.ts 的 SaveData 保持一致 —— 它就是 unlock 动作的抓手。
 */
const SAVE_KEY = 'mahjong_chipeng_save_v1';

const URL_ = process.argv[2] || 'http://127.0.0.1:8123/index.html';
const OUT_DIR = process.argv[3] || '/tmp/smoke';
const ACTIONS = process.argv.slice(4).map((s) => {
    // auto:<n> / auto:<n>@<gapMs> / auto:<n>@<gapMs>!<ms,ms,...>
    //   gapMs = **每步的最小间隔**，默认 800。
    //   实际间隔 = "等游戏吐出新牌局日志" + gapMs，所以它会自动跟随真实节奏。
    //   存在的意义：默认值加上等待本身，一步约 1.3 秒 —— 那是"边看边想"的慢节奏。
    //   而**连锁消除**（一次入槽后槽里还有能消的，间隔接近 0）只在快节奏下
    //   才出现，所以必须能把节奏压下来才能测到它（420ms 大致相当于真人连打）。
    //   !<ms,...> = **撞击帧连拍**：只在"这一步会触发消除"的点击后，
    //   按给定毫秒偏移各截一张图。它是验收动效的唯一手段 ——
    //   否则整段消除动画（约 1 秒）只会出现在最终截图里，中间过程一张都留不下。
    if (s.startsWith('auto')) {
        const [nPart, rest] = s.slice(4).replace(/^:/, '').split('@');
        const [gapPart, burstPart] = (rest ?? '').split('!');
        const n = Number(nPart);
        const gap = Number(gapPart);
        const burst = (burstPart ?? '')
            .split(',')
            .filter((t) => t.trim() !== '')        // ⚠️ 必须先滤空串：Number('') === 0，
            .map(Number)                          //    否则 "auto:70@420" 会凭空多出一个 0ms 连拍
            .filter(Number.isFinite);
        return {
            kind: 'auto',
            steps: Number.isFinite(n) ? n : 12,
            gap: Number.isFinite(gap) ? gap : 800,
            burst,
            label: s.replace(/[:.@!,\-]/g, '_'),
        };
    }
    // dirty:<n> / dirty:<n>@<gapMs> / dirty:<n>@<gapMs>!<ms,ms,...>
    //   `!` 连拍与 auto 同义，但触发条件不同：dirty 永远不凑「碰」，
    //   它唯一可能触发的消除是**「吃」（顺子）** —— 所以这个连拍实际上是
    //   「抓吃（流水汇合）中间帧」的唯一手段（见 §dirtyPlay 的 wouldChi）。
    if (s.startsWith('dirty')) {
        const [nPart, rest] = s.slice(5).replace(/^:/, '').split('@');
        const [gapPart, burstPart] = (rest ?? '').split('!');
        const n = Number(nPart);
        const gap = Number(gapPart);
        const burst = (burstPart ?? '')
            .split(',')
            .filter((t) => t.trim() !== '')
            .map(Number)
            .filter(Number.isFinite);
        return {
            kind: 'dirty',
            steps: Number.isFinite(n) ? n : 12,
            gap: Number.isFinite(gap) ? gap : 800,
            burst,
            label: s.replace(/[:.@!,\-]/g, '_'),
        };
    }
    // fill:<n> / fill:<n>@<gapMs> —— **安全地把槽塞满**（专为逼出「槽满判负」）
    //
    //  【为什么不能拿 dirty 代替 —— 一个很隐蔽的区别】
    //  dirty 只避开"同一牌面槽内已有 2 张"，它**允许撞上「吃」**（这正是它能抓
    //  「吃」动效的原因）。于是槽内一旦凑出 3 个能连号的牌面，立刻就消掉一组 ——
    //  **槽位永远到不了 8 张**，也就永远逼不出「槽满判负 + 复活」这条路径。
    //  fill 把"这一步会不会消"完整预判一遍（碰 / 杠 / 吃都算），只点不会引发
    //  消除的牌，才能真的把 8 格填满。
    if (s.startsWith('fill')) {
        const [nPart, rest] = s.slice(4).replace(/^:/, '').split('@');
        const n = Number(nPart);
        const gap = Number(rest);
        return {
            kind: 'fill',
            steps: Number.isFinite(n) ? n : 8,
            gap: Number.isFinite(gap) ? gap : 620,
            burst: [],
            label: s.replace(/[:.@!,\-]/g, '_'),
        };
    }
    // unlock:<n> —— **把第 1..n 关直接标记为已通关**，然后重载页面。
    //
    //  【为什么必须有它】
    //  关卡解锁规则是「上一关通关才解锁下一关」（SaveService.isUnlocked）。
    //  而 L2 是设计上刻意做成的"第一堵墙"（生成器日志里写着可解通过率 12%），
    //  `auto` 这种贪心策略**大概率会输**——于是想跑到 L3 去看「吃」的动效，
    //  就得先赌一次 12% 的通关率。这会让每次回归测试都变成抽奖。
    //  直接把存档写进去，就能稳定地跳到任意一关。
    //
    //  ⚠️ 只对 web-desktop 有效：它写的是浏览器 localStorage。
    //     微信开发者工具要用 Storage 面板改，或把 CFG.DEBUG.UNLOCK_ALL 打开。
    if (s.startsWith('unlock')) {
        const n = Number(s.split(':')[1] ?? 4);
        return { kind: 'unlock', upTo: Number.isFinite(n) ? n : 4, label: s.replace(/[:.]/g, '_') };
    }
    // wait:<ms> —— **不点击，只等 ms 毫秒然后截图**。
    // 它是抓"动画中间帧"的关键：`d:` 动作之间必然隔着上一次点击的等待，
    // 时间线是断的；而 wait 能接着上一步把时间线连续推下去。
    //   例：d:0,275@150 wait:200 wait:200 wait:200  → 150/350/550/750ms 各一帧
    if (s.startsWith('wait')) {
        const ms = Number(s.split(':')[1] ?? 200);
        return { kind: 'wait', ms: Number.isFinite(ms) ? ms : 200, label: s.replace(/[:.]/g, '_') };
    }
    const design = s.startsWith('d:');
    // 可选后缀 `@<毫秒>`：覆盖"点击后等多久才截图"。
    // 默认 1600ms，那是"等页面/动画彻底稳定"的保守值；
    // 但**动效验收需要看动效中间的那一帧** —— 等 1.6 秒什么都播完了。
    //   例：d:0,275@180  → 进关后 180ms 截图（逐张飞入的早期）
    //       d:0,275@700  → 同一次操作，700ms 时再看一帧
    let body = s;
    let delay = 1600;
    const at = s.indexOf('@');
    if (at >= 0) {
        body = s.slice(0, at);
        const d = Number(s.slice(at + 1));
        if (Number.isFinite(d)) delay = Math.max(0, d);
    }
    const [x, y] = (design ? body.slice(2) : body).split(',').map(Number);
    return { kind: 'click', x, y, design, delay, label: body.replace(/[:.]/g, '_') };
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
        // 【为什么每条都立刻落盘，而不是最后统一 writeFileSync】
        // 页面控制台是这条命令行链路下**唯一的可观测性来源**（游戏自己打的
        // 「牌局 / 消除 牌型=…」全在里面）。而一次完整的冒烟要跑两三分钟，
        // 一旦中途被外部打断（实测遇到过一次：进程被 SIGKILL，正是卡在
        // 「吃」的连拍中间），只靠收尾那次写文件就会**把最关键的那几行丢掉**，
        // 而恰好丢的就是"这一步消了什么牌型、走了哪套动效"。
        // 改成随到随写，任何时刻中断都能拿到截止那一刻的完整日志。
        this.consolePath = `${OUT_DIR}/console.log`;
        writeFileSync(this.consolePath, '');
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
                this.push(`[${msg.params.type}] ${text}`);
            }
            if (msg.method === 'Log.entryAdded') {
                this.push(`[log:${msg.params.entry.level}] ${msg.params.entry.text}`);
            }
            if (msg.method === 'Runtime.exceptionThrown') {
                const d = msg.params.exceptionDetails;
                const desc = d.exception?.description || d.text;
                this.push(`[exception] ${desc}`);
            }
        });
    }

    push(line) {
        this.consoleLines.push(line);
        try {
            appendFileSync(this.consolePath, line + '\n');
        } catch { /* 落盘失败不影响测试本身 */ }
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

/** 目前已收到的「牌局」日志条数 —— 用它判断"点击后游戏有没有吐出新状态" */
function pickableSeq(cdp) {
    let n = 0;
    for (const l of cdp.consoleLines) if (l.includes('牌局 已清=')) n++;
    return n;
}

/**
 * 等游戏吐出一条**新的**牌局日志（返回实际等待毫秒；超时返回 -1）。
 *
 * 【为什么不能只 sleep 一个固定时长 —— 踩过的坑】
 * 自动试玩的决策完全依赖控制台里的那份「可点牌位置列表」，而点击之后
 * 游戏要过「选中 180ms + 飞行 ≤300ms + 落位余量」才会打出下一条列表。
 * 如果不等新日志、只按固定间隔决策，读到的仍是**点击前**那份列表，
 * 于是会对着一张已经拿走的牌再点一次；而这一下会被游戏的 B7 逻辑
 * 判成"点错了、撤回"（这是设计行为，不是 bug），日志里就出现
 *     「拿牌 → 取消选中 → 拿牌 → 落位 → 落位放弃」
 * 的死循环。表现像游戏卡死，实际是测试脚本读了过期数据。
 * 有了这条等待，"点一次 → 等状态真的变了 → 再点下一次"，
 * 节奏自动跟真人对齐，也不会再产生无效点击。
 */
async function waitNewPickable(cdp, seqBefore, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (pickableSeq(cdp) > seqBefore) return Date.now() - t0;
        await sleep(40);
    }
    return -1;
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

//  gapMs：两次点击之间的间隔。默认 800（悠闲地玩），但**消除动效的验收**
//  （碰的撞击 ≈0.5s、"吃"的流水汇合 ≈0.4s）需要按动效时长对齐节奏，
//  260~450ms 比较合适。所以它必须是参数，不能写死。
//  ⚠️ 别再把它写成"连章窗口" ——「连章」= **连击**，是初版误做、**已整体删除**的
//     机制，与「吃」（顺子）毫无关系（见 CFG.MOTION §十五）。
//  另外它认识"这一步会不会触发消除"：决策规则 ① 就是"槽里已有 2 张同牌面 →
//  补第 3 张"，所以只要看**槽内该牌面的张数是不是 2**，就能在点击之前预知
//  「这里马上要消」。这让「撞击帧连拍」成为可能 —— 只在这一步前后连拍，
//  其余步照常走，既拿得到动画中间帧，又不会产出上百张无用截图。
async function autoPlay(cdp, cx, cy, steps, outDir, shotIndex, gapMs = 800, burst = []) {
    let clicked = 0;
    let clears = 0;
    console.log(`    节奏：每步间隔 ${gapMs}ms`);
    if (burst.length) console.log(`    撞击帧连拍：消除步后 +[${burst.join(', ')}]ms 各截一张`);

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
        // 预知这一步会不会消：决策规则①挑的就是"槽里已有 2 张"的牌面
        const willClear = (slotCnt.get(target.key) || 0) === 2;
        const before = latestState(cdp);
        const seq0 = pickableSeq(cdp);
        console.log(`    [${s + 1}] 点 ${target.key} @设计(${target.x}, ${target.y})${willClear ? '  ← 预计触发消除' : ''}`);
        await cdp.clickAt(sx, sy);
        clicked++;

        if (willClear && burst.length) {
            // 撞击帧连拍：消除动画总长不到 1 秒，只有按偏移连拍才抓得到中间过程
            let t = 0;
            for (const off of burst) {
                await sleep(Math.max(0, off - t));
                t = off;
                const p = await cdp.shot(`${String(shotIndex).padStart(2, '0')}-clash-${s + 1}-${off}ms`);
                console.log(`       撞击 ${off}ms → ${p}`);
            }
            await sleep(Math.max(0, gapMs - t));
            await waitNewPickable(cdp, seq0, 1400);
        } else {
            // 等"这一步真的落地了"再继续（见 waitNewPickable 的注释）
            const waited = await waitNewPickable(cdp, seq0, 1400);
            if (waited < 0) console.log('       （这一步没有产生新牌局日志，按最小节奏继续）');
            await sleep(gapMs);
        }

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
//
//  ⚠️ 【顺带白捡的能力：它是唯一能造出「吃」的策略】
//  上面那条"跳过 n≥2"的规则让它永远不会触发「碰」；但"专拿互不相同的单张"
//  这件事本身，恰恰是**凑顺子（234条 / 456万）的前提** —— 而顺子不需要重复牌面，
//  所以 dirty 完全可能在无意中凑出一条来，此时 findMatch 的优先级
//  （先找碰、再找吃）会放行「吃」。
//  这让 dirty 意外成为**「吃」的动效验收工具**：auto 永远测不到「吃」。
// ------------------------------------------------------------
async function dirtyPlay(cdp, cx, cy, steps, outDir, shotIndex, gapMs = 700, burst = []) {
    let clicked = 0;
    console.log(`    节奏：每步间隔 ${gapMs}ms`);
    if (burst.length) console.log(`    消除帧连拍：若这一步会形成「吃」则 +[${burst.join(', ')}]ms 各截一张`);

    for (let s = 0; s < steps; s++) {
        const line = latestPickableLine(cdp);
        const list = parsePickable(line);
        if (list.length === 0) {
            console.log('    （已无可点牌，结束）');
            break;
        }

        const slotKeys = parseSlotKeys(line);
        const slotCnt = new Map();
        for (const k of slotKeys) slotCnt.set(k, (slotCnt.get(k) || 0) + 1);

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
        // 预知这一步会不会形成「吃」：把这张加进去后，槽内是否已有同花色 3 连号
        const willChi = wouldChi(slotKeys, best.key);
        console.log(`    [${s + 1}] 故意点 ${best.key}（槽内已有 ${bestN} 张）@设计(${best.x}, ${best.y})`
            + (willChi ? '  ← 预计形成「吃」' : ''));
        const seq0 = pickableSeq(cdp);
        await cdp.clickAt(sx, sy);
        clicked++;

        if (willChi && burst.length) {
            let t = 0;
            for (const off of burst) {
                await sleep(Math.max(0, off - t));
                t = off;
                const p = await cdp.shot(`${String(shotIndex).padStart(2, '0')}-chi-${s + 1}-${off}ms`);
                console.log(`       吃 ${off}ms → ${p}`);
            }
            await sleep(Math.max(0, gapMs - t));
            await waitNewPickable(cdp, seq0, 1400);
        } else {
            // 与 auto 同理：等这一步真的落地再决策，否则会对着过期列表重复点击
            await waitNewPickable(cdp, seq0, 1400);
            await sleep(gapMs);
        }
    }

    // 判负后游戏会延迟 2 秒弹面板，等它出来再截图
    await sleep(2400);
    const p = await cdp.shot(`${String(shotIndex).padStart(2, '0')}-dirty`);
    console.log(`    已截图：${p}（点击 ${clicked} 次）`);
}

/**
 * 预判"把 key 放进槽之后会不会立刻消除"。
 *
 * ⚠️ 规则必须与 `MatchRule.findMatch` **一致**：碰 = 3 张相同、
 *    杠 = 4 张相同、吃 = 同族（万/条/筒）连号 3 张。
 *    这里只判断"会不会消"，不需要知道消哪三张，所以比 MatchRule 略简单；
 *    但**族名与编号写法必须对齐**（`wan-5` 这种），否则会误判成"安全"，
 *    结果 fill 一填就消、永远填不满槽 —— 而现象只是"槽没满、面板没弹"，
 *    极难联想到判定规则写错了。
 */
function wouldMatch(slotKeys, key) {
    const cnt = new Map();
    for (const k of slotKeys) cnt.set(k, (cnt.get(k) || 0) + 1);
    cnt.set(key, (cnt.get(key) || 0) + 1);
    for (const n of cnt.values()) if (n >= 3) return true;   // 碰 / 杠
    const has = new Set(cnt.keys());
    for (const fam of ['wan', 'sou', 'ton']) {
        for (let t = 1; t <= 7; t++) {
            if (has.has(`${fam}-${t}`) && has.has(`${fam}-${t + 1}`)
                && has.has(`${fam}-${t + 2}`)) return true;   // 吃
        }
    }
    return false;
}

/**
 * fill：把槽位"安全地"塞到指定张数，用于逼出「槽满判负 → 看广告复活」。
 *
 * 策略：每一步在可点牌里挑一张**放进去不会引发任何消除**的，
 * 优先挑"槽内该牌面张数最少"的（保证分布均匀、能填得更满）。
 * 一张都挑不出时立即结束 —— 那说明这局的牌面组合已经不允许再塞了
 * （比如只剩两种牌面、各自再点一张就会凑成 3 张）。
 */
async function fillPlay(cdp, cx, cy, steps, outDir, shotIndex, gapMs = 620) {
    let clicked = 0;
    for (let s = 0; s < steps; s++) {
        const line = latestPickableLine(cdp);
        const list = parsePickable(line);
        if (list.length === 0) {
            console.log('    （已无可点牌，结束）');
            break;
        }
        const slotKeys = parseSlotKeys(line);
        const slotCnt = new Map();
        for (const k of slotKeys) slotCnt.set(k, (slotCnt.get(k) || 0) + 1);

        // 先按"槽内已有张数"升序，再取第一张安全的
        const sorted = list.slice().sort(
            (a, b) => (slotCnt.get(a.key) || 0) - (slotCnt.get(b.key) || 0),
        );
        const safe = sorted.find((t) => !wouldMatch(slotKeys, t.key));
        if (!safe) {
            console.log('    （剩下的牌一点就会消，槽无法再填，结束）');
            break;
        }

        const sx = Math.round(cx + safe.x);
        const sy = Math.round(cy - safe.y);
        console.log(`    [${s + 1}] 填槽 ${safe.key}（槽内已有 ${slotCnt.get(safe.key) || 0} 张，`
            + `当前槽 ${slotKeys.length} 张）@设计(${safe.x}, ${safe.y})`);
        const seq0 = pickableSeq(cdp);
        await cdp.clickAt(sx, sy);
        clicked++;
        await waitNewPickable(cdp, seq0, 1400);
        await sleep(gapMs);
    }

    // 判负后游戏会延迟约 2 秒弹面板，等它出来再截图
    await sleep(2400);
    const p = await cdp.shot(`${String(shotIndex).padStart(2, '0')}-fill`);
    console.log(`    已截图：${p}（点击 ${clicked} 次）`);
}

/**
 * 预测"这一张入槽之后，槽内是否会出现同花色 3 连号（=「吃」）"。
 *
 * 【为什么要预测而不是事后看日志】
 * 「吃」的流水汇合全程只有 300ms 左右，事后从日志里读到 `牌型=chi` 时，
 * 动画早就播完了，一张中间帧都抓不到。只有在点击**之前**就预知，
 * 才能像 auto 的撞击连拍那样，在正确的时刻按下快门。
 *
 * 牌面 key 形如 `wan-3` / `sou-11` / `ton-5`：前缀是花色，数字是点数。
 */
function wouldChi(slotKeys, k) {
    const bySuit = new Map();
    for (const key of slotKeys.concat([k])) {
        const m = key.match(/^([a-z]+)-(\d+)$/);
        if (!m) continue;
        if (!bySuit.has(m[1])) bySuit.set(m[1], new Set());
        bySuit.get(m[1]).add(Number(m[2]));
    }
    for (const nums of bySuit.values()) {
        for (const n of nums) if (nums.has(n + 1) && nums.has(n + 2)) return true;
    }
    return false;
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
    // 【2026-10-01 踩】环境里可能注入了 `HTTP_PROXY=http://127.0.0.1:<port>`
    // （WorkBuddy 会给 Bash 会话注入透明代理），Chrome 会**继承**它 →
    // 连 127.0.0.1:8123 也走代理 → 拿回 502 / 空白页。
    // 现象极具迷惑性：CDP 连得上、视口设置成功、innerSize 正确，
    // 但 `canvas === null`、console.log **一行都没有** —— 看起来像游戏挂了，
    // 其实是页面压根没加载。加这个开关强制直连。
    '--no-proxy-server',
    '--proxy-bypass-list=127.0.0.1,localhost',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',   // 无头环境用软件渲染跑 WebGL
    '--hide-scrollbars',
    // ------------------------------------------------------------
    //  ⚠️ 下面三个是**必需项**，删掉会让整局游戏的"状态流转"看起来像卡死
    // ------------------------------------------------------------
    //  【实测事故】无头 Chrome 会把**后台/被遮挡窗口的 setTimeout 节流到 1 秒**
    //  （Chromium 的 background timer throttling）。而本工程的铁律是
    //  「状态流转只走 setTimeout」——于是所有"落位 / 解锁 / 结算"的定时器
    //  都被拉长到 ~1000ms。
    //  后果极其隐蔽：设计上「拿牌 → 441ms 后落位」，实际 1000ms 才落位；
    //  自动化每 800ms 点一次，第二次点击落在飞行窗口内 →
    //  被 B7 判成"点错了、撤回"，于是日志里只剩
    //      「拿牌 → 取消选中 → 拿牌 → 落位 → 落位放弃」
    //  的循环，看上去像游戏有 bug，实际是测试环境把定时器改了。
    //  加这三个开关后，定时器恢复真实时长，游戏行为与真机一致。
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
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

    /**
     * 重载 → 等引擎起来 → 读回"视口/画布/引擎可见尺寸"并校验。
     * 抽成函数是因为 `unlock` 动作要在运行中途重载一次（写完存档必须重载
     * 才能让 SaveService 重新读档），而重载后**必须重新校验尺寸** ——
     * 注入的 CSS 与 deviceMetricsOverride 都是跨重载生效的，但一旦哪次失效，
     * 后续所有点击坐标都会偏，而那种失败看起来像"游戏点不动"。
     */
    async function bootAndCheck(labelText) {
        console.log(`==> 等待游戏加载渲染（9 秒）${labelText ? ' · ' + labelText : ''}…`);
        await sleep(9000);
        const raw = await cdp.evaluate(`(() => {
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
        const mm = typeof raw === 'string' ? JSON.parse(raw) : raw;
        console.log('    视口/画布/引擎可见尺寸：', JSON.stringify(mm));
        writeFileSync(`${OUT_DIR}/metrics.json`, JSON.stringify(mm, null, 2));
        const ok = mm.visible && mm.visible[0] === DESIGN_W && mm.visible[1] === DESIGN_H;
        console.log(ok
            ? `    ✅ 引擎可见尺寸 = 设计分辨率 ${DESIGN_W}×${DESIGN_H}，设计坐标 1:1 可用`
            : `    ⚠️ 引擎可见尺寸与设计分辨率不一致，坐标换算可能不准，请检查注入样式是否生效`);

        // 【2026-10-01】看不见 canvas = 页面**根本没加载**（静态服务器没起 / 请求被
        // HTTP_PROXY 拦走 / 中间产物缺失）。不在这里拦下的话，后面所有基于 canvas
        // 的坐标计算都会以 `Cannot read properties of null (reading 'left')` 收场 ——
        // 那个报错**完全指错方向**，会让人去查游戏代码。就地报出真因。
        if (!mm.canvas) {
            throw new Error('页面没有加载出 canvas：静态服务器没在跑，或请求被 HTTP_PROXY 拦走。'
                + `\n      自检：curl --noproxy "*" ${URL_} 应返回 200`
                + '\n      另请确认产物根目录存在 application.js（构建是否真的跑完）。');
        }
        return mm;
    }

    const m = await bootAndCheck('');

    // 屏幕坐标 = 画布中心 + 设计坐标（因为 visible === design，缩放为 1，且 y 轴翻转）
    // 中心随重载被重新计算 —— unlock 会重载页面，画布位置理论上不变，
    // 但这里跟着 metrics 走，任何布局变化都会被自动带上。
    let cx = m.canvas.left + m.canvas.cssW / 2;
    let cy = m.canvas.top + m.canvas.cssH / 2;
    console.log(`    （点击换算中心：${cx},${cy}）`);

    const before = await cdp.shot('00-before');
    console.log(`    已截图：${before}`);

    // ---- 依次点击并截图 ----
    let i = 1;
    for (const a of ACTIONS) {
        if (a.kind === 'unlock') {
            const cleared = [];
            for (let k = 1; k <= a.upTo; k++) cleared.push(k);
            const save = { version: 1, cleared, bestTime: {} };
            // 写成 JSON 字符串再交给页面：避免把数值/引号在两端各转义一次
            await cdp.evaluate(
                `localStorage.setItem(${JSON.stringify(SAVE_KEY)}, ${JSON.stringify(JSON.stringify(save))}); true`);
            console.log(`==> 直写存档：标记第 1..${a.upTo} 关已通关，然后重载页面`);
            await cdp.send('Page.reload', { ignoreCache: false });
            const mm = await bootAndCheck('unlock 后重载');
            cx = mm.canvas.left + mm.canvas.cssW / 2;
            cy = mm.canvas.top + mm.canvas.cssH / 2;
            const p = await cdp.shot(`${String(i).padStart(2, '0')}-unlock`);
            console.log(`    已截图：${p}`);
            i++;
            continue;
        }
        if (a.kind === 'auto') {
            console.log(`==> 自动试玩 ${a.steps} 步（坐标取自控制台里的「牌局」日志）`);
            await autoPlay(cdp, cx, cy, a.steps, OUT_DIR, i, a.gap, a.burst);
            i++;
            continue;
        }
        if (a.kind === 'dirty') {
            console.log(`==> 故意凑不成 ${a.steps} 步（负向测试：逼出槽位满的败局）`);
            await dirtyPlay(cdp, cx, cy, a.steps, OUT_DIR, i, a.gap, a.burst);
            i++;
            continue;
        }
        if (a.kind === 'fill') {
            console.log(`==> 安全填槽 ${a.steps} 步（负向测试：**必定**逼出槽位满的败局，`
                + `专门用于验证「看广告复活」）`);
            await fillPlay(cdp, cx, cy, a.steps, OUT_DIR, i, a.gap);
            i++;
            continue;
        }
        if (a.kind === 'wait') {
            await sleep(a.ms);
            const p = await cdp.shot(`${String(i).padStart(2, '0')}-wait-${a.ms}`);
            console.log(`==> 等待 ${a.ms}ms → 截图 ${p}`);
            i++;
            continue;
        }
        const sx = a.design ? Math.round(cx + a.x) : a.x;
        const sy = a.design ? Math.round(cy - a.y) : a.y;   // Cocos y 轴向上 → 屏幕 y 向下
        console.log(`==> 点击 ${a.design ? `设计坐标(${a.x}, ${a.y})` : `屏幕坐标(${a.x}, ${a.y})`} → 屏幕(${sx}, ${sy})`);
        await cdp.clickAt(sx, sy);
        await sleep(a.delay ?? 1600);
        const p = await cdp.shot(`${String(i).padStart(2, '0')}-click-${a.label}`);
        console.log(`    已截图：${p}`);
        i++;
    }

    // ---- 性能采样（2026-10-01 S10 新增）----
    //  【为什么塞进冒烟脚本而不是单独写个工具】
    //  性能必须**在真实玩法状态下**测 —— 菜单页只有 20 来个 draw call，
    //  L4 的 96 张牌才是压力点。而冒烟脚本已经"走"到了目标关卡，
    //  手上正握着那个状态，再单独起一次 Chrome 重走一遍纯属浪费。
    //  ⚠️ `numDrawCalls` 是**每帧清零**的计数，读一次可能正好撞上清屏后的帧，
    //     所以采 6 次取峰值（峰值才是"这一帧要画多少"的真实答案）。
    {
        const SAMPLE = `(() => {
            const d = window.cc && window.cc.director;
            if (!d) return null;
            const dev = d.root && d.root.device;
            return {
                fps: Math.round(1 / d.getDeltaTime()),
                frameMs: +(d.getDeltaTime() * 1000).toFixed(2),
                dc: (dev && dev.numDrawCalls) || 0,
                inst: (dev && dev.numInstances) || 0,
            };
        })()`;
        const samples = [];
        for (let k = 0; k < 6; k++) {
            const s = await cdp.evaluate(SAMPLE);
            if (s) samples.push(s);
            await sleep(250);
        }
        if (samples.length > 0) {
            const peak = samples.reduce((a, b) => (b.dc > a.dc ? b : a));
            const avgMs = +(samples.reduce((a, b) => a + b.frameMs, 0) / samples.length).toFixed(2);
            const perf = {
                peakDrawCalls: peak.dc,
                avgFrameMs: avgMs,
                fps: Math.round(1000 / avgMs),
                note: 'draw call 取 6 次采样峰值；FPS 由平均帧耗时反推（浏览器 vsync 上限 60）',
                samples,
            };
            console.log(`    性能：峰值 draw call ${perf.peakDrawCalls}`
                + ` / 平均帧 ${perf.avgFrameMs}ms → 约 ${perf.fps} FPS`);
            const mPath = `${OUT_DIR}/metrics.json`;
            try {
                const old = JSON.parse(readFileSync(mPath, 'utf8'));
                writeFileSync(mPath, JSON.stringify({ ...old, perf }, null, 2));
            } catch { /* metrics.json 不在就跳过，不影响结论 */ }
        }
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
