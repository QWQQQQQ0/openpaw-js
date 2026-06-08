// 级联学习：点击元素后自动学习子组件

import type { ElementCapability, VisionElement, TriggerInfo } from './types';
import { desktopService } from '@/services/desktop-service';
import { getUICache, updateSemanticAnnotations } from '@/services/cache-service';
import { getCacheService } from '@/services/cache-service-singleton';
import * as state from './state';
import { captureWindowScreenshot, visionAnalyzeScreenshot } from './vision';
import { fetchInteractiveNodes } from './detection';
import { saveVisionElementAsAnnotation } from './storage';

/**
 * 级联学习：点击元素后自动学习子组件
 * @param hwnd 目标窗口句柄
 * @param appName 应用名称
 * @param clickedElement 被点击的元素
 * @param provider LLM 配置
 * @param apiKey API 密钥
 * @returns 子组件学习结果
 */
export async function cascadeLearn(
  hwnd: number,
  appName: string,
  clickedElement: {
    label: string;
    automationId?: string;
    role?: string;
    bounds?: { left: number; top: number; width: number; height: number };
  },
  provider: import('@/types/provider').ProviderConfig,
  apiKey: string,
): Promise<{
  success: boolean;
  childFingerprint?: string;
  newElements?: VisionElement[];
  error?: string;
}> {

  const session = state.getSession();
  if (!session) {
    return { success: false, error: '未在学习模式中' };
  }

  // 1. 点击元素（bounds 是窗口相对坐标，需要加窗口位置偏移）
  if (clickedElement.bounds) {
    let cx = Math.round(clickedElement.bounds.left + clickedElement.bounds.width / 2);
    let cy = Math.round(clickedElement.bounds.top + clickedElement.bounds.height / 2);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const winBounds = await invoke<{ x: number; y: number; width: number; height: number }>('get_window_bounds', { hwnd });
      if (winBounds && winBounds.width > 0) {
        cx += winBounds.x;
        cy += winBounds.y;
      }
    } catch { /* 用原始坐标 */ }
    try {
      await desktopService.click(cx, cy);
    } catch (e) {
      return { success: false, error: `点击失败: ${e}` };
    }
  }

  // 2. 等待 UI 更新
  await new Promise(r => setTimeout(r, 500));

  // 3. 截屏分析
  const screenshot = await captureWindowScreenshot(hwnd);
  if (!screenshot) {
    return { success: false, error: '截屏失败' };
  }

  // 4. LLM 分析新出现的元素
  const visionElements = await visionAnalyzeScreenshot(screenshot, appName, provider, apiKey);

  // 5. 获取 UIA 节点
  const uiaNodes = await fetchInteractiveNodes(hwnd);

  // 6. 生成子组件 fingerprint
  const childFp = `${session.fingerprint}:child:${clickedElement.automationId || clickedElement.role}:${clickedElement.label}`;

  // 7. 保存子组件
  const trigger: TriggerInfo = {
    type: 'click',
    detail: `点击「${clickedElement.label}」后出现`,
    elementRef: {
      label: clickedElement.label,
      automationId: clickedElement.automationId,
    },
  };

  try {
    const cache = getCacheService();
    await cache.storeUICache(
      childFp,
      session.fingerprint,
      null,
      appName,
      '',
      uiaNodes,
      [],
      session.fingerprint,
      trigger,
    );


    // 8. 保存视觉元素到子组件
    for (const ve of visionElements) {
      const capability: ElementCapability = {
        interactionType: 'click',
        notes: ve.known_function || ve.description,
      };

      await saveVisionElementAsAnnotation(ve, capability, childFp);
    }

    // 9. 更新父组件中被点击元素的描述
    const childSummary = visionElements.slice(0, 5).map(ve => ve.label).join('、');
    if (childSummary) {
      const existing = await getUICache(session.fingerprint);
      if (existing) {
        const clickedKey = clickedElement.automationId || `${clickedElement.role}:${clickedElement.label}`;
        const updated = existing.annotations.map(ann => {
          const annKey = ann.automationId || `${ann.role}:${ann.name}`;
          if (annKey === clickedKey) {
            return {
              ...ann,
              capability: {
                ...ann.capability,
                interactionType: 'click' as const,
                notes: `点击后展开: ${childSummary} 等 ${visionElements.length} 个元素`,
              },
            };
          }
          return ann;
        });
        await updateSemanticAnnotations(session.fingerprint, updated);
      }
    }

    return {
      success: true,
      childFingerprint: childFp,
      newElements: visionElements,
    };
  } catch (e) {
    return { success: false, error: `保存失败: ${e}` };
  }
}

/**
 * 批量级联学习：自动识别可展开元素并学习
 * @param hwnd 目标窗口句柄
 * @param appName 应用名称
 * @param elements 要学习的元素列表
 * @param provider LLM 配置
 * @param apiKey API 密钥
 * @param onProgress 进度回调
 */
export async function batchCascadeLearn(
  hwnd: number,
  appName: string,
  elements: Array<{
    label: string;
    automationId?: string;
    role?: string;
    bounds?: { left: number; top: number; width: number; height: number };
    known_function?: string;
  }>,
  provider: import('@/types/provider').ProviderConfig,
  apiKey: string,
  onProgress?: (current: number, total: number, element: string) => void,
): Promise<{
  success: number;
  failed: number;
  children: Array<{ parent: string; childFp: string; elements: number }>;
}> {
  let success = 0;
  let failed = 0;
  const children: Array<{ parent: string; childFp: string; elements: number }> = [];

  // 用户手动选择的元素全部级联学习，不再过滤
  const explorableElements = elements;

  for (let i = 0; i < explorableElements.length; i++) {
    const el = explorableElements[i];

    if (onProgress) {
      onProgress(i + 1, explorableElements.length, el.label);
    }

    // 先按 Escape 关闭可能打开的菜单
    await desktopService.pressKey('Escape');
    await new Promise(r => setTimeout(r, 200));

    const result = await cascadeLearn(hwnd, appName, el, provider, apiKey);

    if (result.success && result.childFingerprint && result.newElements) {
      success++;
      children.push({
        parent: el.label,
        childFp: result.childFingerprint,
        elements: result.newElements.length,
      });
    } else {
      failed++;
    }

    // 等待一下再学习下一个
    await new Promise(r => setTimeout(r, 300));
  }

  return { success, failed, children };
}
