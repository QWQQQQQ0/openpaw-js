// 来源: lib/skills/phone_screen_skill.dart

import type { Skill, SkillTool } from './skill';
import { SkillOk, SkillFail } from './skill';
import type { SkillResult, ToolDefinition } from '@/types/skill';

export class PhoneScreenSkill implements Skill {
  id: string;
  name: string;
  category: string;
  description: string;
  tools: SkillTool[];
  nameCn?: string;
  descriptionCn?: string;
  categoryCn?: string;
  usage?: string;
  usageCn?: string;

  constructor(config?: { id?: string; name?: string; category?: string; description?: string; tools?: ToolDefinition[]; nameCn?: string; descriptionCn?: string; categoryCn?: string; usage?: string; usageCn?: string }) {
    this.id = config?.id ?? 'phone_screen';
    this.name = config?.name ?? 'Phone Screen Control';
    this.category = config?.category ?? 'Device Automation';
    this.description = config?.description ?? 'View and control the Android phone screen via accessibility service.';
    this.tools = config?.tools?.map(t => ({ name: t.name, description: t.description, parameters: t.parameters, nameCn: t.nameCn, descriptionCn: t.descriptionCn })) ?? [];
    if (config?.nameCn) this.nameCn = config.nameCn;
    if (config?.descriptionCn) this.descriptionCn = config.descriptionCn;
    if (config?.categoryCn) this.categoryCn = config.categoryCn;
    if (config?.usage) this.usage = config.usage;
    if (config?.usageCn) this.usageCn = config.usageCn;
  }

  async execute(toolName: string, params: Record<string, unknown>): Promise<SkillResult> {
    // All tools are stubs until native accessibility service is wired (Phase 7+)
    switch (toolName) {
      case 'phone_wait': {
        const ms = Number(params['durationMs']) || 1000;
        await new Promise((r) => setTimeout(r, Math.min(ms, 10000)));
        return SkillOk(`Waited ${ms}ms`, { action: 'wait', durationMs: ms });
      }
      case 'phone_done': {
        const summary = (params['summary'] as string) ?? 'Task completed';
        return SkillOk(summary, { action: 'done', message: summary });
      }
      default:
        return SkillFail(
          `Tool "${toolName}" requires native phone accessibility service (not yet wired).`,
        );
    }
  }
}
