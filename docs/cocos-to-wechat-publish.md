# Cocos 项目 → 微信小游戏：构建与上线全流程

> 本文回答一个具体问题：**Cocos 里写好的项目，怎么变成能玩的微信小游戏、怎么上传发布？**
> 所有命令和路径都在本机实测通过（2026-09-30）。可直接照着做。

---

## 0. 全景：一共只有 4 步

```
① Cocos 里构建          ② 导入微信开发者工具       ③ 上传体验版         ④ 提交审核发布
   build/wechatgame   →   本地模拟器跑起来      →    mp 后台看到开发版本 →  用户能搜到/能分享
   （生成小游戏包）        （预览 + 真机调试）        （扫码给朋友试玩）      （正式上线）
```

**关键认知**：Cocos 只负责「把项目编译成微信小游戏代码包」，它**不负责上传**。
上传发布是微信开发者工具 + 微信公众平台（mp.weixin.qq.com）的事。

---

## 1. 环境就绪清单（本机已全部满足）

| 组件 | 位置 / 版本 | 状态 |
|---|---|---|
| Cocos Creator | `/Applications/Cocos/Creator/3.8.8/` | ✅ 3.8.8 |
| Cocos Dashboard | `/Applications/CocosDashboard.app` | ✅ 2.2.2 |
| 微信开发者工具 | `/Applications/wechatwebdevtools.app` | ✅ 36.6.0 |
| 开发者工具 CLI | `.../Contents/MacOS/cli` | ✅ 可用 |
| 开发者工具登录状态 | `cli islogin` → `{"login":true}` | ✅ 已登录 |
| 开发者工具服务端口 | 已开启（工具自选随机端口，如 24496） | ✅ 已开 |

---

## 2. 步骤一：Cocos 侧的构建配置

### 2.1 唯一可靠的 AppID 通道（踩过的坑）

Cocos CLI 的 `--build` 参数**顶层写 `appid=xxx` 会被静默忽略**，构建出来仍是模板自带的 demo AppID（`wx6ac3f5090a6b99c5`）。
唯一可靠的通道是 **`configPath`** —— 传一个 JSON 文件，AppID 写在 `packages.wechatgame.appid`：

```jsonc
// game-4-mahjong/build-config/wechatgame.json
{
  "platform": "wechatgame",
  "debug": false,
  "outputName": "wechatgame",          // 固定输出目录名，工具里的项目路径不用每次改
  "packages": {
    "wechatgame": {
      "appid": "wxfaa19afc583badd9",   // ← 真正的 AppID 写这里
      "orientation": "portrait"
    }
  }
}
```

> ⚠️ **AppID 归属问题（上线前必须确认）**：`wxfaa19afc583badd9` 目前是 **game-3（牛仔套索）** 在用的 AppID。
> 一个小游戏 AppID 只能承载一个小游戏——**如果用同一个 AppID 上传 game-4，会覆盖 game-3 的线上版本**。
> 开发阶段随便用（不上传就没事），但**正式上传前**要去 mp 后台确认是复用还是新注册一个。

在编辑器图形界面里对应的字段：**构建发布面板 → 平台选「微信小游戏」→ AppID**（填的就是上面这个值）。

### 2.2 如果不想用脚本：编辑器图形界面路径

1. Cocos 编辑器打开工程 → 顶部菜单 **项目 → 构建发布**（或工具栏「构建发布」）
2. **平台** 选 `微信小游戏`
3. 填 **AppID**、**设备方向**（竖屏 `portrait`）
4. 点 **构建** → 产物落在 `<工程>/build/wechatgame`
5. 点 **构建** 旁边的小三角 → **运行**，可直接拉起微信开发者工具（首次需在
   **偏好设置 → 程序 → 微信开发者工具** 里指定路径 `/Applications/wechatwebdevtools.app`）

---

## 3. 步骤二：命令行构建（一键脚本）

```bash
cd /Users/consli/WorkBuddy/2026-09-30-14-03-17

# 用法： bash tools/cocos-build.sh [平台] [debug|release] [工程] [动作]
bash tools/cocos-build.sh                                        # 构建 game-4 微信 release
bash tools/cocos-build.sh wechatgame debug                       # 构建 debug 版（带 sourcemap，包更大）
bash tools/cocos-build.sh wechatgame release game-4-mahjong both # 构建完自动打开微信开发者工具
bash tools/cocos-build.sh web-desktop release _toolchain-verify/hello-world  # 构建网页版
```

脚本自动处理了 4 个本机专属的坑（否则一定报错）：

| # | 现象 | 原因 | 脚本的处理 |
|---|---|---|---|
| 1 | `bad option: --project` | 环境里继承了 `ELECTRON_RUN_AS_NODE=1` / `NODE_OPTIONS`，Cocos 的 Electron 壳被当成纯 Node 跑 | `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS` |
| 2 | 退出码 133 / GPU 进程崩溃 | Chromium 内嵌沙箱嵌在受限环境里初始化失败 | 加 `--no-sandbox --disable-gpu` |
| 3 | `当前初始场景不存在...无法设置为初始场景` | 工程里没有场景，或没设启动场景 | 需在编辑器里建场景并设为启动场景（S1 要做） |
| 4 | 产物 AppID 是 `wx6ac3...` | 顶层 `appid=` 被忽略 | 改用 `configPath=` + JSON |

**构建成功的标志**：

```
✅ 构建成功：.../build/wechatgame
   体积：9.0M （微信首包红线 4MB）
   产物 AppID：wxfaa19afc583badd9
```

---

## 4. 步骤三：导入微信开发者工具

```bash
bash tools/wechat-open.sh game-4-mahjong/build/wechatgame
```

成功输出：

```
✔ IDE server has started, listening on http://127.0.0.1:24496
✔ open
✅ 已在微信开发者工具中打开
   登录状态：{"login":true}
```

脚本自动处理两件事：

1. **服务端口未开**时自动开启（改工具配置 → 重启工具 → 重试）。
   手动路径：工具里 **设置 → 安全设置 → 服务端口** 打开。
2. **竞态重试**：构建刚结束就调用工具会失败（`✖ preparing`），脚本会隔 6 秒重试最多 3 次。

### 手动导入（对应图形界面操作）

微信开发者工具 → **项目 → 导入项目** → 目录选 `<工程>/build/wechatgame` →
AppID 会自动从产物 `project.config.json` 读取 → 确定。

---

## 5. 步骤四：本地预览与真机调试

| 目的 | 操作 |
|---|---|
| 模拟器试玩 | 工具左侧就是模拟器，改代码后点「编译」 |
| 真机预览 | 点工具栏 **预览** → 生成二维码 → 手机微信扫码 |
| 真机调试 | 点 **真机调试** → 扫码 → 可在手机上开 vConsole 看日志 |
| 命令行预览 | `cli preview --project <产物目录>` |

**调玩法手感时的推荐节奏**：改 Cocos 代码 → 跑 `tools/cocos-build.sh ... both` → 工具自动重载。一条命令闭环。

---

## 6. 步骤五：上传体验版

### 6.1 图形界面

工具右上角 **上传** → 填 **版本号**（如 `0.1.0`）和 **项目备注**（如 `L1 教学关`）→ 上传。

### 6.2 命令行

```bash
/Applications/wechatwebdevtools.app/Contents/MacOS/cli upload \
  --project /Users/consli/WorkBuddy/2026-09-30-14-03-17/game-4-mahjong/build/wechatgame \
  -v 0.1.0 -d "L1 教学关首次上传"
```

上传成功后：**mp.weixin.qq.com → 版本管理 → 开发版本** 里能看到这一版，
点「选为体验版本」生成体验版二维码 → 扫码给朋友试玩（**这就是我们做 4 关难度墙 + 分享求助的那个版本**）。

> ⚠️ 上传要求当前登录账号是该 AppID 的**管理员/开发者**。若报权限错误，去 mp 后台「成员管理」加人。

---

## 7. 步骤六：提交审核 → 发布

在 **mp.weixin.qq.com** 完成（工具里做不了）：

1. **开发版本** → 「提交审核」→ 填写类目、页面截图等
2. 首次提交前需先完成：
   - **小游戏类目设置**（游戏类目需要相应资质）
   - **用户隐私保护指引**（现在强制，涉及收集任何信息都要申报）
3. 审核通过后 → **版本管理 → 审核版本 → 发布** → 正式上线
4. 上线后可搜到、可分享给朋友

### 变现相关（我们框架 §4 用到）

- **激励视频广告**（`wx.createRewardedVideoAd`）需要先开通 **流量主**，门槛：累计独立访客约 1000（以 mp 后台显示为准）。
- 未达标期间：我们的代码走**模拟广告占位页**兜底，达标后填入广告位 ID 即切真广告，玩法代码零改动。
- **合规红线**：微信运营规范**禁止诱导分享**——分享不能做成"必须分享才能继续"的强制条件，
  只能做成"看广告 或 分享给朋友"二选一的可选后备。

---

## 8. 关键约束：4MB 首包红线

实测数据（同一个 hello-world 工程）：

| 构建模式 | 总计 | `cocos-js` 引擎 | `assets` |
|---|---|---|---|
| debug | 13 MB | 7.2 MB | 5.3 MB |
| release | 9.0 MB | 3.6 MB | 5.2 MB（示例 3D 资源） |

- 微信小游戏**首包上限 4MB**，超了要么分包、要么裁剪。
- 引擎未裁剪就要 3.6MB → **必须做模块裁剪**（纯 2D 砍掉 3D / 物理 / 骨骼 / 地形 / tiled-map，
  预计降到 1.5–2.5MB）。
- 我们的 2D 资源（代码画 27 种牌面 + 6–8 张氛围图）只有 ~300KB 量级，压力全在引擎上。
- 这项是 **S8 专项**，等玩法跑通后做。

---

## 9. 常见问题速查

| 现象 | 原因 | 解决 |
|---|---|---|
| `bad option: --project` | `ELECTRON_RUN_AS_NODE` 被继承 | 用 `tools/cocos-build.sh` |
| 退出码 133 / `sandbox initialization failed` | Chromium 沙箱冲突 | 加 `--no-sandbox --disable-gpu` |
| `当前初始场景不存在` | 工程没场景 / 没设启动场景 | 编辑器里建场景并设为启动场景 |
| 产物 AppID 不对 | 顶层 `appid=` 被忽略 | 用 `build-config/wechatgame.json` + `configPath` |
| `IDE service port disabled` | 工具服务端口没开 | 工具里开，或 `bash tools/wechat-open.sh --enable-service-port` |
| `✖ preparing` + `openProject` 异常 | 工具还没就绪的竞态 | 隔几秒重试（脚本已内置） |
| 下载 Cocos 安装包 403 | CDN 拒绝海外出口 IP（ClashX 代理） | 关代理或切直连，见 `docs/cocos-install-guide.md` |
| 上传报无权限 | 当前账号不是该 AppID 成员 | mp 后台「成员管理」加人 |

---

## 10. 相关文件索引

| 文件 | 用途 |
|---|---|
| `tools/cocos-build.sh` | 一键无头构建（含 4 个坑的封装） |
| `tools/wechat-open.sh` | 一键在微信开发者工具打开产物 |
| `game-4-mahjong/build-config/wechatgame.json` | 微信小游戏构建配置（AppID 在这里） |
| `docs/game-4-DESIGN.md` | game-4 玩法框架定稿 |
| `docs/cocos-install-guide.md` | Cocos 安装（含 403 破解） |
| `_toolchain-verify/hello-world/` | 验证工程，链路每次改动都可用它复测 |
