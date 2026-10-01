# S7.9 真机预览二维码（**当前有效**）

| 项 | 值 |
|---|---|
| 生成时间 | **2026-10-01 10:24** |
| 对应产物 | `game-4-mahjong/build/wechatgame`，构建于 **10:15**（S7.9 六条决策全部在包内） |
| AppID | `wxfaa19afc583badd9`（⚠️ **game-3 在用的测试号，上线前必须换**） |
| 包体 | **3,157,986 字节 ≈ 3.01 MB** / 红线 4MB |
| 图片 | `真机预览二维码.png`（470×470 灰度 PNG，30.9 KB） |
| 二维码内容 | `https://mp.weixin.qq.com/a/~~SDH9OvmH3Dw~lfrxcafjsEgpG0w8-tJXmw~~` |
| 验收清单 | `../真机验收清单-S7.9.md` |

**可扫性已实测**：用 macOS Vision 框架解码本图成功（`docs/verify/S7.9/device/README.md` 记录命令见下），
不是"生成了但扫不出来"。

---

## 旧码全部作废

| 位置 | 生成时间 | 对应包 | 状态 |
|---|---|---|---|
| `docs/verify/S7.5/device/真机预览二维码.png` | 09-30 22:21 | 含连章（连击）的老包 | ❌ **作废** |
| `docs/verify/S7.7/device/真机预览二维码.png` | 10-01 09:41 | 无连击、但**不含** S7.9 改动 | ❌ **作废** |
| `docs/verify/S7.9/device/真机预览二维码.png` | 10-01 10:24 | 含 S7.9 六条决策 | ✅ **扫这张** |

> 微信的预览码指向"**该账号最近一次预览编译的版本**"，所以**只要再跑一次 `cli preview`，
> 旧码就自动失效**。扫码前请确认用的是本目录这张。

---

## 复现（下次重出二维码照这个来）

```bash
CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/cli"
PROJ="/Users/consli/WorkBuddy/2026-09-30-14-03-17/game-4-mahjong/build/wechatgame"

# ★ 关键：先 close 再 open。IDE 里若残留着别的项目，preview 会在错误的工程上编译，
#    报的却是 "game.json: 未找到 game.json 文件" / "✖ compile_start" —— 极具误导性。
"$CLI" close  --project "$PROJ"
"$CLI" open   --project "$PROJ"
sleep 30

"$CLI" preview --project "$PROJ" \
  --qr-format image \
  --qr-output /path/to/真机预览二维码.png \
  --info-output /path/to/preview-info.json
```

注意两点：

- `--qr-output` 写出的其实是 **JPEG**（哪怕你把文件名写成 `.png`）。
  想要真 PNG 转一下：`sips -s format png <文件> --out <文件>`。
- 验证二维码真能扫（无需装任何库，用系统 Vision）：

```bash
swift - <<'SWIFT' "/绝对路径/真机预览二维码.png"
import Foundation; import Vision; import AppKit
let p = CommandLine.arguments[1]
let img = NSImage(contentsOfFile: p)!
let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil)!
let r = VNDetectBarcodesRequest(); r.symbologies = [.qr]
try! VNImageRequestHandler(cgImage: cg, options: [:]).perform([r])
for x in r.results ?? [] { print("OK \(x.payloadStringValue ?? "?")") }
SWIFT
```
