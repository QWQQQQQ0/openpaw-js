// Task factory — creates Tickable from TaskConfig + WatcherConfig migration.

import type { TaskConfig, Tickable, TriggerConfig, TaskActionConfig } from '@/types/scheduler';
import type { WatcherConfig } from '@/types/watcher';
import { ScreenChangeWatcher } from './screen-change-watcher';
import { TimerWatcher } from './timer-watcher';

export function createTask(config: TaskConfig): Tickable {
  switch (config.trigger.type) {
    case 'screen_change': return new ScreenChangeWatcher(config);
    case 'timer': return new TimerWatcher(config);
    default: throw new Error(`Unknown trigger type: ${(config.trigger as any).type}`);
  }
}

export function migrateWatcherConfig(wc: WatcherConfig): TaskConfig {
  // windowHwnd 是运行时值，迁移时清除（由 tryPrepareApp 在运行时重新解析）
  const monitorTarget = { ...wc.monitorTarget };
  delete monitorTarget.windowHwnd;

  const trigger: TriggerConfig = {
    type: 'screen_change',
    pollIntervalMs: wc.pollIntervalMs,
    cooldownMs: wc.cooldownMs,
    debounceMs: wc.debounceMs,
    minConfidence: wc.minConfidence,
    monitorTarget,
    region: wc.region,
    diffStrategy: wc.diffStrategy,
    regionMode: wc.regionMode ?? 'manual',
    regionDescription: wc.regionDescription,
    ...(wc.preparationGoal ? { preparationGoal: wc.preparationGoal } : {}),
    ...(wc.actionGoal ? { actionGoal: wc.actionGoal } : {}),
  };

  const action: TaskActionConfig = {
    type: wc.action.type,
    ...(wc.action.goalTemplate ? { goalTemplate: wc.action.goalTemplate } : {}),
    ...(wc.action.notifyTemplate ? { notifyTemplate: wc.action.notifyTemplate } : {}),
    ...(wc.action.customHandler ? { handler: wc.action.customHandler } : {}),
    ...(wc.toolMode ? { toolMode: wc.toolMode } : {}),
    ...(wc.customTools ? { customTools: wc.customTools } : {}),
    ...(wc.action.requiresScreenshot !== undefined ? { requiresScreenshot: wc.action.requiresScreenshot } : {}),
    ...(wc.workflowTemplate ? { workflowTemplate: wc.workflowTemplate } : {}),
    ...(wc.lastExecution ? { lastExecution: wc.lastExecution } : {}),
  } as TaskActionConfig;

  return {
    id: wc.id,
    name: wc.name,
    enabled: wc.enabled,
    trigger,
    action,
    context: wc.context,
    createdAt: wc.createdAt,
    updatedAt: wc.updatedAt,
  };
}
