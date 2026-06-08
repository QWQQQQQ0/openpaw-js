// Generic event bus — global singleton for cross-module decoupling.
// Any module emits events; consumers (logger, UI, notifications) subscribe independently.
// Uses globalThis to guarantee a single instance even when ESM bundling creates duplicate modules.

import type { AppEvent, AppEventSource, AppEventListener } from '@/types/events';

const BUS_KEY = '__openpaw_appEventBus__';

class AppEventBus {
  private listeners: Map<string, Set<AppEventListener>> = new Map();

  on(source: AppEventSource | '*', type: string | '*', listener: AppEventListener): () => void {
    const key = `${source}:${type}`;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(listener);
    return () => {
      this.listeners.get(key)?.delete(listener);
    };
  }

  emit(event: AppEvent): void {
    const keys = [
      `${event.source}:${event.type}`,
      `${event.source}:*`,
      `*:${event.type}`,
      '*:*',
    ];
    for (const key of keys) {
      const set = this.listeners.get(key);
      if (set) {
        for (const fn of set) {
          try {
            fn(event);
          } catch { /* ignore */ }
        }
      }
    }
  }

  dispose(): void {
    this.listeners.clear();
  }
}

// Ensure global singleton — survives ESM module duplication
function getOrCreate(): AppEventBus {
  const g = globalThis as Record<string, unknown>;
  if (!g[BUS_KEY]) {
    const bus = new AppEventBus();
    (bus as any).__id = Math.random().toString(36).slice(2, 8);
    g[BUS_KEY] = bus;
  }
  return g[BUS_KEY] as AppEventBus;
}

export const appEventBus = getOrCreate();
