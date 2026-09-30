# 项目长期记忆（本工作区）

## 指针
- **课程主工程在旧工作区**：`/Users/consli/WorkBuddy/2026-09-07-15-28-47/wechat-mini-game-course/`（game-1 接水果、game-2 合成大西瓜、game-3 牛仔套索 9 关已全通，权威上下文读那里的 `KNOWLEDGE_PACK.md`）。
- game-3 正式 AppID `wxfaa19afc583badd9`；game-3 Step5（商店/换装/无尽牧场）挂起未做；包体积 3.96MB/4MB 告急。

## game-4（2026-09-30 启动；**S1 已完成并验收；美工已定稿**，可进 S2 + 美工落地）
- **定稿名称：《麻麻大消除》**（工作代号 mahjong-chipeng，工程目录 `game-4-mahjong/`）。定稿文件 = **`docs/game-4-DESIGN.md`（v1.3，唯一设计依据）**。
- 选题：麻将吃碰三消（叠塔三消骨架 + 万/条/筒牌面），参考用户兄弟做的「吃碰来一局」。
- 已拍板：消除类 → 叠塔三消 → 多层金字塔堆 → 麻将牌面 → **4 关三堵墙（无无尽）** → 道具四件套（消除/移出/洗牌/**加槽**）全看广告+分享 → **技术栈 Cocos Creator 3.8.8（代码驱动 UI）**。
- 🔄 **AppID：暂用测试号 `wxfaa19afc583badd9` 开发**（2026-09-30 用户改口：先不管合规/版权，用测试 AppID 把玩法和代码做出来再说）。⚠️ **上线前必须换号**——此号是 game-3 线上版在用的，拿它上传会覆盖 game-3。
- **Git 已建基线**（用户硬要求"每次修改都能回溯"）：工作区已 `git init -b main`，`.gitignore` 排除 `library/ temp/ local/ build/ profiles/ node_modules/ _toolchain-verify/`，基线提交 `a4054d3`。**S1 代码尚未 commit**（等用户确认再提）。
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
- **体积实测**：**game-4（纯 2D，引擎已裁剪）wechatgame release = 2.9MB**（cocos-js 2.5M、`assets` 仅 **212KB**、web-adapter 88K）；debug 6.0M。→ 红线 4MB，**余量 1.1MB，技术栈确认可行** ✅。assets 只有 212KB 是「代码驱动 UI + 矢量画牌面、零贴图」的直接红利。仍可回收的余量：`settings/v2/packages/engine.json` 里 `spine`/`dragon-bones`/`tiled-map`/`video`/`webview`/`physics-2d-box2d` 全用不到（启动日志出现 `[PHYSICS2D]: register box2d.` 就是它在包里的证据）。
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
├─ settings/v2/packages/{project,engine}.json   ← 设计分辨率 720×1280 fitWidth / 引擎裁剪
└─ tools/{cocos-build.sh,wechat-open.sh,cocos-asset-meta.py,web-smoke.mjs}
```

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
  - 给 S2 的参数结论：`CFG.GAMEPLAY.LAYER_OFFSET_Y` 锁定 **26–40px**。
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
