// TaskBuilder — converts ParsedTask (from IntentClassifier) to TaskConfig (for TaskScheduler).
// Handles cron→intervalMs conversion, monitor target resolution, default values.

import type { ParsedTask } from '@/types/goal';
import type { TaskConfig, TriggerConfig, TaskActionConfig } from '@/types/scheduler';
import type { MonitorTarget, ScreenRegion, DiffStrategyType, RegionMode } from '@/types/watcher';

/**
 * Build a TaskConfig from a ParsedTask.
 * Fills in sensible defaults for missing fields.
 */
export function buildTaskConfig(parsed: ParsedTask): TaskConfig {
  const now = Date.now();

  const action: TaskActionConfig = {
    type: parsed.action.type,
    ...(parsed.action.goalTemplate ? { goalTemplate: parsed.action.goalTemplate } : {}),
    ...(parsed.action.type === 'notify' ? { notifyTemplate: parsed.action.goalTemplate } : {}),
    ...(parsed.action.requiresScreenshot !== undefined ? { requiresScreenshot: parsed.action.requiresScreenshot } : {}),
    ...(parsed.action.toolMode ? { toolMode: parsed.action.toolMode } : {}),
    ...(parsed.action.customTools ? { customTools: parsed.action.customTools } : {}),
  } as TaskActionConfig;

  return {
    id: crypto.randomUUID(),
    name: parsed.name,
    enabled: true,
    trigger: buildTrigger(parsed),
    action,
    createdAt: now,
    updatedAt: now,
  };
}

function buildTrigger(parsed: ParsedTask): TriggerConfig {
  switch (parsed.type) {
    case 'timer': {
      const intervalMs = parsed.schedule?.intervalMs
        ?? parsed.schedule?.delayMs
        ?? parseCronToIntervalMs(parsed.schedule?.cron)
        ?? 3600000; // default 1 hour

      return {
        type: 'timer',
        intervalMs,
        cooldownMs: Math.min(intervalMs, 60000), // cooldown ≤ interval, max 60s
      };
    }

    case 'screen_change': {
      const isAuto = !!(parsed.monitor?.region ?? parsed.monitor?.app);
      return {
        type: 'screen_change',
        pollIntervalMs: 2000,
        cooldownMs: 5000,
        debounceMs: 300,
        minConfidence: 0.9,
        monitorTarget: resolveMonitorTarget(parsed.monitor),
        // auto 模式：0x0 表示"未解析"，触发区域发现管道（含 LLM）
        // manual 模式：400x300 作为默认截图区域
        region: (isAuto
          ? { x: 0, y: 0, width: 0, height: 0 }
          : { x: 0, y: 0, width: 400, height: 300 }) as ScreenRegion,
        diffStrategy: 'semantic_text' as DiffStrategyType,
        regionMode: (isAuto ? 'auto' : 'manual') as RegionMode,
        regionDescription: parsed.monitor?.region ?? parsed.monitor?.app,
        ...(parsed.preparationGoal ? { preparationGoal: parsed.preparationGoal } : {}),
        ...(parsed.actionGoal ? { actionGoal: parsed.actionGoal } : {}),
      };
    }

    default:
      throw new Error(`Cannot build trigger for task type: ${parsed.type}`);
  }
}

function resolveMonitorTarget(monitor?: ParsedTask['monitor']): MonitorTarget {
  if (monitor?.windowTitle) {
    return { type: 'window', windowTitle: monitor.windowTitle, appName: monitor.app };
  }
  if (monitor?.app) {
    return { type: 'window', windowTitle: monitor.app, appName: monitor.app };
  }
  return { type: 'fullscreen' };
}

// Parse a simple cron expression to intervalMs (approximate).
// Supports: "0 9 * * *" (daily 9am), "M * * * *" (hourly), etc.
// For complex cron, returns null — caller should use default.
function parseCronToIntervalMs(cron?: string): number | null {
  if (!cron) return null;

  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, , , dow] = parts;

  // "*/N * * * *" — every N minutes
  if (minute.startsWith('*/')) {
    const n = parseInt(minute.substring(2), 10);
    if (n > 0) return n * 60 * 1000;
  }

  // "H * * * *" — every hour at minute H
  if (hour === '*' && minute !== '*') {
    return 60 * 60 * 1000;
  }

  // "M H * * *" or "M H * * dow" — daily
  if (hour !== '*' && !hour.includes('/')) {
    return 24 * 60 * 60 * 1000;
  }

  // Default: daily
  return 24 * 60 * 60 * 1000;
}
