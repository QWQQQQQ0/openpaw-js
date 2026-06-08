/**
 * Web Recorder Service
 *
 * Manages a Playwright-controlled browser for DOM event recording.
 * Captures full semantic info (tag, text, selector, role, name) from web pages,
 * converts to SemanticEvent and merges with the global listener events.
 */

import { desktopService } from './desktop-service';
import type { SemanticEvent, EventContext } from '@/types/semantic-event';
import type { UnifiedAction } from '@/types/unified-action';
import type { UnifiedElement } from '@/types/unified-element';

/** Raw DOM event from the Python engine */
interface DomEvent {
  type: string;
  timestamp: number;
  x: number;
  y: number;
  element?: {
    tag: string;
    text: string;
    selector: string;
    role: string;
    name: string;
    bounds: { x: number; y: number; width: number; height: number };
  } | null;
  key?: string;
  modifiers?: string[];
  value?: string;
  url?: string;
  title?: string;
}

type EventCallback = (event: SemanticEvent) => void;

class WebRecorder {
  private _isBrowserOpen = false;
  private _isRecording = false;
  private _isPaused = false;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _eventCallbacks: Set<EventCallback> = new Set();

  get isBrowserOpen(): boolean {
    return this._isBrowserOpen;
  }

  get isRecording(): boolean {
    return this._isRecording;
  }

  get isPaused(): boolean {
    return this._isPaused;
  }

  /** Register a callback to receive web recorder events */
  onEvent(callback: EventCallback): () => void {
    this._eventCallbacks.add(callback);
    return () => this._eventCallbacks.delete(callback);
  }

  /** Open the controlled Chromium browser (headed mode) */
  async openBrowser(channel?: string): Promise<void> {
    if (this._isBrowserOpen) return;
    const result = await desktopService.webPwLaunch(false, channel);
    if (!result.launched) {
      throw new Error(String(result.error || 'Failed to launch browser'));
    }
    this._isBrowserOpen = true;
  }

  /** Navigate to a URL */
  async navigate(url: string): Promise<void> {
    if (!this._isBrowserOpen) throw new Error('Browser not open');
    await desktopService.webPwNavigate(url);
  }

  /** Start DOM event recording in the controlled browser */
  async startRecording(): Promise<void> {
    if (!this._isBrowserOpen) throw new Error('Browser not open');
    if (this._isRecording) return;

    const result = await desktopService.webPwStartRecording();
    if (!result.recording) {
      throw new Error(String(result.error || 'Failed to start recording'));
    }

    this._isRecording = true;
    this._isPaused = false;

    // Start polling for events
    this._pollTimer = setInterval(() => {
      if (!this._isPaused) {
        this.pollEvents();
      }
    }, 300);
  }

  /** Pause event collection (events still captured in Python, just not pulled) */
  pauseRecording(): void {
    this._isPaused = true;
  }

  /** Resume event collection */
  async resumeRecording(): Promise<void> {
    this._isPaused = false;
    // 丢弃暂停期间积累的事件，避免把暂停时的操作混入录制
    try {
      await desktopService.webPwGetRecordedEvents();
    } catch {
      // ignore
    }
  }

  /** Stop recording and return all remaining events */
  async stopRecording(): Promise<SemanticEvent[]> {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }

    this._isRecording = false;
    this._isPaused = false;

    // Get remaining events from Python
    const result = await desktopService.webPwStopRecording();
    const rawEvents = (result.events || []) as DomEvent[];
    const semanticEvents = rawEvents.map(e => this.toSemanticEvent(e));

    console.log(`[WebRecorder] Recording stopped, ${semanticEvents.length} events captured`);
    return semanticEvents;
  }

  /** Poll for new events from the Python engine */
  private async pollEvents(): Promise<void> {
    try {
      const result = await desktopService.webPwGetRecordedEvents();
      const rawEvents = (result.events || []) as DomEvent[];
      for (const raw of rawEvents) {
        const event = this.toSemanticEvent(raw);
        for (const cb of this._eventCallbacks) {
          try { cb(event); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore poll errors */ }
  }

  /** Close the controlled browser */
  async closeBrowser(): Promise<void> {
    if (this._isRecording) {
      await this.stopRecording();
    }
    if (this._isBrowserOpen) {
      await desktopService.webPwClose();
      this._isBrowserOpen = false;
    }
  }

  /** Convert a raw DOM event from Python to a SemanticEvent */
  private toSemanticEvent(raw: DomEvent): SemanticEvent {
    const action = this.buildAction(raw);
    const element = this.buildElement(raw);
    const context: EventContext = {
      windowTitle: raw.title || '',
      pageUrl: raw.url || '',
      platform: 'dom',
    };

    return {
      id: crypto.randomUUID(),
      timestamp: raw.timestamp || Date.now(),
      action,
      element,
      context,
    };
  }

  private buildAction(raw: DomEvent): UnifiedAction {
    switch (raw.type) {
      case 'click':
        return {
          type: 'click',
          target: {
            coordinate: { x: raw.x, y: raw.y },
          },
          params: { modifiers: raw.modifiers || [] },
        };
      case 'dblclick':
        return {
          type: 'double_click',
          target: {
            coordinate: { x: raw.x, y: raw.y },
          },
        };
      case 'contextmenu':
        return {
          type: 'right_click',
          target: {
            coordinate: { x: raw.x, y: raw.y },
          },
        };
      case 'keydown': {
        const mods = raw.modifiers || [];
        return {
          type: mods.length > 0 ? 'hotkey' : 'key',
          params: {
            key: this.buildKeyString(raw.key || '', mods),
            rawKey: raw.key,
            modifiers: mods,
          },
        };
      }
      case 'input':
        return {
          type: 'type',
          params: { value: raw.value || '' },
        };
      default:
        return { type: 'custom' };
    }
  }

  private buildElement(raw: DomEvent): UnifiedElement | null {
    if (!raw.element) return null;

    const el = raw.element;
    return {
      identity: {
        role: this.mapTagToRole(el.tag, el.role),
        name: el.name || el.text || '',
      },
      location: {
        semanticPath: [],
        bounds: el.bounds ? {
          x: el.bounds.x,
          y: el.bounds.y,
          width: el.bounds.width,
          height: el.bounds.height,
        } : undefined,
        precisePath: el.selector || undefined,
      },
      raw: {
        platform: 'dom',
        data: {
          tag: el.tag,
          text: el.text,
          selector: el.selector,
          role: el.role,
          name: el.name,
        },
      },
    };
  }

  private mapTagToRole(tag: string, ariaRole: string): string {
    if (ariaRole) return ariaRole;
    switch (tag) {
      case 'button': return 'button';
      case 'a': return 'link';
      case 'input': return 'textbox';
      case 'select': return 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return 'img';
      default: return tag;
    }
  }

  private buildKeyString(key: string, modifiers: string[]): string {
    const parts = [...modifiers];
    if (key && !modifiers.includes(key)) {
      parts.push(key);
    }
    return parts.join('+');
  }
}

export const webRecorder = new WebRecorder();
