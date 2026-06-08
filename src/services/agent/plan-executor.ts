// 规划执行模式：LLM 一次性生成完整步骤，本地执行

import type { AgentDeps, AgentTurn, ToolCallInfo, AgentStepCallback } from './agent-types';
import type { SkillResult } from '@/types/skill';
import type { InteractiveNode, SemanticAnnotation } from '@/types/cache';
import type { LLMMessage } from '@/types/message';
import type { ProviderConfig } from '@/types/provider';
import type { StateMachine } from '../state-machine';
import { AgentEndpoint } from '@/api/types';
import { apiStreamCompat } from '@/api/client';
import { PageKnowledgeService } from '@/services/page-knowledge';
import { compressImage } from '@/utils/image';

/**
 * 规划并执行：LLM 一次性生成完整操作计划，本地直接执行
 *
 * 使用 callWithTools 获取结构化工具调用，不依赖文本解析。
 */
export async function planAndExecute(
  deps: AgentDeps,
  params: {
    goal: string;
    l1CachedNodes: InteractiveNode[] | null;
    l1Annotations?: SemanticAnnotation[];
    provider: ProviderConfig;
    apiKey: string;
    stateMachine: StateMachine;
    onStep?: AgentStepCallback;
    signal?: AbortSignal;
    toolFilter?: Set<string>;
    currentState?: string;
    /** 已有的消息上下文（截图、窗口、L1 标注等），复用而非重建 */
    existingMessages?: LLMMessage[];
    /** 目标窗口句柄 — 截图时优先截取此窗口 */
    focusedHwnd?: number;
  },
): Promise<AgentTurn[] | null> {
  const { goal, provider, apiKey, stateMachine, onStep, signal, toolFilter, currentState, focusedHwnd } = params;

  const smState = stateMachine.getState();
  const focusedWindow = smState.focusedWindow;

  const contextLines: string[] = [];
  if (currentState) {
    contextLines.push(`Current state: ${currentState}`);
  }
  if (focusedWindow) {
    contextLines.push(`Focused window: hwnd=${focusedWindow.hwnd}, title="${focusedWindow.title}"`);
  }
  const contextBlock = contextLines.length > 0 ? `${contextLines.join('\n')}\n\n` : '';

  const currentStateRule = currentState
    ? '- If the Current state says an app is already open and focused, do NOT open it again — skip directly to the interaction step\n'
    : '';

  // 页面能力摘要注入
  let capabilityBlock = '';
  const currentFP = smState.windowFP || smState.pageFP;
  if (currentFP) {
    try {
      const pageKnowledge = new PageKnowledgeService(deps.cacheService);
      const capPrompt = await pageKnowledge.buildCapabilityPrompt(currentFP);
      if (capPrompt) capabilityBlock = `${capPrompt}\n\n`;
    } catch { /* non-critical */ }
  }

  const prompt = `${contextBlock}${capabilityBlock}Goal: "${goal}"

Return a JSON array of tool calls to accomplish this goal. No explanation, no reasoning text — ONLY the JSON array.

Rules:
${currentStateRule}- Use UIA tools for interaction when possible (the focused window is already available)
- IMPORTANT: Before calling desktop_done, you MUST call desktop_screenshot to verify the task is actually completed
- Check the screenshot result to confirm the goal was achieved before calling desktop_done
- If verification shows the task is not complete, continue with more actions
- Only call desktop_done after confirming success via screenshot

Example:
[{"function":{"name":"desktop_open_app","arguments":"{\\"name\\":\\"记事本\\"}"}},{"function":{"name":"desktop_wait","arguments":"{\\"milliseconds\\":2000}"}},{"function":{"name":"desktop_done","arguments":"{\\"message\\":\\"已打开记事本\\"}"}]}]`;

  // Build tools from skill executor, apply tool filter
  const allTools = deps.skillExecutor.buildToolsForLLM();
  const resolvedTools = toolFilter
    ? allTools.filter(t => { const fn = t['function'] as Record<string, string> | undefined; return fn?.name ? toolFilter.has(fn.name) : false; })
    : allTools;

  if (resolvedTools.length === 0) return null;

  // 追加规划提示到已有上下文
  const ctxMessages = params.existingMessages;
  if (ctxMessages) {
    ctxMessages.push({ role: 'user', content: prompt });
  }
  const planMessages = ctxMessages ?? [{ role: 'user', content: prompt } as LLMMessage];

  if (signal?.aborted) return null;

  // 流式调用后端 Agent 端点，实时获取思考过程
  let planCalls: ToolCallInfo[];
  let assistantMessage: LLMMessage | null = null;
  let planResponseText = '';
  let planReasoning = '';
  try {
    const stream = apiStreamCompat(
      AgentEndpoint.desktopAutomationTools,
      provider,
      apiKey,
      { messages: planMessages, tools: resolvedTools, goal },
    );

    let finalJson: string | undefined;
    for await (const chunk of stream) {
      if (chunk.startsWith('__REASONING__:')) {
        planReasoning += chunk.substring(14);
        await onStep?.({ type: 'reasoning', data: { content: chunk.substring(14) }, turnIndex: 0 });
      } else if (chunk.startsWith('__TOOLS__:')) {
        finalJson = chunk.substring(10);
      } else if (!chunk.startsWith('__ERROR__:')) {
        planResponseText += chunk;
      }
    }

    if (finalJson) {
      try {
        const parsed = JSON.parse(finalJson) as { toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>; responseText: string };
        planCalls = (parsed.toolCalls || []).map((r, i) => ({
          id: `plan_${i}`,
          name: r.name,
          arguments: r.arguments,
        }));
        planResponseText = parsed.responseText || planResponseText;
      } catch {
        planCalls = [];
      }
    } else {
      planCalls = [];
    }

    assistantMessage = { role: 'assistant' as const, content: planResponseText || null, reasoning_content: planReasoning || undefined };
  } catch (e) {
    console.log(`[Agent:PlanExec] ✗ LLM call failed:`, e);
    return null;
  }

  // 累积 assistant 消息到上下文（主循环回退时能拿到历史）
  if (ctxMessages && assistantMessage) {
    ctxMessages.push(assistantMessage);
  }

  if (planCalls.length === 0) {
    return null;
  }

  stateMachine.setCacheSource('llm');
  stateMachine.setStage('executing');

  // 执行-验证循环：执行工具 → 截图验证 → LLM 决策 → 重复
  const allTurns: AgentTurn[] = [];
  let currentHwnd = focusedHwnd ?? 0;
  let currentPlanCalls = planCalls;
  const maxVerificationRounds = 3;  // 最多验证 3 轮

  for (let round = 0; round < maxVerificationRounds; round++) {
    if (signal?.aborted) break;

    const results: SkillResult[] = [];
    let hasDesktopDone = false;

    // 执行当前批次的工具调用
    for (const tc of currentPlanCalls) {
      if (signal?.aborted) break;

      // 注入窗口上下文：UIA 工具、截图工具、坐标工具自动带上目标窗口 hwnd
      // 优先用 focusedHwnd，兜底用 currentHwnd（desktop_open_app 后发现的新窗口）
      const activeHwnd = focusedHwnd ?? currentHwnd;
      if (activeHwnd && activeHwnd !== 0 && !('window_hwnd' in tc.arguments)) {
        if (
          tc.name.startsWith('uia_') ||
          tc.name === 'desktop_screenshot' ||
          tc.name.startsWith('desktop_click') ||
          tc.name.startsWith('desktop_double_click') ||
          tc.name.startsWith('desktop_right_click') ||
          tc.name.startsWith('desktop_middle_click') ||
          tc.name === 'desktop_scroll' ||
          tc.name === 'desktop_move_mouse' ||
          tc.name === 'desktop_mouse_down' ||
          tc.name === 'desktop_mouse_up' ||
          tc.name === 'desktop_drag'
        ) {
          tc.arguments = { ...tc.arguments, window_hwnd: activeHwnd };
        }
      }

      const result = await deps.skillExecutor.executeToolCall(tc.name, tc.arguments);
      results.push(result);

      // 更新状态机
      stateMachine.transition(tc.name, result.success, result.data ?? null);

      // 更新窗口句柄：desktop_open_app / desktop_focus_window 之后的工具都应使用新 hwnd
      if (result.success && tc.name === 'desktop_open_app' && result.data) {
        const newHwnd = result.data['hwnd'] as number;
        if (newHwnd && newHwnd > 0) {
          currentHwnd = newHwnd;
        }
      } else if (result.success && tc.name === 'desktop_focus_window') {
        const fwHwnd = tc.arguments['hwnd'] as number;
        if (fwHwnd && fwHwnd > 0) {
          currentHwnd = fwHwnd;
        }
      }

      // 累积到上下文（截断大结果避免请求体爆炸）
      if (ctxMessages) {
        ctxMessages.push({
          role: 'assistant',
          content: null,
          toolCalls: [{
            id: tc.id,
            function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          }],
        });
        const rawContent = result.data ? JSON.stringify(result.data) : result.message ?? '';
        // 截图等大数据截断为摘要，避免 BMP base64 撑爆 HTTP 请求体
        const trimmed = rawContent.length > 2000
          ? (tc.name === 'desktop_screenshot'
            ? JSON.stringify({ note: 'Screenshot captured', format: (result.data as Record<string, unknown>)?.format })
            : rawContent.substring(0, 500) + `... (${rawContent.length} chars)`)
          : rawContent;
        ctxMessages.push({ role: 'tool', content: trimmed, toolCallId: tc.id });
      }

      // desktop_done 标记完成
      if (tc.name === 'desktop_done') {
        hasDesktopDone = true;
        break;
      }
    }

    allTurns.push({ toolCalls: currentPlanCalls, results });

    // 如果已有 desktop_done，任务完成
    if (hasDesktopDone) {
      break;
    }

    // 如果没有 desktop_done，截图验证并询问 LLM 是否完成

    // 截图验证 — 优先截目标窗口（使用运行时更新的 currentHwnd）
    const verifyHwnd = focusedHwnd ?? currentHwnd;
    const screenshotResult = await deps.skillExecutor.executeToolCall('desktop_screenshot',
      verifyHwnd && verifyHwnd !== 0 ? { window_hwnd: verifyHwnd } : {},
    );
    if (!screenshotResult.success) {
      break;
    }

    // 构建验证用消息：包含全部上下文 + 当前截图
    const verifyMessages: LLMMessage[] = ctxMessages ? [...ctxMessages] : [];
    // 注入当前截图作为图片消息（压缩为 JPEG，减小体积）
    const imageData = screenshotResult.data?.['image_data'] as string | undefined;
    if (imageData) {
      let imageUrl = imageData;
      try {
        const compressed = await compressImage(imageData);
        imageUrl = compressed.dataUrl;
      } catch { /* 压缩失败用原图 */ }
      verifyMessages.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: `Verification round ${round + 1}: Goal is "${goal}". Is it fully completed? If YES, call desktop_done. If NO, call the action tools needed to finish — do NOT screenshot again.` },
        ],
      });
    } else {
      verifyMessages.push({
        role: 'user',
        content: `Goal: "${goal}". If not completed, call action tools to finish. If completed, call desktop_done. Do NOT just screenshot again.`,
      });
    }

    // 调用 LLM 决策（流式）
    let verificationCalls: ToolCallInfo[];
    try {
      const vStream = apiStreamCompat(
        AgentEndpoint.desktopAutomationTools,
        provider,
        apiKey,
        { messages: verifyMessages, tools: resolvedTools, goal, skipCache: true },
      );

      let vJson: string | undefined;
      for await (const chunk of vStream) {
        if (chunk.startsWith('__REASONING__:')) {
          await onStep?.({ type: 'reasoning', data: { content: chunk.substring(14) }, turnIndex: 0 });
        } else if (chunk.startsWith('__TOOLS__:')) {
          vJson = chunk.substring(10);
        }
      }

      if (vJson) {
        try {
          const parsed = JSON.parse(vJson) as { toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> };
          verificationCalls = (parsed.toolCalls || []).map((r, i) => ({
            id: r.id || `verify_call_${i}`,
            name: r.name,
            arguments: r.arguments,
          }));
        } catch {
          verificationCalls = [];
        }
      } else {
        verificationCalls = [];
      }
    } catch (e) {
      console.log(`[Agent:PlanExec] ✗ verification LLM call failed:`, e);
      verificationCalls = [];
    }

    if (verificationCalls.length === 0) {
      break;
    }

    // 累积 assistant 消息到上下文
    if (ctxMessages && verificationCalls.length > 0) {
      ctxMessages.push({
        role: 'assistant',
        content: null,
        toolCalls: verificationCalls.map((c, i) => ({
          id: c.id || `verify_call_${i}`,
          type: 'function' as const,
          function: { name: c.name, arguments: JSON.stringify(c.arguments) },
        })),
      });
    }

    // 截图消息放到最后，这样下一轮 verifyMessages 能看到本轮验证结果
    if (ctxMessages) {
      ctxMessages.push({
        role: 'assistant',
        content: null,
        toolCalls: [{
          id: `verify_${round}`,
          function: { name: 'desktop_screenshot', arguments: '{}' },
        }],
      });
      ctxMessages.push({
        role: 'tool',
        content: JSON.stringify({ note: `Verification screenshot round ${round + 1}` }),
        toolCallId: `verify_${round}`,
      });
    }

    // 检查是否调用了 desktop_done
    const hasDoneInVerification = verificationCalls.some(c => c.name === 'desktop_done');
    if (hasDoneInVerification) {
      // 执行 desktop_done
      const doneCall = verificationCalls.find(c => c.name === 'desktop_done');
      if (doneCall) {
        const doneResult = await deps.skillExecutor.executeToolCall(doneCall.name, doneCall.arguments);
        allTurns.push({ toolCalls: [doneCall], results: [doneResult] });
      }
      break;
    }

    // 继续执行下一批工具调用
    currentPlanCalls = verificationCalls;
  }

  return allTurns.length > 0 ? allTurns : null;
}
