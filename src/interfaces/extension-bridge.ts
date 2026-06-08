// Extension Bridge Interface
// 定义浏览器扩展桥接的接口

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

export interface IExtensionBridge {
  readonly isConnected: boolean;

  captureScreen(): Promise<Record<string, unknown>>;
  getDOM(tabId?: number): Promise<Record<string, unknown>>;
  executeAction(tabId: number | null, params: Record<string, unknown>): Promise<Record<string, unknown>>;
  switchTab(tabId: number): Promise<Record<string, unknown>>;
  listTabs(): Promise<Record<string, unknown>>;
  openURL(url: string): Promise<Record<string, unknown>>;
  showFloatingPanel(): Promise<void>;
  hideFloatingPanel(): Promise<void>;
}
