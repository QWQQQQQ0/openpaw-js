// Desktop Service Interface
// 定义桌面自动化服务的接口，Skill通过此接口获取桌面控制能力

export interface WindowInfo {
  hwnd: number;
  title: string;
  class_name: string;
  is_visible: boolean;
  process_id: number;
  app_name: string;  // 进程可执行文件名，如 "WeChat.exe"
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

export interface AppInfo {
  name: string;
  app_id: string;
  source: string;
  path: string;
}

export interface IDesktopService {
  // 基础桌面操作
  screenshot(): Promise<string>;
  screenshotWindow(hwnd: number): Promise<string>;
  getWindowBounds(hwnd: number): Promise<{ x: number; y: number; width: number; height: number }>;
  screenshotV2(): Promise<Record<string, unknown>>;
  screenshotRegionV2(left: number, top: number, width: number, height: number): Promise<Record<string, unknown>>;
  ocrRecognize(imageBase64?: string): Promise<Record<string, unknown>>;
  listWindows(): Promise<WindowInfo[]>;
  focusWindow(hwnd: number): Promise<boolean>;
  minimizeWindow(hwnd: number): Promise<boolean>;
  maximizeWindow(hwnd: number): Promise<boolean>;
  closeWindow(hwnd: number): Promise<boolean>;
  resizeWindow(hwnd: number, width: number, height: number): Promise<boolean>;
  getClipboard(): Promise<string>;
  setClipboard(text: string): Promise<void>;
  click(x: number, y: number): Promise<void>;
  doubleClick(x: number, y: number): Promise<void>;
  rightClick(x: number, y: number): Promise<void>;
  middleClick(x: number, y: number): Promise<void>;
  mouseDown(x: number, y: number, button?: string): Promise<void>;
  mouseUp(x: number, y: number, button?: string): Promise<void>;
  drag(startX: number, startY: number, endX: number, endY: number, durationMs?: number, button?: string): Promise<void>;
  moveCursor(waypoints: number[][], durationMs?: number, holdButton?: string): Promise<void>;
  typeText(text: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  scroll(x: number, y: number, delta: number): Promise<void>;
  moveMouse(x: number, y: number): Promise<void>;

  // 应用管理
  listApps(): Promise<AppInfo[]>;
  openApp(name: string): Promise<number>;
  findApp(name: string): Promise<string | null>;
  findAppByWindowTitle(windowTitle: string): Promise<string | null>;
  refreshApps(): Promise<number>;

  // UIA自动化
  uiaGetInteractive(
    window_hwnd?: number,
    filters?: { roles?: string[]; name_keyword?: string; onscreen_only?: boolean; limit?: number }
  ): Promise<Record<string, unknown>>;
  uiaClick(role: string, name?: string, window_hwnd?: number): Promise<Record<string, unknown>>;
  uiaTypeText(text: string, role?: string, name?: string, window_hwnd?: number): Promise<Record<string, unknown>>;
  uiaFindElement(role: string, name?: string, window_hwnd?: number): Promise<Record<string, unknown>>;
  uiaGetProperty(role: string, name: string | undefined, property: string, window_hwnd?: number): Promise<Record<string, unknown>>;
  uiaFingerprint(window_hwnd?: number): Promise<Record<string, unknown>>;

  // 浏览器自动化
  webPwLaunch(headless?: boolean, channel?: string): Promise<Record<string, unknown>>;
  webPwNavigate(url: string): Promise<Record<string, unknown>>;
  webPwGetInteractive(): Promise<Record<string, unknown>>;
  webPwClickSelector(selector: string): Promise<Record<string, unknown>>;
  webPwClickRole(role: string, name?: string): Promise<Record<string, unknown>>;
  webPwFill(selector: string, text: string): Promise<Record<string, unknown>>;
  webPwScroll(deltaY?: number): Promise<Record<string, unknown>>;
  webPwClose(): Promise<Record<string, unknown>>;
  webPwStartRecording(): Promise<Record<string, unknown>>;
  webPwStopRecording(): Promise<Record<string, unknown>>;
  webPwGetRecordedEvents(): Promise<Record<string, unknown>>;
}
