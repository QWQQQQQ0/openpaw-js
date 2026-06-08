// 截图与视觉分析

import { invoke } from '@tauri-apps/api/core';
import type { VisionElement, WindowBounds } from './types';
import { getModelService } from '@/services/model-service-singleton';
import { ModelScenario } from '@/services/llm-gateway/gateway';
import { resolveMultimodalProvider } from '@/utils/multimodal-provider';
import { useModelConfigStore } from '@/stores/model-config-store';

/** 截取指定窗口的截图（非全屏，不会被其他窗口遮挡） */
export async function captureWindowScreenshot(hwnd: number): Promise<string | null> {
  try {
    // 使用 PrintWindow API 截取窗口内容，不会被其他窗口遮挡
    const imageData = await invoke<string>('screenshot_window', { hwnd });
    console.log(`[CapabilityLearner] 窗口截图成功 (PrintWindow)`);
    return imageData;
  } catch (e) {
    console.warn('[CapabilityLearner] PrintWindow 截图失败，尝试 fallback:', e);
    // Fallback: 使用区域截图（会被遮挡）
    try {
      const winBounds = await invoke<WindowBounds>('get_window_bounds', { hwnd });
      if (winBounds.width <= 0 || winBounds.height <= 0) return null;
      const imageData = await invoke<string>('capture_region', {
        x: winBounds.x,
        y: winBounds.y,
        width: winBounds.width,
        height: winBounds.height,
      });
      console.log(`[CapabilityLearner] 窗口截图成功 (region fallback): ${winBounds.width}x${winBounds.height}`);
      return imageData;
    } catch (e2) {
      console.warn('[CapabilityLearner] 窗口截图失败:', e2);
      return null;
    }
  }
}

/** 用 LLM 视觉分析截图，识别交互元素 */
export async function visionAnalyzeScreenshot(
  screenshotBase64: string,
  appName: string,
  provider: import('@/types/provider').ProviderConfig,
  apiKey: string,
): Promise<VisionElement[]> {
  // 多模态自动切换：视觉分析必须使用支持多模态的模型
  if (provider.supportsMultimodal === false) {
    const allProviders = useModelConfigStore.getState().providers;
    const { provider: resolved, switched } = resolveMultimodalProvider(provider, allProviders, [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,placeholder' } },
    ]);
    if (switched) {
      provider = resolved;
      // 尝试获取新 provider 的 API key（使用空密码，与 chat-store 一致）
      try {
        apiKey = await useModelConfigStore.getState().getApiKey(provider.id, '');
      } catch { /* 使用传入的 apiKey 作为 fallback */ }
    }
  }

  const modelService = getModelService();

  // 压缩图片
  let imageUrl: string;
  try {
    const { compressImage } = await import('@/utils/image');
    const compressed = await compressImage(screenshotBase64);
    imageUrl = compressed.dataUrl;
  } catch {
    imageUrl = screenshotBase64.startsWith('data:') ? screenshotBase64 : `data:image/bmp;base64,${screenshotBase64}`;
  }

  const prompt = `你是 UI 元素识别助手。请分析这个 "${appName}" 窗口的截图。

如果是浏览器场景，需要区分浏览器通用元素（标签栏、地址栏、书签栏、前进/后退按钮等）和网页专有元素，仅返回网页专有元素。

识别所有可交互元素（按钮、输入框、下拉菜单、标签页、链接等）和内容区域。

**重要：对于你能从外观直接判断功能的元素（如图标、文字标识明确的按钮），只需返回其语义功能描述，不需要标记为需要探索。只有功能不明确、需要点击后才能了解其作用的元素才需要重点关注。**

对每个元素输出 JSON：
- label: 中文简短名称（如 "发送按钮"、"搜索框"）
- description: 一行位置描述（如 "窗口顶部右侧的设置按钮"）
- keywords: 中英文关键词数组（如 ["设置", "settings", "齿轮"]）
- relativeX: 左边缘占窗口宽度的比例 (0-1)
- relativeY: 上边缘占窗口高度的比例 (0-1)
- relativeWidth: 宽度占窗口宽度的比例 (0-1)
- relativeHeight: 高度占窗口高度的比例 (0-1)
- type: "interactive"（可点击）或 "content"（内容区域）
- known_function: 如果你能从外观判断该元素的功能，填写简短描述；否则留空

只输出 JSON 数组，不要其他文字。`;

  try {
    let response = '';
    const stream = modelService.chatStream({
      scenario: ModelScenario.raw,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: prompt },
        ],
      }],
      provider,
      apiKey,
    });
    for await (const chunk of stream) {
      if (!chunk.startsWith('__')) response += chunk;
    }

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    // 修复可能被截断的 JSON
    let jsonStr = jsonMatch[0];
    let arr: Array<Record<string, unknown>>;
    try {
      arr = JSON.parse(jsonStr) as Array<Record<string, unknown>>;
    } catch {
      // 尝试修复截断：去掉最后一个不完整的对象，补全括号
      const lastComplete = jsonStr.lastIndexOf('}');
      if (lastComplete > 0) {
        jsonStr = jsonStr.slice(0, lastComplete + 1) + ']';
        arr = JSON.parse(jsonStr) as Array<Record<string, unknown>>;
      } else {
        return [];
      }
    }
    return arr
      .map((item) => ({
        label: (item['label'] as string) || '',
        description: (item['description'] as string) || '',
        keywords: (item['keywords'] as string[]) || [],
        relativeX: Math.max(0, Math.min(1, Number(item['relativeX']) || 0)),
        relativeY: Math.max(0, Math.min(1, Number(item['relativeY']) || 0)),
        relativeWidth: Math.max(0.01, Math.min(1, Number(item['relativeWidth']) || 0.1)),
        relativeHeight: Math.max(0.01, Math.min(1, Number(item['relativeHeight']) || 0.1)),
        type: (item['type'] === 'content' ? 'content' : 'interactive') as 'interactive' | 'content',
        known_function: (item['known_function'] as string) || undefined,
      }))
      .filter((e) => e.label.length > 0);
  } catch (e) {
    return [];
  }
}
