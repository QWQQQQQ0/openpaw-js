// WatcherRuntimeState — 集中管理 watcher 任务的运行时状态。
// 解决 windowHwnd 散落在 config 各处、每个路径都要 backfill 的问题。
// Task 和 Source 共享同一个实例，hwnd 变化只需更新一处。

import type { MonitorTarget, ScreenRegion } from '@/types/watcher';
import type { WindowInfo } from '@/interfaces/desktop-service';

export class WatcherRuntimeState {
  /** 当前有效的窗口 hwnd（0 = 未定位） */
  private _hwnd = 0;
  /** 当前有效的 appName（窗口标题，用于 L1 缓存和 desktop_open_app） */
  private _appName = '';
  /** 已解析的截图区域（窗口相对坐标） */
  resolvedRegion: ScreenRegion | null = null;
  /** baseline 截图 */
  baseline = '';
  /** 窗口是否已失效（hwnd 找不到对应窗口） */
  windowLost = false;

  private monitorTarget: MonitorTarget;
  private taskName: string;
  private _disposed = false;

  constructor(taskName: string, monitorTarget: MonitorTarget) {
    this.taskName = taskName;
    this.monitorTarget = monitorTarget;
    // 从 config 初始化已有的值
    this._hwnd = monitorTarget.windowHwnd ?? 0;
    this._appName = monitorTarget.appName ?? '';
  }

  get hwnd(): number { return this._hwnd; }
  get appName(): string { return this._appName; }
  get disposed(): boolean { return this._disposed; }

  dispose(): void {
    this._disposed = true;
  }

  /** 更新 hwnd（应用重启、窗口切换时调用） */
  setHwnd(hwnd: number): void {
    if (hwnd > 0 && hwnd !== this._hwnd) {
      this._hwnd = hwnd;
      this.windowLost = false;
      // 同步回 monitorTarget（其他地方可能读）
      if (this.monitorTarget.type === 'window') {
        this.monitorTarget.windowHwnd = hwnd;
      }
    }
  }

  /** 更新 appName */
  setAppName(name: string): void {
    if (name && name !== this._appName) {
      this._appName = name;
      this.monitorTarget.appName = name;
    }
  }

  /**
   * 确保 hwnd 有效。按优先级尝试：
   * 1. 已有 hwnd → 验证窗口存在
   * 2. 按 windowTitle 从窗口列表匹配
   * 3. 按 appName 调 desktop_open_app
   * 返回是否成功获取到有效 hwnd。
   */
  async ensureHwnd(): Promise<boolean> {
    if (this._disposed) return false;

    // 1. 已有 hwnd → 验证
    if (this._hwnd > 0) {
      const exists = await this.verifyHwnd(this._hwnd);
      if (exists) {
        return true;
      }
      this._hwnd = 0;
      this.windowLost = true;
    }

    // 2. 从窗口列表按 title 匹配
    if (this.monitorTarget.windowTitle) {
      const win = await this.findWindowByTitle(this.monitorTarget.windowTitle);
      if (win) {
        this.setHwnd(win.hwnd);
        if (!this._appName) this.setAppName(win.title || win.app_name);
        return true;
      }
    }

    // 3. desktop_open_app
    if (this._appName || this.monitorTarget.windowTitle) {
      const appName = this._appName || this.monitorTarget.windowTitle!;
      const hwnd = await this.openApp(appName);
      if (hwnd > 0) {
        this.setHwnd(hwnd);
        return true;
      }
    }

    return false;
  }

  /** 同步到 monitorTarget（持久化前调用） */
  syncToMonitorTarget(): MonitorTarget {
    return {
      ...this.monitorTarget,
      windowHwnd: this._hwnd || this.monitorTarget.windowHwnd,
      appName: this._appName || this.monitorTarget.appName,
    };
  }

  // ── 内部方法 ──

  private async verifyHwnd(hwnd: number): Promise<boolean> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const bounds = await invoke<{ width: number; height: number }>('get_window_bounds', { hwnd });
      return bounds.width > 0 && bounds.height > 0;
    } catch {
      return false;
    }
  }

  private async findWindowByTitle(title: string): Promise<WindowInfo | null> {
    try {
      const { desktopService } = await import('@/services/desktop-service');
      const windows = await desktopService.listWindows();
      return windows.find(w =>
        w.title.includes(title) || title.includes(w.title)
      ) ?? null;
    } catch {
      return null;
    }
  }

  private async openApp(name: string): Promise<number> {
    try {
      const { getBuiltinExecutor } = await import('@/skills/builtin-executor');
      const executor = getBuiltinExecutor();
      const result = await executor.executeToolCall('desktop_open_app', { name });
      const data = result?.data as Record<string, unknown> | undefined;
      return Number(data?.['hwnd'] ?? 0);
    } catch {
      return 0;
    }
  }
}
