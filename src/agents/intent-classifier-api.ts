// IntentClassifierAgent — 意图分类 Agent API
// 前端调用：agent.classify("打开QQ音乐播放'那时雨'")
// 请求通过 Vite 中间件后端 → 统一 LlmExecutor → 外部 LLM
// 使用流式接口，思考过程实时推送到 UI

import type { ProviderConfig } from '@/types/provider';
import type { ParsedGoal } from '@/types/goal';
import { AgentEndpoint } from '@/api/types';
import { apiStreamCompat } from '@/api/client';
import { appEventBus } from '@/services/event-bus';

export class IntentClassifierAgent {
  /**
   * 分类用户意图，返回结构化任务列表。
   * 思考过程通过 appEventBus 实时推送到 UI。
   */
  async classify(userInput: string, provider: ProviderConfig, apiKey: string): Promise<ParsedGoal> {
    appEventBus.emit({
      source: 'app', type: 'intent_classify_start', level: 'debug',
      message: `Classifying intent: ${userInput.substring(0, 80)}`, timestamp: Date.now(),
    });

    let reasoningText = '';
    let resultJson = '';

    const stream = apiStreamCompat(
      AgentEndpoint.intentClassifier,
      provider,
      apiKey,
      { userInput, skipCache: true },
    );

    for await (const chunk of stream) {
      if (chunk.startsWith('__REASONING__:')) {
        reasoningText += chunk.substring(14);
        // 实时推送思考过程
        appEventBus.emit({
          source: 'agent', type: 'reasoning', level: 'info',
          message: `🧠 分析意图中...`,
          timestamp: Date.now(),
          data: { reasoning: chunk.substring(14), accumulated: reasoningText },
        });
      } else if (chunk.startsWith('__TOOLS__:')) {
        resultJson = chunk.substring(10);
      }
      // 普通 text chunk 忽略（LLM 输出 JSON 前可能有文本）
    }

    let parsed: ParsedGoal;
    try {
      parsed = JSON.parse(resultJson) as ParsedGoal;
    } catch {
      // 兜底：把整个用户输入当作一次性任务
      parsed = {
        tasks: [{ name: userInput.substring(0, 30), type: 'once', goal: userInput, action: { type: 'agent_execute', goalTemplate: userInput } }],
        response: '好的，我来处理。',
      };
    }

    appEventBus.emit({
      source: 'app', type: 'intent_classified', level: 'info',
      message: `Classified ${parsed.tasks.length} task(s): ${parsed.tasks.map(t => `${t.name}[${t.type}]`).join(', ')}`,
      timestamp: Date.now(),
      data: { taskCount: parsed.tasks.length, types: parsed.tasks.map(t => t.type), reasoning: reasoningText || undefined },
    });

    return parsed;
  }
}
