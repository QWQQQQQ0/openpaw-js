// 来源: lib/skills/skill_executor.dart

import type { SkillResult, ToolDefinition } from '@/types/skill';
import type { Skill, SkillTool } from './skill';
import { toolToOpenAI } from './skill';
import type { ISkillExecutor } from '@/interfaces/skill-executor';

export class SkillExecutor implements ISkillExecutor {
  private skills: Map<string, Skill> = new Map();
  private toolToSkill: Map<string, Skill> = new Map();
  disabledTools: Set<string> = new Set();

  /** Legacy tool names → unified replacements (transparent to LLM, for backward compat) */
  private static LEGACY_MAP: Record<string, string> = {
    'desktop_double_click': 'desktop_click',
    'desktop_right_click': 'desktop_click',
    'desktop_middle_click': 'desktop_click',
    'desktop_screenshot_window': 'desktop_screenshot',
    'desktop_screenshot_region': 'desktop_screenshot',
  };

  register(skill: Skill): void {
    this.skills.set(skill.id, skill);
    for (const tool of skill.tools) {
      this.toolToSkill.set(tool.name, skill);
    }
  }

  unregister(id: string): void {
    const skill = this.skills.get(id);
    if (skill) {
      for (const tool of skill.tools) {
        this.toolToSkill.delete(tool.name);
      }
      this.skills.delete(id);
    }
  }

  getSkill(id: string): Skill | undefined {
    return this.skills.get(id);
  }

  get allSkills(): Skill[] {
    return [...this.skills.values()];
  }

  get allTools(): SkillTool[] {
    return this.allSkills.flatMap((s) => s.tools);
  }

  get hasTools(): boolean {
    return this.allTools.length > 0;
  }

  get enabledToolNames(): string[] {
    return this.allTools
      .filter((t) => !this.disabledTools.has(t.name))
      .map((t) => t.name);
  }

  get enabledToolsBySkill(): Map<string, SkillTool[]> {
    const result = new Map<string, SkillTool[]>();
    for (const skill of this.allSkills) {
      const tools = skill.tools.filter((t) => !this.disabledTools.has(t.name));
      if (tools.length > 0) result.set(skill.name, tools);
    }
    return result;
  }

  async executeToolCall(
    toolName: string,
    params: Record<string, unknown>,
  ): Promise<SkillResult> {
    // Legacy tool name → search with unified name, but execute with ORIGINAL
    // name so the skill's internal alias can translate params (e.g. right_click → button:'right')
    const mappedName = SkillExecutor.LEGACY_MAP[toolName] ?? toolName;
    const legacyNote = mappedName !== toolName ? ` (→${mappedName})` : '';

    for (const skill of this.allSkills) {
      if (skill.tools.some((t) => t.name === mappedName)) {
        const argsStr = JSON.stringify(params);
        const argsPreview = argsStr.length > 500
          ? argsStr.substring(0, 500) + '...'
          : argsStr;
        console.log(`[executor] ▶ ${toolName}${legacyNote}(${argsPreview}) via ${skill.name}`);
        const start = Date.now();
        // Pass ORIGINAL toolName — skill's executeTool handles legacy param translation
        const result = await skill.execute(toolName, params);
        const duration = Date.now() - start;
        if (result.success) {
          const dataPreview = result.data
            ? JSON.stringify(result.data).substring(0, 200)
            : result.message?.substring(0, 200) ?? '';
          console.log(`[executor] ◀ ${toolName} ✓ ${duration}ms — ${dataPreview}`);
        } else {
          console.warn(`[executor] ◀ ${toolName} ✗ ${duration}ms — ${result.message}`);
        }
        return result;
      }
    }
    console.warn(`[executor] ◀ ${toolName} ✗ — no skill handles this tool`);
    return { success: false, message: `No enabled skill handles tool: ${toolName}` };
  }

  buildToolsForLLM(only?: Set<string> | string[]): Record<string, unknown>[] {
    let tools = this.allTools.filter((t) => !this.disabledTools.has(t.name));
    if (only) {
      const has = only instanceof Set
        ? (name: string) => only.has(name)
        : (name: string) => only.includes(name);
      tools = tools.filter((t) => has(t.name));
    }
    return tools.map(toolToOpenAI);
  }

  async loadAll(): Promise<void> {
    for (const skill of this.skills.values()) {
      await skill.onLoad?.();
    }
  }

  async disposeAll(): Promise<void> {
    for (const skill of this.skills.values()) {
      await skill.onDispose?.();
    }
  }
}
