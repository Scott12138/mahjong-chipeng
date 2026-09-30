#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cocos-asset-meta.py · 为 Cocos Creator 工程的 assets 目录补齐 .meta 文件
================================================================================

【为什么需要它】
Cocos Creator 的 asset-db 依赖 .meta 文件给每个资源分配 uuid。编辑器打开工程时
会自动补，但**纯命令行工作流**（我们用 tools/cocos-build.sh 做无头构建）里，
场景文件必须在写下来的时候就带正确的 uuid —— 因为场景内部通过压缩 uuid 引用
脚本组件，两边对不上就会变成 "Missing Script"。

【uuid 怎么定】
用 uuid5(namespace, 相对路径) —— **确定性**：
    同一路径永远得到同一 uuid，路径不变则 uuid 不变。
好处：可复现、可 git diff、重复执行不产生噪音（不像 uuid4 每次跑都不一样）。

【压缩 uuid 是什么】
场景里引用脚本时写的是 22 字符的压缩形式（例如 'fcmR3XADNLgJ1ByKhqcC5Z'
对应 'fc991dd7-0033-4b80-9d41-c8a86a702e59'）。算法来自引擎源码
cocos/core/utils/decode-uuid.ts 的逆运算，本脚本的 compress() 已用该文件
@example 的标准答案做过双向校验。

用法：
    python3 tools/cocos-asset-meta.py <工程目录> [--force] [--dry-run]

    <工程目录>   例如 game-4-mahjong
    --force      已有 .meta 也重新生成（会换掉 uuid，谨慎使用）
    --dry-run    只打印将要做什么，不写文件
================================================================================
"""

import argparse
import json
import os
import sys
import uuid as _uuid

# ------------------------------------------------------------------
#  uuid 压缩（Cocos 的 36 位 → 22 位）
# ------------------------------------------------------------------
_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'


def compress_uuid(u: str) -> str:
    """36 位标准 uuid → 22 位压缩形式（场景里引用组件用这个）"""
    h = u.replace('-', '')
    if len(h) != 32:
        return u
    out = h[0:2]
    for i in range(2, 32, 3):
        a, b, c = int(h[i], 16), int(h[i + 1], 16), int(h[i + 2], 16)
        out += _B64[(a << 2) | (b >> 2)] + _B64[((b & 3) << 4) | c]
    return out


# ------------------------------------------------------------------
#  uuid 命名空间（固定值 —— 改了会导致全工程 uuid 变化，不要动）
# ------------------------------------------------------------------
_NS = _uuid.uuid5(_uuid.NAMESPACE_DNS, 'mahjong-chipeng.cocos.asset')


def stable_uuid(rel_path: str) -> str:
    """按「相对 assets 的路径」生成确定性 uuid"""
    return str(_uuid.uuid5(_NS, rel_path))


# ------------------------------------------------------------------
#  各类型资源对应的 meta 模板
# ------------------------------------------------------------------
def meta_for_dir(u: str) -> dict:
    return {
        "ver": "1.2.0", "importer": "directory", "imported": False,
        "uuid": u, "files": [], "subMetas": {},
        "userData": {"compressionType": {}, "isRemoteBundle": {}},
    }


def meta_for_ts(u: str, rel_path: str) -> dict:
    # moduleId 指向编译后的 .js —— Cocos 就是这么记的
    module_id = 'project:///assets/' + rel_path[:-3] + '.js'
    return {
        "ver": "4.0.23", "importer": "typescript", "imported": False,
        "uuid": u, "files": [], "subMetas": {},
        "userData": {"moduleId": module_id, "importerSettings": 7, "simulateGlobals": []},
    }


def meta_for_scene(u: str) -> dict:
    return {
        "ver": "1.1.50", "importer": "scene", "imported": False,
        "uuid": u, "files": [".json"], "subMetas": {}, "userData": {},
    }


def meta_for_prefab(u: str) -> dict:
    return {
        "ver": "1.1.50", "importer": "prefab", "imported": False,
        "uuid": u, "files": [".json"], "subMetas": {}, "userData": {},
    }


def meta_for_json(u: str) -> dict:
    return {
        "ver": "1.0.4", "importer": "json", "imported": False,
        "uuid": u, "files": [".json"], "subMetas": {}, "userData": {},
    }


def meta_for_image(u: str) -> dict:
    # 默认按 sprite-frame 处理（见工程 .creator/default-meta.json）
    return {
        "ver": "1.0.26", "importer": "image", "imported": False,
        "uuid": u, "files": [".json"], "subMetas": {}, "userData": {
            "type": "sprite-frame", "hasAlpha": True,
        },
    }


def meta_for_generic(u: str, ext: str) -> dict:
    return {
        "ver": "1.0.0", "importer": "unknown", "imported": False,
        "uuid": u, "files": [], "subMetas": {},
        "userData": {"ext": ext},
    }


def build_meta(rel_path: str, is_dir: bool) -> dict:
    u = stable_uuid(rel_path)
    if is_dir:
        return meta_for_dir(u)
    ext = os.path.splitext(rel_path)[1].lower()
    return {
        '.ts': lambda: meta_for_ts(u, rel_path),
        '.scene': lambda: meta_for_scene(u),
        '.prefab': lambda: meta_for_prefab(u),
        '.json': lambda: meta_for_json(u),
        '.png': lambda: meta_for_image(u),
        '.jpg': lambda: meta_for_image(u),
    }.get(ext, lambda: meta_for_generic(u, ext))()


# ------------------------------------------------------------------
#  主流程
# ------------------------------------------------------------------
def walk_assets(assets_dir: str):
    """深度优先遍历，返回 [(绝对路径, 相对 assets 的路径, 是否目录)]"""
    out = []
    for root, dirs, files in os.walk(assets_dir):
        # 跳过隐藏目录
        dirs[:] = [d for d in dirs if not d.startswith('.')]
        for d in dirs:
            ap = os.path.join(root, d)
            out.append((ap, os.path.relpath(ap, assets_dir), True))
        for f in files:
            if f.endswith('.meta') or f.startswith('.'):
                continue
            ap = os.path.join(root, f)
            out.append((ap, os.path.relpath(ap, assets_dir), False))
    return out


def main():
    ap = argparse.ArgumentParser(description='为 Cocos 工程 assets 补齐 .meta')
    ap.add_argument('project', help='Cocos 工程目录（含 assets/）')
    ap.add_argument('--force', action='store_true', help='已有 meta 也重新生成')
    ap.add_argument('--dry-run', action='store_true', help='只打印，不写文件')
    args = ap.parse_args()

    project = os.path.abspath(os.path.expanduser(args.project))
    assets = os.path.join(project, 'assets')
    if not os.path.isdir(assets):
        print(f'❌ 找不到 assets 目录：{assets}')
        return 1

    items = walk_assets(assets)
    created, skipped = [], []

    for abs_path, rel_path, is_dir in items:
        meta_path = abs_path + '.meta'
        if os.path.exists(meta_path) and not args.force:
            skipped.append(rel_path)
            continue

        meta = build_meta(rel_path, is_dir)
        if not args.dry_run:
            with open(meta_path, 'w', encoding='utf-8') as f:
                json.dump(meta, f, ensure_ascii=False, indent=2)
                f.write('\n')
        created.append((rel_path, meta['uuid']))

    print(f'工程：{project}')
    print(f'  ✅ 生成 meta：{len(created)} 个')
    for rel, u in created:
        print(f'       {rel:44s} {u}  →  {compress_uuid(u)}')
    print(f'  ⏭  已存在跳过：{len(skipped)} 个')
    if args.dry_run:
        print('  （--dry-run：未写入任何文件）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
