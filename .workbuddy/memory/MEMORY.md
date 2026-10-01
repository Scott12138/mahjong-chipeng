# 项目长期记忆（本工作区）

## 指针
- **课程主工程在旧工作区**：`/Users/consli/WorkBuddy/2026-09-07-15-28-47/wechat-mini-game-course/`（game-1 接水果、game-2 合成大西瓜、game-3 牛仔套索 9 关已全通，权威上下文读那里的 `KNOWLEDGE_PACK.md`）。
- game-3 正式 AppID `wxfaa19afc583badd9`；game-3 Step5（商店/换装/无尽牧场）挂起未做；包体积 3.96MB/4MB 告急。
- 📍 **game-4 工程在「本工作区」**：`/Users/consli/WorkBuddy/2026-09-30-14-03-17/`（`game-4-mahjong/` + 工作区根的 `tools/` + `docs/` + `_toolchain-verify/`）。**git 仓库也在本工作区根**。旧工作区 `2026-09-07-15-28-47` **已无 game-4**，只剩 `wechat-mini-game-course` 与 `generated-images`。
- 🌐 **game-4 远程仓库（2026-10-01 建立）：`https://github.com/Scott12138/mahjong-chipeng`（public，默认分支 `main`）**。remote 名 `origin`，协议 SSH（`git@github.com:Scott12138/mahjong-chipeng.git`）。⚠️ **仓库根是整个工作区**（含 `docs/` `tools/` `.workbuddy/memory/`），不只是 `game-4-mahjong/`。`build/` 由 `.gitignore` 排除，不入库。用户**明确知情并选择公开**（含记忆笔记：已扫描确认无手机号/身份证/邮箱/真实姓名/工作单位信息，仅 6 个小程序 AppID 与 `/Users/consli` 路径）。建仓命令：`gh repo create Scott12138/mahjong-chipeng --public --source . --remote origin --push --description "..."`。

## game-4（2026-09-30 启动；**S0 → S1 → S1.5 美工定稿 → S2 → S6 → S6.5 → S7 动效 → S7.5 音效/震动/消除动效 → S7.6 「吃」的流水汇合+两个缺陷 → S7.7 术语订正+连击残留清零 → S7.8 首次提交并推送 全部完成**，下一步 S8 真实广告/分享通道 + S4/S5 难度标定 + 生成器兜底局拍板）
- **定稿名称：《麻麻大消除》**（工作代号 mahjong-chipeng，工程目录 `game-4-mahjong/`）。定稿文件 = **`docs/game-4-DESIGN.md`（v1.9，唯一设计依据）**。
- 选题：麻将吃碰三消（叠塔三消骨架 + 万/条/筒牌面），参考用户兄弟做的「吃碰来一局」。
- 已拍板：消除类 → 叠塔三消 → **多层立体随机堆叠**（2026-09-30 用户改口，原为固定金字塔）→ 麻将牌面 → **4 关三堵墙（无无尽）** → 道具四件套（消除/移出/洗牌/**加槽**）全看广告+分享 → **技术栈 Cocos Creator 3.8.8（代码驱动 UI）**。
- 🔄 **AppID：暂用测试号 `wxfaa19afc583badd9` 开发**（2026-09-30 用户改口：先不管合规/版权，用测试 AppID 把玩法和代码做出来再说）。⚠️ **上线前必须换号**——此号是 game-3 线上版在用的，拿它上传会覆盖 game-3。
- **Git 基线**：`a4054d3`（S0）→ `107432e`（美术定稿 + S1）→ `c1dfcef`（S2–S7 全部）→ `31e40e1`（S7.5 音效/震动/消除动效）→ **`02917d1`（S7.6–S7.7 动效分流 + 术语订正 + 连击清零 + 两个缺陷修复，已 push 到 `origin/main`）**。铁律：**不主动 commit / push**；本次 push 是用户明确说的「先提交并推送」，以后每次 push 仍须用户逐次授权。
- 🚫 **命名雷区词表**（已两次踩坑）：① **「消消乐」是注册商标**（乐元素/天津乐浣，第 9+41 类，判赔 220 万，法院不认通用名称抗辩）；② **「X了个X」**（羊了个羊系命名饱和 + 「麻了个麻」有侵权判例）；③ 碰了个碰/吃碰杠/三缺一/碰碰胡 均已被占用。→ 安全的是「消除」二字（法院认定是通用名称）。中文名 2–15 字；**个人主体每年仅 2 次改名**，未发布的小程序共 3 次；最终以 mp 后台「名称检测」为准。
- 🔴 **最大非技术风险：个人主体的类目约束**。用户主体＝**个人主体（身份证）**；微信运营规范 1.5「棋牌类、角色类不对个人开发者开放」，官方口径「牌类**均需版号**」。→ 必须申报「**休闲益智**」类目 + 游戏内零棋牌语义（不出现胡牌/番数/筹码/对战）。乐观依据：微信上大量麻将题材消除游戏类目都是"休闲益智/消除"，「2048大消除」获版号申报类别＝移动-休闲益智。个人主体还**不能开内购**（本作无经济系统，天然符合 ✅）+ 必须办**软著**（约 1 个月，S1–S2 就该提交）。
- 换题材兜底：若被判牌类驳回，把万/条/筒换成自研图案，**机制与代码零改动**。
- 铁律照旧：先 DESIGN.md 拍板再写代码；不主动 commit/push；代码中文详细注释、参数集中 CFG。
- 详细过程见 `2026-09-30.md`。

## Cocos 环境（2026-09-30 已验证可用）
- 已装：Dashboard 2.2.2（`/Applications/CocosDashboard.app`）、Creator **3.8.8**（`/Applications/Cocos/Creator/3.8.8/CocosCreator.app`，4.1GB）、微信开发者工具（`/Applications/wechatwebdevtools.app`）。
- 工程：正式工程 `game-4-mahjong/`（`Main.scene` 已于 S1 手写补齐）；验证工程 `_toolchain-verify/hello-world/`（3D 模板全量副本，用于验证链路，别删）。
- **无头构建三坑（已封装成 `tools/cocos-build.sh`，务必用它）**：
  1. 必须 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`，否则 Electron 被当纯 Node 跑，报 `bad option: --project`；
  2. 必须加 `--no-sandbox --disable-gpu`，否则 Chromium 内嵌沙箱初始化失败 → exit 133；
  3. 工程必须有场景并设为启动场景，否则报 `cannot be set as the Start Scene`。
  - 用 Bash 工具跑时需 `dangerouslyDisableSandbox: true`（前台，后台运行会丢权限）。
- **体积实测**：**game-4（纯 2D，引擎已裁剪）wechatgame release = 3.0MB**（S1 时 2.9MB；S2 加进 5 个脚本后 +0.1MB）；web-desktop debug 6.7M。→ 红线 4MB，**余量 1MB** ✅。`assets` 仅 484KB 是「代码驱动 UI + 矢量画牌面、零贴图」的直接红利。仍可回收的余量：`settings/v2/packages/engine.json` 里 `spine`/`dragon-bones`/`tiled-map`/`video`/`webview`/`physics-2d-box2d` 全用不到（启动日志出现 `[PHYSICS2D]: register box2d.` 就是它在包里的证据）。
- 对照组：未裁剪的 3D 模板 debug 13MB（cocos-js 7.2M）／release 9.0MB（cocos-js 3.6M + 示例 3D 资源 5.2M）。
- 编辑器自带工程模板路径：`/Applications/Cocos/Creator/3.8.8/CocosCreator.app/Contents/Resources/templates/`（**empty / empty-2d / empty-quality 都不带场景**，只有 hello-3d-world、taxi 带场景）。
- 下载坑：Cocos 安装包 CDN 对海外出口 IP 返回 403 openresty（同域名图片路径 200），需关代理/切直连下载；最新 Dashboard 2.2.2、Creator 3.8.8。

## Cocos → 微信开发者工具 对接（2026-09-30 端到端跑通）
- **一条命令闭环**：`bash tools/cocos-build.sh wechatgame release <工程> both`（构建完自动打开工具）。单开工具用 `bash tools/wechat-open.sh <构建产物目录>`。
- 微信开发者工具 36.6.0，CLI `/Applications/wechatwebdevtools.app/Contents/MacOS/cli`；**已登录**（`cli islogin` → `{"login":true}`）；**服务端口已开**（工具自选随机端口，如 24496，**不要用 --port 硬指定**）。
  - 服务端口开关位置：`~/Library/Application Support/微信开发者工具/<profile>/WeappLocalData/localstorage_<hash>.json`（及 `ls_<hash>.json`）的 `security.enableServicePort`；改动前必须退出工具。
- **构建配置走 `configPath`，别走命令行参数**：顶层 `appid=xxx` 与 JSON 字符串形式 `--build '{...}'` 都**不生效**（前者被静默忽略、后者回落 web-desktop）。唯一可靠通道：`--build "configPath=<json>"`，AppID 写在 `packages.wechatgame.appid`。配置文件 `game-4-mahjong/build-config/wechatgame.json`（构建脚本自动读取并合并 debug 开关）。
- **微信 CLI 的坑**：① CLI 包装脚本有 `cd "$CWD"`，`--project` 传**相对路径**会解析错位置，报 `✖ preparing / openProject 异常`（看不出是路径问题）→ 必须绝对路径；② 工具**冷启动 60 秒+**，起来后立刻 open 必失败 → 先用 `cli islogin` 轮询探活。
- **bash 坑**：`echo "$OUT" | grep -q PAT` 配 `set -o pipefail` 会因 grep 提前退出触发 SIGPIPE 被误判失败 → 用 here-string `grep -q PAT <<<"$OUT"`。
- 上传：`cli upload --project <产物目录> -v <版本号> -d <备注>`。完整流程见 `docs/cocos-to-wechat-publish.md`。
- ⚠️ **AppID 归属**：`wxfaa19afc583badd9` 是 game-3 在用的号，**用它上传 game-4 会覆盖 game-3 线上版**。用户已有两个号：game-1/2＝`wx817f07150e00efa1`，game-3＝`wxfaa19afc583badd9`。**开发期暂用后者做测试，上线前必须定复用还是新注册。**

## game-4 S7 动效系统（2026-09-30 完成，纯表现层改造，玩法数值零改动）
- **新增 `ui/MotionFx.ts`（718 行）= 动效基础设施**：带 tag 的补间注册表（同节点同 tag 先 stop 后起，避免抢 `position`）、六条语义曲线（`EASE_ENTER=quadOut` / `EASE_MOVE=quadOut` / `EASE_POP=backOut` / `EASE_EXIT=quadIn` / `EASE_IDLE=sineInOut` / `EASE_REJECT=sineOut`）、跨容器世界坐标换算（`worldPosOf` / `worldToLocal` / `between`）、特效对象池（碎屑/脉冲/白闪/奖励图标，`_gen` 代次号防重 + `autoRecycle` 到期兜底回收）。
- **`CFG.MOTION` 是动效参数的唯一出处**（60+ 常量）。`MotionFx.unlockMs(秒)` = 秒→毫秒 + 20ms 余量，专供 `setTimeout` 解锁用。
- 🔴 **Cocos Creator 3.8 的 Tween 没有 `bezierTo` / `splineTo`**（2.x Action 系统残留；3.0 重写后只剩 `to/by/set/delay/repeat/call`）。弧线必须自己算：`MotionFx.arc()` 把三次贝塞尔按 `ease(i/n)` 采样成 **8 段直线**，缓动作用在整条弧的参数上、段内用 `linear`（逐段套缓动会"一顿一顿往前拱"）。
- 铁律落点：**状态推进一律 `setTimeout`，禁止 `tween().call()`** —— 补间被 stop / 换父 / 回收后回调永不执行，`_busy` 永久 true 直接死锁。
- **五类时机**：① 开局入场（L1 240ms / L2-4 160ms，按层错峰 + 底部三件套滑入 + 槽格依次点亮）② 点击（touchStart 即压缩 60ms、选中上浮 6px+放大 1.12、**按距离推导飞行时长** `MOVE_SPEED=1.6px/ms`、落位 squash、**被压住的牌给拒绝反馈**）③ 消除（**先聚拢后消除**、前摇停 70ms、再胀 1.20→缩 0、碎屑 6-10 个、槽位余 3 格描边呼吸 4 次）④ 道具奖励（**弧线飞行 + 落点脉冲**，落点按道具有意义地选）⑤ 洗牌（**三段式：收拢 → 数据重排 120ms → 按层铺开**，总长硬约束 ≤800ms，层数变多时压缩步长而非拉长总长）。
- **输入锁两条规矩**：① 洗牌**提前 100ms 解锁**（等动画真正结束会多出可感知的等待）；② **收尾定时器绝不放不属于它的锁** —— `if (!this._pending) this._busy = false;` 只覆盖"拿牌"，**覆盖不到道具**（道具不置 `_pending`），会抢走道具的锁。
- ⚠️ **冒烟测试证明不了"动效真的播了"**：本轮 3 个真实缺陷（① 入场缩放补间与淡入补间共用 tag → 被 `stop` 掉、动画实际没播；② 飞行窗口内取消选中 → 落位定时器不校验归属，同张牌同时在场/在槽；③ 洗牌收尾抢锁）**在冒烟里全是绿灯**，靠第二遍**独立代码审查**才抓到。→ **以后表现层改造必须加一轮"只读 + 不看构建结果"的独立代码审查**。
- ⚠️ **本机不能用 `timeout` 命令包装子进程**（macOS 不带 GNU coreutils）：`timeout 150 node ...` 会因 "command not found" 直接空跑，而 `grep` 会把该错误过滤掉 → **看起来像通过了**。改用工具自身的超时参数。

## game-4 S7.5 音效 / 震动 / 消除动效升级（2026-09-30 完成，提交 `31e40e1`；★ 以后做音频先读这段）

用户四项需求：**① 加音效 ②「碰」= 三张先碰在一起再消除 + 连章丝滑动效 ③ 入场逐张飞入 ④ 震动反馈**。全部实装，证据归档 `docs/verify/S7.5/`。

- **音效零素材、程序化合成**：`game-4-mahjong/tools/make-sfx.py` 直出 16bit/44.1kHz WAV → 16 段 m4a（94.9KB 源 / 128K 入包）。*（v1.8 调整为 **13 段 / 79.4KB**：删 `combo/combo2/combo3/combo4`、加 `flow`。）* 基元 `bell`（泛音用**非整数倍** 2.01/3.02/4.95 产生金属拍频）/`tone`(tanh 软削波)/`sweep`(对数扫频)/`noise`。
- 🔴 **`afconvert` 会写容器时间戳 → 光固定 `SEED` 不够**：它会在 m4a 里写入「编码那一刻」的时间，落在 **3 个 box**：`mvhd`（`moov` 下）、`tkhd`（`trak` 下）、`mdhd`（`trak → mdia` 下）。只清前两个时**仍有 2 字节在变**（偏移 167/171）→ 13 个文件 md5 全变。`make-sfx.py` 已加 `zero_container_times()` 按 MP4 box 结构**递归**清零（**绝不能用 `data.find(b'mvhd')` 盲搜** —— 那 4 字节可能恰好出现在压缩音频数据里，会直接破坏音频，且是"大多数机器正常、偶尔某段变噪音"的隐蔽故障）。清完 13 段**逐字节一致**，`afinfo` 复验可解码。
- ⚠️ **`.m4a` 必须有 `audio-clip` importer 的 `.meta`**，否则落到 `unknown` importer → `resources.load` 拿不到 → **彻底没声音**。`tools/cocos-asset-meta.py` 已补 `meta_for_audio`。
- 🔴 **macOS 不支持 MP3 编码**：`afconvert` 用 `-f mp3` 报 `ExtAudioFileSetProperty ('cfmt') failed ('fmt?')` → 必须 `afconvert -f m4af -d aac -b 64000`。
- 🔴 **Cocos 3.8 的 `AudioSource` 没有 `playbackRate`**（2.x 有，3.x 移除）→ ~~连章音高**必须在合成阶段预生成 4 档**（`COMBO_RATES=[1.0,1.122,1.260,1.414]`），不能运行时变速。~~ **v1.8：连章已删除，此约束对本作不再生效，但这条 API 事实依然成立**（以后要做变速播放必须预生成变体文件）。
- **AudioService**（`ui/AudioService.ts`）：**8 条声道池**而非 `playOneShot`（因为 `playOneShot` 也改不了 rate，为不让连章走特殊链路就统一走上池）；`MIN_GAP_MS=45`；入场落牌 `FLY_IN_LAND_GAP_MS=130`（24 张牌 1 秒落地，不节流会糊成白噪声）；**加载未完成静默跳过、绝不补播**（补播的是 300ms 前该响的声音）。全部就绪打 `[AudioService] 音效就绪 13/13`（v1.8；原 16/16） —— **无头验证时这是"音频加载成功没有"的唯一线索**。
- **「碰」的三段式**：蓄力（各退 12px）→ **冲刺 `EASE_DASH='quadIn'`**（**"越冲越快"是撞击与平移的唯一区别；`quadOut` 会像"小心翼翼靠拢"**）→ 撞击帧（squash `0.84/1.16` + 冲击环 + 碎屑 + 踢牌堆 + 音 + 震）→ `POP_HOLD=0.06s` 停一拍 → 释放（胀 1.20 → 缩 0）。八帧实证：**520ms 三张叠成一摞、650ms 槽位才空** —— "先碰再消除"在时间轴上真实成立。
- **`CLASH_OVERLAP_PENG=0.45`**：碰的三张牌面**完全相同**，叠狠不丢信息。~~`CLASH_OVERLAP_CHI=0.74`~~ **v1.8 已删除** —— 「吃」不再走撞击，改走**流水汇合**（`FLOW_OVERLAP=0.55`）。
- ❌ **【已整套删除】连章（连击）** —— ⚠️ **2026-10-01 订正：「连章」= 连击，不是「吃」**（v1.8 曾把两者写反）。本作不需要这个机制，整套已移除。以下为历史记录：**时间戳窗口**而非"定时器重置"（时间戳无状态，不存在"页面切走忘清理"的残留）。`COMBO_WINDOW=3.6s`（按实际节奏倒推；初版 2.4s 跑完整关一次都没触发）。**"丝滑"的三个定义**：够长（0.46/0.92s）+ 首尾速度为零（全程 `sineInOut`）+ 无抖动无闪烁；与「碰」的 0.2s 硬冲击形成**爆发 vs 流动**，靠时间尺度分层共存。飘字与连章**二选一**（连章信息量已覆盖牌型，再叠 96px「碰」字互相削弱）。
- **逐张飞入**：起点在目标**正上方 680px** + 横向 ±96 + 角度 ±24°，`backOut` 过冲；**按深度升序**（底层先落，否则穿模）。起始态必须在 `buildStack()` 里摆好、`playEnterMotion()` **复用不重随机**；**兜底复位必须复位 `position`**，否则那张牌永久停在屏幕外 = "牌凭空消失"。
- **震动是稀缺资源**：只用三档（light 按下 / medium 碰**与吃**的消除+复活 / heavy 失败），洗牌·加槽一律不震（v1.8：「连消」概念已随连章删除）；**误操作有声音但不震**（震动是"你做对了"的正向信号）；`MIN_GAP_MS=60`。**抖"牌堆层"而不是"整屏镜头"**（全屏抖动会改变 `view.getVisibleSize()` 与触摸坐标换算）。
- 🔴 **真机高概率故障（实测确认）**：Cocos 3.8 微信端音频走 `wx.createInnerAudioContext()`，而**产物里完全没有任何 `obeyMuteSwitch` 设置**；该属性默认 `true` = **遵循系统静音开关（仅 iOS）** → **iPhone 物理静音键拨到静音时游戏一声不响且控制台无报错**。规避：测试前确认静音键在「铃音」位。**待用户拍板是否改**（`wx.setInnerAudioOption({obeyMuteSwitch:false})`；注意 `InnerAudioContext.obeyMuteSwitch` 已被微信标记弃用）。
- ⚠️ **无头 Chrome 会把后台窗口的 `setTimeout` 节流到 1 秒** —— 本工程"状态流转只走 setTimeout"的铁律因此被破坏，表现为"拿牌→撤回→拿牌→撤回"的死循环，**看起来完全像游戏 bug**。`tools/web-smoke.mjs` 已加 `--disable-background-timer-throttling` / `--disable-backgrounding-occluded-windows` / `--disable-renderer-backgrounding` 修复（`落位放弃: 0 / 取消选中: 0` 验证通过）。**这是测试环境伪影，不是游戏 bug。**
- **真机预览出二维码**：`/Applications/wechatwebdevtools.app/Contents/MacOS/cli preview --project <产物绝对路径> --qr-format image --qr-output <png>`。CLI **冷启动 60s+**，先用 `cli islogin` 轮询探活；`--project` **必须绝对路径**。
- 顺带修掉两个缺陷：① **不限时关卡判负原因恒显示「时间到」**（结算页原用 `_timeLeft <= 0` 反推，而不限时关卡 `_timeLeft` 恒为 0）→ 改由判负入口写入 `_failReason`；② **引擎性能面板盖住槽位条**（面板画在左下角 = `SLOT_BAR_Y=-424`）→ 新增 `CFG.DEBUG.STATS` 运行期收掉，且**必须 try/catch**（`profiler.hideStats()` 在 `director.root` 就绪前抛异常会**中断整个模块 → 游戏白屏**，报错指向 profiler 与"游戏起不来"毫无因果关系）。
- 体积：**wechatgame release 3.2MB / 4MB**（余量 0.8MB）。**`CFG.DEBUG.LOG_STATE` release 包里仍为 true，提审前必须关。**
- 新增工具：`tools/anim-sheet.py`（动效连拍**接触印相图**：按设计坐标裁切 + 标注时间偏移。含必需的 `_normalize_argv` 分组逻辑，否则 `-360,-570,...` 会被 argparse 当选项报错）、`tools/smoke-run.sh`（**一条命令跑完「起服务器→冒烟→收服务器」**；Bash 工具的后台进程在调用结束就被回收，分两步做会得到误导性的 `HTTP 502` / `canvas: null`）。`tools/web-smoke.mjs` 新增三个动效验收原语：`d:<x>,<y>@<ms>`（自定义截图延迟）/ `wait:<ms>` / `auto:<n>@<gap>!<ms,…>`（撞击帧连拍）。

## game-4 S7.6 「吃」的流水汇合 + 两个真实缺陷（2026-09-30 深夜；已随 `02917d1` 提交并 push）

> 用户原话：「**连章是指 234 条，456 万这样的消除方式，不是指连击，你误会了，要修正回来。
> 后面遇到有可能引起歧义的地方，都要先问我，确认完之后再做**」

### ❌ 本节的术语结论**已被 2026-10-01（S7.7）推翻** —— 最终定义见下方 S7.7 章节
- 本节当时写的是「**「连章」= 顺子（吃）**」—— **错的**。用户 10-01 明确：
  **「连章」= 连击（本作不需要）；「吃」= 原有玩法 = 顺子（保留）**。
- 仍然成立的部分：S7.5 那套连击机制（`COMBO_*` 10 个参数 / `bumpCombo` / `playCombo` /
  4 段音频 / `make-sfx.py` 的 `sfx_combo` / `SaveService.bestCombo`）**确实全部删除**了；
  只是**删它的理由说错了** —— 正确理由是「连章（连击）本作不需要」，而不是「连章其实是吃」。
- 🎯 **顺带解开一个长期疑点：为什么自动化从没见过「吃」** —— `Generator.pickPatterns()` 给 L1 的「万」只发 2 个连号、L2 每族 2 个 → **凑不出 3 连号**；**L3 才第一次出现 3 连号**（万/条各一组），L4 三族全有。→ **「吃」的验证必须走到 L3**（`unlock:3` 直写存档 + `dirty` 逼出顺子；`auto` 只会凑碰）。
- ⚠️ **新增流程铁律（已写入用户级记忆）**：**遇到有可能引起歧义的地方，一律先问、确认之后再动手。**

### 「吃」= 流水汇合（与撞击处处互为反面）
- `playClear(m)` 变成**分流器**：`m.type === 'chi' ? playFlowClear : playClashClear`。**碰/杠 → 撞击**，**吃 → 流水汇合**。
- **两条路径的收尾共用 `finalizeClear`**（删节点 / 从槽 splice / 清 `_busy` / 左补齐 / 刷 HUD / 连锁判定 / 胜负判定）。**收尾写两份，迟早出现「碰完能连锁、吃完不能」这类只有特定牌型才复现、看起来像运气不好的 bug。**
- 参数（`CFG.MOTION` §十五）：`FLOW_STAGGER 0.07 / FLOW_SLIDE 0.30 / FLOW_OVERLAP 0.55 / FLOW_HOLD 0.05 / FLOW_LIFT 22 / FLOW_FADE 0.28`；全程 `EASE_IDLE='sineInOut'`、**无蓄力、零冲击元素（无挤压 / 无冲击环 / 无碎屑 / 不踢牌堆）、结束不缩放**（只上浮 + 淡出）。
- **音效 `flow`**（470ms，所有成分 attack 拉到 9~14ms 抹平起音、`lp=0.40` 低通噪声、上行对数扫频 523.25→1046.50Hz）必须在**第一张牌起步时**播 —— 等三张汇齐再播，听感立刻变回「撞上了」。
- ★ **「丝滑」是减出来的，不是加出来的。**

### 🐞 缺陷一：`MotionFx.to` 传参形状错 → 每帧抛引擎内部异常
- **症状**：`TypeError: Cannot read properties of null (reading 'length')` **每帧刷屏**（栈顶是引擎 `TweenAction.update`），但**不白屏**；同时「吃」的动效**静默失效**（牌根本不动）。
- **根因**：把 `chain`/`to2` 的 step 形状 `{props, duration, easing}` 误传给了 `to`（`to` 的形参是 `(node, {position}, {duration, …})`）。引擎把 `props`/`duration`/`easing` 当**属性名**去找，`Node` 上都没有 → `TweenAction._initProps` 给 `prop.start` 留的初值是 `null` → 🔑 **`typeof null === 'object'` 骗过了引擎的类型分支**（`update` 判的是 `typeof start === 'object'`）→ 去读同样为 `null` 的 `prop.keys.length`。且 `opts.duration` 为 `undefined` → 时长 0。
- **修**：改两个调用点 + 在 `MotionFx.to` 加**运行时防呆**（非法属性名直接 `error()` 并 return）—— 把「引擎深处的天书异常」换成「调用方一眼就懂的一行报错」。
- **定位线索**：只有「吃」那条路抛异常、碰 **0 异常** → 对比两条路径的调用形状即抓到。

### 🐞 缺陷二：`Generator` 兜底是死代码 → 关卡根本打不开
- **症状**：点第 3 关**没反应**、停在选关页；日志 `第 3 关 40 次采样均未通过可解性校验，已采用兜底布局` + `Cannot read properties of null (reading 'tiles')`。
- **根因**：①「开局可点牌 < `MIN_PICKABLE=6`」分支写的是 `continue`，**兜底赋值排在它后面** → 40 次全卡在 ① 时 `best` 恒为 `null` → `best!.tiles` 炸。**代码与它自己上一行的注释（宁可给一局偏难的、也不白屏）直接矛盾。**
- **实测**（每关 150 个随机种子）：硬崩率 **L2 0.7% / L3 10.7% / L4 42%** → 修后**全 0%**。
- ⏳ **待用户拍板的难度问题**：约 **90%** 的采样止步于 ①；修后落「兜底局」的比例 **L2 ~2% / L3 ~11% / L4 ~47%**。L4 近一半开局未经验证，与 §6「三堵墙」意图可能相悖。三选项：**(a)** 降 `MIN_PICKABLE`；**(b)** 改比例口径；**(c)** 接受现状。**涉及难度设计，本轮不动。**

### 🔧 新增能力：无头跑生成器（★ 以后要复用）
`Generator.ts` 只依赖 `CFG / TileData / MatchRule`（**不含 `cc`**）→ 把 4 个文件复制到临时目录、import 改成带 `.ts` 后缀 + 类型名加 `type` 内联修饰符，即可用 **`node --experimental-strip-types --no-warnings probe.ts 150`** 在纯 Node 里跑生成器，按随机种子批量统计成功率 / 硬崩率 —— **秒级拿到「千次生成」量级的结论，不用起浏览器**。探针归档：`docs/verify/S7.6/生成器兜底量化/probe.ts`。

### 🕳 验证陷阱：产物里的中文串会被 `\u` 转义
Cocos 打包后的 `assets/main/index.js` 里，**字符串字面量中的非 ASCII 会被 `\uXXXX` 转义，而注释里的中文保持原样**。→「grep 中文 UI 文案证明新代码入包」会得到**假阴性**（实测 `"[Generator] \u7B2C "` vs 注释里能搜到的 `兜底布局`）。**结论：验证产物请 grep ASCII 标识符（函数名 / 英文串）或注释文字。** 本轮先后被骗两次（`牌型=`、`非法的属性名` 都被误判成"没入包"）。

### 验收结果（证据归档 `docs/verify/S7.6/`）
- 吃（L3）：`牌型=chi(吃) → 动效=流水汇合 ｜ sou-4 sou-5 sou-6` 与 `wan-1 wan-2 wan-3`，**0 异常**。
- 碰（L1 回归）：`牌型=peng(碰) → 动效=撞击` ×4，通关 **12/12**，**0 异常**，防呆未误触发。
- 产物校验：`playFlowClear 6 / playClashClear 4 / finalizeClear 5 / playCombo 0 / bumpCombo 0`。
- `docs/game-4-DESIGN.md` → **v1.8**。**代码未提交**（铁律：不主动 commit，等用户确认）。

## game-4 S7.7 术语订正 + 连章（连击）残留清零（2026-10-01；已随 `02917d1` 提交并 push 到 `origin/main`）

> 用户原话：「**1、首先，我们把连章和吃的概念彻底分开，连章指的是连击，吃是原来的玩法；
> 2、根据我的试玩，代码里还是有连章（连击）的逻辑，请你仔细检查一下**」

### ✅ 定义（**最终版，前两次都错了，别再改回去**）
| 词 | 含义 | 处置 |
|---|---|---|
| **连章** | **连击** —— 限时窗口内连续消除的计数 | ❌ 本作**不需要** → 已删干净 |
| **吃** | **原有玩法** = 顺子（`MatchRule` 的 `chi`，同花色连号 3 张，如 `234条`/`456万`） | ✅ **保留**（含流水汇合动效 + `flow` 音效） |

### 🔴 最大教训：「试玩结果与代码不一致」时，**第一步先比产物与源码的时间戳**
- 用户试玩截图里有「连章 ×2」，但**源码里早已没有这套逻辑**。
- 真因：试玩用的是 **`build/wechatgame` 产物，且它还是删除前（09-30 22:15）构建的旧包**；
  而 **`build/` 被 `.gitignore` 排除 → 默认的文件搜索会直接跳过它**（这才是"看着像代码没改"的成因）。
- **排查动作**：① 先 `stat` 产物与源码的 mtime；② 用 `os.walk` / 显式路径**强制扫 `build/`**，不要依赖默认 grep。
- 时间线：`09-30 22:15 建旧包（含连章）→ 22:20 提交 31e40e1（删除改动未提交）→ 23:39 建 web 包（已删）→ 10-01 09:41 重建微信包`。

### 本轮改动
- `core/SaveService.ts`：删 `SaveData.bestCombo` 字段 / `makeDefault()` 里的默认值 / `load()` 里的解析 /
  **`setBestCombo()`（S1 遗留，从未被调用）**；文件头「最高连击」一并去掉。
  旧存档里多出的 `bestCombo` 被解析器直接忽略 → **无需迁移**。
- `tools/web-smoke.mjs`：伪造存档同步去掉 `bestCombo`。
- 把概念讲反的注释（`CFG.ts` §十五、`GamePage.ts` 三处 JSDoc、`AudioService.ts` 文件头、
  `make-sfx.py`、`web-smoke.mjs`）统一改为正确定义；**用户原话保留原文 + 方括号注明所指**（不改写用户原话）。
- ✅ **没动的东西**：四关规则、难度、槽位/道具/胜负判定、`CFG.MOTION` 一个数值、`flow` 音效、飘字「吃」。

### 验收（证据归档 `docs/verify/S7.7/`）
- **标记归零**：微信 release 产物里 `playCombo`/`bumpCombo`/`COMBO_`/`COMBO_RATES`/`setBestCombo`/`bestCombo`/`combo`/`连章` **全部为 0**；
  web debug 包仅**注释**里命中（release 会剥离注释，故微信包为 0）。
- 音频：包内 **13 段 / 79.4KB**，`combo*.m4a` 已不在包内，`flow.m4a`（uuid `8e6bcd66-…`）在包内。
- 玩法回归：`吃`（L3）`牌型=chi(吃) → 动效=流水汇合 ｜ sou-4 sou-5 sou-6`、`wan-5 wan-6 wan-7`；
  `碰`（L1）→ 撞击 ×3；**均 0 异常**；`音效就绪 13/13`。
- 包体 **3.0MB / 4MB**。新真机码 `docs/verify/S7.7/device/真机预览二维码.png`（**09-30 的旧码作废**）。
- `docs/game-4-DESIGN.md` → **v1.9**。

## game-4 S7.8 首次提交并推送 GitHub（2026-10-01 上午；用户明确授权）

**提交 `02917d1`**（67 files, +1956/−432），推送到 `origin/main`（见本文档「指针」节的远程仓库）。

### ★ 以后往 GitHub 推任何项目，照这四步走
1. **先查有没有远程**：`git remote -v`。本项目此前**一直是空的** —— 基线时只做了 `git init -b main`，
   **从未配远程**。别假设"有 git 就有远程"。
2. **可见性 / 仓库名 / 敏感目录是否随行公开 —— 三件事都先问用户**（本次三件都问了，无一自行决定）。
3. **推公开仓库前跑一次敏感信息扫描**（可复用清单）：手机号 / 身份证 / 邮箱 / AppSecret·token·password /
   真实姓名 / 工作单位 / 个人生活信息 / 本机绝对路径。**AppID 本身是公开标识符，不算敏感**
   （但**绝不能出现 AppSecret**）。本次结论：62KB 笔记**无隐私内容**，仅 6 个 AppID + `/Users/consli`。
4. **判断"能不能干净地排除某个目录"要先查它在历史里的深度**：
   `git log --format=%h --reverse` + 逐提交 `git ls-tree -r --name-only | grep '^目录'`。
   本次查明 `.workbuddy/memory/` **从最早的 `a4054d3` 就在历史里**（5 个提交全有）→ 排除 = 必须
   `git filter-repo` **重写全部历史、所有 hash 变化**。用户权衡后选择不重写（历史完整性优先）。

### 建仓与推送命令（已验证可用）
```bash
gh repo create <user>/<repo> --public --source . --remote origin --push --description "..."
# 会一并完成：建远程 + 加 origin + 推送当前分支 + 设上游
```
`gh` 已登录 `Scott12138`（keyring 令牌，**SSH** 协议，scopes 含 `repo`）；`ssh -T git@github.com` 可用。

### 规矩
- **push 仍须每次用户明确说**（本次是用户说的「先提交并推送」）。不许因为"已经有远程了"就顺手推。
- `build/` 由 `.gitignore` 排除，**永不入库**；`docs/verify/*/device/*真机预览二维码*.png` 这类会过期的图
  入库时必须在同目录 README 标注「旧码作废」，否则后人会扫到失效码。

## game-4 S1 架构（2026-09-30 完成，后续里程碑都在此骨架上叠加）

### 目录与文件

```
game-4-mahjong/
├─ assets/scenes/Main.scene        ← 手写，只有 Canvas + Camera，【零脚本引用】
├─ assets/scripts/
│  ├─ CFG.ts                       ← 参数总枢纽（唯一 magic number 出处）
│  ├─ Bootstrap.ts                 ← 运行时把 GameRoot 自挂到 Canvas
│  ├─ GameRoot.ts                  ← 总装车间 + PAGE 常量 + 页面注册表
│  ├─ core/PageManager.ts          ← 页面状态机（注册/切换/过渡）
│  ├─ core/SaveService.ts          ← sys.localStorage 存档（容错，坏数据不白屏）
│  ├─ core/Diag.ts                 ← 【已休眠】清屏色信号灯排障法
│  └─ ui/{UIFactory,PageBase,MenuPage,LevelSelectPage}.ts
├─ build-config/wechatgame.json    ← AppID 走这里（configPath 通道）
└─ settings/v2/packages/{project,engine}.json   ← 设计分辨率 720×1280 fitWidth / 引擎裁剪
```

⚠️ **工具脚本在「工作区根」`tools/`，不在工程内**：`tools/{cocos-build.sh, wechat-open.sh, web-smoke.mjs, anim-sheet.py, smoke-run.sh, cocos-asset-meta.py, page-shot.mjs, probe-console.mjs}`；`game-4-mahjong/tools/` 里**只有** `make-sfx.py`。

### 设计约定（改代码必须遵守）

- **代码驱动 UI**：场景文件不含任何逻辑，所有界面在 `onBuild()` 里用 `UIFactory` 创建。新增页面 = 继承 `PageBase` + 在 `GameRoot.registerPages()` 注册一行。
- `CFG.ts` **刻意不 import `cc`** → S4 的无头求解器测试可以直接在纯 Node 里 import 它跑。
- `PageBase` 生命周期：`__build()` → `onBuild()` / `__enter()` → `onEnter()` / `__leave()` → `onLeave()`。
- 铁律：**状态流转必须走"必然执行"的路径，动效只负责好看**（解锁用 `setTimeout`，绝不用 tween 回调）。

### S1 踩过的坑（按坑的隐蔽度排序，报错全都指向错误方向）

| 现象 | 真实原因 | 解法 |
|---|---|---|
| 构建"成功"但运行白屏；`Script "xxx" is missing or invalid` | 无头构建下 asset-db 反序列化场景**早于**脚本类注册 → 场景里的自定义组件被静默丢弃（产物里脚本 bundle 其实是完整的） | 场景保持**零脚本引用**，改由 `Bootstrap.ts` 运行时自挂 `GameRoot`（双路径：`EVENT_AFTER_SCENE_LAUNCH` + 立即试一次） |
| UI 全空、`Draw call 1 / Instance Count 0` | ① 运行时 `new Node()` 默认在 `DEFAULT` 层，而 2D 相机只渲染 `UI_2D`；② **真因**：`GameRoot.onLoad` 漏调 `PageManager.create()` → `.open()` 抛 TypeError 中断了后续 | ① 显式 `node.layer = Layers.Enum.UI_2D`；② `PageManager.instance` 改**抛异常**而非静默返回 null，让这类 bug 立刻暴露 |
| 页面切一次后再也切不动 | 解锁 `_transitioning` 挂在 `tween().call()` 上，动效链路一断回调不触发 → 状态机永久死锁 | 改 `setTimeout(..., 时长+20ms)` |
| 网页版画面被裁一半、点击坐标全偏 | web 模板写死 `#GameDiv{width:1280px;height:960px}`，窗口更窄时 canvas 溢出 → `view.getVisibleSize()` 错成 720×540 | 验证脚本锁 720×1280 视口 + 注入 CSS 撑满，并**自检 `visible === 设计分辨率`** |
| 注入的 `<style>` 不生效 + `Cannot read properties of null` | `Page.addScriptToEvaluateOnNewDocument` 执行时 `document.head`/`documentElement` **都还是 null** | `MutationObserver` 盯 `document` 子树，等 head 出现再插入 |

### 自动化验证：无头点击冒烟测试（★ 以后每个里程碑都用它）

微信开发者工具**没有可编程交互接口**，命令行又看不到控制台；Cocos 画面是 canvas、**无法用 DOM 选择器定位按钮**。但 web-desktop 版与微信版**共用同一份 TS 逻辑**，所以在浏览器里点一遍即可等价验证。

```bash
bash tools/cocos-build.sh web-desktop debug game-4-mahjong
python3 -m http.server 8123 --directory game-4-mahjong/build/web-desktop &
node tools/web-smoke.mjs http://127.0.0.1:8123/index.html /tmp/smoke d:0,-120 d:0,240
```

- `d:<x>,<y>` 是**设计坐标**（原点=屏幕中心、y 向上，与 Cocos 一致）→ 点击坐标与 `CFG` 布局常量一一对应，**读代码即可写测试，不用量像素**。
- 产出 `00-before.png` / `01-click-*.png` / `console.log`（**能读到业务 `log()`，这是命令行链路下唯一的可观测性来源**）/ `metrics.json`。
- 必须确认脚本自检那行是 **`✅ 引擎可见尺寸 = 设计分辨率 720×1280`**，否则一切点击坐标都不可信。
- 零依赖：本机 Chrome + Node 22 内置 `WebSocket` 直连 CDP（不用 playwright，避免全局安装污染环境）。
- 同类工具与上述坑已固化进 skill **`cocos-to-wechat-minigame`**（含 `scripts/web-smoke.mjs`）。

## game-4 S2 架构（2026-09-30 完成；**第一个"真正能玩"的版本**）

**新增脚本**（都在 `assets/scripts/`，每个都配了手写的 `.ts.meta`）：
- `TileData.ts` —— 27 张真牌排布数据 + 真牌三色 + 牌体几何（**纯数据，不 import cc**）
- `core/MatchRule.ts` —— 碰/吃/杠判定（纯函数，**不 import cc**；游戏与求解器共用同一份实现，防止判定逻辑分叉）
- `core/Generator.ts` —— 牌堆生成 + 可解性求解（**不 import cc**，可无头跑）
- `ui/TileRenderer.ts` —— `TileView` 类：SVG 画法 → Cocos Graphics（**全工程唯一翻转 y 轴的地方**，别在别处再翻一次）
- `ui/GamePage.ts` —— 玩法页

**堆叠方案（用户 2026-09-30 调整：要更立体、更随机，不要固定金字塔）**
- 横向格距 `STACK.CELL_W=68` ≥ 牌宽 64 → 同一行相邻牌互不遮挡（**这条不能省，否则读不清"谁压谁"**）
- 纵向格距 = 牌高 × `CELL_H_RATIO_STACK(0.48)` → 上一行的牌压住下一行，**多层立体感自然涌现**，不需要硬编码"第几层"
- L1 教学关走 `CELL_H_RATIO_FLAT(1.02)` 不重叠 → 18 张一次看全、全部可点
- 采样权重（`WEIGHT_X 0.45` 中密 / `WEIGHT_Y 0.62` 下密）+ ±2px 抖动 → **每局轮廓都不同**
- 牌面尺寸因容量约束定为 **64×85**（不是设计稿的 84×112）：L4 的 90 张要在 570×625 里排下，84 宽只够 84 个格点，落不下

**遮挡判定**：矩形相交 + 深度更大 → 被压住；维护 `_blocked[]` 增量计数，判定 O(1)。
**点击**：页面级**统一命中测试**（不给每张牌挂监听）—— 一次点击只认最上面那张，被压住的就吃掉这次点击、不穿透。
**保证有解**：按 3 张一组构造 → 随机落位 → 跑 60 局随机化贪心模拟，通得过才采用（上限 40 次重采样）。
实测通过率 **L1 100% / L2 55% / L4 68%**，**L4 生成耗时仅 69ms**（不卡启动）。

**S2 未做**：道具栏（S6）、正式结算面板（S7，现用 toast 占位）、音效（S7）。

### ★ 冒烟测试新增 `auto` 动作（以后验证玩法必备）
```bash
node tools/web-smoke.mjs http://127.0.0.1:8123/index.html /tmp/smoke d:0,-118 d:0,275 auto:26
```
- `auto:<n>` = 自动试玩 n 步：**从游戏自报的日志里读可点牌坐标**再点击。牌位是随机的，脚本没有视觉识别能力，只能靠游戏自己说。
- 游戏侧对应输出（DEBUG 开关控制）：`[GamePage] 牌局 已清=.. 槽=../8 槽内=[..] 可点=.. ｜ wan-1@x,y ...`
- 实测自动通关 L1（18 点 18 清、6 组消除全中），随后自动进 L2 验证多层叠压。
- S2 验证截图归档在 **`docs/verify/S2/`**。

## game-4 界面改版（2026-09-30 傍晚；**方向已拍板 = C 国潮描边**）

- 用户暂停 S2、要求先美化页面，并启用了 UI 设计专家「像素君」。
- 对比稿（历史决策留痕）：**`docs/design/style-directions.html`**（A 软糖玩具／B 清爽扁平／C 国潮描边）。
  - 我当时推荐 A、并**警告过 C 的合规风险**（朱红+墨+金＝棋牌经典配色，与「必须申报休闲益智类目、不可读作棋牌」冲突）。
  - **用户最终仍选 C，并接受该风险**（与其"先不管合规、把玩法做出来再说"的一贯态度一致）。该决定已记入对比稿的结论区。
- 市场依据：2026 主导风格 = **tactile minimalism（触感极简）**；**claymorphism** 被点名为最适合休闲品类；同类头部均为 Q 萌高饱和；用色参考 **60/30/10**。
- ★ **C 方案的权威设计文件 = `docs/design/guochao-tiles.html`（v2 真牌校色版，已定稿）**（+ 静态导出 `.png`）。含 27 张牌完整矢量设计、状态反馈、尺寸校验、三张页面稿、以及可直接粘贴的 `TILE_PATTERN` 数据表。
  - **牌面 = 现实麻将真实图案**（用户硬要求，且用户提供了真牌参考图 `docs/design/ref-real-mahjong.png`）。
  - ★ **牌面用色（照真牌实测，v2 修正）**：蓝 `#2338A0` / 红 `#B02A1E` / 绿 `#2E6B45`。
    - **万**＝中文数字（**蓝**）+ 繁体「萬」（**红**）；**五萬写作「伍」**（财用大写）。
    - **条**＝竹节（**绿**）+ 定点红蓝：5 条中红、7 条**顶红 + 中列蓝**、9 条**中列红**；1 条＝鸟（幺鸡，红棕冠/白脸/蓝眼喙翅/绿身/红棕长尾，**画鸟，已拍板**）。
    - **筒**＝圆饼（**多色**）：1＝深蓝→绿→红→白心；2＝上绿下蓝；3＝绿红蓝斜排；4＝对角同色；5＝四角蓝绿+中心红；6＝**上2绿+下4红（2列×3行）**；7＝上3绿阶梯斜排+下4红；8＝全蓝(2列×4行)；9＝上绿中红下蓝。
    - 圆饼四层同心：**最深外环 → 同色浅调 → 族色 → 浅心**（浅调用 `tint(色,0.50)`，**不是白**）。
    - **金不进牌面**（已拍板）：金仅用于页面标题描边 + 「消除中」反馈圈。
  - 框仍是国潮：宣纸 `#F2EADA` / 牌面 `#FBF6EA` / 墨 `#22201C` / 朱红角花 `#C4362B`。**牌面归真牌、框归国潮**。
  - 竹节定稿画法：**中央竖向高光（0.26w）必须连续贯通** + 左右两侧短缺口（**宽必须 <0.37w**，实取 0.22w；厚 0.05h；位置 y±0.22h）。**缺口一旦与高光接上就会把整根切满、又变绷带**（踩过两次）。
  - 坐标系固定 **132×176**，绘制时按 `实际牌宽/132` 缩放。元素大小照真牌实测（筒子几乎相切、条子占内框 ~85%）。
  - ~~给 S2 的参数结论：`CFG.GAMEPLAY.LAYER_OFFSET_Y` 锁定 26–40px~~ —— **已被 S2 实装推翻**：新版改用 `CFG.STACK.CELL_H_RATIO_*`（纵向格距系数）统一表达叠压程度，不再有独立的"层间偏移"参数。
- 落地路径（四层）：**色层 → 形层 → 字层 → 牌层**，令牌写进 `CFG.ts`、改造 `UIFactory.ts`、新增 `TileRenderer.ts`。**设计稿已定稿，可直接开工**（游戏代码仍未动）。
- 工具：`tools/page-shot.mjs`（任意页面 → PNG，设计稿自检必备）。

### 方法论（以后处理「参考图 → 设计稿」都照这个来）

低分辨率参考图**不要靠肉眼估色/估比例**，做像素统计：
1. 按网格切分 → 逐格统计色相构成（定位主色）；
2. 3×3 子格颜色图 → 还原队形与配色分配；
3. **ASCII 彩图**（`R/B/G/.` 字符画）→ 直接「看见」形状，比缩略图可靠得多；
4. **bbox 宽高比** → 判定行列数（低分辨率下数不清几列时，用高>宽还是宽>高来定）；
5. **过圆心的水平扫描线 / 游程** → 定内部层次。**别用质心**，质心会被外圈拉偏。

---

## game-4 美术定稿与美工协作（2026-09-30 收尾；★ 以后做美工先读这段）

**状态：美工部分已定稿**（用户验收通过）。游戏代码仍一行未动。

- ★ **唯一权威设计依据 = `docs/design/guochao-tiles.html`**（10 节）。**改视觉只改这里，不要直接改代码里的颜色值**（设计稿是源、代码是产物）。
- ★ **索引与交接说明 = `docs/design/README.md`**（含完整色板 / 字号阶梯 / 形态四规则 / 硬约束 / 落地路径 / 验收工具 / 提审风险）。**动手前先读它。**
- **界面基准图 = `docs/design/screens/{01-菜单页,02-关卡页,03-游戏页}.png`**（720×1280 的 4 倍，1320×2348）。
  ⚠️ 这是**设计稿矢量渲染**，**不是引擎实跑截图**（实跑的在 `docs/verify/`），别混用。
- 🎨 **做美工就找 UI 设计专家「像素君」**（入口：左侧边栏「专家」）。用户明确要求：本项目以后再需要美工**继续找他**，并把 `design/README.md` + `guochao-tiles.html` 一并交给他。
- **四条交付约定（用户明令）**：① 一律以最新版设计为准；② 新图产出后**替换旧图**；③ 旧图**归档不删**（改名标 legacy 或移入 `archive/`），保住可回溯；④ 改完 `grep` 旧值核对交叉引用（设计稿里常手抄了第二份副本）。
- **万子纵向居中定稿参数**：数字 `y=72` / 萬 `y=144`（132×176 坐标系，牌面中心 y=88）。**是像素实测出来的**——原 86/158 使整块下沉 14.4px，萬字底还压出内墨线 0.5px。
  - ⚠️ 量文字居中**不能用 SVG `getBBox()`**（返回 font box ≈1.39em，含行高空白，算出的偏移会偏小），要用 canvas `measureText().actualBoundingBoxAscent/Descent` 取**墨迹**真值。中文字面框经验值 ≈ `[基线−0.795em, 基线+0.186em]`。
  - ⚠️ 「一」这类字墨迹天生偏下，**绝不能为它单独挪基线**（一挪其余 8 张全偏上）。判据是**整排平均中心**。
- **旧风格存档**：`docs/verify/S1/` 下三张是 **S1 期原始风格**（墨绿底＋金色立体字＋红圆角按钮）的冒烟测试截图，**非定稿视觉**，仅作功能验证留痕，别当设计参考。
- 定稿时已修正权威稿的规格笔误：牌面字号由文档写的 60/54 改为与实际一致的 **64/58**。
- 新增可复用脚本（已收进技能 `ref-image-to-art-spec/scripts/`）：`svg_metrics.mjs`（页面内执行 JS 量 SVG 包围盒/跑 canvas 取墨迹）、`shot_with_eval.mjs`（注入 DOM 后按区域截图，做改前改后对照）。

## game-4 S6 + S6.5（2026-09-30 完成；道具四件套 / 激励门禁 / 失败复活 / 牌面放大）

**状态：已实装并自动化验收通过**（截图 + 日志归档 `docs/verify/S6/`）。设计依据已升 `docs/game-4-DESIGN.md` v1.5。

### 交付内容
- 新增 `ui/RewardGate.ts`（激励门禁，347 行）；重写 `ui/GamePage.ts`（≈950 行，加暂存架/道具栏/四件套/失败面板）。
- 改 `core/Generator.ts`（`resolvePositions` 抖动分离、`planReshuffle` 影子副本）、`core/SaveService.ts`（每日分享计数）、`CFG.ts`（v0.3.0，新增 `PROP`/`REWARD`/`STACK.JITTER_*`）。
- 用户拍板的界面调整：**牌面 64×85 → 128×171（2.00×/2.01×）**；堆叠去网格化。

### ★ 六条值得复用的经验（都踩过坑）
1. **「消除」不能只消 1 张**：牌是 3 张一组构造的，消 1 张必留 2 张死牌 → 道具亲手制造死局（首次自动化测试就把 L1 卡在 10/12）。改为**消被点牌所在整组 3 张**，守住不变量「每个牌面在局张数 ≡ 0 (mod 3)」。
2. **「先算方案 → 再要权限 → 最后提交」**：洗牌/复活都先在**影子副本**上算可解布局，算不出就**零改动 + 不放行**。不加这步 = 玩家看完 15 秒广告发现牌还是死的。
3. **重排类功能的最小门槛必须随残局放宽**：为满局设计的 `MIN_PICKABLE=6` 在残局 5~8 张时几乎无法满足 → **洗牌静默失败**（表现为"点了没反应"）。改为 `minPick = max(2, min(6, ceil(ids/3)))`。
4. **门禁面板只"转交"不放行**：初版在面板点按钮时就放行了 → 等于**没看广告也能用道具**。真广告/模拟广告/分享必须收敛到同一个 `settle(ok)`。
5. **复活要做对两件事**：① 槽里的牌**退回场上**而非销毁（销毁会永久少牌 → "清空全部牌"永远达不成）；② 退回后**必须重排并保证可解**。按 `id` 精确定位（同名多张时按牌面找回会还原错）。
6. **「先看日志」的验证有盲区**：本轮三个面板排版缺陷（副标题被按钮压住、按钮文案末字被裁、标题与副标题只剩 3px）**全是逻辑正确但视觉错**，只有**截图留痕**才发现。→ 每个里程碑必须截图。

### 冒烟测试新增 `dirty:<n>` 动作（负向测试原语）
`auto` 是"聪明地玩"→ 永远通关，**测不到失败分支**。`dirty` 与它完全相反：专挑"槽内该牌面张数最少"的牌点，**绝不凑成 3 张** → 槽位一满立刻判负。用来稳定回归「失败/复活/兜底」这条真实游玩里很难复现的链路。已同步进技能。

### 容量倒推（张数为何从 18/60/78/90 降到 12/18/21/24）
牌堆区 588×664，牌 128×171，纵向格距 171×0.48≈82 → **4 列 × 7 行 = 28 格点** → 上限 28，取 24。
**不是难度变了**，难度改由 `patterns`(4/6/8/9) 与 `solveRate` 承担。想回 60/90 张必须把牌面调回 80 上下，二者不可兼得。

### 体积
`wechatgame release = 3.0MB`（cocos-js 2.5M + assets 272K + web-adapter 88K），红线 4MB，**余量 1.0MB**。

