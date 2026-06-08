// Timer watcher — extends BaseWatcher with a simple interval-based trigger.

import type { TaskConfig, TimerTriggerConfig } from '@/types/scheduler';
import type { Trigger, TriggerResult } from './trigger';
import { BaseWatcher } from './base-watcher';

class TimerTrigger implements Trigger {
  private intervalMs: number;
  private lastFiredAt = 0;

  constructor(intervalMs: number) {
    this.intervalMs = intervalMs;
  }

  async resolve(): Promise<void> { /* nothing to resolve */ }

  async check(): Promise<TriggerResult | null> {
    const now = Date.now();
    if (this.lastFiredAt > 0 && now - this.lastFiredAt < this.intervalMs) {
      return null;
    }
    this.lastFiredAt = now;
    return { variables: {} };
  }

  dispose(): void { /* nothing to dispose */ }
}

export class TimerWatcher extends BaseWatcher {
  constructor(config: TaskConfig) {
    const triggerConfig = config.trigger as TimerTriggerConfig;
    super(config, new TimerTrigger(triggerConfig.intervalMs));
  }

  protected override getCooldownMs(): number {
    return (this.config.trigger as TimerTriggerConfig).cooldownMs;
  }
}
