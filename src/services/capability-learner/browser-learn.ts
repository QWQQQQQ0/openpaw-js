// 受控浏览学习：视觉 + DOM 匹配

import type { ElementCapability, VisionElement, InteractiveNode } from './types';
import * as state from './state';
import { saveSingleCapability, saveVisionElementAsAnnotation } from './storage';

/**
 * 受控浏览学习：分析 LLM 视觉结果和 DOM 元素，进行匹配
 * @param visionElements LLM 视觉分析结果
 * @param domElements DOM 交互元素
 * @param screenshotPath 截图路径
 * @returns 匹配后的元素列表
 */
export async function browserLearnWithDOM(
  visionElements: VisionElement[],
  domElements: InteractiveNode[],
  screenshotPath?: string | null,
): Promise<{
  matched: Array<{
    vision: VisionElement;
    dom: InteractiveNode | null;
    confidence: number;
  }>;
  visionOnly: VisionElement[];
  domOnly: InteractiveNode[];
}> {
  const matched: Array<{ vision: VisionElement; dom: InteractiveNode | null; confidence: number }> = [];
  const visionOnly: VisionElement[] = [];
  const domOnly: InteractiveNode[] = [...domElements];

  // 空间匹配：将视觉元素和 DOM 元素进行匹配
  for (const ve of visionElements) {
    let bestMatch: InteractiveNode | null = null;
    let bestConfidence = 0;

    const veCenterX = ve.relativeX + ve.relativeWidth / 2;
    const veCenterY = ve.relativeY + ve.relativeHeight / 2;

    for (const dom of domElements) {
      if (!dom.bounds) continue;

      // 计算 DOM 元素的中心点（假设窗口尺寸为 1920x1080）
      const domCenterX = (dom.bounds.left + dom.bounds.right) / 2 / 1920;
      const domCenterY = (dom.bounds.top + dom.bounds.bottom) / 2 / 1080;

      // 计算距离
      const dx = veCenterX - domCenterX;
      const dy = veCenterY - domCenterY;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // 计算置信度（距离越近，置信度越高）
      const confidence = Math.max(0, 1 - distance * 10);

      if (confidence > bestConfidence && confidence > 0.3) {
        bestConfidence = confidence;
        bestMatch = dom;
      }
    }

    if (bestMatch) {
      matched.push({ vision: ve, dom: bestMatch, confidence: bestConfidence });
      // 从 domOnly 中移除已匹配的元素
      const index = domOnly.indexOf(bestMatch);
      if (index > -1) {
        domOnly.splice(index, 1);
      }
    } else {
      visionOnly.push(ve);
    }
  }

  return { matched, visionOnly, domOnly };
}

/**
 * 保存受控浏览学习的结果
 * @param matched 匹配的元素列表
 * @param visionOnly 仅视觉识别的元素
 * @param domOnly 仅 DOM 识别的元素
 * @param screenshotPath 截图路径
 */
export async function saveBrowserLearnResult(
  matched: Array<{
    vision: VisionElement;
    dom: InteractiveNode | null;
    confidence: number;
  }>,
  visionOnly: VisionElement[],
  domOnly: InteractiveNode[],
  screenshotPath?: string | null,
): Promise<number> {
  const session = state.getSession();
  if (!session) {
    return 0;
  }

  let savedCount = 0;

  // 保存匹配的元素（结合视觉和 DOM 信息）
  for (const item of matched) {
    const capability: ElementCapability = {
      interactionType: 'click',
      notes: item.vision.known_function || item.vision.description,
    };

    const key = `browser:${item.vision.label}:${Date.now()}:${savedCount}`;

    // 使用 DOM 元素的 bounds（如果有）
    const rawBounds = item.dom?.bounds ? {
      left: item.dom.bounds.left,
      top: item.dom.bounds.top,
      width: item.dom.bounds.width,
      height: item.dom.bounds.height,
    } : {
      left: Math.round(item.vision.relativeX * 1920),
      top: Math.round(item.vision.relativeY * 1080),
      width: Math.round(item.vision.relativeWidth * 1920),
      height: Math.round(item.vision.relativeHeight * 1080),
    };
    const bounds = { ...rawBounds, right: rawBounds.left + rawBounds.width, bottom: rawBounds.top + rawBounds.height };

    session.discoveredCapabilities.set(key, capability);
    session.discoveredBounds.set(key, bounds);
    await saveSingleCapability(key, capability, bounds);
    await saveVisionElementAsAnnotation(item.vision, capability);

    savedCount++;
  }

  // 保存仅视觉识别的元素
  for (const ve of visionOnly) {
    const capability: ElementCapability = {
      interactionType: 'click',
      notes: ve.known_function || ve.description,
    };

    const key = `browser:vision:${ve.label}:${Date.now()}:${savedCount}`;

    const rawBounds = {
      left: Math.round(ve.relativeX * 1920),
      top: Math.round(ve.relativeY * 1080),
      width: Math.round(ve.relativeWidth * 1920),
      height: Math.round(ve.relativeHeight * 1080),
    };
    const bounds = { ...rawBounds, right: rawBounds.left + rawBounds.width, bottom: rawBounds.top + rawBounds.height };

    session.discoveredCapabilities.set(key, capability);
    session.discoveredBounds.set(key, bounds);
    await saveSingleCapability(key, capability, bounds);
    await saveVisionElementAsAnnotation(ve, capability);

    savedCount++;
  }

  // 保存仅 DOM 识别的元素
  for (const dom of domOnly) {
    if (!dom.bounds) continue;

    const capability: ElementCapability = {
      interactionType: 'click',
      notes: `DOM: ${dom.role} - ${dom.name}`,
    };

    const key = `browser:dom:${dom.role}:${dom.name}:${Date.now()}:${savedCount}`;

    session.discoveredCapabilities.set(key, capability);
    session.discoveredBounds.set(key, dom.bounds);
    await saveSingleCapability(key, capability, dom.bounds);

    savedCount++;
  }

  state.notifyListeners();
  return savedCount;
}
