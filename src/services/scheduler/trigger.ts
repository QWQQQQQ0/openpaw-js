// Trigger interface — pluggable trigger detection for watchers.
// Each watcher type implements its own Trigger (screen diff, timer, file watch, etc.).
// The tick loop doesn't care how detection works; it just calls check().

export interface TriggerResult {
  /** 截图 base64（屏幕类提供，timer 类不需要） */
  snapshot?: string;
  /** 变化描述（diff detail / OCR text 等） */
  diffDetail?: string;
  /** 注入 action 的模板变量 */
  variables?: Record<string, string>;
}

export interface Trigger {
  /** 初始化（首次截图、区域发现、建立连接等）。start() 时调用。 */
  resolve(): Promise<void>;
  /** 每次 tick 调用。返回 null 表示无变化，返回 TriggerResult 表示命中。 */
  check(): Promise<TriggerResult | null>;
  /** 释放资源。stop() 时调用。 */
  dispose(): void;
}
