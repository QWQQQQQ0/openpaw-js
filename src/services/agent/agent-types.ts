// Agent 共享类型与上下文

import type { SkillResult } from '@/types/skill';
import type { LLMMessage } from '@/types/message';
import type { ISkillExecutor } from '@/interfaces/skill-executor';
import type { ICacheService } from '@/interfaces/cache-service';

/** Agent 依赖注入接口 */
export interface AgentDeps {
  skillExecutor: ISkillExecutor;
  cacheService: ICacheService;
}

/** 工具调用信息结构体 */
export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 智能体回合结构体 */
export interface AgentTurn {
  toolCalls: ToolCallInfo[];
  results: SkillResult[];
}

/** 智能体步骤事件 */
export interface AgentStepEvent {
  type: 'before_llm' | 'after_llm' | 'before_tool' | 'after_tool';
  data: Record<string, unknown>;
  turnIndex: number;
}

/** 步骤回调函数类型 */
export type AgentStepCallback = (event: AgentStepEvent) => Promise<Record<string, unknown> | null>;

/** 阶段执行历史记录 */
export interface PhaseHistoryEntry {
  phase: 'l3' | 'l2a' | 'plan' | 'perturn';
  summary: string;
  success: boolean;
  timestamp: number;
}

/** 智能体上下文 — 贯穿全流水线，保留每次 LLM 调用和执行结果 */
export class AgentContext {
  messages: LLMMessage[] = [];
  allResults: SkillResult[] = [];
  turns: AgentTurn[] = [];

  /** 各阶段的执行历史，失败阶段的结果可供后续阶段参考 */
  phaseHistory: PhaseHistoryEntry[] = [];

  /** 最近一次截图的 base64 data URL */
  lastScreenshot?: string;

  /** 任务是否已被验证为完成 */
  taskCompleted = false;

  /** 追加阶段执行记录 */
  addPhaseHistory(phase: PhaseHistoryEntry['phase'], summary: string, success: boolean): void {
    this.phaseHistory.push({ phase, summary, success, timestamp: Date.now() });
  }

  /**
   * 生成可注入 LLM 消息的阶段上下文文本。
   * 仅当有失败阶段时才返回内容，帮助后续阶段了解之前尝试了什么。
   */
  injectPhaseContext(): string | null {
    const failures = this.phaseHistory.filter(p => !p.success);
    if (failures.length === 0) return null;

    const lines = failures.map(p =>
      `- [${p.phase}] ${p.summary}`
    );
    return `Previous attempts that did not complete the task:\n${lines.join('\n')}\n\nLearn from these: do NOT repeat the same failed approach. Try a different strategy.`;
  }
}
