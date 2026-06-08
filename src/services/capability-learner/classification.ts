// LLM 分类：判断哪些元素可自动探索

import type { ExplorableElement, InteractiveNode, LLMClassifiedElement, VisionElement } from './types';
import { getModelService } from '@/services/model-service-singleton';
import { ModelScenario } from '@/services/llm-gateway/gateway';

/** LLM 分类元素：结合截图理解每个元素的功能，返回分类 + 能力信息 */
export async function llmClassifyElements(
  elements: ExplorableElement[],
  provider: import('@/types/provider').ProviderConfig,
  apiKey: string,
  screenshot?: string | null,
): Promise<LLMClassifiedElement[]> {
  const modelService = getModelService();

  const elementList = elements.slice(0, 50).map((n, i) => {
    const boundsStr = n.bounds
      ? ` @(${n.bounds.left},${n.bounds.top},${n.bounds.width}x${n.bounds.height})`
      : '';
    const sourceTag = n.source === 'vision' ? ' [视觉]' : '';
    const knownFunc = n.visionElement?.known_function ? ` [已知功能: ${n.visionElement.known_function}]` : '';
    return `${i + 1}. [${n.role}] "${n.name}"${sourceTag}${knownFunc}${boundsStr}`;
  }).join('\n');

  const textContent = `你是 UI 学习助手。请结合截图分析以下元素，判断每个元素的类型和功能。

**分类规则：**

**A类 - 可自动探索**（功能不明确，需要点击后才能了解其作用）:
- 功能不明确的按钮、图标
- 不确定会展开什么内容的菜单项
- 需要点击后才能知道具体功能的元素

**B类 - 功能已知按钮**（从外观可直接判断功能，不可自动点击）:
- 功能明确的按钮（如发送、保存、删除、搜索等）
- 带有清晰文字或图标标识的操作按钮
- 已知功能的导航按钮

**C类 - 输入控件**（需要用户输入数据）:
- 文本输入框、搜索框、下拉选择框
- 日期选择器、复选框、单选按钮

**D类 - 不可交互/不明确**:
- 纯展示文本、用途不明确的元素
- 窗口控制按钮（最小化、最大化、关闭）
- 系统级导航（后退、前进、刷新、主页）

元素列表:
${elementList}

请输出 JSON 数组，每个元素一个对象：
[
  { "i": 1, "cat": "A" },
  { "i": 2, "cat": "B", "action": "click", "desc": "点击发送消息" },
  { "i": 3, "cat": "C", "action": "type", "desc": "输入搜索关键词", "input": "任意文本" },
  { "i": 4, "cat": "D" }
]

字段说明：
- i: 元素序号
- cat: 分类 A/B/C/D
- action: B/C 类必填，交互类型 (click/type/expand/select/doubleClick/rightClick/drag)
- desc: B/C 类必填，一句话描述该元素的功能
- input: C 类输入控件的输入格式提示

只输出 JSON 数组，不要其他文字。`;

  // 构建消息（可选包含截图）
  let messageContent: string | import('@/types/message').ContentPart[];

  if (screenshot) {
    const contentParts: import('@/types/message').ContentPart[] = [];
    try {
      const { compressImage } = await import('@/utils/image');
      const compressed = await compressImage(screenshot);
      contentParts.push({ type: 'image_url', image_url: { url: compressed.dataUrl } });
    } catch {
      const imageUrl = screenshot.startsWith('data:') ? screenshot : `data:image/bmp;base64,${screenshot}`;
      contentParts.push({ type: 'image_url', image_url: { url: imageUrl } });
    }
    contentParts.push({ type: 'text', text: textContent });
    messageContent = contentParts;
  } else {
    messageContent = textContent;
  }

  try {
    let response = '';
    const stream = modelService.chatStream({
      scenario: ModelScenario.desktopAutomation,
      messages: [{ role: 'user', content: messageContent }],
      provider,
      apiKey,
    });
    for await (const chunk of stream) {
      if (!chunk.startsWith('__')) response += chunk;
    }

    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn('[CapabilityLearner] LLM 响应无 JSON 数组:', response);
      return [];
    }

    const parsed = JSON.parse(jsonMatch[0]) as Array<{
      i: number;
      cat: string;
      action?: string;
      desc?: string;
      input?: string;
      notes?: string;
    }>;

    const result: LLMClassifiedElement[] = parsed
      .filter(item => !isNaN(item.i) && item.i >= 1 && item.i <= elements.length)
      .map(item => ({
        index: item.i,
        category: item.cat === 'A' ? 'auto_explore' as const
          : item.cat === 'B' || item.cat === 'C' ? 'capability' as const
          : 'skip' as const,
        interactionType: (item.action as import('@/types/cache').ElementCapability['interactionType']) || undefined,
        description: item.desc || undefined,
        inputFormat: item.input || undefined,
        notes: item.notes || undefined,
      }));

    const autoExploreCount = result.filter(r => r.category === 'auto_explore').length;
    const capabilityCount = result.filter(r => r.category === 'capability').length;
    const skipCount = result.filter(r => r.category === 'skip').length;
    console.log(`[CapabilityLearner] LLM 分类: 自动探索=${autoExploreCount}, 能力记录=${capabilityCount}, 跳过=${skipCount}`);

    return result;
  } catch (e) {
    console.warn('[CapabilityLearner] LLM 分类失败:', e);
    return [];
  }
}

/** 合并 UIA 节点和视觉元素为统一的可探索列表 */
export function mergeExplorableElements(uiaNodes: InteractiveNode[], visionElements: VisionElement[]): ExplorableElement[] {
  const result: ExplorableElement[] = [];

  // UIA 节点
  for (const node of uiaNodes) {
    if (!node.visible || !node.enabled) continue;
    const bounds = node.bounds
      ? { left: node.bounds.left, top: node.bounds.top, width: node.bounds.width, height: node.bounds.height }
      : null;
    result.push({
      source: 'uia',
      name: node.name || node.role,
      role: node.role,
      bounds,
      uiaNode: node,
    });
  }

  // 视觉元素（过滤掉与 UIA 重叠的）
  const uiaBoundsSet = new Set(
    uiaNodes
      .filter(n => n.bounds)
      .map(n => `${Math.round(n.bounds!.left / 50)},${Math.round(n.bounds!.top / 50)}`)
  );

  for (const ve of visionElements) {
    if (ve.type !== 'interactive') continue;
    // 简单去重：如果视觉元素位置与某个 UIA 节点相近，跳过
    const veCenterX = ve.relativeX * 1920; // 假设屏幕宽度
    const veCenterY = ve.relativeY * 1080;
    const gridKey = `${Math.round(veCenterX / 50)},${Math.round(veCenterY / 50)}`;
    if (uiaBoundsSet.has(gridKey)) continue;

    // 视觉元素转为 ExplorableElement
    result.push({
      source: 'vision',
      name: ve.label,
      role: 'vision',
      bounds: null, // 需要窗口尺寸才能计算，这里先用 null
      visionElement: ve,
    });
  }

  return result;
}
