// Region capture — thin wrapper around Tauri capture_region command.

import { invoke } from '@tauri-apps/api/core';
import type { ScreenRegion, MonitorTarget } from '@/types/watcher';


// 获取窗口位置和大小
interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function getWindowBounds(hwnd: number): Promise<WindowBounds | null> {
  try {
    // 最小化窗口先恢复，等窗口稳定后再取位置（ShowWindow 是异步的）
    const wasRestored = await invoke<boolean>('restore_window', { hwnd });
    if (wasRestored) {
      await new Promise(r => setTimeout(r, 150));
    }
    const bounds = await invoke<WindowBounds>('get_window_bounds', { hwnd });
    return bounds;
  } catch {
    console.warn('[watcher:capture] 获取窗口位置失败，hwnd 可能已失效');
    return null;
  }
}

// 根据监控目标计算实际截图区域
export async function resolveCaptureRegion(
  monitorTarget: MonitorTarget,
  region: ScreenRegion,
): Promise<ScreenRegion> {
  console.log(`[watcher:capture] ▶ resolveCaptureRegion: targetType=${monitorTarget.type}, windowHwnd=${monitorTarget.windowHwnd}, region=(${region.x},${region.y},${region.width}x${region.height})`);

  if (monitorTarget.type === 'fullscreen') {
    console.log(`[watcher:capture]   → fullscreen 模式, 直接返回 region`);
    return region;
  }

  // 窗口模式：获取窗口位置，将相对坐标转换为绝对坐标
  if (!monitorTarget.windowHwnd) {
    console.warn('[watcher:capture]   窗口模式但未指定窗口 hwnd，使用配置区域');
    return region;
  }

  const windowBounds = await getWindowBounds(monitorTarget.windowHwnd);
  if (!windowBounds) {
    console.warn(`[watcher:capture]   窗口 hwnd=${monitorTarget.windowHwnd} 已失效, 返回 0x0 触发重新定位`);
    return { x: 0, y: 0, width: 0, height: 0 };
  }
  console.log(`[watcher:capture]   窗口实际位置: x=${windowBounds.x}, y=${windowBounds.y}, w=${windowBounds.width}, h=${windowBounds.height}`);

  // 将相对窗口的坐标转换为屏幕绝对坐标
  // region 宽高为 0 时取整个窗口（用于 auto 模式获取全窗口截图）
  const w = region.width > 0
    ? Math.min(region.width, windowBounds.width - region.x)
    : windowBounds.width;
  const h = region.height > 0
    ? Math.min(region.height, windowBounds.height - region.y)
    : windowBounds.height;
  const result = {
    x: windowBounds.x + region.x,
    y: windowBounds.y + region.y,
    width: Math.max(1, w),
    height: Math.max(1, h),
  };
  console.log(`[watcher:capture]   → 返回绝对坐标: x=${result.x}, y=${result.y}, w=${result.width}, h=${result.height}`);
  return result;
}

/**
 * 截取屏幕区域
 * @param region 屏幕绝对坐标区域（用于 capture_region GDI 回退）
 * @param hwnd 窗口句柄（传入时使用 PrintWindow 抗遮挡）
 * @param windowRegion 窗口相对坐标（PrintWindow 裁剪用，不传则用 region）
 */
export async function captureRegion(region: ScreenRegion, hwnd?: number, windowRegion?: ScreenRegion): Promise<string> {
  console.log(`[watcher:capture] ▶ captureRegion: region=(${region.x},${region.y},${region.width}x${region.height}), hwnd=${hwnd ?? 'N/A'}, windowRegion=${windowRegion ? `(${windowRegion.x},${windowRegion.y},${windowRegion.width}x${windowRegion.height})` : 'N/A'}`);
  const start = Date.now();

  // 窗口模式：用 PrintWindow 截完整窗口再裁剪，抗浮窗遮挡
  if (hwnd && hwnd > 0) {
    // PrintWindow 需要窗口相对坐标，不是屏幕绝对坐标。
    // windowRegion 有效时直接使用（窗口相对坐标）；
    // windowRegion 为 0x0 时传 0 给 Rust 后端触发"全窗口"逻辑。
    // 注意：region 是屏幕绝对坐标，绝不能当窗口相对坐标传给 PrintWindow！
    const hasWindowRegion = windowRegion && windowRegion.width > 0 && windowRegion.height > 0;
    const cropX = hasWindowRegion ? windowRegion.x : 0;
    const cropY = hasWindowRegion ? windowRegion.y : 0;
    const cropW = hasWindowRegion ? windowRegion.width : 0;
    const cropH = hasWindowRegion ? windowRegion.height : 0;
    console.log(`[watcher:capture]   → PrintWindow: crop=(${cropX},${cropY},${cropW}x${cropH}), hwnd=${hwnd}`);
    try {
      const result = await invoke<string>('screenshot_window_region', {
        hwnd,
        regionX: cropX,
        regionY: cropY,
        regionW: cropW,
        regionH: cropH,
      });
      return result;
    } catch (e) {
      console.warn(`[watcher:capture]   ✗ PrintWindow 失败, 回退到 capture_region:`, e);
    }
  }

  // 全屏模式 或 PrintWindow 失败时回退
  console.log(`[watcher:capture]   → GDI: (${region.x},${region.y},${region.width}x${region.height})`);
  try {
    const result = await invoke<string>('capture_region', {
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    });
    return result;
  } catch (e) {
    console.error(`[watcher:capture]   ✗ GDI 失败, ${Date.now() - start}ms:`, e);
    throw e;
  }
}
