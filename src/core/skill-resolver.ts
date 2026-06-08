// Goal → Skill resolver (Phase 3)
//
// Matches user goals against auto-learned Skill templates.
// When a skill matches, only parameter extraction is needed — no LLM planning.

import { getDB } from '@/db';
import type { SkillTemplateRow, SkillTemplate } from '@/types/cache';

const MATCH_THRESHOLD = 0.35; // minimum score to consider a match (0-1)

// ── Row → domain object ──

function rowToTemplate(row: SkillTemplateRow): SkillTemplate {
  return {
    name: row.name,
    description: row.description,
    params: JSON.parse(row.params_json) as string[],
    template: JSON.parse(row.template_json),
    preconditions: JSON.parse(row.preconditions_json),
    learnedFrom: row.learned_from,
    lastSuccessAt: row.last_success_at,
  };
}

// ── Load ──

export async function loadSkillTemplates(): Promise<SkillTemplate[]> {
  const db = await getDB();
  const rows = await db.query<SkillTemplateRow>(
    'SELECT * FROM skill_templates WHERE enabled = 1 ORDER BY learned_from DESC',
  );
  return rows.map(rowToTemplate);
}

export async function getSkillTemplate(name: string): Promise<SkillTemplate | null> {
  const db = await getDB();
  const row = await db.get<SkillTemplateRow>(
    'SELECT * FROM skill_templates WHERE name = ? AND enabled = 1',
    [name],
  );
  return row ? rowToTemplate(row) : null;
}

// ── Match ──

interface MatchResult {
  skill: SkillTemplate;
  score: number;
}

/**
 * Find the best matching Skill template for a goal.
 * Returns null if no template scores above the threshold.
 */
export async function matchGoal(goal: string): Promise<MatchResult | null> {
  const templates = await loadSkillTemplates();
  if (templates.length === 0) {
    return null;
  }

  const goalLower = goal.toLowerCase();
  const goalTokens = tokenize(goalLower);

  let best: MatchResult | null = null;

  for (const skill of templates) {
    const score = computeScore(goalLower, goalTokens, skill);
    if (score > MATCH_THRESHOLD && (!best || score > best.score)) {
      best = { skill, score };
    }
  }

  return best;
}

// ── Scoring ──

function tokenize(text: string): Set<string> {
  // Simple CJK + Latin tokenizer: split on non-alphanumeric, keep 1-char CJK tokens
  const tokens = new Set<string>();
  for (const part of text.split(/[\s,，。！？、：；“”"\'\-—]+/)) {
    if (!part) continue;
    // Latin words
    if (/^[a-z0-9]+$/.test(part)) {
      tokens.add(part);
    } else {
      // CJK: individual chars AND bigrams
      for (let i = 0; i < part.length; i++) {
        tokens.add(part[i]);
        if (i + 1 < part.length) {
          tokens.add(part.substring(i, i + 2));
        }
      }
      // Also add the whole segment
      if (part.length > 2) tokens.add(part);
    }
  }
  return tokens;
}

function computeScore(goalLower: string, goalTokens: Set<string>, skill: SkillTemplate): number {
  const nameLower = skill.name.toLowerCase();
  const descLower = skill.description.toLowerCase();

  // Name contains the goal or vice versa → strong signal
  if (nameLower.includes(goalLower) || goalLower.includes(nameLower)) {
    return 0.95;
  }

  // Token overlap with skill name
  const nameTokens = tokenize(nameLower);
  const descTokens = tokenize(descLower);

  const nameOverlap = intersectRatio(goalTokens, nameTokens);
  const descOverlap = intersectRatio(goalTokens, descTokens);

  // Name match is weighted more heavily
  return nameOverlap * 0.7 + descOverlap * 0.3;
}

function intersectRatio(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  return intersection / Math.max(a.size, b.size);
}
