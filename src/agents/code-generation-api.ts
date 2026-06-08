// CodeGenerationAgent — 代码生成 Agent API
// 前端调用：agent.generate({ prompt, provider, apiKey }) → 流式
// 请求通过 Vite 中间件后端 → 统一 LlmExecutor → 外部 LLM

import type { ProviderConfig } from '@/types/provider';
import { AgentEndpoint } from '@/api/types';
import { apiStreamCompat } from '@/api/client';

export class CodeGenerationAgent {
  /** 生成代码 */
  async *generate(params: {
    prompt: string;
    provider: ProviderConfig;
    apiKey: string;
    context?: string;
  }): AsyncGenerator<string> {
    for await (const chunk of apiStreamCompat(
      AgentEndpoint.codeGeneration,
      params.provider,
      params.apiKey,
      { prompt: params.prompt, context: params.context },
    )) {
      yield chunk;
    }
  }

  /** 迭代修复代码 */
  async *iterate(params: {
    code: string;
    error: string;
    provider: ProviderConfig;
    apiKey: string;
  }): AsyncGenerator<string> {
    for await (const chunk of apiStreamCompat(
      AgentEndpoint.codeIteration,
      params.provider,
      params.apiKey,
      { code: params.code, error: params.error },
    )) {
      yield chunk;
    }
  }
}
