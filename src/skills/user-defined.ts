// Dynamic user-defined skill — tools defined in DB config, no native bindings
// Execution modes: sandboxed JS (implementation) or step replay (steps)

import type { Skill, SkillTool } from './skill';
import { SkillOk, SkillFail } from './skill';
import type { SkillResult } from '@/types/skill';
import type { UserSkillConfig, AutomationStep } from '@/types/skill';
import type { SkillExecutor } from './executor';

function substituteParams(obj: Record<string, unknown>, params: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === 'string') {
      result[key] = value.replace(/\{\{(\w+)\}\}/g, (_, name) => String(params[name] ?? ''));
    } else {
      result[key] = value;
    }
  }
  return result;
}

export class UserDefinedSkill implements Skill {
  id: string;
  name: string;
  category: string;
  description: string;
  tools: SkillTool[] = [];
  nameCn?: string;
  descriptionCn?: string;
  categoryCn?: string;
  usage?: string;
  usageCn?: string;
  config: UserSkillConfig;
  private executorRef: SkillExecutor | null = null;

  constructor(config: UserSkillConfig) {
    this.config = config;
    this.id = config.id;
    this.name = config.name;
    this.category = config.category;
    this.description = config.description;
    this.nameCn = config.nameCn;
    this.descriptionCn = config.descriptionCn;
    this.categoryCn = config.categoryCn;
    this.usage = config.usage;
    this.usageCn = config.usageCn;
    this.tools = config.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      nameCn: t.nameCn,
      descriptionCn: t.descriptionCn,
    }));
  }

  setExecutor(executor: SkillExecutor) {
    this.executorRef = executor;
  }

  async execute(toolName: string, params: Record<string, unknown>): Promise<SkillResult> {
    const tool = this.config.tools.find((t) => t.name === toolName);
    if (!tool) return SkillFail(`Unknown tool: ${toolName}`);

    // Mode 1: LLM-generated implementation (sandboxed JS)
    if (this.config.implementation) {
      try {
        const fn = new Function('params', 'skill', 'executor', this.config.implementation);
        const result = fn(params, { ok: SkillOk, fail: SkillFail }, this.executorRef);
        if (result && typeof (result as SkillResult).success === 'boolean') {
          return result as SkillResult;
        }
        return SkillOk('Implementation executed', result as Record<string, unknown> | undefined);
      } catch (e) {
        return SkillFail(`Implementation error: ${e}`);
      }
    }

    // Mode 2: Recorded step replay
    if (this.config.steps && this.config.steps.length > 0) {
      const matchingSteps = this.config.steps.filter((s) => s.toolName === toolName);
      if (matchingSteps.length === 0) {
        return SkillFail(`No recorded step matches tool: ${toolName}`);
      }
      // Find the index range of matching steps in the full step list
      const firstIdx = this.config.steps.indexOf(matchingSteps[0]);
      const lastIdx = this.config.steps.indexOf(matchingSteps[matchingSteps.length - 1]);
      const results = await this.runSteps(this.config.steps.slice(firstIdx, lastIdx + 1), params);
      const allOk = results.every((r) => r.success);
      return allOk
        ? SkillOk(`Replayed ${results.length} step(s)`, { results })
        : SkillFail(`Some steps failed`, { results });
    }

    return SkillFail(`Tool "${toolName}" has no implementation or recorded steps`);
  }

  getSteps(): AutomationStep[] {
    return this.config.steps ?? [];
  }

  /** 执行步骤序列，支持 loop/break/continue 控制流 */
  private async runSteps(steps: AutomationStep[], params: Record<string, unknown>): Promise<SkillResult[]> {
    const CONTROL_FLOW = new Set(['loop_start', 'loop_end', 'break', 'continue']);
    const results: SkillResult[] = [];
    let i = 0;

    while (i < steps.length) {
      const step = steps[i];
      const action = step.toolName;

      if (action === 'loop_start') {
        const loopArgs = substituteParams(step.arguments, params);
        const itemsRaw = loopArgs['over'] ?? loopArgs['items'] ?? loopArgs['collection'];
        const variable = (loopArgs['variable'] as string) ?? 'item';
        const items: unknown[] = Array.isArray(itemsRaw) ? itemsRaw : [];

        // Find matching loop_end
        let depth = 1;
        let loopEndIdx = -1;
        for (let j = i + 1; j < steps.length; j++) {
          if (steps[j].toolName === 'loop_start') depth++;
          if (steps[j].toolName === 'loop_end') { depth--; if (depth === 0) { loopEndIdx = j; break; } }
        }
        if (loopEndIdx < 0) { results.push(SkillFail('loop_start without matching loop_end')); break; }

        const body = steps.slice(i + 1, loopEndIdx);
        let broke = false;
        for (const item of items) {
          const loopParams = { ...params, [variable]: item };
          const bodyResults = await this.runSteps(body, loopParams);
          results.push(...bodyResults);
          if (bodyResults.some(r => !r.success && r.message === '__BREAK__')) { broke = true; break; }
        }
        i = loopEndIdx + 1;
      } else if (action === 'loop_end') {
        i++;
      } else if (action === 'break') {
        results.push(SkillOk('__BREAK__'));
        return results;
      } else if (action === 'continue') {
        return results;
      } else {
        // Normal step — execute as tool call
        const resolvedArgs = substituteParams(step.arguments, params);
        if (this.executorRef) {
          results.push(await this.executorRef.executeToolCall(step.toolName, resolvedArgs));
        } else {
          results.push(SkillOk(`Replayed: ${step.description ?? step.toolName}`, resolvedArgs));
        }
        i++;
      }
    }
    return results;
  }
}
