// Watcher types — persistent screen monitoring

import type { SemanticAction } from './cache';

// ── Workflow Template types ──

/** 工作流步骤：动作步骤 或 LLM 生成步骤 */
export type WorkflowStep = WorkflowActionStep | WorkflowLLMStep;

/** 动作步骤：直接回放的 SemanticAction，支持 {param} 占位符 */
export interface WorkflowActionStep {
  type: 'action';
  action: SemanticAction;
}

/** LLM 生成步骤：调用模型生成文本，结果注入后续步骤的变量 */
export interface WorkflowLLMStep {
  type: 'llm_generate';
  /** prompt 模板，支持 {diff}、{ocr}、{context}、{snapshot} 等占位符 */
  promptTemplate: string;
  /** LLM 输出注入到后续步骤变量映射的参数名，如 "reply_text" */
  outputParam: string;
}

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type MonitorTargetType = 'fullscreen' | 'window';

export interface MonitorTarget {
  type: MonitorTargetType;
  windowHwnd?: number;  // 仅 window 类型时有值
  windowTitle?: string; // 窗口标题（页面级，如"文件管理群"）
  appName?: string;     // 应用名（应用级，如"微信"），用于打开/聚焦应用
}

export type DiffStrategyType = 'fast_visual' | 'semantic_text' | 'llm_vision';

export type RegionMode = 'manual' | 'auto';

export interface DiffBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiffResult {
  changed: boolean;
  confidence: number;
  diffDetail?: string;
  currentSnapshot?: string;
  diffBbox?: DiffBbox;
  /** Raw visual_diff output from Rust — used by RegionQualityTracker */
  rawVisualDiff?: {
    visual_change_ratio: number;
    changed_blocks: number;
    total_blocks: number;
    confidence: number;
  };
}

export type ActionType = 'agent_execute' | 'notify' | 'custom';

export interface ActionConfig {
  type: ActionType;
  goalTemplate?: string;
  notifyTemplate?: string;
  customHandler?: string;
  /** 是否需要截图传给 LLM（默认 true）。纯文本任务如回复消息可设为 false */
  requiresScreenshot?: boolean;
}

export interface WatcherConfig {
  id: string;
  name: string;
  enabled: boolean;
  monitorTarget: MonitorTarget;
  region: ScreenRegion;
  pollIntervalMs: number;
  diffStrategy: DiffStrategyType;
  debounceMs: number;
  cooldownMs: number;
  minConfidence: number;   // 0.0-1.0, minimum confidence to trigger action (default 0.9)
  action: ActionConfig;
  context?: string;
  regionMode?: RegionMode;        // 'manual' (default) or 'auto'
  regionDescription?: string;     // e.g. "微信消息列表" — only for auto mode
  /** 监控前的准备动作目标，Watcher 启动时执行一次（如"确保微信已打开并停留在消息列表页面"） */
  preparationGoal?: string;
  /** 触发后的详细动作描述，比 action.goalTemplate 更具体，注入 agent 执行上下文 */
  actionGoal?: string;
  toolMode?: string;              // ToolMode enum value: 'all'|'none'|'favorites'|'custom'
  customTools?: string[];         // tool names when toolMode='custom'
  /** 学到的工作流模板：首次执行成功后自动录制，后续执行直接回放 */
  workflowTemplate?: WorkflowStep[];
  /** 上次执行记录：帮助 Agent 了解之前的执行上下文 */
  lastExecution?: {
    timestamp: number;
    success: boolean;
    summary: string;
    turnsCount: number;
  };
  createdAt: number;
  updatedAt: number;
}

export type WatcherStatus = 'idle' | 'running' | 'paused' | 'triggered' | 'error';

export interface TaskQueueItem {
  id: number;
  enqueuedAt: number;
}

export interface WatcherState {
  configId: string;
  status: WatcherStatus;
  lastCheckAt: number;
  lastTriggerAt: number;
  triggerCount: number;
  lastError?: string;
  baseline: string;
  queueSize: number;
  queueItems: TaskQueueItem[];
  processing: boolean;
}

export type WatcherEventType =
  | 'tick'
  | 'diff_detected'
  | 'diff_unchanged'
  | 'low_confidence'
  | 'trigger_start'
  | 'trigger_end'
  | 'state_change'
  | 'error'
  | 'quality_evaluated'
  | 'quality_low'
  | 'region_reresolved'
  | 'agent_plan_done';

export interface DiffDetector {
  type: DiffStrategyType;
  detect(previous: string, current: string): Promise<DiffResult>;
}

// ── Region Discovery types ──

export interface WatchSignal {
  /** Human-readable description of what to watch for */
  description: string;
}

export interface WatchTarget {
  /** Semantic region name, e.g. "conversation_list" */
  semantic: string;
  /** Why this region matters */
  reason: string;
  /** Observable change signals */
  signals: WatchSignal[];
  /** 0.0–1.0 importance weight */
  importance: number;
  /** LLM 直接返回的 bbox（无 UIA 时使用） */
  bbox?: ScreenRegion;
}

export interface WatchProfile {
  watch_targets: WatchTarget[];
  uia_signature: string;
}

// ── Region Quality Auto-Validation ──

export interface TickQualityData {
  changed: boolean;
  confidence: number;
  ocrSuccess: boolean;
  visualChangeRatio: number;  // 0.0-1.0 from visual_diff
  jitter: boolean;            // changed but tiny ratio + low confidence
  hasDiffBbox: boolean;
}

export interface RegionQualityMetrics {
  ocrSuccessRate: number;    // 0-1
  changeFrequency: number;   // 0-1, ratio of changed ticks
  staticRatio: number;       // 0-1, max consecutive unchanged / window
  jitterRate: number;        // 0-1, jitter ticks / total
  diffStability: number;     // 0-1, post-change settle speed
  qualityScore: number;      // 0-1, weighted composite
  tickCount: number;
  evaluationCount: number;
}

