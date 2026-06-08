/**
 * 统一 UI 元素 —— 所有平台都映射到这个模型
 *
 * 设计原则：
 * 1. 语义优先：role + name 用于匹配
 * 2. 路径备用：xpath/css 用于精确查找
 * 3. 坐标兜底：bounds 用于最后定位
 * 4. 结构感知：container + position 用于理解上下文
 */
export interface UnifiedElement {
  // ── 语义标识（用于匹配） ──
  identity: {
    role: string;                      // 通用角色: button, cell, row, text, listitem...
    name: string;                      // 元素名称/内容
    description?: string;              // 描述
  };

  // ── 位置信息（用于定位） ──
  location: {
    // 语义路径（优先）
    semanticPath: SemanticPathSegment[];
    // 精确路径（备用）
    precisePath?: string;              // xpath, css selector, UIA path
    // 坐标（最后兜底）
    bounds?: BoundingRect;
  };

  // ── 数据结构（用于理解上下文） ──
  structure?: {
    container?: {                      // 所属容器
      role: string;                    // table, list, tree, grid...
      name?: string;
      columns?: string[];              // 表格列名
      rows?: number;                   // 行数
    };
    position?: {                       // 在容器中的位置
      row?: number;
      column?: number;
      index?: number;
    };
  };

  // ── 平台原始信息（用于深度处理） ──
  raw?: {
    platform: 'dom' | 'uia' | 'accessibility' | 'global' | 'custom';
    data: Record<string, unknown>;     // 平台特有数据
  };
}

/**
 * 语义路径段 —— 描述元素在 UI 树中的位置
 */
export interface SemanticPathSegment {
  role: string;
  name?: string;
  index?: number;                      // 同级同 role 中的索引
}

/**
 * 边界矩形
 */
export interface BoundingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 常用 UI 角色常量
 */
export const UI_ROLE = {
  // 基础交互
  BUTTON: 'button',
  LINK: 'link',
  TEXTBOX: 'textbox',
  CHECKBOX: 'checkbox',
  RADIO: 'radio',
  COMBOBOX: 'combobox',
  LISTBOX: 'listbox',
  SLIDER: 'slider',
  SWITCH: 'switch',

  // 容器
  TABLE: 'table',
  GRID: 'grid',
  LIST: 'list',
  TREE: 'tree',
  TAB_LIST: 'tablist',
  TAB: 'tab',
  TAB_ITEM: 'tabitem',
  PANEL: 'panel',
  DIALOG: 'dialog',
  WINDOW: 'window',
  FORM: 'form',
  GROUP: 'group',

  // 表格
  ROW: 'row',
  CELL: 'cell',
  COLUMN_HEADER: 'columnheader',
  ROW_HEADER: 'rowheader',

  // 列表
  LIST_ITEM: 'listitem',
  TREE_ITEM: 'treeitem',

  // 文本
  HEADING: 'heading',
  LABEL: 'label',
  PARAGRAPH: 'paragraph',
  TEXT: 'text',

  // 媒体
  IMAGE: 'image',
  VIDEO: 'video',
  AUDIO: 'audio',

  // 导航
  MENU: 'menu',
  MENU_BAR: 'menubar',
  MENU_ITEM: 'menuitem',
  TOOLBAR: 'toolbar',
  BREADCRUMB: 'breadcrumb',
  NAVIGATION: 'navigation',

  // 状态
  PROGRESS_BAR: 'progressbar',
  STATUS: 'status',
  ALERT: 'alert',
  TOOLTIP: 'tooltip',

  // 其他
  SEPARATOR: 'separator',
  APPLICATION: 'application',
  DOCUMENT: 'document',
  CALENDAR: 'calendar',
  SCROLLBAR: 'scrollbar',
  SPINBUTTON: 'spinbutton',
  UNKNOWN: 'unknown',
} as const;

export type UIRole = typeof UI_ROLE[keyof typeof UI_ROLE];
