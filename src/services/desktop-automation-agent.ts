// 桌面自动化智能体核心类：负责接收任务目标，调度LLM、技能、缓存，完成桌面端自动化操作

import { ModelScenario } from '@/adapters/model-call-service';
import { getModelService } from '@/services/model-service-singleton';
import type { IModelService } from '@/interfaces/model-service';
import type { ISkillExecutor } from '@/interfaces/skill-executor';
import type { ICacheService } from '@/interfaces/cache-service';
import type { SkillResult } from '@/types/skill';
import type { ProviderConfig } from '@/types/provider';
import type { LLMMessage } from '@/types/message';
import type { WindowInfo } from './desktop-service';
import { compressImage, type CompressedImage } from '@/utils/image';
import { useSettingsStore } from '@/stores/settings-store';
import type { InteractiveNode, SemanticAction, SemanticAnnotation, UIFingerprint } from '@/types/cache';
import { matchGoal } from '@/core/skill-resolver';
import { StateMachine } from './state-machine';

// ── Agent 模块导入 ──
import type { AgentDeps, ToolCallInfo, AgentTurn, AgentStepEvent, AgentStepCallback } from './agent';
import { AgentContext } from './agent';
import { planAndExecute } from './agent/plan-executor';
import { replayCachedActions } from './agent/cache-replayer';
import { trySkillMatch, trySemanticMatch } from './agent/skill-matcher';
import { ensureInteractiveNodes, toolCallsToSemanticActions } from './agent/agent-cache';
import { executeWithSubGoalCache } from './agent/subgoal-executor';

// ── Re-export types ──
export type { ToolCallInfo, AgentTurn, AgentStepEvent, AgentStepCallback };

// ── TaskProgress：LLM 看图确认的子目标进度，跨窗口跨应用持久 ──

/**
 * 任务进度追踪器。
 * 与 UI 状态不同，进度是任务级的：一个 task 可能涉及多个应用/窗口。
 * LLM 通过 task_progress_mark 工具自行确认子目标完成后，后续轮次自动提醒。
 */
class TaskProgress {
  private steps: string[] = [];

  /** LLM 确认一个或多个子目标已完成 */
  mark(steps: string[]): void {
    for (const s of steps) {
      if (!this.steps.includes(s)) {
        this.steps.push(s);
      }
    }
  }

  /** 构建注入 LLM 的上下文消息，无进度时返回 null */
  buildContext(): string | null {
    if (this.steps.length === 0) return null;
    const items = this.steps.map((s, i) => `  ${i + 1}. ${s}`);
    return `📋 Task progress (confirmed by visually checking the screenshot — these are DONE, do NOT redo):\n${items.join('\n')}\n\nContinue with the NEXT incomplete step. If all steps are done, call desktop_done.`;
  }
}

/** task_progress_mark 工具的 OpenAI function 定义 */
function buildTaskProgressTool() {
  return {
    type: 'function' as const,
    function: {
      name: 'task_progress_mark',
      description:
        'Mark sub-goals as completed after you visually CONFIRM them in the current screenshot. ' +
        'Only call this when the screenshot shows the step has actually taken effect. ' +
        'Marked steps will be shown in future turns so you know what is already done. ' +
        'Call this alongside action tools in the same turn — no extra turn needed.',
      parameters: {
        type: 'object',
        properties: {
          done: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Sub-goals you can SEE are completed in the current screenshot. ' +
              'Describe each in natural language, e.g. "已打开浏览器", "已登录账号", "已打开设置页面", "表格数据已填写完成". ' +
              'Be specific enough that future turns can understand what was accomplished.',
          },
        },
        required: ['done'],
      },
    },
  };
}

/**
 * 桌面自动化智能体主类
 * 核心功能：接收任务 → 匹配技能/缓存 → 调用LLM → 执行工具 → 缓存学习
 */
export class DesktopAutomationAgent {
  private modelService: IModelService;
  private skillExecutor: ISkillExecutor;
  private cacheService: ICacheService;
  testMode = false;

  constructor(skillExecutor: ISkillExecutor, cacheService: ICacheService) {
    this.modelService = getModelService();
    this.skillExecutor = skillExecutor;
    this.cacheService = cacheService;
  }

  /** 构建依赖注入对象 */
  private get deps(): AgentDeps {
    return { skillExecutor: this.skillExecutor, modelService: this.modelService, cacheService: this.cacheService };
  }

  /** 路由工具调用：通过SkillExecutor执行 */
  private async executeToolCall(toolName: string, args: Record<string, unknown>): Promise<SkillResult> {
    console.debug(`[Agent:Tool] executeToolCall — ${toolName}`);
    return this.skillExecutor.executeToolCall(toolName, args);
  }

  /**
   * 执行自动化命令（主入口）
   * 完整流程：缓存/技能匹配 → LLM规划 → 逐轮执行 → 缓存学习
   */
  async executeCommand(params: {
    screenshotBase64?: string;
    goal: string;
    provider: ProviderConfig;
    apiKey: string;
    windows?: WindowInfo[];
    actionHistory?: string[];
    toolFilter?: Set<string>;
    maxTurns?: number;
    onStep?: AgentStepCallback;
    signal?: AbortSignal;
    currentState?: string;
    context?: string;
    /** watcher 已定位的目标窗口 hwnd，优先级高于 windows 数组 */
    targetWindowHwnd?: number;
    /** LLM 场景，决定使用哪个系统提示（默认 desktopAutomation） */
    scenario?: ModelScenario;
  }): Promise<AgentTurn[] | null> {
    const {
      screenshotBase64,
      goal,
      provider,
      apiKey,
      windows: initialWindows,
      actionHistory = [],
      toolFilter,
      maxTurns = 3,
      onStep,
      signal,
      currentState,
      context,
      targetWindowHwnd,
      scenario = ModelScenario.desktopAutomation,
    } = params;

    console.log(`[Agent] ▶ executeCommand START — goal="${goal}", maxTurns=${maxTurns}, windows=${initialWindows?.length ?? 0}, hasScreenshot=${!!screenshotBase64}, targetHwnd=${targetWindowHwnd ?? 'none'}`);

    let windows = initialWindows;
    // targetWindowHwnd（来自 watcher）优先，否则从 windows 数组取第一个可见窗口
    let focusedHwnd = targetWindowHwnd ?? windows?.find((w) => w.is_visible)?.hwnd;
    const focusedWindow = windows?.find((w) => w.hwnd === focusedHwnd) ?? null;
    const stateMachine = new StateMachine(goal, focusedWindow);
    console.log(`[Agent]   initial focusedHwnd=${focusedHwnd}, focusedWindow="${focusedWindow?.title ?? 'none'}"`);

    // ── L3 技能模板匹配 ──
    console.log(`[Agent]   Phase 3: trying L3 skill match...`);
    const l3Match = await matchGoal(goal);
    if (l3Match) {
      console.log(`[Agent]   L3 matched template="${l3Match.skill.name}", score=${l3Match.score.toFixed(2)}`);
      const skillResult = await trySkillMatch(this.deps, { goal, focusedHwnd: focusedHwnd ?? 0, windows: windows!, provider, apiKey, stateMachine });
      if (skillResult) {
        console.log(`[Agent] ✓ L3 skill match HIT — early return, turns=${skillResult.turns.length}`);
        stateMachine.setStage('done');
        return skillResult.turns;
      }
      console.log(`[Agent]   L3 skill execution failed, falling through`);
    } else {
      console.log(`[Agent]   L3 skill match MISS`);
    }

    // L1缓存 + 智能体上下文
    let l1CachedNodes: InteractiveNode[] | null = null;
    let l1Annotations: SemanticAnnotation[] = [];
    let l1Fingerprint: string | null = null;
    const ctx = new AgentContext();

    // 启动时立即加载 L1 标注（watcher 已聚焦窗口，不会触发 focus_window 事件）
    if (focusedHwnd) {
      try {
        const nodeResult = await ensureInteractiveNodes(this.deps, focusedHwnd, provider, apiKey);
        if (nodeResult && (nodeResult.nodes.length > 0 || nodeResult.annotations.length > 0)) {
          l1CachedNodes = nodeResult.nodes;
          l1Annotations = nodeResult.annotations;
          l1Fingerprint = nodeResult.fingerprint;
          console.log(`[Agent]   L1 loaded at startup — nodes=${l1CachedNodes.length}, annotations=${l1Annotations.length}, isVision=${!!nodeResult.isVision}`);
        }
      } catch { /* non-fatal */ }
    }

    // ── L2a 子目标缓存 ──
    console.log(`[Agent]   Phase 2: trying sub-goal cache decomposition...`);
    const subgoalResult = await executeWithSubGoalCache(
      this.deps, goal, focusedHwnd ?? 0, provider, apiKey, stateMachine, onStep, signal, toolFilter, currentState, context,
    );
    if (subgoalResult) {
      console.log(`[Agent] ✓ Sub-goal cache SUCCESS — early return, turns=${subgoalResult.length}`);
      stateMachine.setStage('done');
      return subgoalResult;
    }
    console.log(`[Agent]   Sub-goal cache miss or partial — falling through to LLM`);

    // 构建可用工具列表
    const allTools = this.skillExecutor.buildToolsForLLM();
    const resolvedTools = toolFilter
      ? allTools.filter((t) => {
          const fn = t['function'] as { name: string };
          return toolFilter.has(fn.name);
        })
      : allTools;

    if (resolvedTools.length === 0) return null;

    // 注入 task_progress_mark 工具 + 创建进度追踪器
    const tools = [...resolvedTools, buildTaskProgressTool()];
    const progress = new TaskProgress();

    // 压缩初始截图
    let compressedInitial: CompressedImage | undefined;
    if (screenshotBase64) {
      try {
        compressedInitial = await compressImage(screenshotBase64);
      } catch { /* 压缩失败则使用原图 */ }
    }
    ctx.messages.push(this.buildUserMessage({ screenshotBase64, windows, actionHistory, compressedScreenshot: compressedInitial }));

    // 注入 L1 标注到 LLM 上下文
    if (l1Annotations.length > 0) {
      const isVision = l1CachedNodes.length === 0 && l1Annotations.length > 0;
      if (isVision) {
        const summary = l1Annotations.slice(0, 30).map((a) => {
          const w = a.relativeWidth ?? 0;
          const h = a.relativeHeight ?? 0;
          const cx = a.relativeX + w / 2;
          const cy = a.relativeY + h / 2;
          return `- "${a.label}": ${a.description} (keywords: ${a.keywords.join('/')}) @ center(${cx.toFixed(2)}, ${cy.toFixed(2)}) size(${w.toFixed(2)}x${h.toFixed(2)})`;
        }).join('\n');
        ctx.messages.push({
          role: 'system',
          content: `Target window opened (UIA unavailable — vision analysis). Identified interactive elements:\n${summary}\n\nTotal: ${l1Annotations.length} elements.\n\nUse desktop_click with absolute coordinates. To convert center to absolute: x = window_left + centerX * window_width, y = window_top + centerY * window_height. Use desktop_list_windows to get window position.`,
        });
      } else {
        const summary = l1Annotations.slice(0, 30).map((a) =>
          `- "${a.label}": ${a.description} [${a.role}] "${a.name}"${a.keywords.length > 0 ? ` (keywords: ${a.keywords.join('/')})` : ''}`
        ).join('\n');
        ctx.messages.push({
          role: 'system',
          content: `Target window opened. Available elements (semantic annotations):\n${summary}\n\nTotal: ${l1Annotations.length} annotated elements. Use uia_click/uia_type with the role and name above to complete the task.`,
        });
      }
      console.log(`[Agent]   L1 annotations injected — ${l1Annotations.length} elements, isVision=${isVision}`);
    }

    // ── Plan-and-Execute ──
    console.log(`[Agent]   Trying Plan-and-Execute mode...`);
    const planResult = await planAndExecute(this.deps, {
      goal, l1CachedNodes, l1Annotations, provider, apiKey, stateMachine, onStep, signal, toolFilter, currentState,
    });
    if (planResult) {
      console.log(`[Agent] ✓ Plan-and-Execute SUCCESS — early return, turns=${planResult.length}`);
      return planResult;
    }
    console.log(`[Agent]   Plan-and-Execute FAILED — falling through to per-turn LLM loop`);

    let llmAborted = false;
    console.log(`[Agent]   Entering per-turn LLM loop (maxTurns=${maxTurns})...`);

    // 主循环：逐轮调用LLM → 执行工具 → 更新状态
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal?.aborted) { console.log(`[Agent] ■ signal.aborted at turn=${turn}`); break; }
      console.log(`[Agent]   ── Turn ${turn + 1}/${maxTurns} ──`);

      // 注入任务进度上下文，让 LLM 知道已完成哪些子目标
      const progCtx = progress.buildContext();
      if (progCtx) {
        ctx.messages.push({ role: 'user', content: progCtx });
      }

      let toolCalls: ToolCallInfo[];
      let responseText = '';

      if (this.testMode) {
        toolCalls = this.mockToolCalls(goal, turn);
      } else {
        const preEdit = await onStep?.({ type: 'before_llm', data: { model: provider.model, messages: ctx.messages, tools }, turnIndex: turn });
        const callTools = preEdit?.['tools'] ? preEdit['tools'] as Record<string, unknown>[] : tools;

        console.debug(`DesktopAutomation: turn=${turn} msgs=${ctx.messages.length} tools=${callTools.length}`);

        const stream = this.modelService.chatStream({
          scenario,
          messages: ctx.messages,
          provider,
          apiKey,
          tools: callTools,
          goal,
        });

        const textBuffer: string[] = [];
        let toolJson: string | undefined;

        for await (const chunk of stream) {
          if (chunk.startsWith('__TOOLS__:')) {
            toolJson = chunk.substring(10);
          } else if (chunk.startsWith('__ERROR__:')) {
            throw new Error(chunk.substring(10));
          } else if (chunk.startsWith('__REASONING__:')) {
            // MiMo 思考链，自动化流程中不需要
          } else {
            textBuffer.push(chunk);
          }
        }

        responseText = textBuffer.join('');

        if (!toolJson) {
          toolCalls = [];
        } else {
          const list = JSON.parse(toolJson) as Array<Record<string, unknown>>;
          toolCalls = list.map((tc) => {
            const func = tc['function'] as Record<string, unknown>;
            return {
              id: tc['id'] as string,
              name: func['name'] as string,
              arguments: JSON.parse(func['arguments'] as string) as Record<string, unknown>,
            };
          });
        }

        const postEdit = await onStep?.({ type: 'after_llm', data: { tool_calls: toolCalls }, turnIndex: turn });
        if (postEdit?.['tool_calls']) {
          const edited = postEdit['tool_calls'] as Array<Record<string, unknown>>;
          toolCalls = edited.map((tc) => ({
            id: tc['id'] as string ?? '',
            name: tc['name'] as string,
            arguments: tc['arguments'] as Record<string, unknown>,
          }));
        }
      }

      // LLM未输出工具调用：补充提示重试
      if (toolCalls.length === 0) {
        if (responseText.trim().length > 0 && turn < maxTurns - 1) {
          console.log(`[TaskEnd] LLM no tools, text="${responseText.substring(0, 80)}..." — retrying turn=${turn}`);
          ctx.messages.push({
            role: 'user',
            content: 'You MUST respond with one or more tool calls now. Do not output reasoning text — call a tool to take the next action. If you are stuck or the task is done, call desktop_done.',
          });
          continue;
        }
        console.log(`[TaskEnd] llmAborted — no tool calls after retry, turn=${turn}, text="${responseText.substring(0, 80)}"`);
        llmAborted = true;
        break;
      }

      const turnCallInfos = toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }));
      const turnResults: SkillResult[] = [];

      ctx.messages.push({
        role: 'assistant',
        content: responseText || null,
        toolCalls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      });

      // 逐工具执行
      for (const tc of toolCalls) {
        if (signal?.aborted) { console.log(`[Agent] ■ signal.aborted during tool exec, turn=${turn}, tool=${tc.name}`); break; }

        // ── task_progress_mark 拦截：LLM 确认已完成的子目标，不执行真实桌面操作 ──
        if (tc.name === 'task_progress_mark') {
          const done = tc.arguments['done'] as string[] | undefined;
          if (done && done.length > 0) {
            progress.mark(done);
            console.log(`[Agent]   task_progress_mark: +${done.length} step(s) → total=${progress['steps'].length}`);
          }
          const markResult: SkillResult = { success: true, message: `Marked ${done?.length ?? 0} step(s) as done` };
          turnResults.push(markResult);
          ctx.allResults.push(markResult);
          ctx.messages.push({ role: 'tool', content: JSON.stringify(markResult), toolCallId: tc.id });
          continue;
        }

        console.log(`[Agent]   executing tool: ${tc.name}`, Object.keys(tc.arguments).length > 0 ? tc.arguments : '');

        const toolEdit = await onStep?.({ type: 'before_tool', data: { name: tc.name, arguments: tc.arguments }, turnIndex: turn });
        const resolvedArgs = (toolEdit?.['toolArguments'] as Record<string, unknown>) ?? tc.arguments;

        if (focusedHwnd && !('window_hwnd' in resolvedArgs) && tc.name.startsWith('uia_')) {
          resolvedArgs['window_hwnd'] = focusedHwnd;
        }
        if (focusedHwnd && !('hwnd' in resolvedArgs) && tc.name === 'desktop_focus_window') {
          resolvedArgs['hwnd'] = focusedHwnd;
        }

        // Skip desktop_list_windows if we already have a focused hwnd from the watcher
        // — avoids redundant EnumWindows calls and hwnd confusion in multi-window apps
        let result: SkillResult;
        if (tc.name === 'desktop_list_windows' && focusedHwnd && windows?.length) {
          console.log(`[Agent]   skipping desktop_list_windows — already have focusedHwnd=${focusedHwnd} from watcher context`);
          result = { success: true, message: 'Using pre-known window context', data: { windows, count: windows.length } };
        } else {
          result = await this.executeToolCall(tc.name, resolvedArgs);
        }
        console.log(`[Agent]   tool ${tc.name} → success=${result.success}${result.message ? `, msg="${result.message.substring(0, 80)}"` : ''}`);
        turnResults.push(result);
        ctx.allResults.push(result);

        // 窗口切换
        if (result.success) {
          if (tc.name === 'desktop_focus_window' && resolvedArgs['hwnd']) {
            focusedHwnd = Number(resolvedArgs['hwnd']);
          } else if (tc.name === 'desktop_open_app' && result.data) {
            const newHwnd = result.data['hwnd'] as number;
            if (newHwnd && newHwnd !== 0) {
              focusedHwnd = newHwnd;
            } else {
              await new Promise((r) => setTimeout(r, 1500));
              try {
                const refreshed = await this.skillExecutor.executeToolCall('desktop_list_windows', {});
                if (refreshed.success && refreshed.data) {
                  const refreshedWindows = (refreshed.data['windows'] as WindowInfo[]) || [];
                  const freshWindows = refreshedWindows.filter(
                    (w) => w.is_visible && w.title.trim().length > 0,
                  );
                  const focused = freshWindows.find((w) => w.hwnd === focusedHwnd);
                  if (!focused) {
                    const candidate = freshWindows[freshWindows.length - 1];
                    if (candidate) {
                      focusedHwnd = candidate.hwnd;
                    }
                  }
                  windows = freshWindows;
                }
              } catch { /* 非致命 */ }
            }
          }
          // 切换窗口后：更新状态机 + 加载L1缓存
          if (tc.name === 'desktop_focus_window' || tc.name === 'desktop_open_app') {
            const newWinInfo = windows?.find(w => w.hwnd === focusedHwnd);
            if (newWinInfo) {
              stateMachine.setWindow(null, newWinInfo);
            }
            if (focusedHwnd) {
              try {
                const nodeResult = await ensureInteractiveNodes(this.deps, focusedHwnd, provider, apiKey);
                if (nodeResult && (nodeResult.nodes.length > 0 || nodeResult.annotations.length > 0)) {
                  l1CachedNodes = nodeResult.nodes;
                  l1Annotations = nodeResult.annotations;
                  l1Fingerprint = nodeResult.fingerprint;
                  if (nodeResult.isVision) {
                    // 视觉缓存兜底：UIA 不可用，用截图+LLM 识别的元素（含 bbox）
                    const summary = l1Annotations.slice(0, 30).map((a) => {
                      const w = a.relativeWidth ?? 0;
                      const h = a.relativeHeight ?? 0;
                      const cx = a.relativeX + w / 2;
                      const cy = a.relativeY + h / 2;
                      return `- "${a.label}": ${a.description} (keywords: ${a.keywords.join('/')}) @ center(${cx.toFixed(2)}, ${cy.toFixed(2)}) size(${w.toFixed(2)}x${h.toFixed(2)})`;
                    }).join('\n');
                    ctx.messages.push({
                      role: 'system',
                      content: `Target window opened (UIA unavailable — vision analysis). Identified interactive elements:\n${summary}\n\nTotal: ${l1Annotations.length} elements.\n\nUse desktop_click with absolute coordinates. To convert center to absolute: x = window_left + centerX * window_width, y = window_top + centerY * window_height. Use desktop_list_windows to get window position.`,
                    });
                  } else if (l1Annotations.length > 0) {
                    const summary = l1Annotations.slice(0, 30).map((a) =>
                      `- "${a.label}": ${a.description} [${a.role}] "${a.name}"${a.keywords.length > 0 ? ` (keywords: ${a.keywords.join('/')})` : ''}`
                    ).join('\n');
                    ctx.messages.push({
                      role: 'system',
                      content: `Target window opened. Available elements (semantic annotations):\n${summary}\n\nTotal: ${l1Annotations.length} annotated elements. Use uia_click/uia_type with the role and name above to complete the task.`,
                    });
                  } else {
                    const summary = l1CachedNodes.slice(0, 30).map((n) => `[${n.role}] ${n.name || '(unnamed)'}${n.bounds ? ` @(${n.bounds.left},${n.bounds.top})` : ''}`).join('\n');
                    ctx.messages.push({
                      role: 'system',
                      content: `Target window opened. Available interactive elements:\n${summary}\n\nTotal: ${l1CachedNodes.length} elements. Continue with the task — you can use uia_click/uia_type directly.`,
                    });
                  }
                  console.debug(`CacheService: L1 loaded for new target window — nodes=${nodeResult.nodes.length}, vision=${!!nodeResult.isVision}`);
                }
              } catch { /* 非致命 */ }
            }
          }
        }

        // 结果截断
        let content = result.data ? JSON.stringify(result.data) : result.message;
        if (content.length > 15000) {
          if (tc.name === 'uia_get_interactive' && result.data) {
            const data = result.data as Record<string, unknown>;
            const total = (data['total_count'] as number) || (data['count'] as number) || 0;
            const nodeArr = (data['nodes'] as Array<Record<string, unknown>>) || [];
            const truncated = {
              ...data,
              nodes: nodeArr.slice(0, 20),
              count: Math.min(nodeArr.length, 20),
              truncated_from: total,
              note: `Showing 20 of ${total} nodes. Use roles/name_keyword filters to narrow results.`,
            };
            content = JSON.stringify(truncated);
            if (content.length > 15000) content = content.substring(0, 15000) + '... (truncated)';
          } else {
            content = `${content.substring(0, 5000)}... (truncated, original size: ${content.length} chars)`;
          }
        }

        // 截图结果
        if (tc.name === 'desktop_screenshot' && result.data) {
          const imageData = result.data['image_data'] as string | undefined;
          if (imageData) {
            try {
              const compressed = await compressImage(imageData);
              ctx.messages.push({
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: compressed.dataUrl } },
                  { type: 'text', text: `Latest screenshot (original size: ${compressed.originalWidth}x${compressed.originalHeight}). Continue with the task.` },
                ],
              });
            } catch {
              ctx.messages.push({
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: imageData } },
                  { type: 'text', text: 'Here is the latest screenshot. Continue with the task.' },
                ],
              });
            }
          }
        } else {
          ctx.messages.push({ role: 'tool', content, toolCallId: tc.id });
        }

        await onStep?.({ type: 'after_tool', data: { name: tc.name, arguments: resolvedArgs, success: result.success, message: result.message, ...(result.data ? { data: result.data } : {}) }, turnIndex: turn });
      }

      ctx.turns.push({ toolCalls: turnCallInfos, results: turnResults });

      // 检测任务完成
      const lastResult = turnResults[turnResults.length - 1];
      if (lastResult.data?.['action'] === 'done') {
        console.log(`[TaskEnd] desktop_done called, turn=${turn}, message="${(lastResult.data['message'] as string ?? '').substring(0, 100)}"`);
        break;
      }

      if (turn === maxTurns - 1) {
        console.log(`[TaskEnd] maxTurns reached (${maxTurns})`);
      }
    }

    // 兜底：LLM 执行成功后存入子目标缓存
    if (ctx.turns.length > 0 && !llmAborted) {
      console.log(`[Agent]   L2a fallback: storing LLM result as subgoal cache`);
      try {
        const steps = toolCallsToSemanticActions(ctx.turns.flatMap(t => t.toolCalls));
        if (steps.length > 0) {
          await this.cacheService.storeSubGoalCache({
            subgoalKey: this.cacheService.normalizeGoal(goal),
            appName: goal.match(/打开(\S+)/)?.[1],
            params: [],
            template: steps,
            sourceGoal: goal,
          });
          console.log(`[Agent]   ✓ stored LLM result as subgoal — ${steps.length} steps`);
        }
      } catch { /* 非致命 */ }
    }

    console.log(`[TaskEnd] main loop done — turns=${ctx.turns.length}, llmAborted=${llmAborted}`);
    return ctx.turns.length > 0 ? ctx.turns : null;
  }

  /** 构建用户初始消息（支持图片+文本） */
  buildUserMessage(opts: { screenshotBase64?: string; windows?: WindowInfo[]; actionHistory: string[]; compressedScreenshot?: CompressedImage }): LLMMessage {
    const { screenshotBase64, windows, actionHistory, compressedScreenshot } = opts;

    if (screenshotBase64) {
      const imageUrl = compressedScreenshot?.dataUrl
        ?? (screenshotBase64.startsWith('data:') ? screenshotBase64 : `data:image/png;base64,${screenshotBase64}`);
      const parts: Array<Record<string, unknown>> = [
        { type: 'image_url', image_url: { url: imageUrl } },
      ];
      const textParts: string[] = [];
      if (compressedScreenshot) {
        textParts.push(`[屏幕原始尺寸: ${compressedScreenshot.originalWidth}x${compressedScreenshot.originalHeight}]`);
      }
      const windowSummary = this.buildWindowSummary(windows ?? []);
      if (windowSummary) textParts.push(`Visible windows:\n${windowSummary}`);
      if (actionHistory.length > 0) textParts.push(`Recent actions:\n${actionHistory.join('\n')}`);
      textParts.push('What should I do next?');
      parts.push({ type: 'text', text: textParts.join('\n\n') });
      return { role: 'user', content: parts as LLMMessage['content'] };
    }

    const textParts: string[] = [];
    if (windows && windows.length > 0) {
      textParts.push(`Visible windows:\n${this.buildWindowSummary(windows)}`);
    }
    if (actionHistory.length > 0) {
      textParts.push(`Recent actions:\n${actionHistory.join('\n')}`);
    }
    textParts.push('What should I do next?');
    return { role: 'user', content: textParts.join('\n\n') };
  }

  private buildWindowSummary(windows: WindowInfo[]): string {
    if (windows.length === 0) return '';
    const lines = windows.slice(0, 20).map((w) => `- hwnd=${w.hwnd}: "${w.title}" (${w.width}x${w.height})`);
    if (windows.length > 20) lines.push(`... and ${windows.length - 20} more windows`);
    return lines.join('\n');
  }

  mockToolCalls(goal: string, turn: number): ToolCallInfo[] {
    if (turn === 0) {
      const appName = goal.replace(/打开|启动|运行|launch|open/gi, '').trim();
      return [
        { id: 'call_mock_1', name: 'desktop_screenshot', arguments: {} },
        { id: 'call_mock_2', name: 'desktop_open_app', arguments: { name: appName || goal } },
      ];
    }
    return [
      { id: 'call_mock_done', name: 'desktop_done', arguments: { message: `已成功${goal} (mock)` } },
    ];
  }
}
