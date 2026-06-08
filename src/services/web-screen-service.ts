// 来源: lib/services/web_screen_service_web.dart
// Iframe backend for communicating with generated apps

import type { IWebScreenService } from '@/interfaces/web-screen-service';

interface PendingCall {
  resolve: (value: Record<string, unknown>) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ActionPayload {
  type: string;
  id: string;
  [key: string]: unknown;
}

class WebScreenService implements IWebScreenService {
  private _iframe: HTMLIFrameElement | null = null;
  private _cid = 0;
  private _pending = new Map<string, PendingCall>();
  private _listener: ((event: MessageEvent) => void) | null = null;

  get hasIframe(): boolean {
    return this._iframe !== null;
  }

  register(iframe: HTMLIFrameElement): void {
    this._iframe = iframe;

    if (this._listener) {
      window.removeEventListener('message', this._listener);
    }

    this._listener = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      const id = data['id'] as string | undefined;
      if (!id) return;
      const pending = this._pending.get(id);
      if (!pending) return;

      this._pending.delete(id);
      clearTimeout(pending.timer);

      if (data['type'] === 'ui_result') {
        pending.resolve({ nodes: (data['nodes'] as unknown[]) ?? [] });
      } else if (data['type'] === 'action_result') {
        pending.resolve({
          ok: data['ok'] === true,
          info: data['info'],
          message: data['message'] as string | undefined,
        });
      } else {
        pending.resolve({});
      }
    };

    window.addEventListener('message', this._listener);
  }

  unregister(): void {
    this._iframe = null;
    if (this._listener) {
      window.removeEventListener('message', this._listener);
      this._listener = null;
    }
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      p.resolve({ ok: false, error: 'Unregistered' });
      this._pending.delete(id);
    }
  }

  private _post(data: ActionPayload): void {
    this._iframe?.contentWindow?.postMessage(data, '*');
  }

  private _send(type: string, extra?: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `wsc_${++this._cid}`;

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        resolve({ ok: false, error: 'Timeout communicating with app' });
      }, 5000);

      this._pending.set(id, { resolve, timer });

      const payload: ActionPayload = { type, id };
      if (extra) Object.assign(payload, extra);
      this._post(payload);
    });
  }

  async getUI(): Promise<Record<string, unknown> | null> {
    if (!this._iframe) return null;
    return this._send('get_ui');
  }

  async click(x: number, y: number): Promise<Record<string, unknown>> {
    return this._send('do_click', { x, y });
  }

  async typeText(text: string): Promise<Record<string, unknown>> {
    return this._send('do_type', { text });
  }

  async scroll(dx: number, dy: number): Promise<Record<string, unknown>> {
    return this._send('do_scroll', { dx, dy });
  }
}

export const webScreenService = new WebScreenService();
