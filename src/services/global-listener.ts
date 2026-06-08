/**
 * 全局事件监听服务
 *
 * 通过 Python bridge (pynput) 全局键盘/鼠标钩子捕获跨应用事件，
 * 支持拖动、滚轮、修饰键追踪。
 */

import { isTauri } from '@/utils/platform';
import type { SemanticEvent, EventContext } from '@/types/semantic-event';
import type { UnifiedAction } from '@/types/unified-action';
import type { UnifiedElement } from '@/types/unified-element';
import { UI_ROLE } from '@/types/unified-element';

/**
 * 全局输入事件（来自 Python pynput 引擎）
 */
export interface GlobalInputEvent {
  event_type:
    | 'mouse_click'
    | 'mouse_double_click'
    | 'mouse_right_click'
    | 'mouse_drag_start'
    | 'mouse_drag_end'
    | 'mouse_scroll'
    | 'key_down'
    | 'key_up';
  x: number;
  y: number;
  key?: string;
  modifiers: string[];
  hwnd: number;
  window_title: string;
  timestamp: number;
  // scroll 专属
  scroll_dx?: number;
  scroll_dy?: number;
}

/**
 * 全局事件回调
 */
export type GlobalEventCallback = (event: GlobalInputEvent) => void;

/**
 * 全局事件监听器
 */
class GlobalListener {
  private isRunning = false;
  private callbacks: Set<GlobalEventCallback> = new Set();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInterval = 100; // ms

  /**
   * 启动全局监听（通过 Python bridge）
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    if (!isTauri()) {
      throw new Error('Global listener requires Tauri environment');
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');

      // 启动 Python 端的 pynput 监听
      await invoke('global_listener_start');

      // 开始轮询事件
      this.pollTimer = setInterval(() => {
        this.pollEvents();
      }, this.pollInterval);

      this.isRunning = true;
    } catch (error) {
      throw error;
    }
  }

  /**
   * 停止全局监听
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }

      if (isTauri()) {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('global_listener_stop');
      }

      this.isRunning = false;
    } catch (error) {
      throw error;
    }
  }

  /**
   * 是否正在运行
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * 注册回调
   */
  onEvent(callback: GlobalEventCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /**
   * 轮询 Python bridge 获取事件
   */
  private async pollEvents(): Promise<void> {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const result = await invoke<{ events: GlobalInputEvent[]; count: number }>(
        'global_listener_poll',
        { maxEvents: 100 },
      );

      if (result.events && result.events.length > 0) {
        for (const event of result.events) {
          this.handleEvent(event);
        }
      }
    } catch (error) {
      // 忽略轮询错误（bridge 可能正在初始化）
    }
  }

  /**
   * 处理事件
   */
  private handleEvent(event: GlobalInputEvent): void {
    // 通知所有回调
    for (const callback of this.callbacks) {
      try {
        callback(event);
      } catch { /* ignore */ }
    }
  }

  /**
   * 将全局事件转换为语义化事件（含 UIA 元素信息）
   */
  async toSemanticEvent(event: GlobalInputEvent): Promise<SemanticEvent> {
    const action = this.buildAction(event);

    const context = {
      windowTitle: event.window_title,
      windowHwnd: event.hwnd,
      platform: 'global' as const,
    };

    // 尝试获取 UIA 元素信息
    let element: UnifiedElement | null = null;
    try {
      element = await this.getElementAtPoint(event.x, event.y, event.hwnd);
    } catch { /* ignore */ }

    return {
      id: crypto.randomUUID(),
      timestamp: event.timestamp,
      action,
      element,
      context,
    };
  }

  /**
   * 构建动作
   */
  private buildAction(event: GlobalInputEvent): UnifiedAction {
    switch (event.event_type) {
      case 'mouse_click':
        return {
          type: 'click',
          target: { coordinate: { x: event.x, y: event.y } },
          params: { modifiers: event.modifiers },
        };

      case 'mouse_double_click':
        return {
          type: 'double_click',
          target: { coordinate: { x: event.x, y: event.y } },
        };

      case 'mouse_right_click':
        return {
          type: 'right_click',
          target: { coordinate: { x: event.x, y: event.y } },
        };

      case 'mouse_drag_start':
        return {
          type: 'drag',
          target: { coordinate: { x: event.x, y: event.y } },
          params: {
            phase: 'start',
            button: event.key || 'left',
            modifiers: event.modifiers,
          },
        };

      case 'mouse_drag_end':
        return {
          type: 'drag',
          target: { coordinate: { x: event.x, y: event.y } },
          params: {
            phase: 'end',
            button: event.key || 'left',
            modifiers: event.modifiers,
          },
        };

      case 'mouse_scroll':
        return {
          type: 'scroll',
          target: { coordinate: { x: event.x, y: event.y } },
          params: {
            direction: (event.scroll_dy ?? 0) < 0 ? 'down' : 'up',
            delta: Math.abs(event.scroll_dy ?? 0),
            modifiers: event.modifiers,
          },
        };

      case 'key_down': {
        // Combine modifiers + key into a single combo string (e.g. "Alt+a")
        const combo = event.modifiers.length > 0
          ? [...event.modifiers, event.key].join('+')
          : event.key;
        return {
          type: event.modifiers.length > 0 ? 'hotkey' : 'key',
          params: {
            key: combo,
            modifiers: event.modifiers,
          },
        };
      }

      case 'key_up':
        return {
          type: 'key_up',
          params: {
            key: event.key,
            modifiers: event.modifiers,
          },
        };

      default:
        return { type: event.event_type as UnifiedAction['type'] };
    }
  }

  /**
   * 获取指定坐标的元素（带超时）
   */
  async getElementAtPoint(x: number, y: number, hwnd: number, timeoutMs: number = 2000): Promise<UnifiedElement | null> {
    if (!isTauri()) {
      return null;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');

      const timeoutPromise = new Promise<null>((resolve) => {
        setTimeout(() => {
          resolve(null);
        }, timeoutMs);
      });

      const uiaPromise = invoke<any>('uia_find_element_at_point', { x, y, hwnd });
      const result = await Promise.race([uiaPromise, timeoutPromise]);

      if (result) {
        return {
          identity: {
            role: result.role || UI_ROLE.UNKNOWN,
            name: result.name || '',
            description: result.description,
          },
          location: {
            semanticPath: [],
            bounds: result.bounds ? {
              x: result.bounds.left,
              y: result.bounds.top,
              width: result.bounds.right - result.bounds.left,
              height: result.bounds.bottom - result.bounds.top,
            } : undefined,
          },
          raw: {
            platform: 'uia',
            data: result,
          },
        };
      }
    } catch { /* ignore */ }

    // 返回基本信息
    return {
      identity: { role: 'unknown', name: '' },
      location: {
        semanticPath: [],
        bounds: { x, y, width: 0, height: 0 },
      },
      raw: { platform: 'global', data: { hwnd } },
    };
  }
}

// 导出单例
export const globalListener = new GlobalListener();
