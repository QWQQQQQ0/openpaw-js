// Generic task scheduler types — decoupled from any specific trigger or action

import type { MonitorTarget, ScreenRegion, DiffStrategyType, RegionMode, WorkflowStep } from './watcher';

// ── Trigger Config (discriminated union) ──

export type TriggerConfig = TimerTriggerConfig | ScreenChangeTriggerConfig;

export interface TimerTriggerConfig {
  type: 'timer';
  intervalMs: number;
  cooldownMs: number;
}

export interface ScreenChangeTriggerConfig {
  type: 'screen_change';
  pollIntervalMs: number;
  cooldownMs: number;
  debounceMs: number;
  minConfidence: number;
  monitorTarget: MonitorTarget;
  region: ScreenRegion;
  diffStrategy: DiffStrategyType;
  regionMode: RegionMode;
  regionDescription?: string;
  /** 监控前的准备动作目标，Watcher 启动时执行一次 */
  preparationGoal?: string;
  /** 触发后的详细动作描述，注入 agent 执行上下文 */
  actionGoal?: string;
}

// ── Action Config (discriminated union) ──

export type TaskActionConfig = AgentExecuteTaskAction | NotifyTaskAction | CustomTaskAction;

export interface AgentExecuteTaskAction {
  type: 'agent_execute';
  goalTemplate: string;
  toolMode?: string;
  customTools?: string[];
  /** 是否需要截图传给 LLM（默认 true）。纯文本任务如回复消息可设为 false */
  requiresScreenshot?: boolean;
  /** 学到的工作流模板：首次执行成功后自动录制，后续执行直接回放 */
  workflowTemplate?: WorkflowStep[];
  /** 上次执行记录：帮助 Agent 了解之前发生了什么 */
  lastExecution?: TaskExecutionRecord;
}

/** 跨调度的执行记录，帮助 Agent 携带上下文 */
export interface TaskExecutionRecord {
  timestamp: number;
  success: boolean;
  /** LLM 生成的简要执行摘要（≤100字），注入下次执行的 currentState */
  summary: string;
  /** 执行的工具调用轮数 */
  turnsCount: number;
}

export interface NotifyTaskAction {
  type: 'notify';
  notifyTemplate: string;
}

export interface CustomTaskAction {
  type: 'custom';
  handler: string;
}

// ── Task Config (persisted to DB) ──

export interface TaskConfig {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerConfig;
  action: TaskActionConfig;
  context?: string;
  createdAt: number;
  updatedAt: number;
}

// ── Tickable State (minimal, exposed to Manager/UI) ──

export interface TickableState {
  status: 'idle' | 'running' | 'error';
  lastCheckAt: number;
  lastTriggerAt: number;
  triggerCount: number;
  lastError?: string;
}

// ── Tickable Interface ──

export interface Tickable {
  readonly id: string;
  readonly name: string;
  readonly state: TickableState;
  start(): Promise<void>;
  stop(): void;
  tick(): Promise<void>;
}

// ── Task Execution Result (used by action-executor and workflow-executor) ──

export interface TaskExecutionResult {
  success: boolean;
  duration: number;
  detail?: string;
}
