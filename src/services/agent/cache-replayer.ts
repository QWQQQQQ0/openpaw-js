// 缓存回放引擎：带校验 + RecoveryChain + 步骤缓存

import type { AgentDeps, AgentTurn } from './agent-types';
import type { SemanticAction, SemanticAnnotation, UIFingerprint } from '@/types/cache';
import type { SkillResult } from '@/types/skill';
import type { StateMachine } from '../state-machine';
import { RecoveryChain } from '../recovery-chain';
import { matchGoalToAnnotation } from '@/services/semantic-annotation-service';

/** 语义动作 → 工具名称映射 */
export function semanticActionToToolName(action: SemanticAction): string {
  switch (action.action) {
    case 'click': return 'uia_click';
    case 'type': return 'uia_type';
    case 'wait': return 'desktop_wait';
    case 'open_app': return 'desktop_open_app';
    case 'focus_window': return 'desktop_focus_window';
    default: return action.action;
  }
}

/**
 * 回放缓存的语义动作序列（带实时校验 + 失败恢复 + 步骤缓存）
 * @returns 执行回合 + 最终窗口句柄 + 是否完成
 */
export async function replayCachedActions(
  deps: AgentDeps,
  steps: SemanticAction[],
  windowHwnd: number,
  stateMachine?: StateMachine,
  appName?: string,
): Promise<{ turns: AgentTurn[]; finalHwnd: number; completed: boolean } | null> {
  const turns: AgentTurn[] = [];
  const results: SkillResult[] = [];
  const recovery = new RecoveryChain(deps.skillExecutor);
  let currentWindowFP: string | undefined;
  let l1Annotations: SemanticAnnotation[] | null = null;

  if (windowHwnd) {
    try {
      const fpResult = await deps.skillExecutor.executeToolCall('uia_fingerprint', { window_hwnd: windowHwnd });
      if (fpResult.success && fpResult.data) {
        currentWindowFP = (fpResult.data as unknown as UIFingerprint).window_fp;
      }
    } catch { /* 非致命 */ }
  }

  // 预加载 L1 标注（UIA + 视觉）用于语义回退
  if (currentWindowFP) {
    try {
      const cached = await deps.cacheService.getUICache(
        deps.cacheService.resolveFingerprint(currentWindowFP, {}).fingerprint,
      );
      if (cached && cached.annotations.length > 0) {
        l1Annotations = cached.annotations;
      }
    } catch { /* 非致命 */ }
  }

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const toolName = semanticActionToToolName(step);

    // 对于有目标的步骤，先查步骤缓存
    let cachedStep = null;
    if (step.target && step.target.name && step.action !== 'open_app' && step.action !== 'focus_window') {
      cachedStep = await deps.cacheService.getStepCache(step.target.name, currentWindowFP, appName);
      if (cachedStep) {
        step.target.role = cachedStep.role;
        step.target.name = cachedStep.name;
      }
    }

    // Resolve semanticRef against L1 annotations
    if (step.target?.semanticRef && l1Annotations && l1Annotations.length > 0) {
      const semMatch = matchSemanticRef(step.target.semanticRef.label, l1Annotations);
      if (semMatch) {
        step.target.role = semMatch.role;
        step.target.name = semMatch.name || step.target.name;
      } else if (step.target.name) {
        const goalMatch = matchGoalToAnnotation(step.target.name, l1Annotations);
        if (goalMatch) {
          step.target.role = goalMatch.role;
          step.target.name = goalMatch.name || step.target.name;
        }
      }
    }

    // 校验目标元素是否存在
    let validationFailed = false;
    if (step.target && step.action !== 'open_app' && step.action !== 'focus_window') {
      const validate = await deps.skillExecutor.executeToolCall('uia_find_element', {
        role: step.target.role,
        name: step.target.name ?? null,
        window_hwnd: windowHwnd,
      });
      if (!validate.success || !validate.data?.['found']) {
        validationFailed = true;
      }
    }

    // 校验失败：尝试恢复
    if (validationFailed) {
      stateMachine?.markRecoveryAttempt();

      const recoveryResult = await recovery.recover(
        {
          toolName,
          target: step.target ? { role: step.target.role, name: step.target.name } : undefined,
          error: 'Element not found during replay validation',
        },
        stateMachine?.getState() ?? { focusedWindow: null, activePage: null, mode: 'normal', pageFP: null, windowFP: null, goal: '', stage: 'executing', completedSteps: [], remainingSteps: [], cacheSource: 'l2', cacheHitL1: true, cacheHitL2: true, consecutiveFailures: 1, totalActions: 0, lastError: null },
        windowHwnd,
      );

      if (recoveryResult.recovered) {
        stateMachine?.resetFailures();
        if (step.target) {
          const revalidate = await deps.skillExecutor.executeToolCall('uia_find_element', {
            role: step.target.role,
            name: step.target.name ?? null,
            window_hwnd: windowHwnd,
          });
          if (!revalidate.success || !revalidate.data?.['found']) {
            return null;
          }
        }
      } else {
        // RecoveryChain 失败 → 尝试视觉缓存坐标兜底
        const visionMatch = matchSemanticRef(step.target?.name ?? '', l1Annotations);
        if (visionMatch) {
          const cx = visionMatch.relativeX + (visionMatch.relativeWidth ?? 0) / 2;
          const cy = visionMatch.relativeY + (visionMatch.relativeHeight ?? 0) / 2;
          const windowBounds = await getWindowAbsoluteBounds(deps, windowHwnd);
          if (windowBounds) {
            const absX = Math.round(windowBounds.x + cx * windowBounds.width);
            const absY = Math.round(windowBounds.y + cy * windowBounds.height);
            const clickResult = await deps.skillExecutor.executeToolCall('desktop_click', { x: absX, y: absY });
            if (clickResult.success) {
              results.push(clickResult);
              stateMachine?.transition(toolName, true, clickResult.data ?? null);
              await new Promise((r) => setTimeout(r, 300));
              continue;
            }
          }
        }
        return null;
      }
    }

    // 构建工具参数
    const toolArgs: Record<string, unknown> = { ...step.params, window_hwnd: windowHwnd };
    if (step.target) {
      toolArgs['role'] = step.target.role;
      if (step.target.name) toolArgs['name'] = step.target.name;
    }

    // 执行动作
    const argsPreview = JSON.stringify(toolArgs).length > 200
      ? JSON.stringify(toolArgs).substring(0, 200) + '...'
      : JSON.stringify(toolArgs);
    console.log(`[cache-replayer] ▶ ${toolName}(${argsPreview})`);
    const toolStart = Date.now();
    const result = await deps.skillExecutor.executeToolCall(toolName, toolArgs);
    const toolDuration = Date.now() - toolStart;
    console.log(`[cache-replayer] ◀ ${toolName} ${result.success ? '✓' : '✗'} ${toolDuration}ms${result.message ? ` — ${result.message.substring(0, 100)}` : ''}`);
    results.push(result);

    // 执行成功后存入步骤缓存
    if (result.success && step.target && step.target.name && step.action !== 'open_app' && step.action !== 'focus_window') {
      const bounds = result.data?.['bounds'] as { left: number; top: number; right: number; bottom: number } | undefined;
      await deps.cacheService.storeStepCache({
        goalFragment: step.target.name,
        role: step.target.role,
        name: step.target.name,
        bounds,
        appName,
      });
    }

    // 更新窗口句柄
    if (result.success) {
      if (toolName === 'desktop_open_app' && result.data) {
        const newHwnd = result.data['hwnd'] as number;
        if (newHwnd && newHwnd !== 0) {
          windowHwnd = newHwnd;
        } else {
          await new Promise((r) => setTimeout(r, 1500));
          try {
            const refreshed = await deps.skillExecutor.executeToolCall('desktop_list_windows', {});
            if (refreshed.success && refreshed.data) {
              const refreshedWindows = (refreshed.data['windows'] as Array<{ hwnd: number; is_visible: boolean; title: string }>) || [];
              const freshWindows = refreshedWindows.filter(w => w.is_visible && w.title.trim().length > 0);
              const candidate = freshWindows[freshWindows.length - 1];
              if (candidate && candidate.hwnd !== windowHwnd) {
                windowHwnd = candidate.hwnd;
              }
            }
          } catch { /* 非致命 */ }
        }
        // 更新窗口指纹
        try {
          const newFp = await deps.skillExecutor.executeToolCall('uia_fingerprint', { window_hwnd: windowHwnd });
          if (newFp.success && newFp.data) {
            currentWindowFP = (newFp.data as unknown as UIFingerprint).window_fp;
          }
        } catch { /* 非致命 */ }
      } else if (toolName === 'desktop_focus_window' && step.params?.['hwnd']) {
        windowHwnd = Number(step.params['hwnd']);
      }
    }

    // 执行失败：尝试恢复
    if (!result.success) {
      stateMachine?.markRecoveryAttempt();
      const recoveryResult = await recovery.recover(
        { toolName, target: step.target ? { role: step.target.role, name: step.target.name } : undefined },
        stateMachine?.getState() ?? { focusedWindow: null, activePage: null, mode: 'normal', pageFP: null, windowFP: null, goal: '', stage: 'executing', completedSteps: [], remainingSteps: [], cacheSource: 'l2', cacheHitL1: true, cacheHitL2: true, consecutiveFailures: 1, totalActions: 0, lastError: null },
        windowHwnd,
      );

      if (recoveryResult.recovered) {
        const retryResult = await deps.skillExecutor.executeToolCall(toolName, toolArgs);
        if (!retryResult.success) return null;
        results[results.length - 1] = retryResult;
        stateMachine?.resetFailures();
      } else {
        // RecoveryChain 失败 → 尝试视觉缓存坐标兜底
        const visionMatch = matchSemanticRef(step.target?.name ?? '', l1Annotations);
        if (visionMatch) {
          const cx = visionMatch.relativeX + (visionMatch.relativeWidth ?? 0) / 2;
          const cy = visionMatch.relativeY + (visionMatch.relativeHeight ?? 0) / 2;
          const windowBounds = await getWindowAbsoluteBounds(deps, windowHwnd);
          if (windowBounds) {
            const absX = Math.round(windowBounds.x + cx * windowBounds.width);
            const absY = Math.round(windowBounds.y + cy * windowBounds.height);
            const clickResult = await deps.skillExecutor.executeToolCall('desktop_click', { x: absX, y: absY });
            if (clickResult.success) {
              results[results.length - 1] = clickResult;
              stateMachine?.transition(toolName, true, clickResult.data ?? null);
              await new Promise((r) => setTimeout(r, 300));
              continue;
            }
          }
        }
        return null;
      }
    }

    stateMachine?.transition(toolName, true, (result.data as Record<string, unknown>) ?? null);
    await new Promise((r) => setTimeout(r, 300));
  }

  turns.push({ toolCalls: steps.map((s, i) => ({
    id: `cache_replay_${i}`,
    name: semanticActionToToolName(s),
    arguments: { ...s.params, ...s.target } as Record<string, unknown>,
  })), results });

  const completed = steps.some(s => s.action === 'done');
  return { turns, finalHwnd: windowHwnd, completed };
}

// ── Vision helpers ──

function matchSemanticRef(goalFragment: string, annotations: SemanticAnnotation[] | null): SemanticAnnotation | null {
  if (!annotations || annotations.length === 0) return null;

  const normalize = (s: string) => s.trim().toLowerCase().replace(/[\s　]+/g, '');
  const goalNorm = normalize(goalFragment);
  if (!goalNorm) return null;
  const goalChars = [...goalNorm].filter((c) => c.charCodeAt(0) > 0x7f);

  let best: { el: SemanticAnnotation; score: number } | null = null;

  for (const el of annotations) {
    let score = 0;
    const labelNorm = normalize(el.label);
    const descNorm = normalize(el.description);
    const keywordsNorm = el.keywords.map(normalize).join(' ');
    const allText = `${labelNorm} ${descNorm} ${keywordsNorm}`;

    if (labelNorm === goalNorm) score += 10;
    if (labelNorm.includes(goalNorm) || goalNorm.includes(labelNorm)) score += 5;
    for (const kw of el.keywords) {
      if (goalNorm.includes(normalize(kw)) || normalize(kw).includes(goalNorm)) score += 3;
    }
    for (const ch of goalChars) {
      if (allText.includes(ch)) score += 1;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { el, score };
    }
  }

  return best && best.score >= 2 ? best.el : null;
}

async function getWindowAbsoluteBounds(
  deps: AgentDeps,
  windowHwnd: number,
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  try {
    const listResult = await deps.skillExecutor.executeToolCall('desktop_list_windows', {});
    if (!listResult.success || !listResult.data) return null;
    const windows = (listResult.data['windows'] as Array<{
      hwnd: number; left: number; top: number; width: number; height: number;
    }>) || [];
    const win = windows.find((w) => w.hwnd === windowHwnd);
    if (!win) return null;
    return { x: win.left, y: win.top, width: win.width, height: win.height };
  } catch {
    return null;
  }
}
