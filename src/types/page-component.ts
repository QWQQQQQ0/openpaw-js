/** 触发方式 — 从父组件打开子组件的方式 */
export interface TriggerInfo {
  type: 'click' | 'hotkey' | 'menu' | 'hover' | 'other';
  detail: string;       // 如 "点击菜单栏的「插入」tab"
  elementRef?: {        // 触发元素在父页面中的定位
    label?: string;
    name?: string;
    automationId?: string;
  };
}

/** 页面组件 — 对应 ui_cache 的一行，描述一个可识别的页面/状态 */
export interface PageComponent {
  fingerprint: string;              // 主键，复用现有 fingerprint
  appId: string;                    // app_name
  name: string;                     // 页面名称，如 "Excel-插入"
  parentFingerprint: string | null; // 父组件 fingerprint，顶层为 null
  trigger: TriggerInfo | null;      // 从父组件打开本页的方式
  capabilities: string[];           // 语义能力摘要列表
}
