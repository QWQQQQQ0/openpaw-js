// Auto-learned Skill management (Phase 3)
//
// Monitors L2 cache hit counts. When a task is successfully replayed 3+ times,
// asks LLM to abstract it into a reusable, parameterized Skill template.
// Next time a similar goal arrives, only parameter extraction is needed.

import type { SemanticAction, SkillTemplate } from '@/types/cache';
import { storeSkillTemplate } from '@/services/cache-service';
import { getSkillTemplate } from './skill-resolver';

const PROMOTION_THRESHOLD = 3; // promote to skill after this many successful replays

// ── Abstraction prompt (small, focused) ──

const ABSTRACTION_PROMPT = `You are a skill abstractor. Given a task goal and its action sequence, create a reusable parameterized skill template.

Rules:
- Identify which parts of the goal are VARIABLE (user names, message text, file paths, etc.)
- Replace variable text/name values in the action sequence with {param} placeholders
- Give the skill a short, descriptive English name (snake_case)
- Output ONLY valid JSON, no explanation

Example:
Goal: "给张三发消息hello"
Actions: [{"action":"click","target":{"role":"list_item","name":"张三"}},{"action":"click","target":{"role":"edit","name":"输入"}},{"action":"type","params":{"text":"hello"}},{"action":"click","target":{"role":"button","name":"发送"}}]
Output: {"name":"send_wechat_message","description":"给微信联系人发送消息","params":["contact","message"],"template":[{"action":"click","target":{"role":"list_item","name":"{contact}"}},{"action":"click","target":{"role":"edit","name":"输入"}},{"action":"type","params":{"text":"{message}"}},{"action":"click","target":{"role":"button","name":"发送"}}]}`;

// ── Parameter extraction prompt ──

const PARAM_EXTRACTION_PROMPT = `Extract parameter values from the goal.

Skill: {skill_name}
Params: {params}

Goal: "{goal}"

Output ONLY a JSON object with param names as keys. Omit params that are not mentioned in the goal.`;

// ── Abstraction result type ──

interface AbstractionResult {
  name: string;
  description: string;
  params: string[];
  template: SemanticAction[];
}

// ── LLM abstraction callback type ──

export type LLMAbstractor = (goal: string, steps: SemanticAction[]) => Promise<AbstractionResult | null>;
export type LLMParamExtractor = (goal: string, skill: SkillTemplate) => Promise<Record<string, string> | null>;

// ── Promotion check ──

export async function maybePromoteToSkill(
  goal: string,
  windowFP: string,
  fingerprint: string,
  steps: SemanticAction[],
  abstractor: LLMAbstractor,
): Promise<void> {
  // Try to abstract the goal+steps into a parameterized skill template
  const abstracted = await abstractor(goal, steps);
  if (!abstracted) return;

  const { name, description, params, template } = abstracted;
  if (!name || !template || template.length === 0) return;

  // Check if skill already exists — update learned_from count
  const existing = await getSkillTemplate(name);
  if (existing && existing.learnedFrom >= PROMOTION_THRESHOLD) {
    await storeSkillTemplate(
      name,
      description || existing.description,
      params.length > 0 ? params : existing.params,
      template,
      existing.preconditions,
    );
    return;
  }

  // New skill — promote if enough steps
  if (steps.length < 2) {
    return;
  }

  await storeSkillTemplate(name, description, params, template, []);
}

// ── Parameter extraction ──

export async function extractParams(
  goal: string,
  skill: SkillTemplate,
  extractor: LLMParamExtractor,
): Promise<Record<string, string> | null> {
  return extractor(goal, skill);
}

// ── Build parametrized actions from template + extracted params ──

export function instantiateTemplate(
  template: SemanticAction[],
  params: Record<string, string>,
): SemanticAction[] {
  const serialized = JSON.stringify(template);
  let result = serialized;
  for (const [key, value] of Object.entries(params)) {
    result = result.replaceAll(`{${key}}`, value);
  }
  return JSON.parse(result) as SemanticAction[];
}
