// Screen change trigger — wraps ScreenChangeEventSource as a Trigger.
// Encapsulates all screenshot + diff detection logic behind the generic Trigger interface.

import type { Trigger, TriggerResult } from './trigger';
import type { ScreenChangeTriggerConfig } from '@/types/scheduler';
import type { ScreenRegion, MonitorTarget } from '@/types/watcher';
import type { WatcherRuntimeState } from './watcher-runtime-state';
import type { AppEventLevel } from '@/types/events';
import { ScreenChangeEventSource } from './screen-change-source';
import { appEventBus } from '@/services/event-bus';

export class ScreenChangeTrigger implements Trigger {
  private source: ScreenChangeEventSource;
  private taskName: string;
  private runtime: WatcherRuntimeState;

  constructor(
    taskName: string,
    config: ScreenChangeTriggerConfig,
    runtime: WatcherRuntimeState,
    actionType?: string,
    toolFilter?: Set<string>,
  ) {
    this.taskName = taskName;
    this.runtime = runtime;
    this.source = new ScreenChangeEventSource(taskName, config, runtime, actionType, toolFilter);
    this.source.setEmitter((type, level, message, data) => {
      appEventBus.emit({
        source: 'watcher', type, level: level as AppEventLevel,
        message, timestamp: Date.now(),
        sourceName: taskName, data,
      });
    });
  }

  async resolve(): Promise<void> {
    await this.source.resolveRegion();
  }

  async check(): Promise<TriggerResult | null> {
    const event = await this.source.check();
    if (!event) return null;
    // 给 agent 全窗口截图（能看到标题栏确认是哪个窗口），裁剪图只用于 diff 检测
    let fullWindowSnapshot = event.current;
    const hwnd = this.runtime.hwnd;
    if (hwnd > 0) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        fullWindowSnapshot = await invoke<string>('screenshot_window', { hwnd });
      } catch {
        // fallback to cropped region
      }
    }
    return {
      snapshot: fullWindowSnapshot,
      diffDetail: event.diffDetail,
      variables: {
        snapshot: fullWindowSnapshot,
        diff: event.diffDetail ?? '',
        ocr: event.diffDetail ?? '',
      },
    };
  }

  dispose(): void {
    this.source.dispose();
  }

  /** 设置 region 持久化回调 */
  setOnRegionResolved(cb: (region: ScreenRegion, monitorTarget?: MonitorTarget) => void): void {
    this.source.setOnRegionResolved(cb);
  }

  /** 手动触发区域重新定位 */
  async reResolveRegion(): Promise<ScreenRegion> {
    return this.source.reResolveRegion();
  }

  /** 获取底层 source（供 WatcherManager 需要时访问） */
  getSource(): ScreenChangeEventSource {
    return this.source;
  }
}
