// Generic app logger — subscribes to all events on the event bus.
// Persists non-debug events to DB + outputs to console with source prefix.

import { appEventBus } from './event-bus';
import { storeAppLog, cleanupOldLogs } from './cache-service';
import type { AppEvent } from '@/types/events';

class AppLogger {
  private unsubs: (() => void)[] = [];
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    this.unsubs.push(
      appEventBus.on('*', '*', (e) => this.handleEvent(e)),
    );

    // Cleanup old logs on startup
    cleanupOldLogs(7).catch(() => {});
  }

  private handleEvent(event: AppEvent): void {
    // Console output
    const tag = event.sourceName
      ? `[${event.source}:${event.sourceName}]`
      : `[${event.source}]`;
    const levelFn = event.level === 'debug' ? 'debug' : event.level === 'error' ? 'error' : event.level === 'warn' ? 'warn' : 'log';
    console[levelFn](`${tag} ${event.type}: ${event.message}`);

    // Persist to DB (skip debug)
    if (event.level !== 'debug') {
      storeAppLog({
        source: event.source,
        source_id: event.sourceId ?? null,
        source_name: event.sourceName ?? null,
        level: event.level,
        event: event.type,
        message: event.message,
        detail: event.data ? JSON.stringify(event.data) : null,
        snapshot_path: event.snapshotPath ?? null,
        timestamp: event.timestamp,
      }).catch((e) => console.debug('[app-logger] store failed:', e));
    }
  }

  dispose(): void {
    this.unsubs.forEach(fn => fn());
    this.unsubs = [];
    this.started = false;
  }
}

export const appLogger = new AppLogger();
