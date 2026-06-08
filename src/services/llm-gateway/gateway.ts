// LLM Gateway — 统一的 LLM 调用入口。
// 所有 Agent API 都通过此类调用大模型，不直接接触 Adapter 层。
// 负责：适配器管理、系统提示构建、长度检查、调用缓存、图片保存。

import { OpenAIAdapter } from '@/adapters/openai';
import { AnthropicAdapter } from '@/adapters/anthropic';
import { GoogleAdapter } from '@/adapters/google';
import type { LLMAdapter } from '@/adapters/types';
import type { LLMMessage, ToolCallResponse } from '@/types/message';
import type { ProviderConfig } from '@/types/provider';
import systemPrompts from '@/config/system-prompts.json';
// LLM 缓存存储和命中检查已全部移至前端 client.ts
import type { IModelService } from '@/interfaces/model-service';
import { saveImagesBeforeLLMCall } from '@/utils/save-images';

// ── Scenario（从 model-call-service 迁移，保持兼容） ──

export enum ModelScenario {
  chat = 'chat',
  desktopAutomation = 'desktopAutomation',
  webAutomation = 'webAutomation',
  phoneAutomation = 'phoneAutomation',
  watcher = 'watcher',
  watcherResponse = 'watcherResponse',
  recorderAnalysis = 'recorderAnalysis',
  raw = 'raw',
  codeGeneration = 'codeGeneration',
  codeIteration = 'codeIteration',
  adminAgent = 'adminAgent',
  complexityJudge = 'complexityJudge',
}

export interface LengthCheckResult {
  ok: boolean;
  estimatedTokens: number;
  maxTokens: number;
  warning?: string;
}

const MAX_TOKENS_PER_SCENARIO: Record<ModelScenario, number> = {
  [ModelScenario.desktopAutomation]: 16000,
  [ModelScenario.webAutomation]: 16000,
  [ModelScenario.phoneAutomation]: 16000,
  [ModelScenario.chat]: 96000,
  [ModelScenario.watcher]: 8000,
  [ModelScenario.watcherResponse]: 8000,
  [ModelScenario.recorderAnalysis]: 8000,
  [ModelScenario.raw]: 96000,
  [ModelScenario.codeGeneration]: 32000,
  [ModelScenario.codeIteration]: 32000,
  [ModelScenario.adminAgent]: 16000,
  [ModelScenario.complexityJudge]: 8000,
};

// ── 缓存响应拆分 ──

export function splitCachedResponse(text: string): string[] {
  const markers = ['__REASONING__:', '__TOOLS__:', '__ERROR__:'];
  const parts: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    let earliest = -1;
    let markerLen = 0;
    for (const marker of markers) {
      const idx = remaining.indexOf(marker);
      if (idx >= 0 && (earliest < 0 || idx < earliest)) {
        earliest = idx;
        markerLen = marker.length;
      }
    }
    if (earliest < 0) {
      if (remaining.length > 0) parts.push(remaining);
      break;
    }
    if (earliest > 0) parts.push(remaining.substring(0, earliest));
    const afterMarker = remaining.substring(earliest);
    let nextMarker = -1;
    for (const marker of markers) {
      const idx = afterMarker.indexOf(marker, markerLen);
      if (idx >= 0 && (nextMarker < 0 || idx < nextMarker)) nextMarker = idx;
    }
    if (nextMarker < 0) { parts.push(afterMarker); break; }
    parts.push(afterMarker.substring(0, nextMarker));
    remaining = afterMarker.substring(nextMarker);
  }
  return parts.filter(p => p.length > 0);
}

// ── LLM 请求哈希 ──

export function computeLLMRequestHash(
  messages: LLMMessage[],
  tools: Record<string, unknown>[] | undefined,
  model: string,
  providerType: string,
): { hash: string; requestText: string } {
  const input = JSON.stringify({ messages, tools, model, providerType });
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return { hash: `llm_${Math.abs(hash).toString(36)}`, requestText: input };
}

// ── 日志工具 ──

let _prevRequestSig = '';

function summarizeContent(content: LLMMessage['content']): string {
  if (content == null) return 'null';
  if (typeof content === 'string') {
    const preview = content.length > 120 ? content.substring(0, 120) + '...' : content;
    return `str(${content.length}) "${preview.replace(/\n/g, '\\n')}"`;
  }
  const parts = (content as Array<{ type: string; text?: string; image_url?: { url: string } }>).map(p => {
    if (p.type === 'text') return `text(${p.text?.length ?? 0})`;
    const url = p.image_url?.url ?? '';
    const len = url.startsWith('data:') ? url.length - url.indexOf(',') - 1 : url.length;
    return `image(base64:${len})`;
  });
  return `[${parts.join(', ')}]`;
}

function msgSignature(m: LLMMessage): string {
  const parts: string[] = [m.role];
  if (m.toolCallId) parts.push(`tcid:${m.toolCallId}`);
  if (m.toolCallName) parts.push(`tcname:${m.toolCallName}`);
  if (m.toolCalls) parts.push(`tc:${m.toolCalls.length}`);
  if (m.content != null) parts.push(summarizeContent(m.content));
  return parts.join('|');
}

function logRequest(
  provider: string,
  model: string,
  scenario: string,
  messages: LLMMessage[],
  tools: Record<string, unknown>[] | undefined,
) {
  const sig = messages.map(msgSignature).join('\n');
  const isSame = sig === _prevRequestSig;
  const header = `[LLM→] ${provider}/${model} scenario=${scenario} msgs=${messages.length} tools=${tools?.length ?? 0}`;
  if (isSame) { console.log(`${header} (unchanged)`); return; }
  const prevLines = _prevRequestSig.split('\n');
  const newLines = sig.split('\n');
  const minLen = Math.min(prevLines.length, newLines.length);
  let diffStart = 0;
  for (let i = 0; i < minLen; i++) {
    if (prevLines[i] !== newLines[i]) { diffStart = i; break; }
    diffStart = i + 1;
  }
  console.log(`${header} — ${diffStart} unchanged, +${messages.length - diffStart} new`);
  for (let i = diffStart; i < messages.length; i++) {
    const m = messages[i];
    console.log(`  [${i}] ${m.role}: ${summarizeContent(m.content)}`);
    if (m.toolCalls && m.toolCalls.length > 0) {
      for (const tc of m.toolCalls) {
        const fn = tc.function;
        const args = fn.arguments.length > 100 ? fn.arguments.substring(0, 100) + '...' : fn.arguments;
        console.log(`    → ${fn.name}(${args})`);
      }
    }
  }
  _prevRequestSig = sig;
}

// ── LlmGateway ──

export class LlmGateway implements IModelService {
  private _adapters: Record<string, LLMAdapter>;

  constructor() {
    this._adapters = {
      openai: new OpenAIAdapter(),
      anthropic: new AnthropicAdapter(),
      google: new GoogleAdapter(),
    };
  }

  // ── 系统提示构建 ──

  buildSystemPrompt(scenario: ModelScenario, goal = '', extra?: string, requiredTool = false): string {
    let base: string;
    switch (scenario) {
      case ModelScenario.chat:
        base = extra ? `${systemPrompts.chat}\n\n${extra}` : systemPrompts.chat;
        break;
      case ModelScenario.desktopAutomation:
        base = systemPrompts.desktopAutomation.replaceAll('{goal}', goal);
        break;
      case ModelScenario.webAutomation:
        base = systemPrompts.webAutomation.replaceAll('{goal}', goal);
        break;
      case ModelScenario.phoneAutomation:
        base = systemPrompts.phoneAutomation.replaceAll('{goal}', goal);
        break;
      case ModelScenario.watcherResponse:
        base = systemPrompts.watcherResponse.replaceAll('{goal}', goal);
        break;
      case ModelScenario.watcher:
      case ModelScenario.raw:
        base = extra ?? '';
        break;
      case ModelScenario.recorderAnalysis:
        base = systemPrompts.recorderAnalysis ?? '';
        break;
      case ModelScenario.codeGeneration:
        base = systemPrompts.codeGeneration;
        break;
      case ModelScenario.codeIteration:
        base = systemPrompts.codeIteration;
        break;
      case ModelScenario.adminAgent:
        base = systemPrompts.adminAgent.replace('{tools_list}', extra ?? '');
        break;
      case ModelScenario.complexityJudge:
        base = systemPrompts.complexityJudge.replace('{user_request}', goal).replace('{existing_tools}', extra ?? '');
        break;
    }
    if (requiredTool) {
      return `${base}\n\nYou MUST respond ONLY with function calls — do not output any text.`;
    }
    return base;
  }

  withSystemPrompt(messages: LLMMessage[], systemPrompt: string): LLMMessage[] {
    if (systemPrompt.length === 0) return messages;
    return [{ role: 'system', content: systemPrompt }, ...messages];
  }

  // ── Tokens 估算 ──

  estimateTokens(messages: LLMMessage[]): number {
    let chars = 0;
    for (const m of messages) {
      const c = m.content;
      if (typeof c === 'string') {
        chars += c.length > 8000 ? 8000 : c.length;
      } else if (Array.isArray(c)) {
        chars += JSON.stringify(c).length > 8000 ? 8000 : JSON.stringify(c).length;
      }
      if (m.toolCalls) chars += JSON.stringify(m.toolCalls).length;
    }
    return Math.floor(chars / 2);
  }

  checkLength(scenario: ModelScenario, messages: LLMMessage[]): LengthCheckResult {
    const maxTokens = MAX_TOKENS_PER_SCENARIO[scenario] ?? 32000;
    const estimated = this.estimateTokens(messages);
    if (estimated > maxTokens) {
      return { ok: false, estimatedTokens: estimated, maxTokens, warning: `内容过长：预估 ${estimated} tokens，上限 ${maxTokens} tokens。` };
    }
    return { ok: true, estimatedTokens: estimated, maxTokens };
  }

  // ── 核心：流式 LLM 调用 ──

  async *chatStream(params: {
    scenario: ModelScenario;
    messages: LLMMessage[];
    provider: ProviderConfig;
    apiKey: string;
    tools?: Record<string, unknown>[];
    goal?: string;
    skipCache?: boolean;
  }): AsyncGenerator<string> {
    const { scenario, messages, provider, apiKey, tools, goal = '', skipCache = false } = params;

    const supportsTools = provider.supportsTools !== false;
    const adapterTools = supportsTools ? tools : undefined;

    // 系统提示词已由前端注入，后端只处理不支持 tools 的模型的工具格式化
    let fullMessages = messages;
    if (!supportsTools && tools && tools.length > 0) {
      fullMessages = [...messages, { role: 'system' as const, content: formatToolsForPrompt(tools) }];
    }

    // 调用 LLM 之前扫描消息中的截图并保存到本地
    saveImagesBeforeLLMCall(fullMessages);

    console.log('[LlmGateway] ▶', JSON.parse(JSON.stringify({
      scenario, provider: provider.type + '/' + provider.model,
      messageCount: fullMessages.length, tools: adapterTools?.length, goal,
    })));

    const check = this.checkLength(scenario, fullMessages);
    if (!check.ok) {
      yield `__ERROR__:${check.warning}`;
      return;
    }

    const adapter = this._adapters[provider.type];
    if (!adapter) { yield `__ERROR__:Unknown provider type: ${provider.type}`; return; }

    const stream = adapter.chat({
      messages: fullMessages,
      model: provider.model,
      apiKey,
      baseUrl: provider.baseUrl,
      tools: adapterTools,
      thinkingMode: provider.thinkingMode,
    });

    let fullResponse = '';
    for await (const chunk of stream) {
      fullResponse += chunk;
      yield chunk;
    }

    console.log('[LlmGateway] ◀', { responseLen: fullResponse.length });
    // LLM 缓存存储已移至前端 client.ts，后端只负责 cache hit 检查
  }

  // ── 核心：工具调用 ──

  async callWithTools(params: {
    scenario: ModelScenario;
    messages: LLMMessage[];
    provider: ProviderConfig;
    apiKey: string;
    tools: Record<string, unknown>[];
    goal?: string;
    requiredTool?: boolean;
    skipCache?: boolean;
  }): Promise<ToolCallResponse> {
    const { scenario, messages, provider, apiKey, tools, goal = '', requiredTool = false, skipCache = false } = params;
    const stream = this.chatStream({ scenario, messages, provider, apiKey, tools, goal, skipCache });

    let toolJson: string | undefined;
    let responseText = '';
    let reasoningContent = '';
    for await (const chunk of stream) {
      if (chunk.startsWith('__TOOLS__:')) {
        const m = chunk.match(/__TOOLS__:(\[[\s\S]*\])/);
        toolJson = m ? m[1] : chunk.substring(10);
      } else if (chunk.startsWith('__ERROR__:')) {
        throw new Error(chunk.substring(10));
      } else if (chunk.startsWith('__REASONING__:')) {
        reasoningContent += chunk.substring(14);
      } else {
        responseText += chunk;
      }
    }

    if (toolJson == null) {
      if (requiredTool) throw new Error('No tool calls in response');
      return { toolCalls: [], assistantMessage: { role: 'assistant', content: responseText || null, reasoning_content: reasoningContent || undefined } };
    }

    const list = JSON.parse(toolJson) as Array<Record<string, unknown>>;
    const toolCallObjs = list.map((tc) => ({
      id: tc['id'] as string,
      type: 'function' as const,
      function: {
        name: (tc['function'] as Record<string, unknown>)['name'] as string,
        arguments: (tc['function'] as Record<string, unknown>)['arguments'] as string,
      },
    }));
    const results = toolCallObjs.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments),
    }));

    const assistantMessage: LLMMessage = { role: 'assistant', content: responseText || null, toolCalls: toolCallObjs, reasoning_content: reasoningContent || undefined };
    return { toolCalls: results, assistantMessage };
  }

  dispose(): void { /* no explicit cleanup needed */ }
}

// ── Tools 格式化（不支持原生 tools 的模型） ──

function formatToolsForPrompt(tools: Record<string, unknown>[]): string {
  const toolDescs = tools.map((t) => {
    const func = t['function'] as Record<string, unknown>;
    return { name: func['name'], description: func['description'], parameters: func['parameters'] };
  });
  return (
    '\n\n## Available Tools\n\n' +
    'You have access to the following tools. To use a tool, you MUST respond with ONLY a tool call in this format:\n\n' +
    '<tool_call>\n{"name": "<tool_name>", "arguments": {<params>}}\n</tool_call>\n\n' +
    JSON.stringify(toolDescs, null, 2)
  );
}
