// 子目标缓存执行器：分解目标 → 查缓存 → 回放/执行 → 存储

import type { AgentDeps, AgentTurn, AgentStepCallback, AgentContext } from './agent-types';
import type { LLMMessage, ContentPart } from '@/types/message';
import type { ProviderConfig } from '@/types/provider';
import type { GoalDecomposition, SubGoalCacheEntry, SemanticAction, UIFingerprint } from '@/types/cache';
import type { StateMachine } from '../state-machine';
import { decomposeGoal } from './goal-decomposer';
import { replayCachedActions } from './cache-replayer';
import { planAndExecute } from './plan-executor';
import { instantiateTemplate } from '@/core/skill-learner';
import { matchGoalToAnnotation } from '@/services/semantic-annotation-service';

/**
 * 用子目标缓存执行目标
 *
 * 流程：
 * 1. LLM 分解目标为子目标序列（1次轻量调用）
 * 2. 逐个子目标查缓存
 *    - 命中：实例化模板 + 回放
 *    - 未命中：planAndExecute 执行 → 存入缓存
 * 3. 合并所有 turns 返回
 */
export async function executeWithSubGoalCache(
  deps: AgentDeps,
  goal: string,
  windowHwnd: number,
  provider: ProviderConfig,
  apiKey: string,
  stateMachine: StateMachine,
  onStep?: AgentStepCallback,
  signal?: AbortSignal,
  toolFilter?: Set<string>,
  currentState?: string,
  context?: string,
  agentContext?: AgentContext,
): Promise<AgentTurn[] | null> {
  // 1. 查分解缓存 → miss 才调 LLM
  const normalizedGoal = deps.cacheService.normalizeGoal(goal);
  let decomposition: GoalDecomposition | null = await deps.cacheService.getGoalDecomposition(normalizedGoal);
  if (!decomposition) {
    console.log(`[Agent:SubGoal] decomposition cache MISS — calling LLM`);
    decomposition = await decomposeGoal(deps, goal, provider, apiKey, currentState, context);
    if (decomposition && decomposition.subgoals.length > 0) {
      await deps.cacheService.storeGoalDecomposition(normalizedGoal, decomposition);
    }
  }
  if (!decomposition || decomposition.subgoals.length === 0) {
    return null;
  }

  const allTurns: AgentTurn[] = [];
  let currentHwnd = windowHwnd;
  const appName = goal.match(/打开(\S+)/)?.[1];
  // 已完成的子目标摘要，用于传递给后续子目标作为上下文
  const completedSubgoals: string[] = [];

  // 2. 逐个子目标执行
  for (let i = 0; i < decomposition.subgoals.length; i++) {
    if (signal?.aborted) {
      break;
    }

    const subgoal = decomposition.subgoals[i];
    const subgoalKey = deps.cacheService.normalizeGoal(subgoal.key);

    // 2a. 查缓存
    const cached = await deps.cacheService.getSubGoalCache(subgoalKey, appName);

    if (cached) {
      // 实例化模板：替换 {param} 占位符
      const steps = instantiateTemplate(cached.template, subgoal.params);
      if (steps.length === 0) {
        await deps.cacheService.deleteSubGoalCacheByKey(subgoalKey, appName);
        // 走 MISS 路径
        const missResult = await executeSubGoalMiss(deps, subgoal.key, subgoal.description, subgoal.params, currentHwnd, provider, apiKey, stateMachine, onStep, signal, toolFilter, currentState, completedSubgoals, buildSubgoalContext({ agentContext, overallGoal: goal, completedSubgoals, currentHwnd }));
        if (!missResult) {
          // 子目标失败，返回 null 让上层继续处理（如 per-turn LLM loop）
          console.log(`[Agent:SubGoal]   subgoal ${i} failed — returning null to continue with LLM`);
          return null;
        }
        allTurns.push(...missResult.turns);
        if (missResult.finalHwnd) currentHwnd = missResult.finalHwnd;
        completedSubgoals.push(subgoal.description);
        if (agentContext && i < decomposition.subgoals.length - 1) {
          await injectSubgoalContext(agentContext, subgoal.description, currentHwnd);
        }
        continue;
      }

      // 回放
      stateMachine.setCacheSource('l2');
      stateMachine.setStage('executing');

      const replayResult = await replayCachedActions(deps, steps, currentHwnd, stateMachine, appName);

      if (replayResult) {
        allTurns.push(...replayResult.turns);
        currentHwnd = replayResult.finalHwnd;
        completedSubgoals.push(subgoal.description);

        if (!replayResult.completed) {
          // 部分完成：剩余子目标走 LLM
          console.log(`[Agent:SubGoal]   partial replay — remaining subgoals will use LLM`);
          const remainingSubgoals = decomposition.subgoals.slice(i + 1);
          for (const sg of remainingSubgoals) {
            const missResult = await executeSubGoalMiss(deps, sg.key, sg.description, sg.params, currentHwnd, provider, apiKey, stateMachine, onStep, signal, toolFilter, currentState, completedSubgoals, buildSubgoalContext({ agentContext, overallGoal: goal, completedSubgoals, currentHwnd }));
            if (missResult) {
              allTurns.push(...missResult.turns);
              if (missResult.finalHwnd) currentHwnd = missResult.finalHwnd;
              completedSubgoals.push(sg.description);
              if (agentContext) {
                await injectSubgoalContext(agentContext, sg.description, currentHwnd);
              }
            } else {
              // 子目标失败，返回 null 让上层继续处理
              console.log(`[Agent:SubGoal]   subgoal failed during partial replay — returning null`);
              return null;
            }
          }
          break;
        }
      } else {
        // 回放失败：缓存失效，走 MISS 路径
        await deps.cacheService.deleteSubGoalCacheByKey(subgoalKey, appName);

        const missResult = await executeSubGoalMiss(deps, subgoal.key, subgoal.description, subgoal.params, currentHwnd, provider, apiKey, stateMachine, onStep, signal, toolFilter, currentState, completedSubgoals, buildSubgoalContext({ agentContext, overallGoal: goal, completedSubgoals, currentHwnd }));
        if (!missResult) {
          console.log(`[Agent:SubGoal]   subgoal ${i} failed after replay failure — returning null`);
          return null;
        }
        allTurns.push(...missResult.turns);
        if (missResult.finalHwnd) currentHwnd = missResult.finalHwnd;
        completedSubgoals.push(subgoal.description);
      }
    } else {
      // 2b. 缓存未命中：调 LLM 执行
      console.log(`[Agent:SubGoal]   L2a MISS — executing via LLM`);

      const missResult = await executeSubGoalMiss(deps, subgoal.key, subgoal.description, subgoal.params, currentHwnd, provider, apiKey, stateMachine, onStep, signal, toolFilter, currentState, completedSubgoals, buildSubgoalContext({ agentContext, overallGoal: goal, completedSubgoals, currentHwnd }));
      if (!missResult) {
        // 子目标失败，返回 null 让上层继续处理
        console.log(`[Agent:SubGoal]   subgoal ${i} failed — returning null to continue with LLM`);
        return null;
      }
      allTurns.push(...missResult.turns);
      if (missResult.finalHwnd) currentHwnd = missResult.finalHwnd;
      completedSubgoals.push(subgoal.description);
    }

    // 子目标完成后：如果还有后续子目标，截图注入 agentContext 提供视觉上下文
    if (agentContext && i < decomposition.subgoals.length - 1) {
      await injectSubgoalContext(agentContext, subgoal.description, currentHwnd);
    }
  }

  return allTurns.length > 0 ? allTurns : null;
}

/**
 * 构建子目标执行上下文 — 告诉子目标 LLM：整体任务是什么、已完成什么、当前屏幕状态、
 * 之前什么失败了。精简但完整，避免传执行历史导致请求体爆炸。
 */
function buildSubgoalContext(opts: {
  agentContext?: AgentContext;
  overallGoal: string;
  completedSubgoals: string[];
  currentHwnd: number;
}): LLMMessage[] | undefined {
  const { agentContext, overallGoal, completedSubgoals, currentHwnd } = opts;

  // 构建文本上下文
  let textCtx = `Overall task: "${overallGoal}"`;
  if (completedSubgoals.length > 0) {
    textCtx += `\nAlready completed (${completedSubgoals.length} step(s)):`;
    for (const s of completedSubgoals) {
      textCtx += `\n  ✓ ${s}`;
    }
    textCtx += `\nContinue from current state — do NOT repeat completed steps.`;
  }
  if (currentHwnd && currentHwnd !== 0) {
    textCtx += `\nTarget window hwnd: ${currentHwnd}`;
  }
  const phaseCtx = agentContext?.injectPhaseContext();
  if (phaseCtx) {
    textCtx += `\n\n${phaseCtx}`;
  }

  // 合并为单条 user 消息：文本 + 可选截图（避免多个 system 角色割裂上下文）
  const content: LLMMessage['content'] = [{ type: 'text', text: textCtx }] as LLMMessage['content'];
  if (agentContext?.lastScreenshot) {
    (content as ContentPart[]).unshift({ type: 'image_url', image_url: { url: agentContext.lastScreenshot } });
  }
  return [{ role: 'user', content }];
}

/** 子目标完成后截图，注入 agentContext.messages 作为下一个子目标的视觉上下文 */
async function injectSubgoalContext(agentContext: AgentContext, subgoalDesc: string, windowHwnd?: number): Promise<void> {
  try {
    const { desktopService } = await import('@/services/desktop-service');
    // 优先截取目标窗口（图片更小、噪音更少）
    const screenshot = windowHwnd && windowHwnd !== 0
      ? await desktopService.screenshotWindow(windowHwnd)
      : await desktopService.screenshot();
    agentContext.lastScreenshot = screenshot;
    agentContext.messages.push({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: screenshot } },
        { type: 'text', text: `Sub-goal "${subgoalDesc}" completed. Current screen state for next step.` },
      ],
    });
  } catch { /* 非致命 */ }
}

/**
 * 缓存未命中时执行单个子目标
 * 调用 planAndExecute 执行 → 将结果存入 subgoal_cache
 */
async function executeSubGoalMiss(
  deps: AgentDeps,
  subgoalKey: string,
  description: string,
  params: Record<string, string>,
  windowHwnd: number,
  provider: ProviderConfig,
  apiKey: string,
  stateMachine: StateMachine,
  onStep?: AgentStepCallback,
  signal?: AbortSignal,
  toolFilter?: Set<string>,
  currentState?: string,
  completedSubgoals?: string[],
  existingMessages?: LLMMessage[],
): Promise<{ turns: AgentTurn[]; finalHwnd: number } | null> {
  // 确保状态机有当前窗口的 fingerprint（用于页面能力查询）
  if (!stateMachine.getState().windowFP && windowHwnd > 0) {
    try {
      const fpResult = await deps.skillExecutor.executeToolCall('uia_fingerprint', { window_hwnd: windowHwnd });
      if (fpResult.success && fpResult.data) {
        const fp = fpResult.data as unknown as UIFingerprint;
        if (fp.window_fp) {
          const { fingerprint } = deps.cacheService.resolveFingerprint(fp.window_fp, fp.pages);
          stateMachine.setWindow(fingerprint, {
            hwnd: windowHwnd, title: '', class_name: '', is_visible: true, process_id: 0,
            left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0,
          });
        }
      }
    } catch { /* non-critical */ }
  }

  // 构造子目标的执行目标：描述 + 参数上下文 + 已完成子目标摘要
  const paramContext = Object.keys(params).length > 0
    ? `\nParameters: ${JSON.stringify(params)}`
    : '';
  const completedContext = completedSubgoals && completedSubgoals.length > 0
    ? `\nAlready completed: ${completedSubgoals.join(', ')}\nContinue from current state — do NOT repeat completed steps.`
    : '';
  const subgoalGoal = `${description}${paramContext}${completedContext}`;

  stateMachine.setCacheSource('llm');
  stateMachine.setStage('executing');

  const result = await planAndExecute(deps, {
    goal: subgoalGoal,
    l1CachedNodes: null,
    provider,
    apiKey,
    stateMachine,
    onStep,
    signal,
    toolFilter,
    currentState,
    existingMessages,
  });

  if (!result || result.length === 0) {
    return null;
  }

  // 从执行结果中提取步骤，构建模板存入缓存
  const executedSteps = extractStepsFromTurns(result);
  if (executedSteps.length > 0) {
    // 将具体参数值替换为 {param} 占位符，构建可复用模板
    const template = buildTemplate(executedSteps, params);
    const enrichedTemplate = await enrichWithSemanticRefs(deps, template, windowHwnd);
    const appName = subgoalKey.match(/打开(\S+)/)?.[1];

    await deps.cacheService.storeSubGoalCache({
      subgoalKey: deps.cacheService.normalizeGoal(subgoalKey),
      appName,
      params: Object.keys(params),
      template: enrichedTemplate,
      sourceGoal: subgoalKey,
    });
  }

  // 获取最终窗口句柄 — hwnd 在工具执行的 result.data 中，不在 arguments 中
  let finalHwnd = windowHwnd;
  for (const turn of result) {
    for (let i = 0; i < turn.toolCalls.length; i++) {
      const tc = turn.toolCalls[i];
      const tr = turn.results[i];
      if (tc.name === 'desktop_open_app') {
        const hwnd = tr?.data?.['hwnd'] as number;
        if (typeof hwnd === 'number' && hwnd > 0) finalHwnd = hwnd;
      } else if (tc.name === 'desktop_focus_window') {
        const hwnd = tc.arguments['hwnd'] as number;
        if (typeof hwnd === 'number' && hwnd > 0) finalHwnd = hwnd;
      }
    }
  }

  return { turns: result, finalHwnd };
}

/** 从 AgentTurn 中提取语义动作（过滤诊断工具） */
function extractStepsFromTurns(turns: AgentTurn[]): SemanticAction[] {
  const steps: SemanticAction[] = [];
  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      if (tc.name === 'desktop_done' || tc.name === 'desktop_screenshot'
          || tc.name === 'uia_get_interactive' || tc.name === 'uia_fingerprint'
          || tc.name === 'uia_find_element' || tc.name === 'uia_get_property'
          || tc.name === 'desktop_list_windows' || tc.name === 'desktop_list_apps'
          || tc.name === 'desktop_wait') {
        continue;
      }
      const action: SemanticAction = { action: toolNameToAction(tc.name) };
      if (tc.arguments['role']) {
        action.target = { role: tc.arguments['role'] as string, name: tc.arguments['name'] as string | undefined };
      }
      if (tc.arguments['text']) {
        action.params = { text: tc.arguments['text'] };
      } else if (Object.keys(tc.arguments).length > 0) {
        const { window_hwnd, ...rest } = tc.arguments;
        if (Object.keys(rest).length > 0) action.params = rest;
      }
      steps.push(action);
    }
  }
  return steps;
}

/** 工具名 → 语义动作映射 */
function toolNameToAction(name: string): string {
  switch (name) {
    case 'uia_click': return 'click';
    case 'uia_type': return 'type';
    case 'desktop_open_app': return 'open_app';
    case 'desktop_focus_window': return 'focus_window';
    case 'desktop_press_key': return 'press_key';
    default: return name;
  }
}

/**
 * 将执行过的具体步骤构建为带 {param} 占位符的模板
 * 例如: type("那时雨") + params={song_name:"那时雨"} → type("{song_name}")
 */
function buildTemplate(steps: SemanticAction[], params: Record<string, string>): SemanticAction[] {
  if (Object.keys(params).length === 0) return steps;

  const serialized = JSON.stringify(steps);
  let result = serialized;
  for (const [key, value] of Object.entries(params)) {
    if (value && typeof value === 'string' && value.length > 0) {
      // 全局替换参数值为占位符
      result = result.split(JSON.stringify(value).slice(1, -1)).join(`{${key}}`);
    }
  }
  try {
    return JSON.parse(result) as SemanticAction[];
  } catch {
    return steps;
  }
}

/**
 * Cross-reference template steps against L1 annotations to populate semanticRef.
 * Falls back gracefully if annotations are unavailable.
 */
async function enrichWithSemanticRefs(
  deps: AgentDeps,
  template: SemanticAction[],
  windowHwnd: number,
): Promise<SemanticAction[]> {
  try {
    const fpResult = await deps.skillExecutor.executeToolCall('uia_fingerprint', { window_hwnd: windowHwnd });
    if (!fpResult.success || !fpResult.data) return template;
    const fp = fpResult.data as unknown as UIFingerprint;
    const { fingerprint } = deps.cacheService.resolveFingerprint(fp.window_fp, fp.pages);
    const cached = await deps.cacheService.getUICache(fingerprint);
    if (!cached || cached.annotations.length === 0) return template;

    return template.map(step => {
      if (!step.target || step.target.semanticRef) return step;
      const matched = matchGoalToAnnotation(
        step.target.name || step.target.role,
        cached.annotations,
      );
      if (matched) {
        return {
          ...step,
          target: {
            ...step.target,
            semanticRef: {
              label: matched.label,
              keywords: matched.keywords,
              description: matched.description,
            },
          },
        };
      }
      return step;
    });
  } catch {
    return template;
  }
}
