// 半自动学习：截屏 + LLM 分析 + 用户确认保存

import type { ElementCapability, VisionElement } from './types';
import * as state from './state';
import { captureWindowScreenshot, visionAnalyzeScreenshot } from './vision';
import { saveSingleCapability, saveVisionElementAsAnnotation } from './storage';
import { startLearning } from './index';

/**
 * 半自动学习：截屏并发送给 LLM 分析
 * @param hwnd 目标窗口句柄
 * @param appName 应用名称（窗口标题）
 * @param userNote 用户备注（当前截屏中需要学习的内容）
 * @param provider LLM 配置
 * @param apiKey API 密钥
 * @returns 分析结果和截图路径
 */
export async function semiAutoCapture(
  hwnd: number,
  appName: string,
  userNote: string,
  provider: import('@/types/provider').ProviderConfig,
  apiKey: string,
): Promise<{
  screenshotPath: string | null;
  visionElements: VisionElement[];
  success: boolean;
  error?: string;
}> {
  console.log(`[CapabilityLearner] ▶ Semi-auto capture — app="${appName}", note="${userNote}"`);

  // 确保学习会话存在
  let session = state.getSession();
  if (!session || session.hwnd !== hwnd) {
    // 启动新的学习会话（会自动处理浏览器判断和 appName 提取）
    await startLearning(hwnd, appName);
    session = state.getSession();
    if (!session) {
      return { screenshotPath: null, visionElements: [], success: false, error: '无法启动学习会话' };
    }
  }

  // 截屏
  const screenshot = await captureWindowScreenshot(hwnd);
  if (!screenshot) {
    return { screenshotPath: null, visionElements: [], success: false, error: '截屏失败' };
  }

  // 保存截图
  let screenshotPath: string | null = null;
  try {
    const { isTauri } = await import('@/utils/platform');
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core');
      const dataUrl = screenshot.startsWith('data:') ? screenshot : `data:image/bmp;base64,${screenshot}`;
      const safeFp = typeof session.fingerprint === 'string' ? session.fingerprint : 'unknown';
      const filename = `semi_${safeFp}_${Date.now()}.jpg`.replace(/[<>:"/\\|?*]/g, '_');
      const saved: string[] = await invoke('save_llm_images', {
        images: [{ data: dataUrl, filename }],
      });
      if (saved.length > 0) {
        screenshotPath = saved[0];
        state.setScreenshotPath(screenshotPath);
        console.log(`[CapabilityLearner] 截图已保存: ${screenshotPath}`);
      }
    }
  } catch (e) {
    console.warn('[CapabilityLearner] 截图保存失败:', e);
  }

  // 构建带备注的 prompt（使用 session 中的 appName，对于浏览器是 hostname）
  let enhancedAppName = session.appName;
  if (userNote) {
    enhancedAppName = `${session.appName}（用户备注：${userNote}）`;
  }

  // LLM 分析
  const visionElements = await visionAnalyzeScreenshot(screenshot, enhancedAppName, provider, apiKey);

  return {
    screenshotPath,
    visionElements,
    success: true,
  };
}

/**
 * 半自动学习：保存用户确认的元素
 * @param elements 用户确认的元素列表
 * @param screenshotPath 截图路径（可选）
 */
export async function semiAutoSave(
  elements: Array<{
    label: string;
    description: string;
    relativeX: number;
    relativeY: number;
    relativeWidth: number;
    relativeHeight: number;
    type: 'interactive' | 'content';
    known_function?: string;
  }>,
  screenshotPath?: string | null,
): Promise<number> {
  const session = state.getSession();
  if (!session) {
    return 0;
  }

  let savedCount = 0;

  // 获取实际窗口尺寸用于坐标转换
  let winWidth = 1920, winHeight = 1080;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const winBounds = await invoke<{ x: number; y: number; width: number; height: number }>('get_window_bounds', { hwnd: session.hwnd });
    if (winBounds && winBounds.width > 0 && winBounds.height > 0) {
      winWidth = winBounds.width;
      winHeight = winBounds.height;
    }
  } catch {
    // fallback to default 1920x1080
  }

  for (const el of elements) {
    const capability: ElementCapability = {
      interactionType: 'click',
      notes: el.known_function || el.description,
    };

    // 生成唯一的 key
    const key = `semi:${el.label}:${Date.now()}:${savedCount}`;

    // 计算绝对坐标（使用实际窗口尺寸）
    const left = Math.round(el.relativeX * winWidth);
    const top = Math.round(el.relativeY * winHeight);
    const width = Math.round(el.relativeWidth * winWidth);
    const height = Math.round(el.relativeHeight * winHeight);
    const bounds = { left, top, right: left + width, bottom: top + height, width, height };

    // 保存到 discoveredCapabilities
    session.discoveredCapabilities.set(key, capability);
    session.discoveredBounds.set(key, bounds);

    // 保存到存储
    await saveSingleCapability(key, capability, bounds);

    // 保存为视觉元素注解
    await saveVisionElementAsAnnotation({
      label: el.label,
      description: el.description,
      keywords: [el.label],
      relativeX: el.relativeX,
      relativeY: el.relativeY,
      relativeWidth: el.relativeWidth,
      relativeHeight: el.relativeHeight,
      type: el.type,
      known_function: el.known_function,
    }, capability);

    savedCount++;
  }

  state.notifyListeners();
  return savedCount;
}
