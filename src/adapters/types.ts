// 来源: lib/adapters/llm_adapter.dart (LLMAdapter 抽象类)

import type { LLMMessage } from '@/types/message';

export type { LLMMessage };

export interface LLMAdapter {
  readonly adapterId: string;
  readonly displayName: string;
  readonly defaultBaseUrl: string;

  chat(params: {
    messages: LLMMessage[];
    model: string;
    apiKey: string;
    baseUrl?: string;
    tools?: Record<string, unknown>[];
    /** MiMo 等思考模型：开启 thinking 模式 */
    thinkingMode?: boolean;
  }): AsyncGenerator<string>;
}
