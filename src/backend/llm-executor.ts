// LlmExecutor —— 后端统一的 LLM 调用方法。
// 所有 Agent Handler 共用此实例，内部维护单例 LlmGateway 连接池。
// 每个 Agent 端点调用此方法中转请求到大模型，拿到结果后返回给前端。

import { LlmGateway, ModelScenario } from '@/services/llm-gateway/gateway';
import type { ProviderConfig } from '@/types/provider';
import type { LLMMessage, ToolCallResponse } from '@/types/message';

let _gateway: LlmGateway | null = null;

function getGateway(): LlmGateway {
  if (!_gateway) {
    _gateway = new LlmGateway();
  }
  return _gateway;
}

// ── 非流式调用 ──

export interface ExecutorParams {
  scenario: ModelScenario;
  messages: LLMMessage[];
  provider: ProviderConfig;
  apiKey: string;
  tools?: Record<string, unknown>[];
  goal?: string;
  requiredTool?: boolean;
  skipCache?: boolean;
}

export async function executeCall(params: ExecutorParams): Promise<{
  responseText: string;
  toolCalls: ToolCallResponse['toolCalls'];
  assistantMessage: LLMMessage;
}> {
  const gateway = getGateway();
  const result = await gateway.callWithTools({
    scenario: params.scenario,
    messages: params.messages,
    provider: params.provider,
    apiKey: params.apiKey,
    tools: params.tools ?? [],
    goal: params.goal,
    requiredTool: params.requiredTool,
    skipCache: params.skipCache,
  });
  return {
    responseText: typeof result.assistantMessage.content === 'string' ? result.assistantMessage.content : '',
    toolCalls: result.toolCalls,
    assistantMessage: result.assistantMessage,
  };
}

// ── 流式调用 ──

export interface StreamExecutorParams {
  scenario: ModelScenario;
  messages: LLMMessage[];
  provider: ProviderConfig;
  apiKey: string;
  tools?: Record<string, unknown>[];
  goal?: string;
  skipCache?: boolean;
}

export function executeStream(params: StreamExecutorParams): AsyncGenerator<string> {
  const gateway = getGateway();
  return gateway.chatStream({
    scenario: params.scenario,
    messages: params.messages,
    provider: params.provider,
    apiKey: params.apiKey,
    tools: params.tools,
    goal: params.goal,
    skipCache: params.skipCache,
  });
}
