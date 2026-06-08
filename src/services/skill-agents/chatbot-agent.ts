// 聊天机器人 Skill-Agent
//
// 纯文本输入 → LLM 生成回复 → 返回回复文本
// 不涉及任何 UI 操作，调用方负责后续的输入和发送。

import type { SkillAgent, SkillAgentInput, SkillAgentResult } from './types';
import type { IModelService } from '@/interfaces/model-service';
import type { ICacheService } from '@/interfaces/cache-service';
import { ModelScenario } from '@/services/llm-gateway/gateway';
import systemPrompts from '@/config/system-prompts.json';

export class ChatbotAgent implements SkillAgent {
  readonly name = 'chatbot_reply';
  readonly description = '根据消息内容生成合适的聊天回复';

  constructor(
    private modelService: IModelService,
    private cacheService: ICacheService,
  ) {}

  async execute(input: SkillAgentInput): Promise<SkillAgentResult> {
    const { diff, context } = input.variables;

    if (!diff) {
      return { success: false, detail: '缺少消息内容 (diff)' };
    }

    const userMessage = context
      ? `消息内容：${diff}\n\n上下文：${context}`
      : `消息内容：${diff}`;

    try {
      const stream = this.modelService.chatStream({
        scenario: ModelScenario.raw,
        messages: [
          { role: 'system', content: systemPrompts.chatbotReply },
          { role: 'user', content: userMessage },
        ],
        provider: input.provider,
        apiKey: input.apiKey,
        tools: undefined,
      });

      const parts: string[] = [];
      for await (const chunk of stream) {
        if (!chunk.startsWith('__')) {
          parts.push(chunk);
        }
      }

      const reply = parts.join('').trim();
      if (!reply) {
        return { success: false, detail: 'LLM 返回空回复' };
      }

      return {
        success: true,
        output: { reply },
        detail: reply,
      };
    } catch (e) {
      return { success: false, detail: `LLM 调用失败: ${e}` };
    }
  }
}
