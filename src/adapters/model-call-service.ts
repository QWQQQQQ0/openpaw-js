// 向后兼容层 —— 委托到 LlmGateway。
// 旧代码可继续 import { ModelCallService, ModelScenario } from './model-call-service'
// 新代码应使用 Agent API：IntentClassifierAgent、VerificationAgent 等

import { LlmGateway, ModelScenario } from '@/services/llm-gateway/gateway';
import type { LengthCheckResult } from '@/services/llm-gateway/gateway';

export { ModelScenario };
export type { LengthCheckResult };

/** @deprecated 请使用 LlmGateway 或各 Agent API */
export class ModelCallService extends LlmGateway {}
