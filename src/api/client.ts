// Agent API Client —— 前端调用后端 Agent 端点的统一入口。
// 替代直接 import LlmGateway，所有 Agent API 通过此 client 发 HTTP 请求到 Vite 中间件后端。
// 支持普通 JSON 响应和 SSE 流式响应。

import type { AgentRequestBody, AgentResponseBody, SSEEvent } from './types';
import { AgentEndpoint } from './types';
import type { ProviderConfig } from '@/types/provider';
import { computeLLMRequestHash, splitCachedResponse } from '@/services/llm-gateway/gateway';
import { getLLMCallCache, storeLLMCallCache } from '@/services/cache-service';
import type { LLMMessage } from '@/types/message';
import systemPrompts from '@/config/system-prompts.json';

// ── 系统提示词（前端注入，用户可编辑） ──

const ENDPOINT_PROMPT_KEY: Record<string, keyof typeof systemPrompts> = {
  [AgentEndpoint.chat]: 'chat',
  [AgentEndpoint.desktopAutomation]: 'desktopAutomation',
  [AgentEndpoint.desktopAutomationTools]: 'desktopAutomation',
  [AgentEndpoint.codeGeneration]: 'codeGeneration',
  [AgentEndpoint.codeIteration]: 'codeIteration',
};

function injectSystemPrompt(endpoint: string, messages: LLMMessage[], goal?: string): LLMMessage[] {
  const key = ENDPOINT_PROMPT_KEY[endpoint];
  if (!key) return messages;
  let prompt = systemPrompts[key] as string;
  if (goal) prompt = prompt.replaceAll('{goal}', goal);
  return [{ role: 'system', content: prompt }, ...messages];
}

// ── 配置 ──

let _baseUrl = '';

/** 设置后端 API 的 base URL（在 app-init 中调用）。默认空字符串 = 同源。 */
export function setApiBaseUrl(url: string): void {
  _baseUrl = url;
}

export function getApiBaseUrl(): string {
  return _baseUrl;
}

// ── 普通 JSON 请求 ──

export async function apiPost<T = unknown>(
  endpoint: AgentEndpoint,
  provider: ProviderConfig,
  apiKey: string,
  params: Record<string, unknown>,
): Promise<T> {
  // 前端注入系统提示词
  const rawMessages = (params['messages'] as LLMMessage[]) ?? [];
  const goal = params['goal'] as string | undefined;
  if (rawMessages.length > 0) {
    params = { ...params, messages: injectSystemPrompt(endpoint, rawMessages, goal) };
  }

  const url = `${_baseUrl}${endpoint}`;
  const body: AgentRequestBody = { provider, apiKey, params };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown error');
    throw new Error(`Agent API error ${response.status}: ${text}`);
  }

  const json = (await response.json()) as AgentResponseBody<T>;
  if (!json.ok) {
    throw new Error(json.error ?? 'Unknown error');
  }

  return json.data as T;
}

// ── SSE 流式请求 → 兼容旧的 AsyncGenerator<string> 格式 ──

/**
 * 流式请求，返回旧格式的字符串块（向后兼容）。
 * - text → 直接 yield
 * - tools → yield "__TOOLS__:{json}"
 * - error → yield "__ERROR__:{msg}"
 * - reasoning → yield "__REASONING__:{text}"
 */
export async function* apiStreamCompat(
  endpoint: AgentEndpoint,
  provider: ProviderConfig,
  apiKey: string,
  params: Record<string, unknown>,
): AsyncGenerator<string> {
  // 前端注入系统提示词
  const rawMessages = (params['messages'] as LLMMessage[]) ?? [];
  const goal = params['goal'] as string | undefined;
  if (rawMessages.length > 0) {
    params = { ...params, messages: injectSystemPrompt(endpoint, rawMessages, goal) };
  }
  const messages = (params['messages'] as LLMMessage[]) ?? [];

  const skipCache = params['skipCache'] === true;

  // 前端缓存命中检查（查 openpaw.db，与其他缓存同一数据库）
  if (!skipCache) {
    try {
      const tools = (params['tools'] as Record<string, unknown>[]) ?? [];
      const { hash } = computeLLMRequestHash(messages, tools.length > 0 ? tools : undefined, provider.model, provider.type);
      const cached = await getLLMCallCache(hash);
      if (cached) {
        console.log(`[apiStreamCompat] ✓ cache HIT — hash=${hash.substring(0, 12)}`);
        for (const part of splitCachedResponse(cached.response_text)) yield part;
        return;
      }
    } catch { /* 非致命 */ }
  }

  const chunks: string[] = [];
  for await (const event of apiStream(endpoint, provider, apiKey, params)) {
    let chunk: string;
    switch (event.type) {
      case 'text':
        chunk = event.content;
        break;
      case 'tools':
        chunk = `__TOOLS__:${JSON.stringify(event.content)}`;
        break;
      case 'error':
        chunk = `__ERROR__:${event.content}`;
        break;
      case 'reasoning':
        chunk = `__REASONING__:${(event as import('./types').SSEReasoningEvent).content}`;
        break;
      case 'done':
        // 流结束：将完整响应写入前端数据库
        try {
          const fullResponse = chunks.join('');
          if (fullResponse.length > 0 && !fullResponse.startsWith('__ERROR__:')) {
            const tools = (params['tools'] as Record<string, unknown>[]) ?? [];
            const { hash: storeHash, requestText } = computeLLMRequestHash(messages, tools.length > 0 ? tools : undefined, provider.model, provider.type);
            await storeLLMCallCache(storeHash, fullResponse, provider.model, provider.type, messages.length, tools.length, requestText);
          }
        } catch { /* 非致命 */ }
        return;
    }
    chunks.push(chunk);
    yield chunk;
  }
}

// ── SSE 流式请求（原始事件） ──

export async function* apiStream(
  endpoint: AgentEndpoint,
  provider: ProviderConfig,
  apiKey: string,
  params: Record<string, unknown>,
): AsyncGenerator<SSEEvent> {
  const url = `${_baseUrl}${endpoint}`;
  const body: AgentRequestBody = { provider, apiKey, params };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => 'unknown error');
    throw new Error(`Agent API error ${response.status}: ${text}`);
  }

  if (!response.body) {
    throw new Error('Agent API response has no body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });

    // SSE format: "data: {...}\n\n"
    const lines = buffer.split('\n\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data: ')) continue;
      const data = trimmed.substring(6).trim();
      if (data === '[DONE]') return;

      try {
        const event = JSON.parse(data) as SSEEvent;
        yield event;
      } catch {
        // Skip malformed events
      }
    }

    if (done) {
      if (buffer.trim().length > 0) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data: ') && trimmed.substring(6).trim() !== '[DONE]') {
          try {
            yield JSON.parse(trimmed.substring(6).trim()) as SSEEvent;
          } catch { /* skip */ }
        }
      }
      break;
    }
  }
}
