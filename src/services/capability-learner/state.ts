// 能力学习器 — 单例状态管理

import type { LearningStatus, LearningSession, LearningProgress, InteractiveNode } from './types';

let currentStatus: LearningStatus = 'idle';
let currentSession: LearningSession | null = null;
let snapshotBeforeInteraction: InteractiveNode[] | null = null;
let listeners: Array<(progress: LearningProgress) => void> = [];
let eventUnsub: (() => void) | null = null;
let currentScreenshotPath: string | null = null;

export function getStatus(): LearningStatus {
  return currentStatus;
}

export function setStatus(status: LearningStatus): void {
  currentStatus = status;
}

export function getSession(): LearningSession | null {
  return currentSession;
}

export function setSession(session: LearningSession | null): void {
  currentSession = session;
}

export function getSnapshot(): InteractiveNode[] | null {
  return snapshotBeforeInteraction;
}

export function setSnapshot(snapshot: InteractiveNode[] | null): void {
  snapshotBeforeInteraction = snapshot;
}

export function getScreenshotPath(): string | null {
  return currentScreenshotPath;
}

export function setScreenshotPath(path: string | null): void {
  currentScreenshotPath = path;
}

export function getEventUnsub(): (() => void) | null {
  return eventUnsub;
}

export function setEventUnsub(unsub: (() => void) | null): void {
  eventUnsub = unsub;
}

export function getProgress(): LearningProgress {
  return {
    status: currentStatus,
    session: currentSession,
    totalDiscovered: currentSession?.discoveredCapabilities.size ?? 0,
    lastInteraction: null,
  };
}

export function addListener(callback: (progress: LearningProgress) => void): () => void {
  listeners.push(callback);
  return () => { listeners = listeners.filter(l => l !== callback); };
}

export function notifyListeners(): void {
  const progress = getProgress();
  for (const listener of listeners) {
    try { listener(progress); } catch { /* ignore */ }
  }
}
