// 来源: lib/services/desktop/desktop_native_service.dart
// Frontend wrapper for Tauri Rust desktop automation commands

import { isTauri } from '@/utils/platform';
import type { IDesktopService, WindowInfo, AppInfo } from '@/interfaces/desktop-service';

// Re-export types for backward compatibility
export type { WindowInfo, AppInfo } from '@/interfaces/desktop-service';

const tauriApi = {
  screenshot: async (): Promise<string> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('desktop_screenshot');
  },
  screenshotWindow: async (hwnd: number): Promise<string> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('screenshot_window', { hwnd });
  },
  listWindows: async (): Promise<WindowInfo[]> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<WindowInfo[]>('desktop_list_windows');
  },
  focusWindow: async (hwnd: number): Promise<boolean> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('desktop_focus_window', { hwnd });
  },
  minimizeWindow: async (hwnd: number): Promise<boolean> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('desktop_minimize_window', { hwnd });
  },
  maximizeWindow: async (hwnd: number): Promise<boolean> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('desktop_maximize_window', { hwnd });
  },
  closeWindow: async (hwnd: number): Promise<boolean> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('desktop_close_window', { hwnd });
  },
  resizeWindow: async (hwnd: number, width: number, height: number): Promise<boolean> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<boolean>('desktop_resize_window', { hwnd, width, height });
  },
  getClipboard: async (): Promise<string> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string>('desktop_get_clipboard');
  },
  setClipboard: async (text: string): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_set_clipboard', { text });
  },
  getWindowBounds: async (hwnd: number): Promise<{ x: number; y: number; width: number; height: number }> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('get_window_bounds', { hwnd });
  },
  click: async (x: number, y: number): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_click', { x, y });
  },
  doubleClick: async (x: number, y: number): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_double_click', { x, y });
  },
  rightClick: async (x: number, y: number): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_right_click', { x, y });
  },
  typeText: async (text: string): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_type_text', { text });
  },
  pressKey: async (key: string): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_press_key', { key });
  },
  scroll: async (x: number, y: number, delta: number): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_scroll', { x, y, delta });
  },
  moveMouse: async (x: number, y: number): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_move_mouse', { x, y });
  },
  middleClick: async (x: number, y: number): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_middle_click', { x, y });
  },
  mouseDown: async (x: number, y: number, button?: string): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_mouse_down', { x, y, button: button ?? null });
  },
  mouseUp: async (x: number, y: number, button?: string): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_mouse_up', { x, y, button: button ?? null });
  },
  drag: async (startX: number, startY: number, endX: number, endY: number, durationMs?: number, button?: string): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_drag', {
      startX, startY, endX, endY,
      durationMs: durationMs ?? null,
      button: button ?? null,
    });
  },
  moveCursor: async (waypoints: number[][], durationMs?: number, holdButton?: string): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_move_cursor', {
      waypoints: waypoints.map(([x, y]) => ({ x, y })),
      durationMs: durationMs ?? null,
      holdButton: holdButton ?? null,
    });
  },
  keyDown: async (key: string): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_key_down', { key });
  },
  keyUp: async (key: string): Promise<void> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke('desktop_key_up', { key });
  },
  listApps: async (): Promise<AppInfo[]> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<AppInfo[]>('desktop_list_apps');
  },
  openApp: async (name: string): Promise<number> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<number>('desktop_open_app', { name });
  },
  findApp: async (name: string): Promise<string | null> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string | null>('desktop_find_app', { name });
  },
  findAppByWindowTitle: async (windowTitle: string): Promise<string | null> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<string | null>('desktop_find_app_by_title', { windowTitle });
  },
  refreshApps: async (): Promise<number> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<number>('desktop_refresh_apps');
  },
  // ── Python UIA bridge (Phase 1) ──
  uiaGetInteractive: async (
    window_hwnd?: number,
    filters?: { roles?: string[]; name_keyword?: string; onscreen_only?: boolean; limit?: number },
  ): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('uia_get_interactive', {
      windowHwnd: window_hwnd ?? null,
      roles: filters?.roles ?? null,
      nameKeyword: filters?.name_keyword ?? null,
      onscreenOnly: filters?.onscreen_only ?? null,
      limit: filters?.limit ?? null,
    });
  },
  uiaClick: async (role: string, name?: string, window_hwnd?: number): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('uia_click', { role, name: name ?? null, windowHwnd: window_hwnd ?? null });
  },
  uiaTypeText: async (text: string, role?: string, name?: string, window_hwnd?: number): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('uia_type_text', { text, role: role ?? null, name: name ?? null, windowHwnd: window_hwnd ?? null });
  },
  uiaFindElement: async (role: string, name?: string, window_hwnd?: number): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('uia_find_element', { role, name: name ?? null, windowHwnd: window_hwnd ?? null });
  },
  uiaGetProperty: async (role: string, name: string | undefined, property: string, window_hwnd?: number): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('uia_get_property', { role, name: name ?? null, property, windowHwnd: window_hwnd ?? null });
  },
  uiaFingerprint: async (window_hwnd?: number): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('uia_fingerprint', { windowHwnd: window_hwnd ?? null });
  },
  // ── Phase 5: Browser (Playwright) ──
  webPwLaunch: async (headless?: boolean, channel?: string): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('web_launch', { headless: headless ?? null, channel: channel ?? null });
  },
  webPwNavigate: async (url: string): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('web_navigate', { url });
  },
  webPwGetInteractive: async (): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('web_get_interactive');
  },
  webPwClickSelector: async (selector: string): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('web_click_selector', { selector });
  },
  webPwClickRole: async (role: string, name?: string): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('web_click_role', { role, name: name ?? null });
  },
  webPwFill: async (selector: string, text: string): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('web_fill', { selector, text });
  },
  webPwScroll: async (deltaY?: number): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('web_scroll', { delta_y: deltaY ?? null });
  },
  webPwClose: async (): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('web_close');
  },
  webPwStartRecording: async (): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('web_start_recording');
  },
  webPwStopRecording: async (): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('web_stop_recording');
  },
  webPwGetRecordedEvents: async (): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('web_get_recorded_events');
  },
  // ── Phase 5: Screenshot (mss) + OCR ──
  screenshotV2: async (): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('screenshot_full');
  },
  screenshotRegionV2: async (left: number, top: number, width: number, height: number): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('screenshot_region', { left, top, width, height });
  },
  ocrRecognize: async (imageBase64?: string): Promise<Record<string, unknown>> => {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<Record<string, unknown>>('ocr_recognize', { image_base64: imageBase64 ?? null, image_path: null });
  },
};

type DesktopApi = typeof tauriApi;

const fallbackError = 'Desktop API not available outside Tauri desktop environment';

const fallback = {
  screenshot: async () => { throw new Error(fallbackError); },
  screenshotWindow: async () => { throw new Error(fallbackError); },
  getWindowBounds: async () => { throw new Error(fallbackError); },
  screenshotV2: async () => { throw new Error(fallbackError); },
  screenshotRegionV2: async () => { throw new Error(fallbackError); },
  ocrRecognize: async () => { throw new Error(fallbackError); },
  listWindows: async () => { throw new Error(fallbackError); },
  focusWindow: async () => { throw new Error(fallbackError); },
  minimizeWindow: async () => { throw new Error(fallbackError); },
  maximizeWindow: async () => { throw new Error(fallbackError); },
  closeWindow: async () => { throw new Error(fallbackError); },
  resizeWindow: async () => { throw new Error(fallbackError); },
  getClipboard: async () => { throw new Error(fallbackError); },
  setClipboard: async () => { throw new Error(fallbackError); },
  click: async () => { throw new Error(fallbackError); },
  doubleClick: async () => { throw new Error(fallbackError); },
  rightClick: async () => { throw new Error(fallbackError); },
  middleClick: async () => { throw new Error(fallbackError); },
  mouseDown: async () => { throw new Error(fallbackError); },
  mouseUp: async () => { throw new Error(fallbackError); },
  drag: async () => { throw new Error(fallbackError); },
  moveCursor: async () => { throw new Error(fallbackError); },
  typeText: async () => { throw new Error(fallbackError); },
  pressKey: async () => { throw new Error(fallbackError); },
  keyDown: async () => { throw new Error(fallbackError); },
  keyUp: async () => { throw new Error(fallbackError); },
  scroll: async () => { throw new Error(fallbackError); },
  moveMouse: async () => { throw new Error(fallbackError); },
  listApps: async () => { throw new Error(fallbackError); },
  openApp: async () => { throw new Error(fallbackError); },
  findApp: async () => { throw new Error(fallbackError); },
  findAppByWindowTitle: async () => { throw new Error(fallbackError); },
  refreshApps: async () => { throw new Error(fallbackError); },
  uiaGetInteractive: async () => { throw new Error(fallbackError); },
  uiaClick: async () => { throw new Error(fallbackError); },
  uiaTypeText: async () => { throw new Error(fallbackError); },
  uiaFindElement: async () => { throw new Error(fallbackError); },
  uiaGetProperty: async () => { throw new Error(fallbackError); },
  uiaFingerprint: async () => { throw new Error(fallbackError); },
  webPwLaunch: async () => { throw new Error(fallbackError); },
  webPwNavigate: async () => { throw new Error(fallbackError); },
  webPwGetInteractive: async () => { throw new Error(fallbackError); },
  webPwClickSelector: async () => { throw new Error(fallbackError); },
  webPwClickRole: async () => { throw new Error(fallbackError); },
  webPwFill: async () => { throw new Error(fallbackError); },
  webPwScroll: async () => { throw new Error(fallbackError); },
  webPwClose: async () => { throw new Error(fallbackError); },
  webPwStartRecording: async () => { throw new Error(fallbackError); },
  webPwStopRecording: async () => { throw new Error(fallbackError); },
  webPwGetRecordedEvents: async () => { throw new Error(fallbackError); },
} as DesktopApi;

export const desktopService: IDesktopService = isTauri() ? tauriApi : fallback;
