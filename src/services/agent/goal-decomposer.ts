// 子目标分解：轻量 LLM 调用，将用户目标拆分为可缓存的子目标序列

import type { AgentDeps } from './agent-types';
import type { GoalDecomposition } from '@/types/cache';
import type { ProviderConfig } from '@/types/provider';
import { AgentEndpoint } from '@/api/types';
import { apiStreamCompat } from '@/api/client';

// ── Goal cleaning — separate metadata from actual goal content ──

interface CleanedGoal {
  /** Pure action goal, e.g. "回复微信文件管理群最新消息" */
  cleanGoal: string;
  /** Reference metadata extracted from diffDetail, e.g. "文本相似度 53.8%" */
  context?: string;
  /** Actual message content detected in the goal, e.g. "你在哪" */
  messageHint?: string;
}

/**
 * Clean a goal string that may contain watcher diff metadata.
 *
 * Input patterns handled:
 *   "回复XXX：新增 2 行: 17.34 | 你在哪 (文本相似度 53.8%)"
 *   "回复XXX：新增 1 行: 来了来了 (文本相似度 80.0%)"
 *   "回复XXX：新增: Hello | World (文本变化 10.5%)"
 *   "普通目标文本"  (no metadata — returned as-is)
 */
function cleanGoal(rawGoal: string, extraContext?: string): CleanedGoal {
  let goal = rawGoal.trim();
  let context = extraContext || undefined;
  let messageHint: string | undefined;

  // Pattern 1: "新增 N 行: msg1 | msg2 (文本相似度 X.X%)"
  // 消息在 "新增" 和 "(文本" 之间，元数据在括号里
  const newLineMatch = goal.match(/新增\s*\d*\s*行?\s*[：:]\s*(.+?)\s*[（(](文本相似度|文本变化|text)/i);
  if (newLineMatch) {
    messageHint = newLineMatch[1].trim();
    // 提取括号里的元数据作为 context
    const metaMatch = goal.match(/[（(](文本相似度[^）)]+|文本变化[^）)]+|text[^）)]+)[）)]/i);
    if (metaMatch && !context) {
      context = metaMatch[1].trim();
    }
    // goal 截取到 "新增" 之前
    const newIdx = goal.search(/新增\s*\d*\s*行?\s*[：:]/i);
    if (newIdx >= 0) {
      goal = goal.substring(0, newIdx).trim();
    }
    return { cleanGoal: goal, context, messageHint };
  }

  // Pattern 2: "action：metadata_pattern" (冒号分隔的旧格式或无消息)
  const colonIdx = goal.search(/[：:]\s*(文本相似度|text\s*similarity|新增\s*\d+\s*行|行号|文本变化|OCR|visual)/i);
  if (colonIdx >= 0) {
    const afterColon = goal.substring(colonIdx + 1).trim();
    const lineMatch = afterColon.match(/新增\s*\d*\s*行?\s*[：:]\s*(.+)$/i);
    if (lineMatch) {
      messageHint = lineMatch[1].trim();
    }
    if (!context) {
      context = afterColon;
    }
    goal = goal.substring(0, colonIdx).trim();
  } else {
    // Pattern 3: "action | actual_message" (pipe-only, no metadata)
    const pipeIdx = goal.lastIndexOf('|');
    if (pipeIdx >= 0) {
      messageHint = goal.substring(pipeIdx + 1).trim();
      goal = goal.substring(0, pipeIdx).trim();
    }
  }

  return { cleanGoal: goal, context, messageHint };
}

// ── Prompt ──

const DECOMPOSE_PROMPT = `You are a desktop automation goal decomposer. Break the user's goal into sub-goals.

Rules:
- Each sub-goal should map to a cacheable, reusable action sequence
- Extract variable parts (song names, contact names, file names, text content, etc.) as named parameters
- Use generic, normalized Chinese sub-goal keys that describe the ACTION, not the specific value
- Keep sub-goals atomic: one conceptual operation per sub-goal
- Output ONLY valid JSON, no explanation
- Context awareness: If currentState is provided below, it describes what is ALREADY accomplished. Skip any sub-goals that are already covered by the current state.
- IMPORTANT: "Reference context" below is analysis metadata — it is NOT text to send or act on. Only the "Message content" field (if present) contains the actual text to use in message_text/type_text parameters.

Output format:
{"subgoals":[{"key":"动作描述","description":"详细说明","params":{"参数名":"参数值"}}]}

{state}{context}{msgHint}Goal: "{goal}"
Output:`;

/**
 * 轻量 LLM 调用：将用户目标分解为子目标序列
 * 这是一次不带工具的纯文本生成调用，成本很低
 *
 * @param goal     Raw goal string (may contain watcher metadata — automatically cleaned)
 * @param context  Optional reference context (diff metadata, OCR text, etc.) — presented to LLM as "Reference context", NOT as goal content
 */
export async function decomposeGoal(
  deps: AgentDeps,
  goal: string,
  provider: ProviderConfig,
  apiKey: string,
  currentState?: string,
  context?: string,
): Promise<GoalDecomposition | null> {
  const cleaned = cleanGoal(goal, context);

  const stateSection = currentState
    ? `Current state: ${currentState}\n`
    : '';
  const contextSection = cleaned.context
    ? `Reference context (analysis metadata, NOT text to send): ${cleaned.context}\n`
    : '';
  const msgHintSection = cleaned.messageHint
    ? `Message content (the actual text to use in params): "${cleaned.messageHint}"\n`
    : '';

  const prompt = DECOMPOSE_PROMPT
    .replace('{goal}', cleaned.cleanGoal)
    .replace('{state}', stateSection)
    .replace('{context}', contextSection)
    .replace('{msgHint}', msgHintSection);

  try {
    const stream = apiStreamCompat(
      AgentEndpoint.chat,
      provider,
      apiKey,
      { messages: [{ role: 'user', content: prompt }] },
    );

    let text = '';
    for await (const chunk of stream) {
      if (!chunk.startsWith('__')) {
        text += chunk;
      }
    }

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as GoalDecomposition;
    if (!parsed.subgoals || !Array.isArray(parsed.subgoals) || parsed.subgoals.length === 0) {
      return null;
    }

    // 验证每个子目标的结构
    for (const sg of parsed.subgoals) {
      if (!sg.key || typeof sg.key !== 'string') {
        return null;
      }
      if (!sg.params) sg.params = {};
    }

    return parsed;
  } catch (e) {
    console.log(`[Agent:Decompose] ✗ LLM call failed:`, e);
    return null;
  }
}
