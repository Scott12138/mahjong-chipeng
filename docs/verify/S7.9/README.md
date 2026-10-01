# S7.9 · 通关口径 + 生成器门槛（2026-10-01）

> 本轮把 S7.7 收尾时挂起的三个问题拍板并落地，过程中又牵出两个边界、一个一致性缺陷，
> 最终冻成 **六条决策**。设计依据见 `docs/game-4-DESIGN.md` **v2.0 修订**。

---

## 一、六个决策点

| # | 决策 | 落地位置 |
|---|---|---|
| 1 | **`场上清空 = 通关`**（槽 / 暂存架剩什么都不管） | `GamePage.isFieldCleared()`（原 `isBoardEmpty`） |
| 2 | 槽满与清空**同一刻**发生 → 判**通关**（清空优先） | `afterInsert` / `finalizeClear` 的分支顺序 |
| 3 | `MIN_PICKABLE` **6 → 5** | `CFG.STACK.MIN_PICKABLE` |
| 4 | iPhone 物理静音键：**零行为改动**（微信默认已跟随），只补一行显式声明 | `AudioService.pinMuteSwitch()` |
| 5 | 通关时槽 / 暂存架的残留牌**计入「已清」显示**，并做收尾淡出 | `GamePage.finish()` + `sweepLeftovers()` |
| 6 | 兜底局**必须先补跑可解性校验**，不许出现"未验证可解"的牌局 | `Generator.generateLevel()` |

**另加一条施工中发现的一致性缺陷**（不是新设计，是必须一起修）：
`Generator.simulate()` 的通关判定原本是 `left === 0 && slots.length === 0`，**比游戏更严**。
口径一变，它就会把"其实能通关"的布局误判成死局、白白报废采样 —— 已同步改为 `return left === 0`。

---

## 二、验证证据

### 2.1 生成器：兜底率归零、真死局归零

`生成器回归/修复后-每关150次.txt`（每关 150 次生成，确定性种子，任何人可复现）：

| 关 | 平均采样次数 | 兜底局 | 真死局（可解率 0） |
|---|---|---|---|
| L1 试手气（12 张） | 1.00 | 0/150 | 0/150 |
| L2 上道了（18 张） | 3.66 | 0/150 | 0/150 |
| L3 有点意思（21 张） | 3.93 | 0/150 | 0/150 |
| L4 就差一点（24 张） | **5.68**（原 27.4） | **0/150**（原 ~72%） | **0/150** |

**兜底分支本身也单独验证过**：把副本的 `MIN_PICKABLE` 临时改成 99（强制每次都走兜底），
20 次生成全部补出了**真实可解率**（93% / 12% / 100% / 2% …）—— 无一是"未验证"，无一是真死局。

复现：`docs/verify/S7.9/开局可点分布/`（探针）+ `生成器回归/verify-gen.ts`。

### 2.2 通关口径：旧口径会静默卡死的局面，现在正确判通关

**测试构思**（这是关键）：要证明新口径，必须造出**旧口径下既不赢也不输**的局面 ——
「场上清空、槽里凑不成型、暂存架里还挂着牌」。构造路径：

```
进 L1 → dirty:3（把 3 张互不相同的牌塞进槽）
      → 点「移出」道具（-89,-524）→ 看广告（0,112）
      → 3 张被挂到暂存架
      → auto:40 打完场上剩余 9 张
```

终局必然是：**场上 0 张、槽里有残留、暂存架里有牌**。

**实跑结果**（`通关口径/冒烟-console.log`）：

```
[RewardGate] 渠道=ad 放行 ok=true
[GamePage] 道具 移出 已生效，暂存 1 张
[GamePage] 第 1 关 通关，已清 9/12，用时 0s，道具 消除0/移出1/洗牌0/加槽0，复活0
[GamePage] 通关清尾：收掉残留牌 3 张（槽 2 + 暂存 1）
```

三条结论：
1. **`已清 9/12` 却判了通关** → 新口径生效（旧口径在这里会永远不判胜负，玩家只能自己点返回）。
2. **`通关清尾：收掉残留牌 3 张`** → 收尾动效生效，屏幕上不会出现"进度满了、牌还挂着"。
3. **日志打的是真实 9/12**，而 HUD 会显示 12/12 → 显示口径与数据口径**分开**，数据没被掩盖。

另：同一次冒烟的自检行是
`✅ 引擎可见尺寸 = 设计分辨率 720×1280`，**0 异常**，`音效就绪 13/13`。

---

## 三、顺带修掉的两个工具缺陷（都属于"报错指向错误方向"）

1. **`tools/cocos-build.sh` 的假阳性判据**：原来只检查"产物目录存在"就报 `✅ 构建成功`。
   改为核对**产物根目录的入口文件**（web 系 `application.js` / 微信 `game.js`），
   并在失败时把日志里的 `SIGTERM|error` 行直接打出来。
   另在头注里写明：日志中的 `signal:SIGTERM in task build-script` 是**常态噪音**，
   成功的构建里同样会出现（微信包就是这样，58 个文件、体积正常）。

2. **`tools/web-smoke.mjs` 的环境陷阱**：会话里注入了 `HTTP_PROXY`，无头 Chrome **会继承它**
   → 连 `127.0.0.1` 也走代理 → 拿回空页。现象极具迷惑性：CDP 连得上、视口设置成功、
   `innerSize` 正确，但 `canvas === null`、`console.log` **一行都没有**，
   最后以一个 `Cannot read properties of null (reading 'left')` 收场 —— 报错完全指错方向。
   已在 Chrome 启动参数里加 `--no-proxy-server` + `--proxy-bypass-list`，
   并在检测到 `canvas` 为空时**就地报出真因**（附自检命令）。

> ⚠️ 教训：**静态服务器必须和冒烟测试写在同一条命令里**。
> 分开两条命令时，服务器会随上一条命令一起被回收 —— 症状与"页面代码坏了"完全一样。

---

## 四、真机试玩（2026-10-01 10:24 出码）

二维码：`device/真机预览二维码.png`，对应 **10:15 重建的微信包**（S7.9 六条决策全部在包内）。

| 项 | 值 |
|---|---|
| 包体 | 3,157,986 字节 ≈ **3.01 MB** / 红线 4MB |
| AppID | `wxfaa19afc583badd9`（测试号，**上线前必须换**） |
| 可扫性 | 已用 macOS Vision 解码成功 → `mp.weixin.qq.com/a/~~SDH9OvmH3Dw~…~~` |
| 验收清单 | `真机验收清单-S7.9.md`（只列本轮变化 + 回归项；音效/震动看 S7.5 清单） |

**旧码两处已作废**（各自目录内已放 README 说明）：`S7.5/device/`（09-30 22:21）、
`S7.7/device/`（10-01 09:41）。

### 出码时踩到的新坑（已写进技能）

**`cli preview` 之前必须先 `close` 再 `open`。** IDE 里若残留着上一次打开的项目，
`preview` 会在**错误的工程**上编译，报出来的却是极具误导性的
`game.json: 未找到 game.json 文件` / `✖ compile_start` ——
而项目里 `game.json`、`project.config.json` 一切正常（我照着这个错误排查了三轮）。

另一个小事实：`--qr-output` 写出的实际是 **JPEG**（即使文件名写成 `.png`），
要真 PNG 用 `sips -s format png` 转一下。

---

## 五、复现步骤

```bash
cd /Users/consli/WorkBuddy/2026-09-30-14-03-17

# ① 生成器回归（纯 Node，秒级）
cd /tmp/gen-probe2 && node --experimental-transform-types verify-gen.ts 150

# ② 构建 web-desktop，然后**同一条命令内**起服务器 + 跑冒烟
bash tools/cocos-build.sh web-desktop debug game-4-mahjong
nohup /usr/bin/python3 -m http.server 8123 --directory game-4-mahjong/build/web-desktop > /tmp/httpd.log 2>&1 &
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy \
  node tools/web-smoke.mjs http://127.0.0.1:8123/index.html /tmp/smoke-clear \
  d:0,-118 d:0,275 dirty:3 d:-89,-524 wait:700 d:0,112 wait:4200 auto:40
```
