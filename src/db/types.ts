// DB row types (snake_case matching SQLite columns)
// 来源: lib/services/database/tables.dart

export interface ModelProviderRow {
  id: string;
  name: string;
  provider_type: string;
  base_url: string;
  model: string;
  encrypted_api_key: string;
  is_default: number;
  supports_tools: number;
  thinking_mode: number;
  supports_multimodal: number;
  created_at: string;
}

export interface ConversationRow {
  id: string;
  title: string;
  model_provider_id: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  timestamp: string;
  reasoning_content?: string | null;
}

export interface SavedAppRow {
  id: string;
  name: string;
  code: string;
  created_at: string;
}

export interface SkillRow {
  id: string;
  name: string;
  description: string | null;
  category: string;
  schema_json: string;
  enabled: number;
  builtin: number;
  steps_json: string | null;
  implementation: string | null;
  created_at: string;
  updated_at: string;
  name_cn: string | null;
  description_cn: string | null;
  category_cn: string | null;
  usage_text: string | null;
  usage_cn: string | null;
  exposed_to_ai: number;
}

export interface TaskTreeRow {
  id: string;
  project_name: string;
  module_name: string;
  parent_module_id: string | null;
  module_path: string;
  agent_id: string | null;
  agent_type: string;
  status: string;
  depth: number;
  sort_order: number;
  contract_json: string | null;
  decision_json: string | null;
  output_files_json: string | null;
  error_info: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentProcessLogRow {
  id: number;
  task_id: string;
  agent_id: string;
  step_order: number;
  action: string;
  file_path: string | null;
  input_summary: string | null;
  output_summary: string | null;
  full_input_path: string | null;
  full_output_path: string | null;
  decision_rationale: string | null;
  error_info: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface AgentMessageRow {
  id: string;
  from_agent_id: string;
  to_agent_id: string;
  task_id: string;
  message_type: string;
  subject: string;
  content: string;
  reply_to_id: string | null;
  resolved: number;
  resolution: string | null;
  created_at: string;
}

export interface PackageRegistryRow {
  id: number;
  package_name: string;
  language: string;
  approved_at: string;
}

export interface CodeRegistryRow {
  id: string;
  name: string;
  description: string;
  language: string;
  code: string;
  params_json: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
  hit_count: number;
}
