/**
 * ============================================================
 *  Diag.ts · 启动诊断探针
 * ============================================================
 *  【为什么需要它】
 *  命令行无头构建时没有调试器可看，一旦游戏白屏，只能靠猜。
 *  本模块用「改写 2D 相机的清屏色」当作信号灯 —— 屏幕是什么颜色，
 *  就代表启动流程走到了哪一步，一眼定位卡点。
 *
 *  【颜色约定】（每步一个颜色，见 STARTUP_COLORS）
 *      深绿  = Camera 自身的 clearColor，什么都没执行
 *      洋红  = Bootstrap 顶层代码执行了
 *      蓝    = 已找到 Canvas 节点
 *      黄    = GameRoot 挂载成功
 *      青    = GameRoot.onLoad 跑完
 *      白    = 首页构建完成（此时应该能看到 UI）
 *
 *  【当前状态：已休眠】
 *  S1 启动链路验证通过（菜单 → 关卡页 → 返回均正常），因此
 *  PROBE_ENABLED 已置 false，本模块当前处于休眠状态、不参与打包逻辑。
 *  它被保留下来是因为这套"清屏色信号灯"排障法非常有效：
 *  下次再遇到白屏，把开关打开、在可疑步骤插一行 diagColor 就能立刻定位。
 *  注意业务代码里不要再常驻调用它，用完即撤。
 * ============================================================
 */

import { Camera, Color, director, log } from 'cc';

/** 诊断开关。S1 验证通过 → 已关闭；排查白屏类问题时可临时置 true */
export const PROBE_ENABLED = false;

/** 各阶段对应的信号色 */
export const STARTUP_COLORS = {
    BOOTED: '#FF00FF',   // 洋红：Bootstrap 执行
    CANVAS: '#0000FF',   // 蓝　：找到 Canvas
    MOUNTED: '#FFFF00',  // 黄　：GameRoot 挂载成功
    ONLOAD: '#00FFFF',   // 青　：GameRoot.onLoad 完成
    PAGE: '#FFFFFF',     // 白　：首页构建完成
} as const;

/**
 * 把 2D 相机清屏色改成指定颜色，作为启动进度信号。
 * @param hex  目标颜色
 * @param tag  日志标记（同时打到 console，真机调试时也有用）
 */
export function diagColor(hex: string, tag: string): void {
    if (!PROBE_ENABLED) return;
    log(`[Diag] ${tag}`);

    const scene = director.getScene();
    if (!scene) return;
    const canvas = scene.getChildByName('Canvas');
    if (!canvas) return;

    // 2D 相机是 Canvas 的子节点
    const cam = canvas.getComponentInChildren(Camera);
    if (!cam) return;

    const c = new Color();
    c.fromHEX(hex);
    cam.clearColor = c;
}
