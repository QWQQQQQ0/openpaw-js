// 技能模板匹配 + 语义标注匹配

import type { AgentDeps, AgentTurn, AgentStepCallback } from './agent-types';
import type { SemanticAction, SemanticAnnotation, SkillTemplate } from '@/types/cache';
import type { ProviderConfig } from '@/types/provider';
import type { WindowInfo } from '../desktop-service';
import type { StateMachine } from '../state-machine';
import { matchGoal } from '@/core/skill-resolver';
import { instantiateTemplate } from '@/core/skill-learner';
import { AgentEndpoint } from '@/api/types';
import { apiStreamCompat } from '@/api/client';
import { replayCachedActions } from './cache-replayer';
import { matchGoalToAnnotation } from '../semantic-annotation-service';

/** L3 技能模板匹配 + 执行 */
export async function trySkillMatch(
  deps: AgentDeps,
  params: {
    goal: string;
    focusedHwnd: number;
    windows: WindowInfo[];
    provider: ProviderConfig;
    apiKey: string;
    stateMachine: StateMachine;
  },
): Promise<{ turns: AgentTurn[] } | null> {
  const { goal, focusedHwnd, provider, apiKey, stateMachine } = params;

  const match = await matchGoal(goal);
  if (!match) {
    return null;
  }

  const extractedParams = await llmExtractParams(deps, goal, match.skill, provider, apiKey);
  if (!extractedParams) {
    return null;
  }

  const steps = instantiateTemplate(match.skill.template, extractedParams);
  if (steps.length === 0) {
    return null;
  }

  stateMachine.setCacheSource('l3');
  stateMachine.setStage('executing');

  const appNameMatch = goal.match(/打开(\S+)/);
  const appName = appNameMatch ? appNameMatch[1] : undefined;

  const replayResult = await replayCachedActions(deps, steps, focusedHwnd, stateMachine, appName);
  if (replayResult) {
    return { turns: replayResult.turns };
  }

  return null;
}

/** 轻量 LLM 调用：从任务目标中提取技能参数 */
export async function llmExtractParams(
  deps: AgentDeps,
  goal: string,
  skill: SkillTemplate,
  provider: ProviderConfig,
  apiKey: string,
): Promise<Record<string, string> | null> {
  if (skill.params.length === 0) {
    return {};
  }

  const paramList = skill.params.join(', ');
  const prompt = `Extract parameter values from the goal.\n\nSkill: ${skill.name}(${paramList})\nParams: [${paramList}]\nGoal: "${goal}"\n\nOutput ONLY a JSON object, e.g. {"${skill.params[0]}": "value1", "${skill.params[1] || 'p2'}": "value2"}. Omit any params not in the goal.`;

  try {
    const stream = apiStreamCompat(
      AgentEndpoint.chat,
      provider,
      apiKey,
      { messages: [{ role: 'user', content: prompt }], goal },
    );

    let text = '';
    for await (const chunk of stream) {
      if (!chunk.startsWith('__')) {
        text += chunk;
      }
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as Record<string, string>;
    }
    return null;
  } catch {
    return null;
  }
}

/** 语义标注匹配：直接匹配目标与 UI 元素标注，无需 LLM */
export async function trySemanticMatch(
  deps: AgentDeps,
  params: {
    goal: string;
    focusedHwnd: number;
    annotations: SemanticAnnotation[];
    stateMachine: StateMachine;
    onStep?: AgentStepCallback;
    signal?: AbortSignal;
  },
): Promise<AgentTurn[] | null> {
  const { goal, focusedHwnd, annotations, stateMachine, onStep, signal } = params;

  if (annotations.length === 0) return null;

  const matched = matchGoalToAnnotation(goal, annotations);
  if (!matched) {
    return null;
  }


  const validate = await deps.skillExecutor.executeToolCall('uia_find_element', {
    role: matched.role,
    name: matched.name ?? null,
    window_hwnd: focusedHwnd,
  });

  if (!validate.success || !validate.data?.['found']) {
    return null;
  }

  const step: SemanticAction = {
    action: 'click',
    target: { role: matched.role, name: matched.name || undefined },
  };

  stateMachine.setCacheSource('l1');
  stateMachine.setStage('executing');

  await onStep?.({ type: 'before_tool', data: { name: 'uia_click', arguments: { role: matched.role, name: matched.name } }, turnIndex: 0 });

  const result = await deps.skillExecutor.executeToolCall('uia_click', {
    role: matched.role,
    name: matched.name || undefined,
    window_hwnd: focusedHwnd,
  });

  await onStep?.({ type: 'after_tool', data: { name: 'uia_click', success: result.success, message: result.message }, turnIndex: 0 });

  if (!result.success) {
    return null;
  }

  return [{
    toolCalls: [{ id: 'semantic_match_0', name: 'uia_click', arguments: { role: matched.role, name: matched.name } }],
    results: [result],
  }];
}
