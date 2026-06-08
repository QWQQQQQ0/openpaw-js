/**
 * Capability Learner — 学习模式核心服务
 *
 * 通过监听用户的交互操作 + 截图视觉分析，学习目标窗口上各种元素的能力信息
 * 特别是需要交互才能显示的元素（下拉菜单、右键菜单、弹出层等）
 *
 * 按应用结构指纹存储，不依赖具体窗口标题或文件名
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  ElementCapability,
  InteractiveNode,
  LearningProgress,
  VisionElement,
  WindowBounds,
  AutoLearnResult,
} from './types';
import { desktopService } from '@/services/desktop-service';
import { getUICache } from '@/services/cache-service';

// 子模块
import * as state from './state';
import { extractBrowserUrlFromNodes, appNameFromUrl, extractAppNameFromTitle } from './browser';
import { captureWindowScreenshot, visionAnalyzeScreenshot } from './vision';
import { inferCapabilityFromInteraction, inferCapabilityFromVision } from './inference';
import { saveSingleCapability, saveVisionElementAsAnnotation } from './storage';
import { llmClassifyElements, mergeExplorableElements } from './classification';
import { fetchInteractiveNodes, getAppFingerprint, detectChangesAfterInteraction, recordChildComponent } from './detection';

// ── Re-export 子模块公共 API ──
export { semiAutoCapture, semiAutoSave } from './semi-auto';
export { browserLearnWithDOM, saveBrowserLearnResult } from './browser-learn';
export { cascadeLearn, batchCascadeLearn } from './cascade';
export { fetchInteractiveNodes, getAppFingerprint } from './detection';

// ── Public API ──

export function getLearningStatus() {
  return state.getStatus();
}

export function getLearningProgress(): LearningProgress {
  return state.getProgress();
}

export function onLearningProgress(callback: (progress: LearningProgress) => void): () => void {
  return state.addListener(callback);
}

// ── Core API ──

/**
 * 开始学习模式
 * @param hwnd 目标窗口句柄
 * @param appName 应用名称（用于显示）
 */
export async function startLearning(hwnd: number, appName: string): Promise<void> {
  if (state.getStatus() === 'learning') {
    return;
  }

  // 获取基线节点
  const baselineNodes = await fetchInteractiveNodes(hwnd);

  // 用应用结构指纹代替窗口标题，这样同一应用不同文件共享学习结果
  let fingerprint = await getAppFingerprint(hwnd);

  // 检测是否是浏览器（基于窗口标题中的浏览器关键词）
  const BROWSER_KEYWORDS = ['Google Chrome', 'Microsoft Edge', 'Firefox', 'Safari', 'Opera', 'Brave', 'Vivaldi', 'Arc', 'Chromium'];
  const matchedKeyword = BROWSER_KEYWORDS.find(keyword => appName.includes(keyword));
  const isBrowser = !!matchedKeyword;

  if (isBrowser) {
    // 浏览器：尝试提取 URL 的 hostname 作为应用名
    const url = extractBrowserUrlFromNodes(baselineNodes);

    if (url) {
      const hostname = appNameFromUrl(url) || 'browser';
      const path = new URL(url).pathname;
      fingerprint = `${fingerprint}:${hostname}${path}`;
      appName = hostname;
    }
  } else {
    // 非浏览器：从窗口标题中提取应用名称
    // 很多桌面应用的窗口标题格式为 "文档名 - 应用名"
    // 例如 "README.md - Visual Studio Code" → "Visual Studio Code"
    const extractedAppName = extractAppNameFromTitle(appName);
    if (extractedAppName !== appName) {
      appName = extractedAppName;
    }
  }

  // 恢复已有学习记录
  const discoveredCapabilities = new Map<string, ElementCapability>();
  const discoveredBounds = new Map<string, { left: number; top: number; width: number; height: number }>();
  try {
    const existing = await getUICache(fingerprint);
    if (existing && existing.annotations.length > 0) {
      for (const ann of existing.annotations) {
        if (ann.capability) {
          const key = ann.automationId || `${ann.role}:${ann.name}`;
          discoveredCapabilities.set(key, ann.capability);
          if (ann.relativeX != null && ann.relativeY != null) {
            discoveredBounds.set(key, {
              left: Math.round(ann.relativeX * 1920),
              top: Math.round(ann.relativeY * 1080),
              width: Math.round((ann.relativeWidth ?? 0.05) * 1920),
              height: Math.round((ann.relativeHeight ?? 0.03) * 1080),
            });
          }
        }
      }
    }
  } catch { /* ignore */ }

  state.setSession({
    fingerprint,
    appName,
    windowTitle: appName,
    startedAt: Date.now(),
    discoveredCapabilities,
    discoveredBounds,
    interactionCount: 0,
    hwnd,
    isBrowser,
  });
  state.setStatus('learning');

  // 使用基线节点（不再过滤，由 LLM 自行识别网页元素）
  state.setSnapshot(baselineNodes);

  // 启动全局输入监听并订阅事件
  const { globalListener } = await import('@/services/global-listener');
  if (!globalListener.isActive()) {
    await globalListener.start();
  }
  state.setEventUnsub(globalListener.onEvent(async (event) => {
    if (state.getStatus() !== 'learning' || !state.getSession()) return;
    const type = event.event_type;
    if (type !== 'mouse_click' && type !== 'mouse_double_click' && type !== 'mouse_right_click') return;
    if (event.hwnd !== state.getSession()!.hwnd) return;
    await detectChangesAfterInteraction(type, event.x, event.y);
  }));

  state.notifyListeners();
}

export function pauseLearning(): void {
  if (state.getStatus() !== 'learning') return;
  state.setStatus('paused');
  stopEventListening();
  state.notifyListeners();
}

export function resumeLearning(): void {
  if (state.getStatus() !== 'paused') return;
  state.setStatus('learning');
  startEventListening();
  state.notifyListeners();
}

async function startEventListening() {
  stopEventListening();
  const { globalListener } = await import('@/services/global-listener');
  if (!globalListener.isActive()) {
    await globalListener.start();
  }
  state.setEventUnsub(globalListener.onEvent(async (event) => {
    if (state.getStatus() !== 'learning' || !state.getSession()) return;
    const type = event.event_type;
    if (type !== 'mouse_click' && type !== 'mouse_double_click' && type !== 'mouse_right_click') return;
    if (event.hwnd !== state.getSession()!.hwnd) return;
    await detectChangesAfterInteraction(type, event.x, event.y);
  }));
}

function stopEventListening() {
  const unsub = state.getEventUnsub();
  if (unsub) {
    unsub();
    state.setEventUnsub(null);
  }
}

export async function stopLearning(): Promise<number> {
  const session = state.getSession();
  if (!session) return 0;

  stopEventListening();

  const count = session.discoveredCapabilities.size;

  state.setStatus('idle');
  state.setSession(null);
  state.setSnapshot(null);
  state.setScreenshotPath(null);

  state.notifyListeners();
  return count;
}

// ── 能力管理 ──

export function addCapability(automationId: string, capability: ElementCapability): void {
  const session = state.getSession();
  if (!session) return;
  session.discoveredCapabilities.set(automationId, capability);
  state.notifyListeners();
}

export function getDiscoveredList(): Array<{ automationId: string; name: string; role: string; capability: ElementCapability; bounds?: { left: number; top: number; width: number; height: number } }> {
  const session = state.getSession();
  if (!session) return [];
  return Array.from(session.discoveredCapabilities.entries()).map(([key, capability]) => {
    const [role, ...nameParts] = key.split(':');
    return {
      automationId: key,
      name: nameParts.length > 0 ? nameParts.join(':') : key,
      role: nameParts.length > 0 ? role : '',
      capability,
      bounds: session.discoveredBounds.get(key),
    };
  });
}

export function getBaselineNodes(): InteractiveNode[] {
  return state.getSnapshot() ?? [];
}

// ── 全自动学习模式 ──

export async function autoLearn(
  hwnd: number,
  provider: import('@/types/provider').ProviderConfig,
  apiKey: string,
): Promise<AutoLearnResult> {
  const session = state.getSession();
  if (!session) {
    return { explored: 0, childComponentsFound: 0, visionElementsFound: 0, errors: ['未在学习模式中'] };
  }

  const result: AutoLearnResult = { explored: 0, childComponentsFound: 0, visionElementsFound: 0, errors: [] };

  let winBounds: WindowBounds | null = null;
  try {
    winBounds = await invoke<WindowBounds>('get_window_bounds', { hwnd });
  } catch { /* ignore */ }

  // 1. 获取 UIA 节点
  const rawNodes = await fetchInteractiveNodes(hwnd);

  const uiaNodes = rawNodes;
  const visibleUIA = uiaNodes.filter(n => n.visible && n.enabled);

  // 2. 截图 + 视觉分析（由 LLM 自行识别网页元素）
  let visionElements: VisionElement[] = [];
  const screenshot = await captureWindowScreenshot(hwnd);
  if (screenshot) {
    try {
      const { isTauri } = await import('@/utils/platform');
      if (isTauri()) {
        const dataUrl = screenshot.startsWith('data:') ? screenshot : `data:image/bmp;base64,${screenshot}`;
        // 确保 fingerprint 是安全的文件名字符串
        const safeFp = typeof session.fingerprint === 'string' ? session.fingerprint : 'unknown';
        const filename = `learn_${safeFp}_${Date.now()}.jpg`.replace(/[<>:"/\\|?*]/g, '_');
        const saved: string[] = await invoke('save_llm_images', {
          images: [{ data: dataUrl, filename }],
        });
        if (saved.length > 0) {
          state.setScreenshotPath(saved[0]);
          console.log(`[CapabilityLearner] 截图已保存: ${state.getScreenshotPath()}`);
        }
      }
    } catch (e) {
      console.warn('[CapabilityLearner] 截图保存失败:', e);
    }

    visionElements = await visionAnalyzeScreenshot(screenshot, session.appName, provider, apiKey);
    result.visionElementsFound = visionElements.length;
  } else {
    result.errors.push('窗口截图失败，仅使用 UIA');
  }

  if (!state.getSession()) return result;

  // 3. 空间匹配
  const matchedVisionIdx = new Set<number>();
  const wWidth = winBounds?.width ?? 1920;
  const wHeight = winBounds?.height ?? 1080;
  const wX = winBounds?.x ?? 0;
  const wY = winBounds?.y ?? 0;

  const visionCenters = visionElements.map(ve => ({
    cx: ve.relativeX * wWidth + wX + (ve.relativeWidth * wWidth) / 2,
    cy: ve.relativeY * wHeight + wY + (ve.relativeHeight * wHeight) / 2,
  }));

  for (const node of visibleUIA) {
    if (!state.getSession()) break;
    if (!node.bounds) continue;

    const key = node.automation_id || `${node.role}:${node.name}`;
    if (session.discoveredCapabilities.has(key)) continue;

    const nodeCx = (node.bounds.left + node.bounds.right) / 2;
    const nodeCy = (node.bounds.top + node.bounds.bottom) / 2;
    let bestVision: VisionElement | null = null;
    let bestDist = Infinity;
    let bestIdx = -1;

    for (let i = 0; i < visionElements.length; i++) {
      if (matchedVisionIdx.has(i)) continue;
      const ve = visionElements[i];
      const dx = visionCenters[i].cx - nodeCx;
      const dy = visionCenters[i].cy - nodeCy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist && dist < 100) {
        bestDist = dist;
        bestVision = ve;
        bestIdx = i;
      }
    }

    let capability = bestVision
      ? inferCapabilityFromVision(bestVision)
      : inferCapabilityFromInteraction(node, 'click');
    if (!capability && node.enabled && node.visible) {
      capability = { interactionType: 'click' };
    }
    if (!capability) continue;

    if (bestVision) {
      matchedVisionIdx.add(bestIdx);
      capability.notes = bestVision.description;
      await saveSingleCapability(key, capability, node.bounds, winBounds, {
        label: bestVision.label,
        description: bestVision.description,
        keywords: bestVision.keywords,
        type: bestVision.type,
      });
    } else {
      await saveSingleCapability(key, capability, node.bounds, winBounds);
    }
    session.discoveredCapabilities.set(key, capability);
    session.discoveredBounds.set(key, node.bounds);
    result.childComponentsFound++;
  }

  if (!state.getSession()) return result;

  // 4. 保存视觉独有的元素
  for (let i = 0; i < visionElements.length; i++) {
    if (!state.getSession()) break;
    if (matchedVisionIdx.has(i)) continue;
    const ve = visionElements[i];

    const capability = inferCapabilityFromVision(ve) ?? { interactionType: 'click' as const };
    const key = `vision:${ve.label}`;
    if (!session.discoveredCapabilities.has(key)) {
      session.discoveredCapabilities.set(key, capability);
      session.discoveredBounds.set(key, {
        left: Math.round(ve.relativeX * 1920),
        top: Math.round(ve.relativeY * 1080),
        width: Math.round(ve.relativeWidth * 1920),
        height: Math.round(ve.relativeHeight * 1080),
      });
      await saveVisionElementAsAnnotation(ve, capability);
    }
  }
  if (!state.getSession()) return result;
  state.notifyListeners();

  // 5. LLM 分类可自动探索元素
  const explorableElements = mergeExplorableElements(uiaNodes, visionElements);
  if (explorableElements.length === 0) return result;

  const classification = await llmClassifyElements(explorableElements, provider, apiKey, screenshot);
  if (!state.getSession()) return result;

  const safeItems = classification.filter(c => c.category === 'auto_explore');
  const safeElements = safeItems.map(item => explorableElements[item.index - 1]).filter(Boolean);

  if (safeElements.length === 0) {
    return result;
  }

  // 6. 逐个探索
  for (const el of safeElements) {
    if (!state.getSession() || state.getStatus() !== 'learning') break;

    try {
      if (el.bounds) {
        const cx = Math.floor(el.bounds.left + el.bounds.width / 2);
        const cy = Math.floor(el.bounds.top + el.bounds.height / 2);
        await desktopService.click(cx, cy);
      } else if (el.uiaNode) {
        await desktopService.uiaClick(el.uiaNode.role, el.uiaNode.name, hwnd);
      } else {
        continue;
      }

      await new Promise(r => setTimeout(r, 600));
      if (!state.getSession()) break;

      let snapshotAfter = await fetchInteractiveNodes(hwnd);
      const { diffUIATrees } = await import('./detection');
      const newElements = diffUIATrees(uiaNodes, snapshotAfter);

      let newVisionElements: VisionElement[] = [];
      const afterScreenshot = await captureWindowScreenshot(hwnd);
      if (afterScreenshot && state.getSession()) {
        const afterVision = await visionAnalyzeScreenshot(afterScreenshot, session.appName, provider, apiKey);
        const beforeLabels = new Set(visionElements.map(v => v.label));
        newVisionElements = afterVision.filter(v => !beforeLabels.has(v.label));
      }
      if (!state.getSession()) break;

      let childFp: string | null = null;
      if (newElements.length > 0 || newVisionElements.length > 0) {
        if (el.uiaNode) {
          childFp = await recordChildComponent(el.uiaNode, newElements, 'click');
        }
        result.childComponentsFound++;
      }

      for (const element of newElements) {
        if (!state.getSession()) break;
        const capability = inferCapabilityFromInteraction(element, 'click');
        if (capability) {
          const key = element.automation_id || `${element.role}:${element.name}`;
          if (!session.discoveredCapabilities.has(key)) {
            session.discoveredCapabilities.set(key, capability);
            if (element.bounds) session.discoveredBounds.set(key, element.bounds);
            await saveSingleCapability(key, capability, element.bounds, winBounds, undefined, childFp ?? undefined);
          }
        }
      }

      for (const ve of newVisionElements) {
        if (!state.getSession()) break;
        const capability: ElementCapability = { interactionType: 'click', notes: `视觉识别: ${ve.description}` };
        const key = `vision:${ve.label}`;
        if (!session.discoveredCapabilities.has(key)) {
          session.discoveredCapabilities.set(key, capability);
          session.discoveredBounds.set(key, {
            left: Math.round(ve.relativeX * 1920),
            top: Math.round(ve.relativeY * 1080),
            width: Math.round(ve.relativeWidth * 1920),
            height: Math.round(ve.relativeHeight * 1080),
          });
          await saveVisionElementAsAnnotation(ve, capability, childFp ?? undefined);
        }
      }

      result.explored++;
      await desktopService.pressKey('Escape');
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      const msg = `探索 "${el.name || el.role}" 失败: ${e}`;
      result.errors.push(msg);
    }
  }

  return result;
}
