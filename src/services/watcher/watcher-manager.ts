// Watcher manager — singleton backed by TickLoop.
// Handles lifecycle (create/start/stop/remove), persistence, auto-restore, and cross-window sync.

import type { WatcherConfig, WatcherState, ScreenRegion, MonitorTarget, WorkflowStep } from '@/types/watcher';
import type { TaskConfig, Tickable } from '@/types/scheduler';
import type { ScreenChangeWatcher } from '@/services/scheduler/screen-change-watcher';
import { TickLoop } from '@/services/scheduler/scheduler';
import { createTask, migrateWatcherConfig } from '@/services/scheduler/task-factory';
import {
  storeWatcherConfig,
  getAllWatcherConfigs,
  deleteWatcherConfig,
} from '@/services/cache-service';
import { appEventBus } from '@/services/event-bus';

class WatcherManager {
  private loop = new TickLoop();
  private syncUnlisten: (() => void) | null = null;
  // Store original WatcherConfig for backward-compatible getStates()
  private configStore: Map<string, WatcherConfig> = new Map();

  async initSync(): Promise<void> {
    if (this.syncUnlisten) return;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const currentLabel = getCurrentWebviewWindow().label;

      this.syncUnlisten = await listen<{ id: string; enabled: boolean; sourceLabel: string }>(
        'watcher-toggle',
        (event) => {
          if (event.payload.sourceLabel === currentLabel) return;
          const { id, enabled } = event.payload;
          if (enabled) this.start(id).catch(() => {});
          else {
            this.loop.get(id)?.stop();
          }
        },
      );
    } catch { /* not in Tauri */ }
  }

  destroySync(): void {
    this.syncUnlisten?.();
    this.syncUnlisten = null;
  }

  private async emitToggle(id: string, enabled: boolean): Promise<void> {
    try {
      const { emit } = await import('@tauri-apps/api/event');
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      await emit('watcher-toggle', { id, enabled, sourceLabel: getCurrentWebviewWindow().label });
    } catch { /* not in Tauri */ }
  }

  /** 为 ScreenChangeWatcher 设置 region 持久化回调 */
  private wireRegionPersistence(task: Tickable, id: string): void {
    if ('setOnRegionResolved' in task && typeof task.setOnRegionResolved === 'function') {
      (task as unknown as ScreenChangeWatcher).setOnRegionResolved(async (region: ScreenRegion, monitorTarget?: MonitorTarget) => {
        const patch: Partial<WatcherConfig> = { region };
        if (monitorTarget) patch.monitorTarget = monitorTarget;
        let config = this.configStore.get(id);
        if (config) {
          const updated = { ...config, ...patch, updatedAt: Math.floor(Date.now() / 1000) };
          if (updated.monitorTarget?.windowHwnd) delete updated.monitorTarget.windowHwnd;
          await storeWatcherConfig(updated);
          this.configStore.set(id, updated);
        }
      });
    }
  }

  /** 为 ScreenChangeWatcher 设置执行完成回调（持久化 lastExecution） */
  private wireExecutionComplete(task: Tickable, id: string): void {
    if ('setOnExecutionComplete' in task && typeof task.setOnExecutionComplete === 'function') {
      (task as unknown as ScreenChangeWatcher).setOnExecutionComplete(async (success: boolean, summary: string) => {
        let config = this.configStore.get(id);
        if (config) {
          const updated = {
            ...config,
            lastExecution: {
              timestamp: Date.now(),
              success,
              summary,
              turnsCount: 0,
            },
            updatedAt: Math.floor(Date.now() / 1000),
          };
          if (updated.monitorTarget?.windowHwnd) delete updated.monitorTarget.windowHwnd;
          await storeWatcherConfig(updated);
          this.configStore.set(id, updated);
          const taskConfig = migrateWatcherConfig(updated);
          const task = this.loop.get(id);
          if (task && 'updateConfig' in task) {
            (task as unknown as { updateConfig(c: TaskConfig): void }).updateConfig(taskConfig);
          }
        }
      });
    }
  }

  /** 为 ScreenChangeWatcher 设置工作流模板学习回调 */
  private wireWorkflowTemplate(task: Tickable, id: string): void {
    if ('setOnWorkflowLearned' in task && typeof task.setOnWorkflowLearned === 'function') {
      (task as unknown as ScreenChangeWatcher).setOnWorkflowLearned(async (template: WorkflowStep[]) => {
        let config = this.configStore.get(id);
        if (config) {
          const updated = { ...config, workflowTemplate: template, updatedAt: Math.floor(Date.now() / 1000) };
          if (updated.monitorTarget?.windowHwnd) delete updated.monitorTarget.windowHwnd;
          await storeWatcherConfig(updated);
          this.configStore.set(id, updated);
          const taskConfig = migrateWatcherConfig(updated);
          const task = this.loop.get(id);
          if (task && 'updateConfig' in task) {
            (task as unknown as { updateConfig(c: TaskConfig): void }).updateConfig(taskConfig);
          }
        }
      });
    }
  }

  async create(config: WatcherConfig): Promise<void> {
    // windowHwnd 是运行时值，不持久化
    if (config.monitorTarget?.windowHwnd) {
      delete config.monitorTarget.windowHwnd;
    }
    await storeWatcherConfig(config);
    this.configStore.set(config.id, config);

    const taskConfig = migrateWatcherConfig(config);
    const task = createTask(taskConfig);
    this.wireRegionPersistence(task, config.id);
    this.wireWorkflowTemplate(task, config.id);
    this.wireExecutionComplete(task, config.id);

    this.loop.add(task);
    if (config.enabled) {
      await task.start();
    }

    if (config.enabled) {
      await this.emitToggle(config.id, true);
    }

    this.emitStateChange(config.id, 'created');
  }

  /** 手动触发区域重新定位 */
  async reResolveRegion(id: string): Promise<void> {
    const task = this.loop.get(id);
    if (!task || !('reResolveRegion' in task)) return;
    try {
      await (task as unknown as ScreenChangeWatcher).reResolveRegion();
    } catch { /* ignore */ }
  }

  async start(id: string): Promise<void> {
    const task = this.loop.get(id);
    if (task) {
      await task.start();
    } else {
      // Task not in loop — try loading from DB
      const configs = await getAllWatcherConfigs();
      const config = configs.find(c => c.id === id);
      if (config) {
        this.configStore.set(id, config);
        const taskConfig = migrateWatcherConfig(config);
        const newTask = createTask(taskConfig);
        this.wireRegionPersistence(newTask, id);
        this.wireWorkflowTemplate(newTask, id);
        this.wireExecutionComplete(newTask, id);
        this.loop.add(newTask);
        if (config.enabled) {
          await newTask.start();
        }
      }
    }
  }

  pause(id: string): void {
    this.loop.get(id)?.stop();
  }

  resume(id: string): void {
    this.loop.get(id)?.start();
  }

  async remove(id: string): Promise<void> {
    this.loop.remove(id);
    this.configStore.delete(id);
    await deleteWatcherConfig(id);
    await this.emitToggle(id, false);
    this.emitStateChange(id, 'removed');
  }

  async update(id: string, patch: Partial<WatcherConfig>): Promise<void> {
    let config = this.configStore.get(id);

    if (!config) {
      const configs = await getAllWatcherConfigs();
      config = configs.find(c => c.id === id);
      if (!config) return;
    }

    const updated: WatcherConfig = { ...config, ...patch, updatedAt: Math.floor(Date.now() / 1000) };
    // windowHwnd 是运行时值（每次启动都变），不能持久化
    if (updated.monitorTarget?.windowHwnd) {
      delete updated.monitorTarget.windowHwnd;
    }
    await storeWatcherConfig(updated);
    this.configStore.set(id, updated);

    const task = this.loop.get(id);
    if (task) {
      const taskConfig = migrateWatcherConfig(updated);
      if ('updateConfig' in task) {
        (task as unknown as { updateConfig(c: TaskConfig): void }).updateConfig(taskConfig);
      }

      if (patch.enabled !== undefined) {
        if (patch.enabled) {
          await task.start();
        } else {
          task.stop();
        }
        await this.emitToggle(id, patch.enabled);
      }
    } else {
      const taskConfig = migrateWatcherConfig(updated);
      const newTask = createTask(taskConfig);
      this.wireRegionPersistence(newTask, id);
      this.wireWorkflowTemplate(newTask, id);
      this.loop.add(newTask);
      if (patch.enabled !== undefined) {
        await this.emitToggle(id, patch.enabled);
      }
    }

    this.emitStateChange(id, 'updated');
  }

  getStates(): Array<{ config: WatcherConfig; state: WatcherState }> {
    const result: Array<{ config: WatcherConfig; state: WatcherState }> = [];
    for (const task of this.loop.getAll()) {
      const wc = this.configStore.get(task.id);
      if (!wc) continue;
      result.push({
        config: wc,
        state: {
          configId: task.id,
          status: task.state.status as WatcherState['status'],
          lastCheckAt: task.state.lastCheckAt,
          lastTriggerAt: task.state.lastTriggerAt,
          triggerCount: task.state.triggerCount,
          lastError: task.state.lastError,
          baseline: '',
          queueSize: 0,
          queueItems: [],
          processing: false,
        },
      });
    }
    return result;
  }

  async restore(): Promise<void> {
    const configs = await getAllWatcherConfigs();
    let restored = 0;

    // Start the tick loop
    this.loop.start();

    for (const config of configs) {
      this.configStore.set(config.id, config);
      const taskConfig = migrateWatcherConfig(config);
      const task = createTask(taskConfig);
      this.wireRegionPersistence(task, config.id);
      this.wireWorkflowTemplate(task, config.id);
    this.wireExecutionComplete(task, config.id);

      this.loop.add(task);
      if (config.enabled) {
        await task.start();
        restored++;
      }
    }

    if (restored > 0) {
      appEventBus.emit({
        source: 'watcher', type: 'manager_restore', level: 'info',
        message: `已恢复 ${restored} 个任务`, timestamp: Date.now(),
      });
    }
  }

  private emitStateChange(id: string, action: string): void {
    appEventBus.emit({
      source: 'watcher', type: 'manager_action', level: 'info',
      message: `Task ${action}: ${id}`, sourceId: id, timestamp: Date.now(),
    });
  }
}

export const watcherManager = new WatcherManager();
