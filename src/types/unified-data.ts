import type { ActionTarget } from './unified-action';

/**
 * 统一数据描述 —— 描述数据的来源、结构、目标
 */
export interface DataFlow {
  source: DataSource;
  target: DataTarget;
  mapping: FieldMapping[];
}

/**
 * 数据源
 */
export interface DataSource {
  type: 'table' | 'list' | 'tree' | 'form' | 'custom';
  location: ActionTarget;              // 指向数据容器
  fields: DataField[];                 // 数据字段
  sample?: Record<string, unknown>[];  // 样本数据（用于 LLM 分析）
}

/**
 * 数据目标
 */
export interface DataTarget {
  type: 'table' | 'list' | 'form' | 'input' | 'custom';
  location: ActionTarget;
  fields: DataField[];
}

/**
 * 数据字段
 */
export interface DataField {
  name: string;                        // 字段名
  type: DataFieldType;                 // 字段类型
  location?: ActionTarget;             // 字段在 UI 中的位置
  description?: string;                // 字段描述
}

/**
 * 数据字段类型
 */
export type DataFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'time'
  | 'datetime'
  | 'boolean'
  | 'image'
  | 'link'
  | 'email'
  | 'phone'
  | 'address'
  | 'currency'
  | 'percentage'
  | 'custom';

/**
 * 字段映射
 */
export interface FieldMapping {
  source: string;                      // 源字段名
  target: string;                      // 目标字段名
  transform?: string;                  // 转换规则（可选）
  description?: string;                // 映射描述
}

/**
 * 表格数据结构
 */
export interface TableData {
  headers: string[];                   // 表头
  rows: unknown[][];                   // 数据行
  metadata?: {
    totalRows?: number;
    totalColumns?: number;
    source?: string;                   // 数据来源
  };
}

/**
 * 列表数据结构
 */
export interface ListData {
  items: unknown[];                    // 列表项
  metadata?: {
    totalItems?: number;
    source?: string;
  };
}

/**
 * 树形数据结构
 */
export interface TreeData {
  nodes: TreeNode[];
  metadata?: {
    totalNodes?: number;
    maxDepth?: number;
    source?: string;
  };
}

/**
 * 树节点
 */
export interface TreeNode {
  id: string;
  label: string;
  value?: unknown;
  children?: TreeNode[];
  depth?: number;
  isLeaf?: boolean;
}

/**
 * 表单数据结构
 */
export interface FormData {
  fields: FormField[];
  metadata?: {
    formName?: string;
    formId?: string;
    source?: string;
  };
}

/**
 * 表单字段
 */
export interface FormField {
  name: string;
  label: string;
  type: DataFieldType;
  value?: unknown;
  required?: boolean;
  options?: unknown[];                 // 下拉选项等
}

/**
 * 数据类型常量
 */
export const DATA_TYPE = {
  TABLE: 'table',
  LIST: 'list',
  TREE: 'tree',
  FORM: 'form',
  CUSTOM: 'custom',
} as const;

/**
 * 字段类型常量
 */
export const FIELD_TYPE = {
  TEXT: 'text',
  NUMBER: 'number',
  DATE: 'date',
  TIME: 'time',
  DATETIME: 'datetime',
  BOOLEAN: 'boolean',
  IMAGE: 'image',
  LINK: 'link',
  EMAIL: 'email',
  PHONE: 'phone',
  ADDRESS: 'address',
  CURRENCY: 'currency',
  PERCENTAGE: 'percentage',
  CUSTOM: 'custom',
} as const;
