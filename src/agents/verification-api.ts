// VerificationAgent — 任务完成验证 Agent API
// 前端调用：agent.verify("打开画图工具画苹果", screenshotBase64)
// 请求通过 Vite 中间件后端 → 统一 LlmExecutor → 外部 LLM

import type { ProviderConfig } from '@/types/provider';
import type { LLMMessage } from '@/types/message';
import { AgentEndpoint } from '@/api/types';
import { apiPost } from '@/api/client';

export interface VerifyResult {
  completed: boolean;
  feedback: string;
  screenshot: string;
}

export class VerificationAgent {
  /**
   * 验证任务是否完成 —— 截图 + LLM 看图判断。
   */
  async verify(
    goal: string,
    screenshotBase64: string,
    provider: ProviderConfig,
    apiKey: string,
    contextMessages?: LLMMessage[],
  ): Promise<VerifyResult> {
    const result = await apiPost<VerifyResult>(
      AgentEndpoint.verification,
      provider,
      apiKey,
      { goal, screenshotBase64, contextMessages },
    );

    console.log(`[VerificationAgent] ${result.completed ? '✓' : '✗'} ${result.feedback.substring(0, 120)}`);
    return result;
  }
}
