// Platform-aware database factory
// 来源: lib/services/database/app_database.dart

import { isTauri } from '@/utils/platform';
import type { SQLiteAdapter } from './adapter';
import { tauriSQLiteAdapter } from './tauri';
import { wasmSQLiteAdapter } from './wasm';

const DDL = `
CREATE TABLE IF NOT EXISTS modelProviders (
  id TEXT PRIMARY KEY, name TEXT, provider_type TEXT,
  base_url TEXT, model TEXT, encrypted_api_key TEXT,
  is_default INTEGER DEFAULT 0, supports_tools INTEGER DEFAULT 1, supports_multimodal INTEGER DEFAULT 1, created_at TEXT
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT, model_provider_id TEXT,
  created_at TEXT, updated_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT,
  content TEXT, timestamp TEXT
);

CREATE TABLE IF NOT EXISTS savedApps (
  id TEXT PRIMARY KEY, name TEXT, code TEXT, created_at TEXT
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  category TEXT DEFAULT 'user', schema_json TEXT NOT NULL,
  enabled INTEGER DEFAULT 1, builtin INTEGER DEFAULT 0,
  steps_json TEXT, implementation TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  name_cn TEXT DEFAULT '',
  description_cn TEXT DEFAULT '',
  category_cn TEXT DEFAULT '',
  usage_text TEXT DEFAULT '',
  usage_cn TEXT DEFAULT '',
  exposed_to_ai INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at);
CREATE INDEX IF NOT EXISTS idx_model_providers_default ON modelProviders(is_default);

CREATE TABLE IF NOT EXISTS ui_cache (
  fingerprint TEXT PRIMARY KEY,
  window_fp TEXT NOT NULL,
  page_fp TEXT,
  app_name TEXT NOT NULL,
  window_class TEXT DEFAULT '',
  interactive_nodes TEXT NOT NULL,
  semantic_annotations TEXT NOT NULL DEFAULT '[]',
  ocr_texts TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_hit_at INTEGER NOT NULL DEFAULT (unixepoch()),
  hit_count INTEGER DEFAULT 1,
  ttl_days INTEGER DEFAULT 30,
  parent_fingerprint TEXT,
  trigger_json TEXT,
  screenshot_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_ui_cache_parent ON ui_cache(parent_fingerprint);
CREATE INDEX IF NOT EXISTS idx_ui_cache_app ON ui_cache(app_name);

-- action_cache table removed (replaced by subgoal_cache + step_cache)

CREATE TABLE IF NOT EXISTS skill_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT DEFAULT '',
  params_json TEXT NOT NULL DEFAULT '[]',
  template_json TEXT NOT NULL,
  preconditions_json TEXT DEFAULT '[]',
  learned_from INTEGER DEFAULT 0,
  last_success_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  enabled INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS step_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_fragment TEXT NOT NULL,
  role TEXT NOT NULL,
  name TEXT NOT NULL,
  bounds_json TEXT,
  window_fp TEXT,
  app_name TEXT,
  hit_count INTEGER DEFAULT 1,
  last_used_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_step_goal ON step_cache(goal_fragment, window_fp);
CREATE INDEX IF NOT EXISTS idx_step_app ON step_cache(goal_fragment, app_name);

CREATE TABLE IF NOT EXISTS subgoal_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subgoal_key TEXT NOT NULL,
  app_name TEXT,
  window_fp TEXT,
  params_json TEXT NOT NULL DEFAULT '[]',
  template_json TEXT NOT NULL,
  source_goal TEXT NOT NULL,
  hit_count INTEGER DEFAULT 1,
  last_used_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(subgoal_key, app_name)
);
CREATE INDEX IF NOT EXISTS idx_subgoal_key ON subgoal_cache(subgoal_key);
CREATE INDEX IF NOT EXISTS idx_subgoal_app ON subgoal_cache(app_name);

CREATE TABLE IF NOT EXISTS llm_call_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_hash TEXT NOT NULL UNIQUE,
  response_text TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_type TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  tool_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  hit_count INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_llm_hash ON llm_call_cache(request_hash);

CREATE TABLE IF NOT EXISTS goal_decomposition_cache (
  normalized_goal TEXT PRIMARY KEY,
  subgoals_json TEXT NOT NULL,
  hit_count INTEGER DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS watcher_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  monitor_target_json TEXT NOT NULL DEFAULT '{"type":"fullscreen"}',
  region_json TEXT NOT NULL,
  poll_interval_ms INTEGER NOT NULL DEFAULT 2000,
  diff_strategy TEXT NOT NULL DEFAULT 'fast_visual',
  debounce_ms INTEGER NOT NULL DEFAULT 300,
  cooldown_ms INTEGER NOT NULL DEFAULT 5000,
  min_confidence REAL NOT NULL DEFAULT 0.9,
  action_json TEXT NOT NULL,
  context TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS app_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  source_id TEXT,
  source_name TEXT,
  level TEXT NOT NULL DEFAULT 'info',
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT,
  snapshot_path TEXT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_app_logs_source ON app_logs(source, source_id);
CREATE INDEX IF NOT EXISTS idx_app_logs_ts ON app_logs(timestamp);

-- Multi-agent collaboration tables
CREATE TABLE IF NOT EXISTS task_tree (
  id TEXT PRIMARY KEY,
  project_name TEXT NOT NULL,
  module_name TEXT NOT NULL,
  parent_module_id TEXT,
  module_path TEXT NOT NULL,
  agent_id TEXT,
  agent_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  depth INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  contract_json TEXT,
  decision_json TEXT,
  output_files_json TEXT,
  error_info TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_tree_project ON task_tree(project_name, status);
CREATE INDEX IF NOT EXISTS idx_task_tree_parent ON task_tree(parent_module_id);

CREATE TABLE IF NOT EXISTS agent_process_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  step_order INTEGER NOT NULL,
  action TEXT NOT NULL,
  file_path TEXT,
  input_summary TEXT,
  output_summary TEXT,
  full_input_path TEXT,
  full_output_path TEXT,
  decision_rationale TEXT,
  error_info TEXT,
  duration_ms INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_log_task ON agent_process_log(task_id, step_order);

CREATE TABLE IF NOT EXISTS agent_messages (
  id TEXT PRIMARY KEY,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  message_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  reply_to_id TEXT,
  resolved INTEGER DEFAULT 0,
  resolution TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agent_msgs_task ON agent_messages(task_id);
CREATE INDEX IF NOT EXISTS idx_agent_msgs_unresolved ON agent_messages(resolved, task_id);

CREATE TABLE IF NOT EXISTS package_registry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  package_name TEXT NOT NULL,
  language TEXT NOT NULL,
  approved_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pkg_registry_name ON package_registry(package_name, language);

CREATE TABLE IF NOT EXISTS code_registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  language TEXT NOT NULL,
  code TEXT NOT NULL,
  params_json TEXT DEFAULT '[]',
  tags_json TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  hit_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_code_registry_lang ON code_registry(language);
`;

let _adapter: SQLiteAdapter | null = null;
let _initPromise: Promise<void> | null = null;

export async function getDB(): Promise<SQLiteAdapter> {
  if (!_adapter) {
    _adapter = isTauri() ? tauriSQLiteAdapter : wasmSQLiteAdapter;
  }
  if (!_initPromise) {
    _initPromise = (async () => {
      // Run DDL in individual execute calls (sql.js doesn't support multi-statement)
      const stmts = DDL.split(';').map(s => s.trim()).filter(Boolean);
      for (const stmt of stmts) {
        try {
          await _adapter!.execute(stmt);
        } catch { /* ignore DDL errors */ }
      }
      // Run migrations
      await runMigrations(_adapter!);
      // Verify parent_fingerprint column exists
      try {
        await _adapter!.query("SELECT parent_fingerprint FROM ui_cache LIMIT 0");
      } catch { /* ignore */ }
    })().catch(e => {
      _initPromise = null;
      throw e;
    });
  }
  await _initPromise;
  return _adapter;
}

async function hasColumn(db: SQLiteAdapter, table: string, column: string): Promise<boolean> {
  try {
    const rows = await db.query<{ name: string }>(`PRAGMA table_info(${table})`);
    return rows.some(r => r.name === column);
  } catch {
    return false;
  }
}

async function addColumnIfMissing(db: SQLiteAdapter, table: string, column: string, colDef: string): Promise<void> {
  if (await hasColumn(db, table, column)) return;
  try {
    await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${colDef}`);
  } catch { /* ignore */ }
}

async function runMigrations(db: SQLiteAdapter): Promise<void> {
  // ui_cache
  await addColumnIfMissing(db, 'ui_cache', 'semantic_annotations', "TEXT NOT NULL DEFAULT '[]'");
  await addColumnIfMissing(db, 'ui_cache', 'ocr_texts', "TEXT NOT NULL DEFAULT '[]'");
  await addColumnIfMissing(db, 'ui_cache', 'parent_fingerprint', 'TEXT');
  await addColumnIfMissing(db, 'ui_cache', 'trigger_json', 'TEXT');
  await addColumnIfMissing(db, 'ui_cache', 'screenshot_path', 'TEXT');

  // indexes (safe: IF NOT EXISTS)
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_ui_cache_parent ON ui_cache(parent_fingerprint)"); } catch {}
  try { await db.execute("CREATE INDEX IF NOT EXISTS idx_ui_cache_app ON ui_cache(app_name)"); } catch {}

  // modelProviders
  await addColumnIfMissing(db, 'modelProviders', 'supports_tools', 'INTEGER DEFAULT 1');

  // skills
  await addColumnIfMissing(db, 'skills', 'category', "TEXT DEFAULT 'user'");
  await addColumnIfMissing(db, 'skills', 'builtin', 'INTEGER DEFAULT 0');
  await addColumnIfMissing(db, 'skills', 'steps_json', 'TEXT');
  await addColumnIfMissing(db, 'skills', 'implementation', 'TEXT');
  await addColumnIfMissing(db, 'skills', "created_at", "TEXT DEFAULT (datetime('now'))");
  await addColumnIfMissing(db, 'skills', "updated_at", "TEXT DEFAULT (datetime('now'))");
  await addColumnIfMissing(db, 'skills', 'name_cn', "TEXT DEFAULT ''");
  await addColumnIfMissing(db, 'skills', 'description_cn', "TEXT DEFAULT ''");
  await addColumnIfMissing(db, 'skills', 'category_cn', "TEXT DEFAULT ''");
  await addColumnIfMissing(db, 'skills', 'usage_text', "TEXT DEFAULT ''");
  await addColumnIfMissing(db, 'skills', 'usage_cn', "TEXT DEFAULT ''");
  await addColumnIfMissing(db, 'skills', 'exposed_to_ai', 'INTEGER DEFAULT 1');

  // watcher_configs
  await addColumnIfMissing(db, 'watcher_configs', 'monitor_target_json', "TEXT NOT NULL DEFAULT '{\"type\":\"fullscreen\"}'");
  await addColumnIfMissing(db, 'watcher_configs', 'region_mode', "TEXT NOT NULL DEFAULT 'manual'");
  await addColumnIfMissing(db, 'watcher_configs', 'region_description', 'TEXT');
  await addColumnIfMissing(db, 'watcher_configs', 'min_confidence', 'REAL NOT NULL DEFAULT 0.9');
  await addColumnIfMissing(db, 'watcher_configs', 'trigger_json', 'TEXT');
  await addColumnIfMissing(db, 'watcher_configs', 'task_type', "TEXT NOT NULL DEFAULT 'screen_change'");
  await addColumnIfMissing(db, 'watcher_configs', 'preparation_goal', 'TEXT');
  await addColumnIfMissing(db, 'watcher_configs', 'action_goal', 'TEXT');
  await addColumnIfMissing(db, 'watcher_configs', 'tool_mode', "TEXT DEFAULT 'all'");
  await addColumnIfMissing(db, 'watcher_configs', 'custom_tools', 'TEXT');

  // llm_call_cache
  await addColumnIfMissing(db, 'llm_call_cache', 'request_text', "TEXT DEFAULT ''");

  // messages — reasoning_content for MiMo thinking models
  await addColumnIfMissing(db, 'messages', 'reasoning_content', 'TEXT');

  // modelProviders — thinking_mode for MiMo thinking models
  await addColumnIfMissing(db, 'modelProviders', 'thinking_mode', 'INTEGER DEFAULT 0');

  // modelProviders — supports_multimodal for vision/image models
  await addColumnIfMissing(db, 'modelProviders', 'supports_multimodal', 'INTEGER DEFAULT 1');

  // data migrations
  try { await db.execute("UPDATE watcher_configs SET diff_strategy = 'fast_visual' WHERE diff_strategy = 'pixel_hash'"); } catch {}
  try { await db.execute("UPDATE watcher_configs SET diff_strategy = 'semantic_text' WHERE diff_strategy = 'ocr_text'"); } catch {}
}

export type { SQLiteAdapter } from './adapter';
export type {
  ModelProviderRow,
  ConversationRow,
  MessageRow,
  SavedAppRow,
  SkillRow,
  TaskTreeRow,
  AgentProcessLogRow,
  AgentMessageRow,
  PackageRegistryRow,
  CodeRegistryRow,
} from './types';
