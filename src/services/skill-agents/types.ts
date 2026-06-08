// Skill-Agent 类型定义
//
// SkillAgent 是一个职责单一的 LLM 驱动 agent，有自己的系统提示和工具子集。
// 与 Skill 不同，SkillAgent 内部有 LLM 循环，而 Skill 是被动的工具执行器。

import type { ProviderConfig } from '@/types/provider';

/** Skill-Agent 输入 */
export interface SkillAgentInput {
  /** 变量映射：diff, context, sender, content, reply 等 */
  variables: Record<string, string>;
  /** 当前截图 base64 */
  screenshot?: string;
  /** 目标窗口 hwnd */
  windowHwnd?: number;
  /** LLM 提供商配置 */
  provider: ProviderConfig;
  /** API Key */
  apiKey: string;
  /** 取消信号 */
  signal?: AbortSignal;
}

/** Skill-Agent 执行结果 */
export interface SkillAgentResult {
  success: boolean;
  /** 产出的变量，供下游 step 使用（如 reply 文本） */
  output?: Record<string, string>;
  /** 执行后的截图 */
  screenshot?: string;
  /** 人类可读的结果描述 */
  detail?: string;
}

/** Skill-Agent 接口 */
export interface SkillAgent {
  /** 唯一标识 */
  readonly name: string;
  /** 人类可读描述 */
  readonly description: string;
  /** 执行 */
  execute(input: SkillAgentInput): Promise<SkillAgentResult>;
}
