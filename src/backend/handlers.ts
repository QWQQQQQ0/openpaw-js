// Agent Handler —— 每个 Agent 端点的后端处理逻辑。
// 每个 handler 接收前端请求数据，调用统一的 LlmExecutor，返回结果。
// 内部复用现有系统提示和 JSON 解析逻辑（与前端 Agent API 一致）。

import { ModelScenario } from '@/services/llm-gateway/gateway';
import { executeCall, executeStream } from './llm-executor';
import type {
  IntentClassifierParams,
  VerificationParams,
  ChatParams,
  CodeGenerationParams,
  CodeIterationParams,
  UIVisionAnalyzeParams,
  UIVisionAnnotateParams,
  UIVisionOcrClassifyParams,
  ScreenAnalysisDiffParams,
  ScreenAnalysisRegionsParams,
  ScreenAnalysisOcrParams,
  ScreenAnalysisInterruptionParams,
  DesktopAutomationParams,
} from '@/api/types';
import type { ProviderConfig } from '@/types/provider';

// ═══════════════════════════════════════════════════════════════
// 类型辅助
// ═══════════════════════════════════════════════════════════════

function unwrapParams<T>(params: unknown): T {
  return params as T;
}

// ═══════════════════════════════════════════════════════════════
// IntentClassifierHandler
// ═══════════════════════════════════════════════════════════════

function buildClassifierPrompt(): string {
  return `你是一个意图分类器。用户会用自然语言描述他们想做的事，你负责分类、提取参数、并对 screen_change 类型做结构化分解。

输出格式（严格 JSON，不要包含其他文字）：
{
  "tasks": [
    {
      "name": "简短任务名",
      "type": "once" | "timer" | "screen_change",
      "goal": "具体执行描述，供 agent 执行用",
      "schedule": { "cron": "...", "intervalMs": 0, "delayMs": 0, "at": 0 },
      "monitor": { "app": "...", "region": "...", "windowTitle": "..." },
      "action": {
        "type": "agent_execute" | "notify",
        "goalTemplate": "...",
        "requiresScreenshot": true/false
      },
      "preparationGoal": "监控前的准备动作（仅 screen_change）",
      "actionGoal": "触发后的详细动作描述（仅 screen_change）"
    }
  ],
  "response": "一句话确认，≤15字，例如'好的，马上处理'、'已设置定时任务'"
}

规则：
1. type："once"（一次性）、"timer"（定时/周期）、"screen_change"（屏幕变化监控）
2. schedule 仅 timer 类型
3. monitor 仅 screen_change 类型
4. screen_change 需分解 preparationGoal 和 actionGoal
5. 一个输入可包含多个任务
6. response 只一句话确认意图`;
}

function parseIntentResponse(raw: string): unknown {
  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const obj = JSON.parse(cleaned);
    if (!obj.tasks || !Array.isArray(obj.tasks)) throw new Error('Missing tasks array');
    for (const task of obj.tasks) {
      if (!task.type || !task.goal || !task.action) throw new Error('Invalid task');
    }
    return { tasks: obj.tasks, response: obj.response ?? '好的，我来处理。' };
  } catch {
    return {
      tasks: [{ name: raw.substring(0, 30), type: 'once', goal: raw, action: { type: 'agent_execute', goalTemplate: raw } }],
      response: '好的，我来处理。',
    };
  }
}

export async function* handleIntentClassifier(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): AsyncGenerator<string> {
  const p = unwrapParams<IntentClassifierParams>(rawParams);
  const prompt = buildClassifierPrompt();

  const stream = executeStream({
    scenario: ModelScenario.watcher,
    messages: [
      { role: 'system', content: prompt },
      { role: 'user', content: p.userInput },
    ],
    provider,
    apiKey,
    goal: p.userInput,
  });

  let responseText = '';
  for await (const chunk of stream) {
    if (chunk.startsWith('__REASONING__:') || chunk.startsWith('__ERROR__:')) {
      // 思考过程和错误直接透传给前端
      yield chunk;
    } else if (chunk.startsWith('__TOOLS__:')) {
      yield chunk;
    } else {
      responseText += chunk;
      yield chunk;
    }
  }

  // 流结束时输出解析后的分类结果
  const parsed = parseIntentResponse(responseText);
  yield `__TOOLS__:${JSON.stringify(parsed)}`;
}

// ═══════════════════════════════════════════════════════════════
// VerificationHandler
// ═══════════════════════════════════════════════════════════════

export async function handleVerification(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): Promise<unknown> {
  const p = unwrapParams<VerificationParams>(rawParams);
  // screenshotBase64 is already compressed on the frontend before sending
  const imageUrl = p.screenshotBase64.startsWith('data:')
    ? p.screenshotBase64
    : `data:image/jpeg;base64,${p.screenshotBase64}`;

  const messages: import('@/types/message').LLMMessage[] = [];
  if (p.contextMessages && p.contextMessages.length > 0) {
    messages.push(...p.contextMessages);
  }
  messages.push({
    role: 'user',
    content: [
      { type: 'image_url', image_url: { url: imageUrl } },
      {
        type: 'text',
        text: `Original goal: "${p.goal}"\n\nLook at the screenshot above. Is the goal FULLY completed?\n\nAnswer with ONLY one word on the first line: YES or NO.\nIf NO, describe what is still missing on the next line.\n\nBe strict: even small issues mean the task is NOT complete. Do NOT use any tool — just answer in plain text.`,
      },
    ],
  });

  try {
    const { responseText } = await executeCall({
      scenario: ModelScenario.desktopAutomation,
      messages,
      provider,
      apiKey,
      goal: p.goal,
      skipCache: true,
    });

    const trimmed = responseText.trim();
    const firstLine = trimmed.split('\n')[0]?.trim().toUpperCase() ?? '';
    const completed = firstLine === 'YES' || firstLine.startsWith('YES');
    const feedback = completed
      ? 'Task verified complete'
      : firstLine.startsWith('NO')
        ? trimmed.substring(trimmed.indexOf('\n') + 1).trim() || 'Task appears incomplete'
        : trimmed || 'Task appears incomplete';

    return { completed, feedback, screenshot: p.screenshotBase64 };
  } catch {
    return { completed: true, feedback: 'Verification error — trusted agent', screenshot: p.screenshotBase64 };
  }
}

// ═══════════════════════════════════════════════════════════════
// ChatHandler（流式）
// ═══════════════════════════════════════════════════════════════

export function handleChat(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): AsyncGenerator<string> {
  const p = unwrapParams<ChatParams>(rawParams);
  return executeStream({
    scenario: ModelScenario.raw,
    messages: p.messages,
    provider,
    apiKey,
    tools: p.tools,
    goal: p.goal,
    skipCache: p.skipCache,
  });
}

// ═══════════════════════════════════════════════════════════════
// CodeGenerationHandler（流式）
// ═══════════════════════════════════════════════════════════════

export function handleCodeGeneration(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): AsyncGenerator<string> {
  const p = unwrapParams<CodeGenerationParams>(rawParams);
  return executeStream({
    scenario: ModelScenario.codeGeneration,
    messages: [{ role: 'user', content: p.prompt }],
    provider,
    apiKey,
  });
}

// ═══════════════════════════════════════════════════════════════
// CodeIterationHandler（流式）
// ═══════════════════════════════════════════════════════════════

export function handleCodeIteration(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): AsyncGenerator<string> {
  const p = unwrapParams<CodeIterationParams>(rawParams);
  return executeStream({
    scenario: ModelScenario.codeIteration,
    messages: [{
      role: 'user',
      content: `The following code produced an error:\n\nCode:\n\`\`\`\n${p.code}\n\`\`\`\n\nError:\n${p.error}\n\nPlease fix the code and explain the fix.`,
    }],
    provider,
    apiKey,
  });
}

// ═══════════════════════════════════════════════════════════════
// UIVision Handlers
// ═══════════════════════════════════════════════════════════════

function buildVisionPrompt(goal: string, existingAnnotations?: string): string {
  const existingBlock = existingAnnotations
    ? `\nPreviously known elements (keep their names):\n${existingAnnotations}\n`
    : '';
  return `Task goal: "${goal}"${existingBlock}
Analyze the screenshot and identify ALL interactive UI elements.
Return a JSON array of objects with:
- label: semantic name in Chinese (e.g. "发送按钮", "搜索框")
- description: location description (e.g. "聊天窗口底部右侧")
- keywords: array of search keywords (Chinese + English)
- relativeX: 0-1, x position relative to image width
- relativeY: 0-1, y position relative to image height
- relativeWidth: 0-1, element width / image width
- relativeHeight: 0-1, element height / image height
- type: "interactive" or "content"

Only output the JSON array, nothing else.`;
}

function parseVisionJson(text: string): unknown[] {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]) as unknown[];
    return [];
  } catch {
    return [];
  }
}

export async function handleUIVisionAnalyze(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): Promise<unknown> {
  const p = unwrapParams<UIVisionAnalyzeParams>(rawParams);
  const prompt = buildVisionPrompt(p.goal, p.existingAnnotations);

  const { responseText } = await executeCall({
    scenario: ModelScenario.raw,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: p.screenshotBase64 } },
        { type: 'text', text: prompt },
      ],
    }],
    provider,
    apiKey,
  });

  return parseVisionJson(responseText);
}

export async function handleUIVisionAnnotate(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): Promise<unknown> {
  const p = unwrapParams<UIVisionAnnotateParams>(rawParams);
  const elementDesc = p.elements.slice(0, 30).map((n) =>
    `[${n['role']}] "${n['name'] || '(unnamed)'}"${n['bounds'] ? ` @(${(n['bounds'] as Record<string, unknown>)['left']},${(n['bounds'] as Record<string, unknown>)['top']})` : ''}`
  ).join('\n');

  const prompt = `Task goal: "${p.goal}"\n\nAvailable UI elements in the target window:\n${elementDesc}\n\nTotal: ${p.elements.length} elements.\n\nFor each element relevant to the task, provide a Chinese semantic annotation in JSON format:\n[{"label": "中文语义名", "description": "位置描述", "role": "原始role", "name": "原始name", "relativeX": 0.5, "relativeY": 0.3, "keywords": ["中文关键词", "英文关键词"]}]\n\nInclude ALL interactive elements.`;

  const { responseText } = await executeCall({
    scenario: ModelScenario.raw,
    messages: [{ role: 'user', content: prompt }],
    provider,
    apiKey,
  });

  return parseVisionJson(responseText);
}

export async function handleUIVisionOcrClassify(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): Promise<unknown> {
  const p = unwrapParams<UIVisionOcrClassifyParams>(rawParams);
  const ocrDesc = p.ocrItems.map((item, i) =>
    `[${i}] "${item.text}" @ (${item.bbox.left}, ${item.bbox.top})`
  ).join('\n');

  const prompt = `Task goal: "${p.goal}"\n\nOCR text results:\n${ocrDesc}\n\nIdentify interactive elements from these OCR results. Return JSON array of objects with: label (semantic name), keywords (array), relativeX (0-1), relativeY (0-1).`;

  const { responseText } = await executeCall({
    scenario: ModelScenario.raw,
    messages: [{ role: 'user', content: prompt }],
    provider,
    apiKey,
  });

  return parseVisionJson(responseText);
}

// ═══════════════════════════════════════════════════════════════
// ScreenAnalysis Handlers
// ═══════════════════════════════════════════════════════════════

export async function handleScreenAnalysisDiff(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): Promise<unknown> {
  const p = unwrapParams<ScreenAnalysisDiffParams>(rawParams);

  const { responseText } = await executeCall({
    scenario: ModelScenario.watcherResponse,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: p.beforeScreenshot } },
        { type: 'image_url', image_url: { url: p.afterScreenshot } },
        { type: 'text', text: `Goal: "${p.goal}"\n\nCompare the two screenshots above (BEFORE → AFTER). Is there a meaningful change?\nAnswer in JSON: {"changed": true/false, "description": "what changed", "confidence": 0.0-1.0}` },
      ],
    }],
    provider,
    apiKey,
    goal: p.goal,
  });

  try {
    const match = responseText.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return { changed: !!parsed.changed, description: parsed.description ?? '', confidence: parsed.confidence ?? 0.5 };
    }
  } catch { /* parse failed */ }
  return { changed: false, description: 'Could not parse analysis', confidence: 0 };
}

export async function handleScreenAnalysisRegions(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): Promise<unknown> {
  const p = unwrapParams<ScreenAnalysisRegionsParams>(rawParams);

  const { responseText } = await executeCall({
    scenario: ModelScenario.watcherResponse,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: p.screenshot } },
        { type: 'text', text: `Goal: "${p.goal}"\n\nIdentify regions in this screenshot that should be monitored for changes.\nReturn JSON: {"regions": [{"description": "...", "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.1, "label": "消息列表"}]}\nCoordinates are 0-1 relative to image size.` },
      ],
    }],
    provider,
    apiKey,
    goal: p.goal,
  });

  try {
    const match = responseText.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
  } catch { /* parse failed */ }
  return { regions: [] };
}

export async function handleScreenAnalysisOcr(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): Promise<unknown> {
  const p = unwrapParams<ScreenAnalysisOcrParams>(rawParams);

  const { responseText } = await executeCall({
    scenario: ModelScenario.watcherResponse,
    messages: [{
      role: 'user',
      content: `Goal: "${p.goal}"\n\nOCR detected texts:\n${p.ocrTexts.join('\n')}\n\nAnalyze what changed and describe it in one sentence.`,
    }],
    provider,
    apiKey,
    goal: p.goal,
  });

  return { analysis: responseText.trim() };
}

export async function handleScreenAnalysisInterruption(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): Promise<unknown> {
  const p = unwrapParams<ScreenAnalysisInterruptionParams>(rawParams);
  const stepsText = p.completedSteps.join('\n');

  const { responseText } = await executeCall({
    scenario: ModelScenario.watcherResponse,
    messages: [{
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: p.screenshot } },
        { type: 'text', text: `Goal: "${p.goal}"\n\nCompleted steps:\n${stepsText}\n\nLook at the screenshot. Is the task complete? If yes, say DONE. If not, say CONTINUE and describe the next step.` },
      ],
    }],
    provider,
    apiKey,
    goal: p.goal,
  });

  return { decision: responseText.trim() };
}

// ═══════════════════════════════════════════════════════════════
// DesktopAutomationHandler（流式）
// ═══════════════════════════════════════════════════════════════

export function handleDesktopAutomation(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): AsyncGenerator<string> {
  const p = unwrapParams<DesktopAutomationParams>(rawParams);
  return executeStream({
    scenario: ModelScenario.desktopAutomation,
    messages: p.messages,
    provider,
    apiKey,
    tools: p.tools,
    goal: p.goal,
    skipCache: p.skipCache,
  });
}

// ═══════════════════════════════════════════════════════════════
// DesktopAutomationToolsHandler（流式，思考过程实时返回）
// ═══════════════════════════════════════════════════════════════

function parseSimpleToolCalls(toolJson: string | undefined, responseText: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  if (toolJson) {
    try {
      const list = JSON.parse(toolJson) as Array<Record<string, unknown>>;
      return list.map((tc) => {
        const func = tc['function'] as Record<string, unknown> | undefined;
        if (func) {
          return { name: func['name'] as string, arguments: JSON.parse(func['arguments'] as string) as Record<string, unknown> };
        }
        return { name: tc['name'] as string, arguments: (tc['arguments'] as Record<string, unknown>) ?? {} };
      });
    } catch { /* fall through */ }
  }
  // 尝试从文本中提取
  try {
    const match = responseText.match(/```json\s*\n?([\s\S]*?)\n?\s*```|\[[\s\S]*\]/);
    if (match) {
      const json = JSON.parse(match[1] || match[0]);
      const arr = Array.isArray(json) ? json : [json];
      return arr.map((item: Record<string, unknown>) => ({
        name: (item['name'] as string) || 'unknown',
        arguments: (item['arguments'] as Record<string, unknown>) ?? item,
      }));
    }
  } catch { /* fall through */ }
  return [];
}

export interface DesktopAutomationToolsParams {
  messages: import('@/types/message').LLMMessage[];
  tools: Record<string, unknown>[];
  goal: string;
  skipCache?: boolean;
}

export async function* handleDesktopAutomationTools(
  provider: ProviderConfig,
  apiKey: string,
  rawParams: unknown,
): AsyncGenerator<string> {
  const p = unwrapParams<DesktopAutomationToolsParams>(rawParams);
  const stream = executeStream({
    scenario: ModelScenario.desktopAutomation,
    messages: p.messages,
    provider,
    apiKey,
    tools: p.tools,
    goal: p.goal,
    skipCache: p.skipCache,
  });

  let responseText = '';
  let toolJson: string | undefined;

  for await (const chunk of stream) {
    if (chunk.startsWith('__REASONING__:') || chunk.startsWith('__ERROR__:')) {
      yield chunk;
    } else if (chunk.startsWith('__TOOLS__:')) {
      toolJson = chunk.substring(10);
    } else {
      responseText += chunk;
      yield chunk;
    }
  }

  // 流结束：将工具调用作为最终结果发送
  const toolCalls = parseSimpleToolCalls(toolJson, responseText);
  yield `__TOOLS__:${JSON.stringify({ toolCalls, responseText })}`;
}
