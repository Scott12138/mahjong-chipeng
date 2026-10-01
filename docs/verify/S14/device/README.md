# 真机试玩二维码（微信小游戏）

**本目录只保留「当前有效」的那一张码。**

| 项 | 值 |
|---|---|
| 生成时间 | 2026-10-01 18:43:49 |
| AppID | `wxfaa19afc583badd9` |
| 包体 | 2253836 字节（2.15 MB，红线 4MB） |
| 构建模式 | release |
| 解码内容 | `https://mp.weixin.qq.com/a/~~RTXhPEKF1Sk~mnXIWjXV1LXrBh8-hoLecg~~` |

## ★ 扫码须知
微信预览码**有且只有最新一张有效**：再跑一次 `tools/wechat-preview.sh`，
上一张立刻作废。所以：

- 如果你**扫码后看到的现象和最新改动对不上**，先怀疑扫的是旧码 → 重新生成一张再扫。
- 历史上作废的码不必留；要留就在本文件里写明「XX 时间的码已作废」。

## 重新出码
```bash
SKIP_BUILD=1 bash tools/wechat-preview.sh       # 代码没变，只想换一张新码
bash tools/wechat-preview.sh                     # 代码变了：构建 + 出码
```
