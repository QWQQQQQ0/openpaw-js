// Web Screen Service Interface
// 定义Web屏幕服务的接口（用于iframe通信）

export interface IWebScreenService {
  readonly hasIframe: boolean;

  getUI(): Promise<Record<string, unknown> | null>;
  click(x: number, y: number): Promise<Record<string, unknown>>;
  typeText(text: string): Promise<Record<string, unknown>>;
  scroll(dx: number, dy: number): Promise<Record<string, unknown>>;
}
