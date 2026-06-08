import type { InteractiveNode, SemanticAnnotation, ElementCapability } from '@/types/cache';
import type { ProviderConfig } from '@/types/provider';
import { ModelScenario } from '@/services/llm-gateway/gateway';
import { getModelService } from '@/services/model-service-singleton';

/**
 * Ask LLM to produce semantic annotations for a set of UIA interactive nodes.
 * Returns SemanticAnnotation[] with labels, descriptions, and keywords.
 */
export async function annotatePage(
  nodes: InteractiveNode[],
  windowTitle: string,
  provider: ProviderConfig,
  apiKey: string,
): Promise<SemanticAnnotation[]> {
  if (nodes.length === 0) return [];

  const modelService = getModelService();

  const elementList = nodes.slice(0, 50).map((n, i) => {
    const boundsStr = n.bounds
      ? ` @(${n.bounds.left},${n.bounds.top},${n.bounds.width}x${n.bounds.height})`
      : '';
    return `${i + 1}. [${n.role}] "${n.name || ''}"${n.enabled ? '' : ' (disabled)'}${boundsStr}`;
  }).join('\n');

  const prompt = `你是页面元素标注器。以下是应用"${windowTitle}"窗口中的可交互元素列表。
为每个元素生成语义标注和能力信息。

元素列表:
${elementList}

对每个元素输出一个 JSON 对象，组成数组。每个对象字段:
- index: 元素序号（从1开始）
- label: 简短语义名（中文，如"搜索按钮"、"用户名输入框"）
- description: 一句话说明用途
- keywords: 匹配关键词数组，包含中文和英文（如["搜索","search","查找"]）
- interactionType: 交互方式，可选值: "click" | "doubleClick" | "rightClick" | "type" | "expand" | "select" | "drag"
- options: 如果是下拉框/菜单/列表，列出可能的选项数组，每项有 label 和可选 description
- inputFormat: 如果是输入框，说明输入格式要求（如"YYYY-MM-DD"、"数字"、"任意文本"）
- notes: 交互技巧或注意事项（如"需要先点击展开"、"右键弹出菜单"）

规则:
- label 要简洁直观，用用户会说的自然语言
- keywords 要覆盖用户可能的各种说法
- interactionType 根据元素 role 推断: Button→click, Edit→type, ComboBox→expand, List→select, 菜单→click
- options 只在能明显推断时填写（如常见的字体选择、语言选择等），否则留空
- notes 记录重要的交互模式（如右键菜单、双击打开等）
- 只输出 JSON 数组，无其他文字

示例输出:
[{"index":1,"label":"搜索按钮","description":"点击执行搜索","keywords":["搜索","search","查找","搜"],"interactionType":"click","notes":"点击后执行搜索"},{"index":2,"label":"搜索输入框","description":"输入搜索关键词","keywords":["搜索框","search","输入","关键词"],"interactionType":"type","inputFormat":"任意文本","notes":"输入后按回车或点击搜索按钮"}]`;

  try {
    const stream = modelService.chatStream({
      scenario: ModelScenario.raw,
      messages: [{ role: 'user', content: prompt }],
      provider,
      apiKey,
      tools: undefined,
    });

    let text = '';
    for await (const chunk of stream) {
      if (!chunk.startsWith('__')) text += chunk;
    }

    // Extract JSON array from response
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const arr = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
    const windowBounds = computeWindowBounds(nodes);

    return arr.map((item, _i) => {
      const idx = (item['index'] as number) - 1;
      const node = nodes[idx];
      if (!node) return null;

      const relPos = computeRelativePosition(node, windowBounds);

      // Build capability from LLM response
      const capability: ElementCapability | undefined = item['interactionType'] ? {
        interactionType: item['interactionType'] as ElementCapability['interactionType'],
        options: item['options'] as ElementCapability['options'],
        inputFormat: item['inputFormat'] as string | undefined,
        notes: item['notes'] as string | undefined,
      } : undefined;

      return {
        label: (item['label'] as string) || node.name || node.role,
        description: (item['description'] as string) || '',
        role: node.role,
        name: node.name,
        automationId: node.automation_id,
        relativeX: relPos.x,
        relativeY: relPos.y,
        keywords: (item['keywords'] as string[]) || [],
        capability,
      };
    }).filter(Boolean) as SemanticAnnotation[];
  } catch (e) {
    console.debug('SemanticAnnotation: LLM annotation failed', e);
    return [];
  }
}

/**
 * Convert web DOMNode[] to SemanticAnnotation[] without LLM calls.
 * Uses DOM structure (tag, text, selector, bounds) to generate annotations directly.
 */
export function domNodesToAnnotations(
  nodes: Array<{
    tag?: string;
    text?: string;
    selector?: string;
    bounds?: { x: number; y: number; width: number; height: number };
    clickable?: boolean;
    inputType?: string;
    href?: string;
    children?: Array<unknown>;
  }>,
  viewportWidth: number,
  viewportHeight: number,
): SemanticAnnotation[] {
  const annotations: SemanticAnnotation[] = [];

  function walk(nodeList: typeof nodes, depth: number) {
    for (const node of nodeList) {
      if (depth > 10) break;

      const isInteractive = node.clickable || node.inputType || node.href;
      if (isInteractive && node.bounds) {
        const label = inferWebLabel(node);
        const role = inferWebRole(node);
        const capability = inferWebCapability(node);
        annotations.push({
          label,
          description: `${role}: ${label}`,
          role,
          name: label,
          automationId: node.selector ?? '',
          relativeX: viewportWidth > 0 ? node.bounds.x / viewportWidth : 0,
          relativeY: viewportHeight > 0 ? node.bounds.y / viewportHeight : 0,
          relativeWidth: viewportWidth > 0 ? node.bounds.width / viewportWidth : 0,
          relativeHeight: viewportHeight > 0 ? node.bounds.height / viewportHeight : 0,
          keywords: generateWebKeywords(node),
          type: 'interactive',
          capability,
        });
      }

      if (node.children && node.children.length > 0) {
        walk(node.children as typeof nodes, depth + 1);
      }
    }
  }

  walk(nodes, 0);
  return annotations;
}

function inferWebLabel(node: { tag?: string; text?: string; inputType?: string; href?: string }): string {
  const text = (node.text ?? '').trim();
  if (text.length > 0 && text.length <= 50) return text;
  if (node.tag === 'input') return `${node.inputType ?? 'text'}输入框`;
  if (node.tag === 'a') return node.href ? `链接: ${node.href.substring(0, 30)}` : '链接';
  if (node.tag === 'button') return text || '按钮';
  return `${node.tag ?? '元素'}`;
}

function inferWebRole(node: { tag?: string; inputType?: string }): string {
  if (node.tag === 'input') {
    switch (node.inputType) {
      case 'text': case 'search': return 'Edit';
      case 'button': case 'submit': return 'Button';
      case 'checkbox': return 'CheckBox';
      case 'radio': return 'RadioButton';
      default: return 'Edit';
    }
  }
  if (node.tag === 'button') return 'Button';
  if (node.tag === 'a') return 'Hyperlink';
  if (node.tag === 'select') return 'ComboBox';
  if (node.tag === 'textarea') return 'Edit';
  return 'Control';
}

function generateWebKeywords(node: { tag?: string; text?: string; inputType?: string; href?: string }): string[] {
  const keywords: string[] = [];
  const text = (node.text ?? '').trim();
  if (text.length > 0 && text.length <= 30) {
    keywords.push(text);
  }
  if (node.tag === 'input') keywords.push('输入', 'input', '输入框');
  if (node.tag === 'button') keywords.push('按钮', 'button', '点击');
  if (node.tag === 'a') keywords.push('链接', 'link');
  return keywords;
}

function inferWebCapability(node: { tag?: string; inputType?: string; clickable?: boolean }): ElementCapability | undefined {
  if (node.tag === 'input') {
    const inputType = node.inputType ?? 'text';
    switch (inputType) {
      case 'text': case 'search': case 'email': case 'url':
        return { interactionType: 'type', inputFormat: '任意文本' };
      case 'number':
        return { interactionType: 'type', inputFormat: '数字' };
      case 'date':
        return { interactionType: 'type', inputFormat: 'YYYY-MM-DD' };
      case 'checkbox':
        return { interactionType: 'click', notes: '点击切换勾选状态' };
      case 'radio':
        return { interactionType: 'click', notes: '点击选择此选项' };
      case 'submit': case 'button':
        return { interactionType: 'click' };
      default:
        return { interactionType: 'type' };
    }
  }
  if (node.tag === 'button') return { interactionType: 'click' };
  if (node.tag === 'a') return { interactionType: 'click', notes: '点击跳转链接' };
  if (node.tag === 'select') return { interactionType: 'expand', notes: '点击展开下拉框选择选项' };
  if (node.tag === 'textarea') return { interactionType: 'type', inputFormat: '多行文本' };
  if (node.clickable) return { interactionType: 'click' };
  return undefined;
}

/** Match a goal against cached semantic annotations. Returns the best match or null. */
export function matchGoalToAnnotation(
  goal: string,
  annotations: SemanticAnnotation[],
): SemanticAnnotation | null {
  if (annotations.length === 0) return null;

  const goalNorm = normalizeForMatch(goal);
  const goalTokens = tokenize(goalNorm);
  if (goalTokens.length === 0) return null;

  let best: { ann: SemanticAnnotation; score: number } | null = null;

  for (const ann of annotations) {
    const labelNorm = normalizeForMatch(ann.label);
    const descNorm = normalizeForMatch(ann.description);
    const keywordsNorm = ann.keywords.map(normalizeForMatch).join(' ');
    const optionsNorm = ann.capability?.options?.map(o => normalizeForMatch(o.label)).join(' ') ?? '';
    const allTargets = `${labelNorm} ${descNorm} ${keywordsNorm} ${optionsNorm}`;

    let score = 0;
    for (const token of goalTokens) {
      if (allTargets.includes(token)) score += 1;
      if (labelNorm.includes(token)) score += 2; // label match is stronger
      if (optionsNorm.includes(token)) score += 3; // option match is strongest (user wants specific option)
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { ann, score };
    }
  }

  // Require at least 30% of goal tokens to match
  if (best && best.score >= goalTokens.length * 0.3) {
    return best.ann;
  }
  return null;
}

// ── Helpers ──

function normalizeForMatch(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s　]+/g, '')
    .replace(/[，。！？、；：""''【】（）《》,.!?;:'"()[\]{}]/g, '');
}

function tokenize(normalized: string): string[] {
  // Split into meaningful tokens: CJK characters as individual tokens, ASCII words as whole tokens
  const tokens: string[] = [];
  let asciiBuf = '';
  for (const ch of normalized) {
    if (ch.charCodeAt(0) > 0x7f) {
      if (asciiBuf) { tokens.push(asciiBuf); asciiBuf = ''; }
      tokens.push(ch);
    } else {
      asciiBuf += ch;
    }
  }
  if (asciiBuf) tokens.push(asciiBuf);
  return tokens.filter(t => t.length > 0);
}

function computeWindowBounds(nodes: InteractiveNode[]): { left: number; top: number; width: number; height: number } {
  let minLeft = Infinity, minTop = Infinity, maxRight = -Infinity, maxBottom = -Infinity;
  for (const n of nodes) {
    if (!n.bounds) continue;
    if (n.bounds.left < minLeft) minLeft = n.bounds.left;
    if (n.bounds.top < minTop) minTop = n.bounds.top;
    if (n.bounds.right > maxRight) maxRight = n.bounds.right;
    if (n.bounds.bottom > maxBottom) maxBottom = n.bounds.bottom;
  }
  if (minLeft === Infinity) return { left: 0, top: 0, width: 1, height: 1 };
  return { left: minLeft, top: minTop, width: maxRight - minLeft || 1, height: maxBottom - minTop || 1 };
}

function computeRelativePosition(node: InteractiveNode, windowBounds: { left: number; top: number; width: number; height: number }): { x: number; y: number } {
  if (!node.bounds) return { x: 0.5, y: 0.5 };
  const cx = (node.bounds.left + node.bounds.right) / 2;
  const cy = (node.bounds.top + node.bounds.bottom) / 2;
  return {
    x: Math.round(((cx - windowBounds.left) / windowBounds.width) * 100) / 100,
    y: Math.round(((cy - windowBounds.top) / windowBounds.height) * 100) / 100,
  };
}
