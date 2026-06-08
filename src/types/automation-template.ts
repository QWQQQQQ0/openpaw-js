import type { ActionTarget, TemplateExpression } from './unified-action';
import type { DataFlow } from './unified-data';

/**
 * 自动化模板 —— 最终生成的可执行流程
 */
export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  version: string;

  // ── 数据流定义 ──
  dataFlow?: DataFlow;

  // ── 参数定义 ──
  parameters: TemplateParameter[];

  // ── 执行步骤 ──
  steps: TemplateStep[];

  // ── 元数据 ──
  createdAt: number;
  updatedAt?: number;
  sourceSession: string;               // 来源录制会话 ID
  llmModel?: string;                   // 使用的 LLM 模型
  author?: string;                     // 作者
  tags?: string[];                     // 标签

  // ── 执行配置 ──
  config?: TemplateConfig;
}

/**
 * 模板参数
 */
export interface TemplateParameter {
  name: string;                        // 参数名
  description: string;                 // 参数描述
  type: ParameterType;                 // 参数类型
  required: boolean;
  defaultValue?: unknown;
  constraints?: ParameterConstraints;  // 参数约束
}

/**
 * 参数类型
 */
export type ParameterType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'element'                          // UI 元素
  | 'window'                           // 窗口
  | 'array'                            // 数组
  | 'object'                           // 对象
  | 'any';

/**
 * 参数约束
 */
export interface ParameterConstraints {
  min?: number;                        // 最小值（数字）/ 最小长度（字符串/数组）
  max?: number;                        // 最大值 / 最大长度
  pattern?: string;                    // 正则表达式（字符串）
  enum?: unknown[];                    // 枚举值
  format?: string;                     // 格式（日期、邮箱等）
}

/**
 * 模板步骤
 */
export interface TemplateStep {
  id: string;
  action: string;                      // 操作类型
  description: string;                 // 步骤描述

  // ── 目标定位（语义优先） ──
  target?: ActionTarget;

  // ── 操作参数 ──
  params?: Record<string, unknown | TemplateExpression>;

  // ── 流程控制 ──
  control?: FlowControl;

  // ── 等待/重试 ──
  waitBefore?: number;                 // 执行前等待 (ms)
  waitAfter?: number;                  // 执行后等待 (ms)
  retry?: RetryConfig;

  // ── 条件执行 ──
  condition?: string;                  // 执行条件表达式

  // ── 错误处理 ──
  onError?: 'stop' | 'continue' | 'retry' | 'skip';

  // ── 元数据 ──
  metadata?: Record<string, unknown>;
}

/**
 * 流程控制
 */
export type FlowControl =
  | { type: 'loop'; over: string; variable: string; body: string[] }
  | { type: 'if'; condition: string; then: string[]; else?: string[] }
  | { type: 'goto'; stepId: string }
  | { type: 'break' }
  | { type: 'continue' }
  | { type: 'exit'; message?: string };

/**
 * 重试配置
 */
export interface RetryConfig {
  maxAttempts: number;                 // 最大重试次数
  delay: number;                       // 重试间隔 (ms)
  backoff?: 'linear' | 'exponential';  // 退避策略
  retryOn?: string[];                  // 重试条件（错误类型）
}

/**
 * 模板配置
 */
export interface TemplateConfig {
  timeout?: number;                    // 整体超时 (ms)
  stepTimeout?: number;                // 单步超时 (ms)
  pauseOnError?: boolean;              // 出错时暂停
  dryRun?: boolean;                    // 试运行模式
  verbose?: boolean;                   // 详细日志
  screenshotOnError?: boolean;         // 出错时截图
}

/**
 * 模板执行状态
 */
export type TemplateStatus =
  | 'idle'                             // 空闲
  | 'running'                          // 运行中
  | 'paused'                           // 已暂停
  | 'completed'                        // 已完成
  | 'failed'                           // 失败
  | 'cancelled';                       // 已取消

/**
 * 模板执行上下文
 */
export interface TemplateExecutionContext {
  template: AutomationTemplate;
  params: Record<string, unknown>;
  variables: Record<string, unknown>;
  currentStepIndex: number;
  loopStack: LoopContext[];
  status: TemplateStatus;
  startTime: number;
  endTime?: number;
  error?: Error;
  logs: ExecutionLog[];
}

/**
 * 循环上下文
 */
export interface LoopContext {
  items: unknown[];
  currentIndex: number;
  variable: string;
  bodyStartIndex: number;
}

/**
 * 执行日志
 */
export interface ExecutionLog {
  timestamp: number;
  stepId: string;
  stepIndex: number;
  action: string;
  status: 'success' | 'failure' | 'skipped';
  message?: string;
  error?: string;
  duration?: number;
  screenshot?: string;
}

/**
 * 参数类型常量
 */
export const PARAMETER_TYPE = {
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  ELEMENT: 'element',
  WINDOW: 'window',
  ARRAY: 'array',
  OBJECT: 'object',
  ANY: 'any',
} as const;

/**
 * 模板状态常量
 */
export const TEMPLATE_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
} as const;
