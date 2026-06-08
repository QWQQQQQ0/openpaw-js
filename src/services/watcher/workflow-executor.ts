// 工作流回放执行器：回放 WorkflowStep[] 模板
//
// action 步骤 → 直接回放（复用 replayCachedActions，含验证+恢复）
// llm_generate 步骤 → 填充 prompt 模板 → 调 LLM → 结果注入变量映射

import type { WorkflowStep, WorkflowActionStep, WorkflowLLMStep } from '@/types/watcher';
import type { SemanticAction } from '@/types/cache';
import type { AgentDeps } from '@/services/agent/agent-types';
import type { TaskExecutionResult } from '@/types/scheduler';
import type { ProviderConfig } from '@/types/provider';
import type { IModelService } from '@/interfaces/model-service';
import { replayCachedActions } from '@/services/agent/cache-replayer';
import { AgentEndpoint } from '@/api/types';
import { apiStreamCompat } from '@/api/client';

export interface WorkflowExecuteDeps {
  skillExecutor: AgentDeps['skillExecutor'];
  modelService: IModelService;
  cacheService: AgentDeps['cacheService'];
  provider: ProviderConfig;
  apiKey: string;
  /** Watcher 的目标窗口 hwnd（运行时值） */
  windowHwnd?: number;
  /** 初始变量映射，包含 {diff}、{ocr}、{context}、{snapshot} 等 */
  variables: Record<string, string>;
  signal?: AbortSignal;
}

/**
 * 回放工作流模板
 *
 * 遍历步骤，维护变量映射：
 * - action 步骤：将连续的 action 步骤分组，通过 replayCachedActions 回放
 * - llm_generate 步骤：填充 prompt 模板 → 调 LLM → 结果写入变量映射
 *
 * 任意步骤失败 → 返回失败，调用方应降级到完整 agent 流程
 */
export async function executeWorkflow(
  steps: WorkflowStep[],
  deps: WorkflowExecuteDeps,
): Promise<TaskExecutionResult> {
  const start = Date.now();

  const variables = { ...deps.variables };
  let currentHwnd = deps.windowHwnd ?? 0;
  const deps_: AgentDeps = {
    skillExecutor: deps.skillExecutor,
    cacheService: deps.cacheService,
  };

  // 将步骤按类型分组：连续的 action 步骤合并为一组
  const groups = groupSteps(steps);

  for (const group of groups) {
    if (deps.signal?.aborted) {
      return { success: false, duration: Date.now() - start, detail: 'Aborted' };
    }

    if (group.type === 'actions') {
      // 替换占位符
      const resolved = group.steps.map((s) => resolveActionPlaceholders(s, variables));


      const result = await replayCachedActions(deps_, resolved, currentHwnd);
      if (!result || !result.completed) {
        return { success: false, duration: Date.now() - start, detail: 'Action replay failed, falling back to agent' };
      }

      // 更新窗口句柄（回放过程中可能切换了窗口）
      if (result.finalHwnd && result.finalHwnd !== currentHwnd) {
        currentHwnd = result.finalHwnd;
      }
    } else {
      // llm_generate 步骤
      const step = group.step;
      const prompt = fillTemplate(step.promptTemplate, variables);


      try {
        const generated = await callLLM(deps.modelService, deps.provider, deps.apiKey, prompt);
        variables[step.outputParam] = generated;
      } catch (e) {
        return { success: false, duration: Date.now() - start, detail: `LLM generate failed: ${e}` };
      }
    }
  }

  return { success: true, duration: Date.now() - start, detail: 'Workflow template replayed' };
}

// ── 内部工具函数 ──

type StepGroup =
  | { type: 'actions'; steps: SemanticAction[] }
  | { type: 'llm_generate'; step: WorkflowLLMStep };

/** 将步骤按类型分组：连续的 action 合并，llm_generate 各自独立 */
function groupSteps(steps: WorkflowStep[]): StepGroup[] {
  const groups: StepGroup[] = [];
  let actionBuffer: SemanticAction[] = [];

  for (const step of steps) {
    if (step.type === 'action') {
      actionBuffer.push(step.action);
    } else {
      if (actionBuffer.length > 0) {
        groups.push({ type: 'actions', steps: actionBuffer });
        actionBuffer = [];
      }
      groups.push({ type: 'llm_generate', step });
    }
  }

  if (actionBuffer.length > 0) {
    groups.push({ type: 'actions', steps: actionBuffer });
  }

  return groups;
}

/** 替换 SemanticAction 中的占位符 */
function resolveActionPlaceholders(action: SemanticAction, variables: Record<string, string>): SemanticAction {
  const resolved = { ...action };

  if (resolved.target?.name) {
    resolved.target = { ...resolved.target, name: fillTemplate(resolved.target.name, variables) };
  }

  if (resolved.params) {
    const newParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(resolved.params)) {
      newParams[key] = typeof value === 'string' ? fillTemplate(value, variables) : value;
    }
    resolved.params = newParams;
  }

  return resolved;
}

/** 填充模板中的 {key} 占位符 */
function fillTemplate(template: string, variables: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return result;
}

/** 调用 LLM 生成文本（非流式，取完整响应） */
async function callLLM(
  modelService: IModelService,
  provider: ProviderConfig,
  apiKey: string,
  prompt: string,
): Promise<string> {
  const stream = apiStreamCompat(
    AgentEndpoint.chat,
    provider,
    apiKey,
    { messages: [{ role: 'user', content: prompt }] },
  );

  const parts: string[] = [];
  for await (const chunk of stream) {
    if (!chunk.startsWith('__')) {
      parts.push(chunk);
    }
  }

  const text = parts.join('').trim();
  if (!text) throw new Error('LLM returned empty response');
  return text;
}
