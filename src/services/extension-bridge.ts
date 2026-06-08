// 来源: lib/services/web_extension_bridge_web.dart

import type { IExtensionBridge, TabInfo } from '@/interfaces/extension-bridge';

// Re-export types for backward compatibility
export type { TabInfo } from '@/interfaces/extension-bridge';

type StateListener = (state: Record<string, unknown>) => void;
type CommandListener = (command: string) => void;

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class ExtensionBridge implements IExtensionBridge {
  private _stateListeners: StateListener[] = [];
  private _commandListeners: CommandListener[] = [];
  private _pending = new Map<string, PendingCall>();
  private _reqId = 0;
  private _isConnected = false;
  private _connectionCheckTimer: ReturnType<typeof setInterval> | null = null;

  get isConnected(): boolean {
    return this._isConnected;
  }

  init(): void {
    window.addEventListener('openpaw-response', ((event: CustomEvent) => {
      const detail = event.detail;
      if (!detail) return;
      const id = detail['id'] as string | undefined;
      if (!id) return;
      const pending = this._pending.get(id);
      if (!pending) return;
      this._pending.delete(id);
      clearTimeout(pending.timer);

      const error = detail['error'];
      if (error && typeof error === 'string' && error.length > 0) {
        pending.reject(new Error(error));
      } else {
        pending.resolve(detail['result']);
      }
    }) as EventListener);

    window.addEventListener('openpaw-state-changed', ((event: CustomEvent) => {
      const detail = event.detail;
      if (detail && typeof detail === 'object') {
        const state = detail as Record<string, unknown>;
        for (const listener of this._stateListeners) {
          listener(state);
        }
      }
    }) as EventListener);

    window.addEventListener('openpaw-command', ((event: CustomEvent) => {
      const detail = event.detail;
      if (detail && typeof detail === 'object') {
        const command = detail['command'] as string | undefined;
        if (command && command.length > 0) {
          for (const listener of this._commandListeners) {
            listener(command);
          }
        }
      }
    }) as EventListener);

    this._checkConnection();
    this._connectionCheckTimer = setInterval(() => this._checkConnection(), 5000);
  }

  private _checkConnection(): void {
    try {
      const ready = localStorage.getItem('__openpawReady');
      if (ready === 'true') {
        this._isConnected = true;
        return;
      }
    } catch { /* ignore */ }
  }

  onStateChanged(callback: StateListener): void {
    this._stateListeners.push(callback);
  }

  removeStateListener(callback: StateListener): void {
    const idx = this._stateListeners.indexOf(callback);
    if (idx >= 0) this._stateListeners.splice(idx, 1);
  }

  onCommand(callback: CommandListener): void {
    this._commandListeners.push(callback);
  }

  removeCommandListener(callback: CommandListener): void {
    const idx = this._commandListeners.indexOf(callback);
    if (idx >= 0) this._commandListeners.splice(idx, 1);
  }

  private _call(method: string, ...args: unknown[]): Promise<unknown> {
    const id = `r${++this._reqId}_${Date.now()}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Bridge call ${method} timed out`));
      }, 30000);

      this._pending.set(id, { resolve, reject, timer });

      try {
        window.dispatchEvent(new CustomEvent('openpaw-call', {
          detail: { id, method, args },
        }));
      } catch (e) {
        this._pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  private _toMap(value: unknown): Record<string, unknown> {
    if (value == null) return { success: false, error: 'Null result' };
    if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value === 'string') return { success: true, data: value };
    return { success: true, data: value };
  }

  async captureScreen(): Promise<Record<string, unknown>> {
    try {
      return this._toMap(await this._call('captureScreen'));
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async getDOM(tabId?: number): Promise<Record<string, unknown>> {
    try {
      return this._toMap(await this._call('getDOM', tabId));
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async executeAction(tabId: number | null, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      return this._toMap(await this._call('executeAction', tabId, params));
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async switchTab(tabId: number): Promise<Record<string, unknown>> {
    try {
      return this._toMap(await this._call('switchTab', tabId));
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async listTabs(): Promise<Record<string, unknown>> {
    try {
      return this._toMap(await this._call('listTabs'));
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async openURL(url: string): Promise<Record<string, unknown>> {
    try {
      return this._toMap(await this._call('openURL', url));
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }

  async showFloatingPanel(): Promise<void> {
    try {
      await this._call('showFloatingPanel');
    } catch { /* ignore */ }
  }

  async hideFloatingPanel(): Promise<void> {
    try {
      await this._call('hideFloatingPanel');
    } catch { /* ignore */ }
  }

  dispose(): void {
    for (const [id, pending] of this._pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Disposed'));
      this._pending.delete(id);
    }
    this._stateListeners.length = 0;
    this._commandListeners.length = 0;
    if (this._connectionCheckTimer !== null) {
      clearInterval(this._connectionCheckTimer);
      this._connectionCheckTimer = null;
    }
  }
}

export const extensionBridge = new ExtensionBridge();
