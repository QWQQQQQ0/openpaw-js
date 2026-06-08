// 工作流录制器：从 AgentTurn[] 提取 WorkflowStep[] 模板
//
// 首次执行成功后，将工具调用序列转换为可回放的工作流模板。
// 动作类工具 → WorkflowActionStep
// 文本生成类（uia_type 的文本来自 LLM 输出）→ WorkflowLLMStep

import type { AgentTurn, ToolCallInfo } from '@/services/agent/agent-types';
import type { WorkflowStep, WorkflowActionStep, WorkflowLLMStep } from '@/types/watcher';
import type { SemanticAction } from '@/types/cache';
import { toolNameToAction, toolCallsToSemanticActions } from '@/services/agent/agent-cache';

/** 诊断/辅助工具 — 不录入工作流 */
const SKIP_TOOLS = new Set([
  'desktop_done',
  'desktop_screenshot',
  'uia_get_interactive',
  'uia_fingerprint',
  'uia_find_element',
  'uia_get_property',
  'desktop_list_windows',
  'desktop_list_apps',
  'desktop_wait',
]);

/**
 * 从 AgentTurn[] 提取工作流模板
 *
 * 逻辑：
 * 1. 收集所有非诊断工具调用
 * 2. 对每个 uia_type 工具调用，判断其文本是否来自 LLM 动态生成
 *    - 如果文本是 goalTemplate/context 的子串 → 固定文本 → WorkflowActionStep
 *    - 否则 → 动态文本 → WorkflowLLMStep（prompt 从 goalTemplate 提取）
 * 3. 其他工具调用 → WorkflowActionStep
 */
export function extractWorkflowFromTurns(
  turns: AgentTurn[],
  goalTemplate?: string,
  context?: string,
): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  const knownFixedTexts = extractKnownTexts(goalTemplate, context);

  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      if (SKIP_TOOLS.has(tc.name)) continue;

      const semanticAction = toolCallToSemanticAction(tc);
      if (!semanticAction) continue;

      // 识别 uia_type 的动态文本 → 转为 LLM 生成步骤
      if (tc.name === 'uia_type' && tc.arguments['text']) {
        const typedText = String(tc.arguments['text']);
        if (isDynamicText(typedText, knownFixedTexts)) {
          const llmStep: WorkflowLLMStep = {
            type: 'llm_generate',
            promptTemplate: buildLLMPrompt(goalTemplate, context),
            outputParam: 'generated_text',
          };
          steps.push(llmStep);
          // 将 type 动作的 text 替换为占位符
          const typeStep: WorkflowActionStep = {
            type: 'action',
            action: { ...semanticAction, params: { text: '{generated_text}' } },
          };
          steps.push(typeStep);
          continue;
        }
      }

      steps.push({ type: 'action', action: semanticAction });
    }
  }

  return steps.length > 0 ? steps : [];
}

/** 从 goalTemplate 和 context 中提取已知的固定文本片段 */
function extractKnownTexts(goalTemplate?: string, context?: string): string[] {
  const texts: string[] = [];
  if (goalTemplate) texts.push(goalTemplate);
  if (context) texts.push(context);
  // 提取引号中的文本作为已知固定值
  const quotedPattern = /[""「」『』]([^""「」『』]{2,})[""「」『』]/g;
  for (const text of [goalTemplate, context].filter(Boolean)) {
    let match;
    while ((match = quotedPattern.exec(text!)) !== null) {
      texts.push(match[1]);
    }
  }
  return texts;
}

/** 判断文本是否是动态生成的（不是已知固定文本的子串） */
function isDynamicText(text: string, knownTexts: string[]): boolean {
  if (text.length < 5) return false; // 太短的文本（如"ok"）不值得 LLM 生成
  for (const known of knownTexts) {
    if (known.includes(text) || text.includes(known)) {
      return false; // 文本与已知内容重叠，是固定的
    }
  }
  return true;
}

/** 构建 LLM 生成步骤的 prompt */
function buildLLMPrompt(goalTemplate?: string, context?: string): string {
  const parts = ['请根据以下信息生成回复文本：'];
  if (context) parts.push(`任务上下文：{context}`);
  if (goalTemplate) parts.push(`目标：${goalTemplate}`);
  parts.push('检测到的变化：{diff}');
  parts.push('请直接输出回复内容，不要包含其他说明。');
  return parts.join('\n');
}

/** 单个工具调用 → SemanticAction（过滤诊断工具） */
function toolCallToSemanticAction(tc: ToolCallInfo): SemanticAction | null {
  const action: SemanticAction = { action: toolNameToAction(tc.name) };

  if (tc.arguments['role']) {
    action.target = {
      role: tc.arguments['role'] as string,
      name: tc.arguments['name'] as string | undefined,
    };
  }

  if (tc.arguments['text']) {
    action.params = { text: tc.arguments['text'] };
  } else if (tc.arguments['hwnd']) {
    action.params = { hwnd: tc.arguments['hwnd'] };
  } else if (tc.arguments['app_name']) {
    action.params = { app_name: tc.arguments['app_name'] };
  } else if (tc.arguments['keys']) {
    action.params = { keys: tc.arguments['keys'] };
  }

  return action;
}
