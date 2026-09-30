# Cocos Creator 安装指南（macOS 15.3.1 / Apple Silicon）

> 目标：装好 Cocos Creator 3.8.8，新建空工程，并能**构建出微信小游戏**——这是 game-4 的 S0 验收标准。
> 本机现状：未安装任何 Cocos 组件；Node v22.22.2 ✅；磁盘余量 217GB ✅；macOS 15.3.1 ✅（避开 macOS 26.x 上 Dashboard 2.2.1 无法启动的 bug）。

---

## ⚠️ 先解决下载问题（不然一定卡在第 1 步）

Cocos 的安装包 CDN（`download.cocos.com/CocosDashboard/`）会**拒绝海外出口 IP**，返回 403 openresty。你机器上 ClashX 开着系统代理（127.0.0.1:7890），流量走海外节点，所以会被拒。

**三选一即可解决：**
1. 点菜单栏 ClashX 图标 → **模式 → 直连（Direct）**，下完再切回来；
2. 或直接**退出 ClashX**；
3. 或在 ClashX 规则里加 `DOMAIN-SUFFIX,cocos.com,DIRECT`。

> 验证方法：关掉代理后重跑一次下载，能开始下载就是通了（判断标准见下方"如何判断是不是 403 错误页"）。

---

## 第 1 步：下载 Cocos Dashboard

**官方直链（最新 2.2.2，约 190MB）：**
```
https://download.cocos.com/CocosDashboard/v2.2.2/CocosDashboard-v2.2.2-mac-091515.dmg
```

或走官网页面：`https://www.cocos.com/creator-download` → 点下载按钮。

**❓如何判断是不是 403 错误页**：如果下载下来只有几 KB 的文件，用文本编辑器打开看到 `403 Forbidden / openresty`，说明被拦了——不是网络慢，是出口 IP 被拒（换直连重下）。

---

## 第 2 步：安装 Dashboard

**方式 A（推荐，自动）：**
```bash
bash /Users/consli/WorkBuddy/2026-09-30-14-03-17/tools/install-cocos-dashboard.sh
```
脚本会自动完成：校验体积 → 挂载 dmg → 拷贝到 `/Applications` → 解除 `com.apple.quarantine` 隔离属性（防"已损坏"打不开）。**需要输入你的开机密码**（写 /Applications 要管理员权限）。

**方式 B（手动）：**
1. 双击 dmg；
2. 把 `CocosDashboard.app` 拖进「应用程序」；
3. 若首次打开提示"来自身份不明的开发者 / 已损坏"：在「应用程序」里**右键点 app → 打开 → 再点"打开"**；或去 `系统设置 → 隐私与安全性` → 点「仍要打开」。

---

## 第 3 步：用 Dashboard 安装 Creator 编辑器

1. 打开 **Cocos Dashboard**；
2. 首次使用需**登录 Cocos 账号**（免费注册，邮箱即可）——这一步必须由你本人完成，编辑器只能通过 Dashboard 登录后下载；
3. 左侧「**编辑器 / Editor**」页 → 版本列表里选 **3.8.8**（当前稳定版）→ 点下载并安装；
4. 体积约 3–5GB，装到默认路径即可（磁盘够）。

---

## 第 4 步：新建工程

1. Dashboard → 「**项目 / Projects**」→ 「**新建 / New**」；
2. 模板选 **Empty（空项目）**（2D 空场景即可，不要选示例项目）；
3. 路径建议：`/Users/consli/WorkBuddy/2026-09-30-14-03-17/game-4-mahjong`
4. 项目名建议：`mahjong-chipeng`
5. **建完把工程路径发我**，我把脚本写进去（我们的玩法是"代码驱动 UI"，场景里几乎不用你拖东西）。

---

## 第 5 步：验证"能构建微信小游戏"（S0 验收）

1. 用 Cocos Creator 打开刚建的工程；
2. 先点右上角「**预览**」，能在浏览器里跑出空场景 = 编辑器可用 ✅；
3. 菜单「**项目 → 构建发布**」→ 平台选「**微信小游戏 / wechatgame**」；
4. 首次构建可能要求指定**微信开发者工具的路径**（在 `偏好设置 → 程序管理器/外部程序` 里填 `/Applications/wechatwebdevtools.app`）；
5. 构建完成后，输出目录一般是 `build/wechatgame`，用**微信开发者工具**导入该目录（AppID 填你已注册的 `wxfaa19afc583badd9`，或先用测试号预览）。

---

## 常见坑速查

| 现象 | 原因 / 解法 |
|---|---|
| 下载只有几 KB，打开是 403 页 | CDN 拒绝海外出口 → 关代理/切直连重下 |
| 提示"已损坏，无法打开" | quarantine 隔离属性 → 用脚本装，或右键→打开；或 `xattr -dr com.apple.quarantine /Applications/CocosDashboard.app` |
| Dashboard 打开就闪退 | 旧版 2.2.1 在 macOS 26.x 有已知 bug；你是 15.3.1，且装最新 2.2.2 即可规避 |
| 找不到 Creator 下载按钮 | 必须**登录账号**后，「编辑器」页才会列出可下载版本 |
| 构建微信小游戏报错找不到开发者工具 | 在偏好设置里指定微信开发者工具路径 |
| 引擎包体积大 | 后续 S8 做引擎裁剪（微信首包 4MB 上限），先跑通链路 |
