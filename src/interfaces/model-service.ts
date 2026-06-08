import type { LLMMessage, ToolCallResponse } from '@/types/message';
import type { ProviderConfig } from '@/types/provider';
import type { ModelScenario } from '@/services/llm-gateway/gateway';

export interface IModelService {
  chatStream(params: {
    scenario: ModelScenario;
    messages: LLMMessage[];
    provider: ProviderConfig;
    apiKey: string;
    tools?: Record<string, unknown>[];
    goal?: string;
    skipCache?: boolean;
  }): AsyncGenerator<string>;

  callWithTools(params: {
    scenario: ModelScenario;
    messages: LLMMessage[];
    provider: ProviderConfig;
    apiKey: string;
    tools: Record<string, unknown>[];
    goal?: string;
    requiredTool?: boolean;
    skipCache?: boolean;
  }): Promise<ToolCallResponse>;
}
