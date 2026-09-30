/**
 * ============================================================
 *  Bootstrap.ts · 启动自举
 * ============================================================
 *  【为什么需要它 —— 一个踩过的真实工程坑】
 *  用命令行做无头构建（tools/cocos-build.sh）时，asset-db 导入场景的时机
 *  **早于**脚本类注册，于是场景里挂载的自定义组件会被判定为
 *  「Script "xxx" attached to "Canvas" ... is missing or invalid」
 *  并被静默丢弃。
 *
 *  实测现象（很能说明问题）：
 *      · 脚本 bundle 是成功的 —— 产物 assets/main/index.js 里 9 个模块一个不少；
 *      · 但场景的 import json 里，脚本引用计数 = 0（组件没了）；
 *      · 结果：构建"成功"、体积正常，但运行起来是一片空白 —— 没有任何入口。
 *
 *  【解法】
 *  本工程让 Main.scene 保持「零脚本引用」的纯舞台（只有 Canvas + Camera），
 *  改由本模块在脚本被加载执行时，主动把 GameRoot 挂到 Canvas 上。
 *  这同时正好契合本工程「代码驱动 UI」的定位：场景文件里不含任何逻辑。
 *
 *  【为什么可以确定本文件一定会被执行】
 *  构建产物里所有项目脚本都会被 "chunks:///_virtual/main" 模块依赖，
 *  而该模块又被 "virtual:///prerequisite-imports/main" 引用 ——
 *  加载 main bundle 时即全部执行，因此顶层代码必然会跑。
 *
 *  【代价与取舍】
 *  代价：在 Cocos 编辑器里打开 Main.scene 时，看不到 Canvas 上挂着组件。
 *  权衡：反正本工程 UI 全部由代码创建，在编辑器里本来也看不到界面，
 *        因此这个代价可以接受；换来的是命令行构建链路完全可靠。
 * ============================================================
 */

import { Director, director, log, warn } from 'cc';
import { CFG } from './CFG';
import { GameRoot } from './GameRoot';

/** 场景里承载一切 UI 的根节点名（见 assets/scenes/Main.scene） */
const CANVAS_NODE_NAME = 'Canvas';

/** 幂等挂载：Scene 就绪后把 GameRoot 挂到 Canvas 上 */
function mountGameRoot(): void {
    const scene = director.getScene();
    if (!scene) {
        return;   // 场景尚未加载，交给事件回调再试
    }

    const canvas = scene.getChildByName(CANVAS_NODE_NAME);
    if (!canvas) {
        warn(`[Bootstrap] 场景 "${scene.name}" 里找不到 "${CANVAS_NODE_NAME}" 节点，游戏无法启动`);
        return;
    }
    if (canvas.getComponent(GameRoot)) {
        return;   // 已挂载过，保证幂等
    }

    // 用 try/catch 包住：即使挂载过程中抛异常，也要把原因打出来，
    // 而不是让小游戏静默白屏（命令行构建时看不到调试器，这条日志很关键）
    try {
        canvas.addComponent(GameRoot);
        if (CFG.DEBUG.LOG_STATE) log(`[Bootstrap] GameRoot 已挂载到 "${CANVAS_NODE_NAME}"`);
    } catch (e) {
        warn('[Bootstrap] 挂载 GameRoot 失败：', e);
    }
}

// ------------------------------------------------------------
//  双保险：两条路径都试
// ------------------------------------------------------------
// ① 常规路径：脚本在场景加载【之前】执行，此时监听"场景启动完成"事件
director.on(Director.EVENT_AFTER_SCENE_LAUNCH, mountGameRoot);

// ② 兜底路径：万一脚本执行时机【晚于】场景加载（事件已经错过），立即尝试一次。
//    两种时机在真机与开发者工具上都可能出现，所以两条都要留。
mountGameRoot();
