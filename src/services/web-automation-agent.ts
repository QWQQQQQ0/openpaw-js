// 来源: lib/services/web_automation_agent.dart + desktop_automation_agent.dart

import { ModelScenario } from '@/services/llm-gateway/gateway';
import { getModelService } from '@/services/model-service-singleton';
import type { IModelService } from '@/interfaces/model-service';
import type { ISkillExecutor } from '@/interfaces/skill-executor';
import type { ICacheService } from '@/interfaces/cache-service';
import type { SkillResult } from '@/types/skill';
import type { ProviderConfig } from '@/types/provider';
import type { LLMMessage } from '@/types/message';
import type { SemanticAnnotation } from '@/types/cache';
import { compressImage, type CompressedImage } from '@/utils/image';
import { resolveMultimodalProvider } from '@/utils/multimodal-provider';
import { useModelConfigStore } from '@/stores/model-config-store';
import { computeWebFingerprint, hashDOMStructure } from '@/services/cache-service';
import { domNodesToAnnotations } from '@/services/semantic-annotation-service';

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentTurn {
  toolCalls: ToolCallInfo[];
  results: SkillResult[];
}

export type AgentStepCallback = (event: {
  type: 'before_llm' | 'after_llm' | 'before_tool' | 'after_tool';
  data: Record<string, unknown>;
  turnIndex: number;
}) => Promise<Record<string, unknown> | null>;

interface DOMNode {
  tag?: string;
  text?: string;
  selector?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  clickable?: boolean;
  inViewport?: boolean;
  inputType?: string;
  href?: string;
  children?: DOMNode[];
}

class AgentContext {
  messages: LLMMessage[] = [];
  allResults: SkillResult[] = [];
  turns: AgentTurn[] = [];
}

export class WebAutomationAgent {
  private modelService: IModelService;
  private skillExecutor: ISkillExecutor;
  private cacheService?: ICacheService;
  testMode = false;

  constructor(modelService: IModelService, skillExecutor: ISkillExecutor, cacheService?: ICacheService) {
    this.modelService = modelService;
    this.skillExecutor = skillExecutor;
    this.cacheService = cacheService;
  }

  async executeCommand(params: {
    screenshotBase64?: string;
    domNodes?: DOMNode[];
    goal: string;
    provider: ProviderConfig;
    apiKey: string;
    currentUrl?: string;
    actionHistory?: string[];
    toolFilter?: Set<string>;
    maxTurns?: number;
    onStep?: AgentStepCallback;
  }): Promise<AgentTurn[] | null> {
    const {
      screenshotBase64,
      domNodes = [],
      goal,
      currentUrl,
      actionHistory = [],
      toolFilter,
      maxTurns = 5,
      onStep,
    } = params;
    let { provider, apiKey } = params;

    // 多模态自动切换：Web 自动化需要截图分析，必须使用支持多模态的模型
    if (provider.supportsMultimodal === false) {
      const allProviders = useModelConfigStore.getState().providers;
      const { provider: resolved, switched } = resolveMultimodalProvider(provider, allProviders, [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,placeholder' } },
      ]);
      if (switched) {
        provider = resolved;
        try {
          apiKey = await useModelConfigStore.getState().getApiKey(provider.id, '');
        } catch { /* 使用传入的 apiKey */ }
      }
    }

    // L1 cache for web pages
    let webAnnotations: SemanticAnnotation[] = [];
    if (this.cacheService && domNodes.length > 0 && currentUrl) {
      try {
        const structHash = hashDOMStructure(domNodes);
        const webFP = computeWebFingerprint(currentUrl, domNodes.length, structHash);
        const cached = await this.cacheService.getUICache(webFP);
        if (cached && cached.annotations.length > 0) {
          webAnnotations = cached.annotations;
        } else {
          webAnnotations = domNodesToAnnotations(domNodes, 1920, 1080);
          if (webAnnotations.length > 0) {
            // 用网站域名作为 app_name，URL 路径作为 window_class
            const appName = extractHostname(currentUrl);
            const urlPath = extractPath(currentUrl);
            await this.cacheService.storeUICache(webFP, webFP, null, appName, urlPath, [], webAnnotations);
          }
        }
      } catch { /* non-fatal cache error */ }
    }

    const allTools = this.skillExecutor.buildToolsForLLM();
    const resolvedTools = toolFilter
      ? allTools.filter((t) => {
          const fn = t['function'] as { name: string };
          return toolFilter.has(fn.name);
        })
      : allTools;

    if (resolvedTools.length === 0) return null;

    const ctx = new AgentContext();
    const tools = resolvedTools;

    let compressedInitial: CompressedImage | undefined;
    if (screenshotBase64) {
      try {
        compressedInitial = await compressImage(screenshotBase64);
      } catch { /* use original if compression fails */ }
    }
    ctx.messages.push(this.buildUserMessage({ screenshotBase64, domNodes, currentUrl, actionHistory, compressedScreenshot: compressedInitial, webAnnotations }));

    for (let turn = 0; turn < maxTurns; turn++) {
      let toolCalls: ToolCallInfo[];
      let responseText = '';
      let reasoningBuffer = '';

      if (this.testMode) {
        toolCalls = this.mockToolCalls(goal, turn);
      } else {
        const preEdit = await onStep?.({ type: 'before_llm', data: { model: provider.model, messages: ctx.messages, tools }, turnIndex: turn });
        const callTools = preEdit?.['tools'] ? preEdit['tools'] as Record<string, unknown>[] : tools;


        const stream = this.modelService.chatStream({
          scenario: ModelScenario.webAutomation,
          messages: ctx.messages,
          provider,
          apiKey,
          tools: callTools,
          goal,
        });

        const textBuffer: string[] = [];
        let toolJson: string | undefined;

        for await (const chunk of stream) {
          if (chunk.startsWith('__TOOLS__:')) {
            toolJson = chunk.substring(10);
          } else if (chunk.startsWith('__ERROR__:')) {
            throw new Error(chunk.substring(10));
          } else if (chunk.startsWith('__REASONING__:')) {
            reasoningBuffer += chunk.substring(14);
          } else {
            textBuffer.push(chunk);
          }
        }

        responseText = textBuffer.join('');

        if (!toolJson) {
          toolCalls = [];
        } else {
          const list = JSON.parse(toolJson) as Array<Record<string, unknown>>;
          toolCalls = list.map((tc) => {
            const func = tc['function'] as Record<string, unknown>;
            return {
              id: tc['id'] as string,
              name: func['name'] as string,
              arguments: JSON.parse(func['arguments'] as string) as Record<string, unknown>,
            };
          });
        }

        const postEdit = await onStep?.({ type: 'after_llm', data: { tool_calls: toolCalls }, turnIndex: turn });
        if (postEdit?.['tool_calls']) {
          const edited = postEdit['tool_calls'] as Array<Record<string, unknown>>;
          toolCalls = edited.map((tc) => ({
            id: tc['id'] as string ?? '',
            name: tc['name'] as string,
            arguments: tc['arguments'] as Record<string, unknown>,
          }));
        }
      }

      if (toolCalls.length === 0) break;

      const turnCallInfos = toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }));
      const turnResults: SkillResult[] = [];

      ctx.messages.push({
        role: 'assistant',
        content: responseText || null,
        reasoning_content: reasoningBuffer || undefined,
        toolCalls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });

      for (const tc of toolCalls) {
        const toolEdit = await onStep?.({ type: 'before_tool', data: { name: tc.name, arguments: tc.arguments }, turnIndex: turn });
        const resolvedArgs = (toolEdit?.['toolArguments'] as Record<string, unknown>) ?? tc.arguments;

        const result = await this.skillExecutor.executeToolCall(tc.name, resolvedArgs);
        turnResults.push(result);
        ctx.allResults.push(result);

        let content = result.data ? JSON.stringify(result.data) : result.message;
        if (content.length > 8000) {
          content = `${content.substring(0, 1000)}... (truncated, original size: ${content.length} chars)`;
        }

        if (tc.name === 'web_screenshot' && result.data) {
          const imageData = result.data['screenshot'] as string | undefined;
          if (imageData) {
            try {
              const compressed = await compressImage(imageData);
              ctx.messages.push({
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: compressed.dataUrl } },
                  { type: 'text', text: `Latest screenshot. Continue with the task.` },
                ],
              });
            } catch {
              ctx.messages.push({
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: imageData } },
                  { type: 'text', text: 'Here is the latest screenshot. Continue with the task.' },
                ],
              });
            }
          }
        } else {
          ctx.messages.push({ role: 'tool', content, toolCallId: tc.id });
        }

        await onStep?.({ type: 'after_tool', data: { name: tc.name, arguments: resolvedArgs, success: result.success, message: result.message, ...(result.data ? { data: result.data } : {}) }, turnIndex: turn });
      }

      ctx.turns.push({ toolCalls: turnCallInfos, results: turnResults });

      const lastResult = turnResults[turnResults.length - 1];
      if (lastResult.data?.['action'] === 'done') break;
    }

    return ctx.turns.length > 0 ? ctx.turns : null;
  }

  buildUserMessage(opts: {
    screenshotBase64?: string;
    domNodes?: DOMNode[];
    currentUrl?: string;
    actionHistory: string[];
    compressedScreenshot?: CompressedImage;
    webAnnotations?: SemanticAnnotation[];
  }): LLMMessage {
    const { screenshotBase64, domNodes = [], currentUrl, actionHistory, compressedScreenshot, webAnnotations } = opts;

    const domSummary = this.buildDOMSummary(domNodes);

    const annotationSummary = webAnnotations && webAnnotations.length > 0
      ? `\nSemantic element annotations:\n${webAnnotations.slice(0, 30).map(a =>
          `- "${a.label}" [${a.role}] (${a.description}) keywords: [${a.keywords.join(', ')}]`
        ).join('\n')}\n`
      : '';

    const textContent = [
      `Current URL: ${currentUrl ?? 'unknown'}`,
      '',
      `Interactive DOM elements (${domNodes.length} total):`,
      domSummary,
      annotationSummary,
      `Recent actions:`,
      actionHistory.length > 0 ? actionHistory.join('\n') : '(none)',
      '',
      'What should I do next?',
    ].join('\n');

    if (screenshotBase64) {
      const imageUrl = compressedScreenshot?.dataUrl
        ?? (screenshotBase64.startsWith('data:') ? screenshotBase64 : `data:image/jpeg;base64,${screenshotBase64}`);
      return {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: textContent },
        ],
      };
    }

    const textParts = [textContent];
    if (domNodes.length === 0) {
      textParts.push('(No DOM captured yet. Call web_get_ui or web_screenshot first.)');
    }
    return { role: 'user', content: textParts.join('\n\n') };
  }

  private buildDOMSummary(nodes: DOMNode[]): string {
    if (nodes.length === 0) return '(no interactive elements detected)';

    const viewportNodes = nodes.filter((n) => n.inViewport);
    const lines: string[] = [];
    const max = 50;

    for (let i = 0; i < viewportNodes.length && i < max; i++) {
      const n = viewportNodes[i];
      const tag = n.tag ?? '?';
      const text = (n.text ?? '').replace(/\n/g, ' ').trim();
      const bounds = n.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
      const sel = n.selector ?? '';
      const inputType = n.inputType;

      let desc = `[${i}] <${tag}>`;
      if (inputType) desc += ` type=${inputType}`;
      if (text) desc += ` "${text.length > 60 ? text.substring(0, 60) + '...' : text}"`;
      desc += ` @(${bounds.x},${bounds.y}) ${bounds.width}x${bounds.height}`;
      if (sel && sel.length < 100) desc += ` sel=${sel}`;
      lines.push(desc);
    }

    if (nodes.length > max) {
      lines.push(`... and ${nodes.length - max} more elements`);
    }

    return lines.join('\n');
  }

  mockToolCalls(goal: string, turn: number): ToolCallInfo[] {
    if (turn === 0) {
      return [
        { id: 'call_mock_1', name: 'web_get_ui', arguments: {} },
        { id: 'call_mock_2', name: 'web_screenshot', arguments: {} },
      ];
    }
    if (turn === 1) {
      return [
        { id: 'call_mock_3', name: 'web_navigate', arguments: { url: `https://${goal.replace(/\s+/g, '').toLowerCase()}.com` } },
      ];
    }
    return [
      { id: 'call_mock_done', name: 'web_done', arguments: { summary: `Task "${goal}" completed (mock)` } },
    ];
  }
}

/** 从 URL 提取网站域名（如 "doubao.com"） */
function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return 'unknown-site';
  }
}

/** 从 URL 提取路径（如 "/chat"） */
function extractPath(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname + (parsed.search || '');
  } catch {
    return '/';
  }
}
