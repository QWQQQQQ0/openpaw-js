// Generic event types for cross-module event bus
// Any module (watcher, agent, web, phone) emits AppEvent; consumers subscribe independently.

export type AppEventSource = 'watcher' | 'agent' | 'web_agent' | 'phone_agent' | 'app';
export type AppEventLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppEvent {
  source: AppEventSource;
  type: string;
  level: AppEventLevel;
  message: string;
  timestamp: number;
  sourceId?: string;
  sourceName?: string;
  snapshotPath?: string;
  data?: Record<string, unknown>;
}

export type AppEventListener = (event: AppEvent) => void;

export interface AppLogEntry {
  id: number;
  source: AppEventSource;
  source_id: string | null;
  source_name: string | null;
  level: AppEventLevel;
  event: string;
  message: string;
  detail: string | null;
  snapshot_path: string | null;
  timestamp: number;
}
