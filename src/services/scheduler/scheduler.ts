// TickLoop — generic tick-based scheduler.
// Iterates registered Tickable instances every 1s and calls their tick().
// Each instance decides internally whether to actually execute.

import type { Tickable } from '@/types/scheduler';

const TICK_MS = 1000;

export class TickLoop {
  private instances: Map<string, Tickable> = new Map();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  /** 注册实例（不自动 start，由调用方决定） */
  add(instance: Tickable): void {
    this.instances.set(instance.id, instance);
  }

  /** 移除实例并 stop */
  remove(id: string): void {
    const inst = this.instances.get(id);
    if (inst) {
      inst.stop();
      this.instances.delete(id);
    }
  }

  get(id: string): Tickable | undefined {
    return this.instances.get(id);
  }

  getAll(): Tickable[] {
    return Array.from(this.instances.values());
  }

  /** 启动 tick 循环 */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext();
  }

  /** 停止循环 + stop 所有实例 */
  stop(): void {
    this.running = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    for (const inst of this.instances.values()) inst.stop();
  }

  private scheduleNext(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.tick(), TICK_MS);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    for (const inst of this.instances.values()) {
      try {
        await inst.tick();
      } catch {
        // 异常不阻塞其他实例
      }
    }
    this.scheduleNext();
  }
}
