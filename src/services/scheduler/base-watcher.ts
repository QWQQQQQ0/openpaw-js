// BaseWatcher — generic watcher base class.
// Manages tick lifecycle: trigger.check() → debounce → cooldown → doAction().
// Subclasses provide specific Trigger implementations and can override doAction().

import type { Tickable, TickableState, TaskConfig, TaskActionConfig } from '@/types/scheduler';
import type { Trigger, TriggerResult } from './trigger';
import type { ActionContext } from './action-executor';
import { executeAction } from './action-executor';
import { appEventBus } from '@/services/event-bus';
import { useSettingsStore } from '@/stores/settings-store';

export abstract class BaseWatcher implements Tickable {
  readonly id: string;
  readonly name: string;
  readonly state: TickableState = {
    status: 'idle',
    lastCheckAt: 0,
    lastTriggerAt: 0,
    triggerCount: 0,
  };

  protected config: TaskConfig;
  protected trigger: Trigger;

  private _executing = false;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private debounceReject: ((reason: Error) => void) | null = null;
  private abortController: AbortController | null = null;

  constructor(config: TaskConfig, trigger: Trigger) {
    this.id = config.id;
    this.name = config.name;
    this.config = config;
    this.trigger = trigger;
  }

  async start(): Promise<void> {
    if (this.state.status === 'running') return;
    try {
      await this.trigger.resolve();
      this.state.status = 'running';
      this.emit('state_change', 'info', 'Watcher started');
    } catch (e) {
      this.state.status = 'error';
      this.state.lastError = String(e);
      this.emit('error', 'error', `Start failed: ${e}`);
    }
  }

  stop(): void {
    this.state.status = 'idle';

    // 中断 debounce
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
    if (this.debounceReject) { this.debounceReject(new Error('stopped')); this.debounceReject = null; }

    // 中断正在执行的 action
    if (this.abortController) { this.abortController.abort(); this.abortController = null; }

    // 释放 trigger
    this.trigger?.dispose();

    this.emit('state_change', 'info', 'Watcher stopped');
  }

  async tick(): Promise<void> {
    if (this.state.status !== 'running') return;
    if (this._executing) return;

    this._executing = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      // ① 触发检测 — 委托给 Trigger
      const result = await this.trigger.check();
      this.state.lastCheckAt = Date.now();

      if (!result) { this._executing = false; return; }

      // ② debounce — 可被 stop() 通过 reject 中断
      const debounceMs = this.getDebounceMs();
      if (debounceMs > 0) {
        try {
          await new Promise<void>((resolve, reject) => {
            this.debounceReject = reject;
            if (this.debounceTimer) clearTimeout(this.debounceTimer);
            this.debounceTimer = setTimeout(() => {
              this.debounceReject = null;
              resolve();
            }, debounceMs);
          });
        } catch {
          this._executing = false;
          return;
        }
      }

      // ③ 检查是否已被停止
      if (signal.aborted || this.state.status !== 'running') {
        this._executing = false;
        return;
      }

      // ④ cooldown
      const cooldownMs = this.getCooldownMs();
      const elapsed = Date.now() - this.state.lastTriggerAt;
      if (cooldownMs > 0 && elapsed < cooldownMs) {
        this._executing = false;
        return;
      }

      // ⑤ 执行动作
      this.emit('trigger_start', 'info', `Triggering action: ${this.config.action.type}`);
      const actionResult = await this.doAction(result, signal);

      this.state.lastTriggerAt = Date.now();
      this.state.triggerCount++;
      this.emit('trigger_end', actionResult.success ? 'info' : 'error',
        actionResult.success ? `Action done (${actionResult.duration}ms)` : `Action failed: ${actionResult.detail}`,
        { success: actionResult.success, duration: actionResult.duration, detail: actionResult.detail },
      );
    } catch (e) {
      this.state.status = 'error';
      this.state.lastError = String(e);
      this.emit('error', 'error', `Tick failed: ${e}`);
    } finally {
      this._executing = false;
    }
  }

  updateConfig(config: TaskConfig): void {
    this.config = config;
  }

  // ── 可由子类覆写 ──

  /** debounce 时长（毫秒）。默认 0（不防抖）。屏幕类覆写返回配置值。 */
  protected getDebounceMs(): number { return 0; }

  /** cooldown 时长（毫秒）。默认 0（不冷却）。屏幕类覆写返回配置值。 */
  protected getCooldownMs(): number { return 0; }

  /** 执行动作。子类可覆写注入额外上下文（如 monitorTarget、preparationGoal）。 */
  protected async doAction(triggerResult: TriggerResult, signal: AbortSignal): Promise<import('@/types/scheduler').TaskExecutionResult> {
    const actionCtx = this.buildBaseActionCtx(triggerResult, signal);
    return executeAction(this.config.action, actionCtx);
  }

  // ── 内部工具 ──

  protected buildBaseActionCtx(triggerResult: TriggerResult, signal: AbortSignal): ActionContext {
    const action = this.config.action;
    return {
      taskId: this.id,
      taskName: this.name,
      goalTemplate: action.type === 'agent_execute' ? action.goalTemplate : undefined,
      notifyTemplate: action.type === 'notify' ? action.notifyTemplate : undefined,
      context: this.config.context,
      variables: triggerResult.variables ?? {},
      toolFilter: this.buildToolFilter(),
      signal,
      workflowTemplate: action.type === 'agent_execute' ? action.workflowTemplate : undefined,
    };
  }

  protected buildToolFilter(): Set<string> | undefined {
    const action = this.config.action;
    if (action.type !== 'agent_execute') return undefined;
    const toolMode = action.toolMode;
    if (!toolMode || toolMode === 'all') return undefined;

    const settings = useSettingsStore.getState();
    if (toolMode === 'none') return new Set();
    if (toolMode === 'favorites') return settings.favoriteTools;
    if (toolMode === 'custom' && action.customTools) return new Set(action.customTools);
    return undefined;
  }

  protected emit(type: string, level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): void {
    appEventBus.emit({
      source: 'watcher', type, level,
      message, timestamp: Date.now(),
      sourceId: this.id, sourceName: this.name, data,
    });
  }
}
