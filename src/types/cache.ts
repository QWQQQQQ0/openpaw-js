// Cache row types for Phase 2 Agent Runtime (snake_case matching SQLite)

export interface UICacheRow {
  fingerprint: string; // PRIMARY KEY — window_fp or page_fp
  window_fp: string;
  page_fp: string | null;
  app_name: string;
  window_class: string;
  interactive_nodes: string; // JSON string (viewer: truncated to 200 chars)
  interactive_nodes_total_len?: number; // 原始总长度 (viewer query 返回)
  semantic_annotations: string; // JSON string — SemanticAnnotation[] (viewer: truncated to 200 chars)
  semantic_annotations_total_len?: number; // 原始总长度 (viewer query 返回)
  ocr_texts: string; // JSON string — OcrItem[] from OCR (used when UIA unavailable)
  created_at: number;
  last_hit_at: number;
  hit_count: number;
  ttl_days: number;
  parent_fingerprint?: string | null; // 父组件 fingerprint（页面知识库）
  trigger_json?: string | null;       // JSON string — TriggerInfo（从父组件打开本页的方式）
  screenshot_path?: string | null;    // 学习时的截图文件路径
}

/** Element capability — what an element can do and how to interact with it */
export interface ElementCapability {
  interactionType: 'click' | 'doubleClick' | 'rightClick' | 'type' | 'expand' | 'select' | 'drag';
  options?: Array<{ label: string; value?: string; description?: string }>;
  inputFormat?: string;
  inputExample?: string;
  notes?: string;
}

/** LLM-generated semantic annotation for a UI element. */
export interface SemanticAnnotation {
  label: string;          // semantic name: "搜索框", "播放按钮"
  description: string;    // one-line: "顶部导航栏右侧的搜索输入框"
  role: string;           // UIA role (kept for execution)
  name: string;           // UIA name
  automationId: string;   // UIA AutomationId
  relativeX: number;      // 0-1, relative to window width (left edge of bbox)
  relativeY: number;      // 0-1, relative to window height (top edge of bbox)
  relativeWidth?: number; // 0-1, bbox width as fraction of window width
  relativeHeight?: number;// 0-1, bbox height as fraction of window height
  keywords: string[];     // matching keywords: ["搜索", "search", "查找"]
  type?: 'interactive' | 'content'; // region type: interactive element or content area
  capability?: ElementCapability; // what this element can do
}

/** Vision-identified interactive element from LLM screenshot analysis (UIA unavailable). */
export interface VisionElement {
  label: string;          // semantic name: "发送按钮", "消息列表"
  description: string;    // one-line location: "聊天窗口底部右侧的发送按钮"
  keywords: string[];     // matching keywords: ["发送", "send", "发送消息"]
  relativeX: number;      // 0-1, left edge of bbox relative to window width
  relativeY: number;      // 0-1, top edge of bbox relative to window height
  relativeWidth: number;  // 0-1, bbox width as fraction of window width
  relativeHeight: number; // 0-1, bbox height as fraction of window height
  type?: 'interactive' | 'content'; // region type
  known_function?: string; // LLM 判断的功能描述，如果能从外观直接判断
}

export interface UIFingerprint {
  window_fp: string;
  pages: Record<string, string>;
  window_title: string;
  window_hwnd: number | null;
}

export interface InteractiveNode {
  role: string;
  name: string;
  automation_id: string;
  class_name: string;
  enabled: boolean;
  visible: boolean;
  bounds: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    width: number;
    height: number;
  } | null;
}

/** Semantic reference stored in L2a templates for L1 resolution during replay */
export interface SemanticReference {
  label: string;           // semantic label from annotation: "搜索框"
  keywords: string[];      // matching keywords: ["搜索", "search"]
  description?: string;    // one-line description
}

export interface SemanticAction {
  action: string; // 'click' | 'type' | 'invoke' | 'wait' | 'open_app' | ...
  target?: {
    role: string;
    name?: string;
    semanticRef?: SemanticReference;
  };
  params?: Record<string, unknown>;
}

export type CacheSource = 'l1' | 'l2' | 'l3' | 'llm' | 'none';

// ── L3: Skill templates (auto-learned) ──

export interface SkillTemplateRow {
  id: number;
  name: string;
  description: string;
  params_json: string;   // JSON array of param names: ["user", "message"]
  template_json: string;  // JSON array of SemanticAction with {param} placeholders
  preconditions_json: string;  // JSON array of precondition strings
  learned_from: number;   // how many successful executions → this template
  last_success_at: number | null;
  created_at: number;
  enabled: number;
}

export interface SkillTemplate {
  name: string;
  description: string;
  params: string[];        // e.g. ["user", "message"]
  template: SemanticAction[];
  preconditions: string[];
  learnedFrom: number;
  lastSuccessAt: number | null;
}

// ── L2: Step cache (goal fragment → element location) ──

export interface StepCacheRow {
  id: number;
  goal_fragment: string;  // "搜索"、"输入框"、"播放按钮"
  role: string;           // UIA role: "Button"、"Edit"
  name: string;           // UIA element name
  bounds_json: string | null;  // JSON: {left, top, right, bottom}
  window_fp: string | null;    // 窗口指纹（可选）
  app_name: string | null;     // 应用名（可选）
  hit_count: number;
  last_used_at: number;
}

export interface StepCacheEntry {
  goalFragment: string;
  role: string;
  name: string;
  bounds?: { left: number; top: number; right: number; bottom: number };
  windowFP?: string;
  appName?: string;
}

// ── L2a: Sub-goal cache (sub-goal key → parameterized action template) ──

export interface SubGoalCacheRow {
  id: number;
  subgoal_key: string;      // 归一化键: "播放歌曲", "搜索歌曲"
  app_name: string | null;   // 应用上下文
  window_fp: string | null;  // 窗口指纹(可选)
  params_json: string;       // JSON array of param names: ["song_name"]
  template_json: string;     // JSON: SemanticAction[] with {param} placeholders
  source_goal: string;       // 原始 goal
  hit_count: number;
  last_used_at: number;
}

export interface SubGoalCacheEntry {
  subgoalKey: string;
  appName?: string;
  windowFP?: string;
  params: string[];           // parameter names
  template: SemanticAction[]; // action template with {param} placeholders
  sourceGoal: string;
}

/** LLM 分解出的单个子目标 */
export interface SubGoal {
  key: string;                    // 归一化语义键: "搜索歌曲"
  description: string;            // 人类可读: "在搜索框中搜索指定歌曲"
  params: Record<string, string>; // 提取的参数值: {song_name: "那时雨"}
}

/** LLM 目标分解结果 */
export interface GoalDecomposition {
  subgoals: SubGoal[];
}

// ── LLM 调用缓存 (request hash → response text) ──

export interface LLMCallCacheRow {
  id: number;
  request_hash: string;
  request_text: string;
  response_text: string;
  response_size?: number; // viewer query 返回 length(response_text)
  model: string;
  provider_type: string;
  message_count: number;
  tool_count: number;
  created_at: number;
  hit_count: number;
}

// ── Capability Learning ──

export type LearningStatus = 'idle' | 'learning' | 'paused';

export interface LearningSession {
  fingerprint: string;
  appName: string;
  windowTitle: string;
  startedAt: number;
  discoveredCapabilities: Map<string, ElementCapability>; // automationId → capability
  discoveredBounds: Map<string, { left: number; top: number; width: number; height: number; right?: number; bottom?: number }>; // automationId → screen bounds
  interactionCount: number;
  hwnd: number;
  isBrowser?: boolean;
}

export interface LearningProgress {
  status: LearningStatus;
  session: LearningSession | null;
  totalDiscovered: number;
  lastInteraction: string | null;
}

