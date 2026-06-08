// 向后兼容层 —— 委托到 IntentClassifierAgent。
// 旧代码可继续 import { classifyIntent } from './intent-classifier'
// 新代码应直接使用 IntentClassifierAgent

import type { ProviderConfig } from '@/types/provider';
import type { ParsedGoal } from '@/types/goal';
import { IntentClassifierAgent } from '@/agents/intent-classifier-api';

export async function classifyIntent(
  userInput: string,
  _modelService: unknown,  // 保留参数兼容旧调用方，实际不再使用
  provider: ProviderConfig,
  apiKey: string,
): Promise<ParsedGoal> {
  const agent = new IntentClassifierAgent();
  return agent.classify(userInput, provider, apiKey);
}
