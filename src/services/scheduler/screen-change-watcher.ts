// Screen change watcher — extends BaseWatcher with screen-specific trigger and action context.
// Replaces the old ScreenChangeTask, now cleanly separated: trigger detection in ScreenChangeTrigger,
// generic tick lifecycle in BaseWatcher, screen-specific action context here.

import type { TaskConfig, TaskActionConfig, ScreenChangeTriggerConfig, TaskExecutionResult } from '@/types/scheduler';
import type { ScreenRegion, MonitorTarget, WorkflowStep } from '@/types/watcher';
import type { TriggerResult } from './trigger';
import type { ActionContext } from './action-executor';
import { BaseWatcher } from './base-watcher';
import { ScreenChangeTrigger } from './screen-change-trigger';
import { WatcherRuntimeState } from './watcher-runtime-state';
import { executeAction } from './action-executor';

export class ScreenChangeWatcher extends BaseWatcher {
  private _onRegionResolved: ((region: ScreenRegion, monitorTarget?: MonitorTarget) => void) | null = null;
  private _onWorkflowLearned: ((template: WorkflowStep[]) => void) | null = null;

  constructor(config: TaskConfig) {
    // trigger 在 start() 中创建（需要运行时 hwnd），这里传一个占位
    super(config, null!);
  }

  /** 设置 region 持久化回调（由 WatcherManager 注入） */
  setOnRegionResolved(cb: (region: ScreenRegion, monitorTarget?: MonitorTarget) => void): void {
    this._onRegionResolved = cb;
    // 如果 trigger 已存在，也设置到 trigger 上
    if (this.trigger) {
      (this.trigger as ScreenChangeTrigger).setOnRegionResolved(cb);
    }
  }

  /** 设置工作流模板学习回调（由 WatcherManager 注入） */
  setOnWorkflowLearned(cb: (template: WorkflowStep[]) => void): void {
    this._onWorkflowLearned = cb;
  }

  /** 手动触发区域重新定位 */
  async reResolveRegion(): Promise<ScreenRegion> {
    if (!this.trigger) {
      throw new Error('Watcher not started — no trigger available');
    }
    return (this.trigger as ScreenChangeTrigger).reResolveRegion();
  }

  // ── 覆写 BaseWatcher 生命周期 ──

  override async start(): Promise<void> {
    // 防重入
    if (this.state.status === 'running' && this.trigger) return;

    // 释放旧 trigger
    if (this.trigger) {
      this.trigger.dispose();
    }

    // 创建新的 trigger（每次 start 都需要新的 runtime state，hwnd 可能已变）
    const triggerConfig = this.config.trigger as ScreenChangeTriggerConfig;
    const toolFilter = this.buildToolFilter();
    const runtime = new WatcherRuntimeState(this.name, triggerConfig.monitorTarget);
    const screenTrigger = new ScreenChangeTrigger(
      this.name, triggerConfig, runtime, this.config.action.type, toolFilter,
    );
    if (this._onRegionResolved) {
      screenTrigger.setOnRegionResolved(this._onRegionResolved);
    }
    this.trigger = screenTrigger;

    // 委托给 BaseWatcher.start() → trigger.resolve() → 设 status
    await super.start();
  }

  override stop(): void {
    super.stop();
    this.trigger = null!;
  }

  override updateConfig(config: TaskConfig): void {
    this.config = config;
  }

  // ── 覆写 BaseWatcher 的可定制方法 ──

  protected override getDebounceMs(): number {
    return (this.config.trigger as ScreenChangeTriggerConfig).debounceMs;
  }

  protected override getCooldownMs(): number {
    return (this.config.trigger as ScreenChangeTriggerConfig).cooldownMs;
  }

  protected override async doAction(triggerResult: TriggerResult, signal: AbortSignal): Promise<TaskExecutionResult> {
    const triggerConfig = this.config.trigger as ScreenChangeTriggerConfig;
    const action = this.config.action;

    const actionCtx: ActionContext = {
      ...this.buildBaseActionCtx(triggerResult, signal),
      currentState: this.buildCurrentState(triggerConfig, action),
      monitorTarget: triggerConfig.monitorTarget,
      preparationGoal: triggerConfig.preparationGoal,
      actionGoal: triggerConfig.actionGoal,
      lastExecutionSummary: action.type === 'agent_execute' ? action.lastExecution?.summary : undefined,
    };

    this.emit('trigger_start', 'info', `Triggering action: ${action.type}`);
    const result = await executeAction(action, actionCtx);

    // 学到了新的工作流模板 → 通知 WatcherManager 持久化
    if (result.learnedWorkflow && result.learnedWorkflow.length > 0 && this._onWorkflowLearned) {
      this._onWorkflowLearned(result.learnedWorkflow);
    }

    // 执行摘要 → 持久化供下次执行参考
    if (result.executionSummary && this._onExecutionComplete) {
      this._onExecutionComplete(result.success, result.executionSummary);
    }

    return result;
  }

  // ── 内部工具 ──

  private _onExecutionComplete: ((success: boolean, summary: string) => void) | null = null;

  /** 设置执行完成回调（由 WatcherManager 注入） */
  setOnExecutionComplete(cb: (success: boolean, summary: string) => void): void {
    this._onExecutionComplete = cb;
  }

  private buildCurrentState(trigger: ScreenChangeTriggerConfig, action?: TaskActionConfig): string | undefined {
    const mt = trigger.monitorTarget;
    const parts: string[] = [];

    if (mt?.type === 'window' && mt.windowHwnd) {
      if (mt.appName) parts.push(`应用${mt.appName}已打开并聚焦`);
      if (mt.windowTitle) parts.push(`窗口"${mt.windowTitle}"已可见`);
    }

    if (trigger.preparationGoal) {
      parts.push(`前置准备已完成：${trigger.preparationGoal}`);
    }

    // 上次执行历史（帮助 Agent 了解上下文）
    if (action?.type === 'agent_execute' && action.lastExecution?.summary) {
      const lastTime = new Date(action.lastExecution.timestamp).toLocaleString();
      parts.push(`上次执行(${lastTime}): ${action.lastExecution.summary}`);
    }

    return parts.length > 0 ? parts.join(', ') : undefined;
  }
}
