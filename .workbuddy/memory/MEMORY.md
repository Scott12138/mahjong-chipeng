# 项目长期记忆（本工作区）

## 指针
- **课程主工程在旧工作区**：`/Users/consli/WorkBuddy/2026-09-07-15-28-47/wechat-mini-game-course/`（game-1 接水果、game-2 合成大西瓜、game-3 牛仔套索 9 关已全通，权威上下文读那里的 `KNOWLEDGE_PACK.md`）。
- game-3 正式 AppID `wxfaa19afc583badd9`；game-3 Step5（商店/换装/无尽牧场）挂起未做；包体积 3.96MB/4MB 告急。

## game-4（2026-09-30 启动；**框架 v1.3 已定稿，未写代码**）
- **定稿名称：《麻麻大消除》**（工作代号 mahjong-chipeng，工程目录 `game-4-mahjong/`）。定稿文件 = **`docs/game-4-DESIGN.md`（v1.3，唯一设计依据）**。
- 选题：麻将吃碰三消（叠塔三消骨架 + 万/条/筒牌面），参考用户兄弟做的「吃碰来一局」。
- 已拍板：消除类 → 叠塔三消 → 多层金字塔堆 → 麻将牌面 → **4 关三堵墙（无无尽）** → 道具四件套（消除/移出/洗牌/**加槽**）全看广告+分享 → **技术栈 Cocos Creator 3.8.8（代码驱动 UI）** → **AppID 新注册一个**（不复用 game-3 的 `wxfaa19afc583badd9`）。
- 🚫 **命名雷区词表**（已两次踩坑）：① **「消消乐」是注册商标**（乐元素/天津乐浣，第 9+41 类，判赔 220 万，法院不认通用名称抗辩）；② **「X了个X」**（羊了个羊系命名饱和 + 「麻了个麻」有侵权判例）；③ 碰了个碰/吃碰杠/三缺一/碰碰胡 均已被占用。→ 安全的是「消除」二字（法院认定是通用名称）。中文名 2–15 字；**个人主体每年仅 2 次改名**，未发布的小程序共 3 次；最终以 mp 后台「名称检测」为准。
- 🔴 **最大非技术风险：个人主体的类目约束**。用户主体＝**个人主体（身份证）**；微信运营规范 1.5「棋牌类、角色类不对个人开发者开放」，官方口径「牌类**均需版号**」。→ 必须申报「**休闲益智**」类目 + 游戏内零棋牌语义（不出现胡牌/番数/筹码/对战）。乐观依据：微信上大量麻将题材消除游戏类目都是"休闲益智/消除"，「2048大消除」获版号申报类别＝移动-休闲益智。个人主体还**不能开内购**（本作无经济系统，天然符合 ✅）+ 必须办**软著**（约 1 个月，S1–S2 就该提交）。
- 换题材兜底：若被判牌类驳回，把万/条/筒换成自研图案，**机制与代码零改动**。
- 铁律照旧：先 DESIGN.md 拍板再写代码；不主动 commit/push；代码中文详细注释、参数集中 CFG。
- 详细过程见 `2026-09-30.md`。

## Cocos 环境（2026-09-30 已验证可用）
- 已装：Dashboard 2.2.2（`/Applications/CocosDashboard.app`）、Creator **3.8.8**（`/Applications/Cocos/Creator/3.8.8/CocosCreator.app`，4.1GB）、微信开发者工具（`/Applications/wechatwebdevtools.app`）。
- 工程：正式工程 `game-4-mahjong/`（模板生成，**缺 Main.scene，待 S1 补**）；验证工程 `_toolchain-verify/hello-world/`（3D 模板全量副本，用于验证链路，别删）。
- **无头构建三坑（已封装成 `tools/cocos-build.sh`，务必用它）**：
  1. 必须 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`，否则 Electron 被当纯 Node 跑，报 `bad option: --project`；
  2. 必须加 `--no-sandbox --disable-gpu`，否则 Chromium 内嵌沙箱初始化失败 → exit 133；
  3. 工程必须有场景并设为启动场景，否则报 `cannot be set as the Start Scene`。
  - 用 Bash 工具跑时需 `dangerouslyDisableSandbox: true`（前台，后台运行会丢权限）。
- **体积实测（wechatgame）**：debug 13MB（cocos-js 7.2M）／release 9.0MB（**cocos-js 3.6M** + 示例 3D 资源 5.2M）。→ 引擎必须做**模块裁剪**（纯 2D 砍 3D/物理/骨骼，预计降到 1.5–2.5M）；我们的 2D 资源约 300KB 级 → 主包可压在 4MB 内，**技术栈可行**。
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
- ⚠️ **AppID 归属待定**：`wxfaa19afc583badd9` 是 game-3 在用的号，**用它上传 game-4 会覆盖 game-3 线上版**。用户已有两个号：game-1/2＝`wx817f07150e00efa1`，game-3＝`wxfaa19afc583badd9`。上线前必须定复用还是新注册。
