// 来源: lib/models/skill_definition.dart
// 来源: lib/skills/skill.dart

export interface SkillDefinition {
  name: string;
  description: string;
  tools: ToolDefinition[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  nameCn?: string;
  descriptionCn?: string;
}

export interface SkillResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

// Dynamic / user-defined skill config (stored in DB)
export interface UserSkillConfig {
  id: string;
  name: string;
  description: string;
  category: string;
  tools: ToolDefinition[];
  builtin: boolean;
  steps?: AutomationStep[];
  implementation?: string;
  nameCn?: string;
  descriptionCn?: string;
  categoryCn?: string;
  usage?: string;
  usageCn?: string;
  /** Whether this skill's tools are exposed to the AI agent. Defaults to true. */
  exposedToAI?: boolean;
}

export interface AutomationStep {
  toolName: string;
  arguments: Record<string, unknown>;
  description?: string;
}
