import type { SemanticEvent, EventTag, EventStats } from './semantic-event';
import type { DataFlow } from './unified-data';
import type { AutomationTemplate } from './automation-template';

/**
 * 录制会话 —— 包含一次录制的所有事件
 */
export interface RecordingSession {
  id: string;
  startTime: number;
  endTime?: number;
  status: 'recording' | 'paused' | 'completed' | 'cancelled';
  events: SemanticEvent[];

  // ── 元数据 ──
  metadata: RecordingMetadata;
}

/**
 * 录制元数据
 */
export interface RecordingMetadata {
  userDescription?: string;            // 用户对这次录制的描述
  detectedPattern?: DetectedPattern;   // LLM 检测到的模式
  generatedTemplate?: AutomationTemplate; // 生成的模板
  dataFlow?: DataFlow;                 // 识别的数据流
  stats?: EventStats;                  // 事件统计

  // 自定义元数据
  [key: string]: unknown;
}

/**
 * 检测到的模式
 */
export interface DetectedPattern {
  type: PatternType;
  confidence: number;                  // 置信度 0-1
  description: string;                 // 模式描述

  // 循环相关
  loopVariable?: string;               // 循环变量名
  loopSource?: string;                 // 循环数据源
  loopBody?: SemanticEvent[];          // 循环体事件
  loopCount?: number;                  // 循环次数

  // 条件相关
  condition?: string;                  // 条件表达式
  thenBranch?: SemanticEvent[];
  elseBranch?: SemanticEvent[];

  // 数据流相关
  dataFlow?: DataFlow;
}

/**
 * 模式类型
 */
export type PatternType =
  | 'linear'                           // 线性执行，无循环
  | 'loop'                             // 存在循环
  | 'conditional'                      // 存在条件分支
  | 'mixed'                            // 混合模式
  | 'unknown';                         // 未知模式

/**
 * 模式类型常量
 */
export const PATTERN_TYPE = {
  LINEAR: 'linear',
  LOOP: 'loop',
  CONDITIONAL: 'conditional',
  MIXED: 'mixed',
  UNKNOWN: 'unknown',
} as const;

/**
 * 录制配置
 */
export interface RecordingConfig {
  description?: string;                // 录制描述
  captureScreenshot?: boolean;         // 是否捕获截图
  captureContext?: boolean;            // 是否捕获上下文
  autoTag?: boolean;                   // 是否自动标记
  platforms?: string[];                // 启用的平台
  excludeActions?: string[];           // 排除的动作类型
  maxEvents?: number;                  // 最大事件数
  timeout?: number;                    // 超时时间 (ms)
}

/**
 * 录制状态
 */
export interface RecordingState {
  isRecording: boolean;
  isPaused: boolean;
  session: RecordingSession | null;
  currentEvent: SemanticEvent | null;
  eventCount: number;
  duration: number;
}

/**
 * 录制事件
 */
export type RecordingEventType =
  | 'start'                            // 录制开始
  | 'stop'                             // 录制停止
  | 'pause'                            // 录制暂停
  | 'resume'                           // 录制恢复
  | 'event'                            // 新事件
  | 'event-remove'                     // 事件移除（去重）
  | 'event-loading'                    // 事件加载中
  | 'event-loading-end'                // 事件加载结束
  | 'tag'                              // 事件标记
  | 'undo'                             // 撤销
  | 'tick'                             // 计时器
  | 'error';                           // 错误

/**
 * 录制事件回调
 */
export type RecordingCallback = (type: RecordingEventType, data?: unknown) => void;
