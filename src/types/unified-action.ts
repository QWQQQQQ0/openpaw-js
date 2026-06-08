import type { SemanticPathSegment, BoundingRect } from './unified-element';

/**
 * 统一动作 —— 所有操作都映射到这个模型
 */
export interface UnifiedAction {
  type: ActionType;
  target?: ActionTarget;
  params?: Record<string, unknown>;
  description?: string;
}

/**
 * 动作类型 —— 通用操作
 */
export type ActionType =
  // 基础交互
  | 'click'                            // 点击
  | 'double_click'                     // 双击
  | 'right_click'                      // 右键
  | 'hover'                            // 悬停

  // 输入
  | 'type'                             // 输入文本
  | 'key'                              // 按键
  | 'hotkey'                           // 组合键

  // 导航
  | 'scroll'                           // 滚动
  | 'drag'                             // 拖动
  | 'drag'                             // 拖拽
  | 'focus'                            // 聚焦

  // 数据
  | 'copy'                             // 复制
  | 'paste'                            // 粘贴
  | 'cut'                              // 剪切
  | 'select'                           // 选择

  // 等待
  | 'wait'                             // 等待
  | 'wait_for'                         // 等待条件

  // 流程控制
  | 'loop_start'                       // 循环开始
  | 'loop_end'                         // 循环结束
  | 'if'                               // 条件
  | 'break'                            // 跳出
  | 'continue'                         // 继续

  // 代码执行
  | 'code'                             // 执行自定义代码

  // 自定义
  | 'custom';                          // 自定义操作

/**
 * 动作目标 —— 通用目标描述
 */
export interface ActionTarget {
  // 方式1: 语义定位（优先）
  semantic?: {
    role: string;
    name: string | TemplateExpression;
    path?: SemanticPathSegment[];
  };

  // 方式2: 路径定位
  path?: string;                       // xpath, css selector, etc.

  // 方式3: 坐标定位（兜底）
  coordinate?: {
    x: number | TemplateExpression;
    y: number | TemplateExpression;
  };

  // 方式4: 变量引用
  variable?: string;                   // 引用循环变量或参数
}

/**
 * 模板表达式 —— 支持参数引用和简单计算
 *
 * 示例:
 * - "{{item.name}}"           - 引用参数
 * - "{{index + 1}}"           - 简单计算
 * - "{{list[{{index}}].name}}" - 嵌套引用
 */
export type TemplateExpression = string;

/**
 * 动作类型常量
 */
export const ACTION_TYPE = {
  // 基础交互
  CLICK: 'click',
  DOUBLE_CLICK: 'double_click',
  RIGHT_CLICK: 'right_click',
  HOVER: 'hover',

  // 输入
  TYPE: 'type',
  KEY: 'key',
  HOTKEY: 'hotkey',

  // 导航
  SCROLL: 'scroll',
  DRAG: 'drag',
  DRAG: 'drag',
  FOCUS: 'focus',

  // 数据
  COPY: 'copy',
  PASTE: 'paste',
  CUT: 'cut',
  SELECT: 'select',

  // 等待
  WAIT: 'wait',
  WAIT_FOR: 'wait_for',

  // 流程控制
  LOOP_START: 'loop_start',
  LOOP_END: 'loop_end',
  IF: 'if',
  BREAK: 'break',
  CONTINUE: 'continue',

  // 代码执行
  CODE: 'code',

  // 自定义
  CUSTOM: 'custom',
} as const;

/**
 * 常用组合键
 */
export const HOTKEYS = {
  COPY: 'Ctrl+c',
  PASTE: 'Ctrl+v',
  CUT: 'Ctrl+x',
  UNDO: 'Ctrl+z',
  REDO: 'Ctrl+y',
  SELECT_ALL: 'Ctrl+a',
  SAVE: 'Ctrl+s',
  OPEN: 'Ctrl+o',
  NEW: 'Ctrl+n',
  FIND: 'Ctrl+f',
  REPLACE: 'Ctrl+h',
  CLOSE: 'Ctrl+w',
  TAB: 'Tab',
  ENTER: 'Enter',
  ESCAPE: 'Escape',
  DELETE: 'Delete',
  BACKSPACE: 'Backspace',
} as const;
