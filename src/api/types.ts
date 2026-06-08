// Agent API 协议 —— 前端 Agent APIs 和后端 Handler 共享的类型定义。
// 每个 Agent 端点有独立的 URL，后端统一通过 LlmExecutor 调外部 LLM。

import type { ProviderConfig } from '@/types/provider';
import type { LLMMessage, ToolCallResponse } from '@/types/message';

// ── Agent 端点枚举 ──

export enum AgentEndpoint {
  intentClassifier = '/api/agent/intent-classifier',
  verification = '/api/agent/verification',
  chat = '/api/agent/chat',
  codeGeneration = '/api/agent/code-generation',
  codeIteration = '/api/agent/code-iteration',
  uiVisionAnalyze = '/api/agent/ui-vision/analyze-screenshot',
  uiVisionAnnotate = '/api/agent/ui-vision/annotate-elements',
  uiVisionOcrClassify = '/api/agent/ui-vision/ocr-classify',
  screenAnalysisDiff = '/api/agent/screen-analysis/diff',
  screenAnalysisRegions = '/api/agent/screen-analysis/regions',
  screenAnalysisOcr = '/api/agent/screen-analysis/ocr',
  screenAnalysisInterruption = '/api/agent/screen-analysis/interruption',
  desktopAutomation = '/api/agent/desktop-automation',
  desktopAutomationTools = '/api/agent/desktop-automation/tools',
}

// ── SSE 流式事件 ──

export interface SSETextEvent {
  type: 'text';
  content: string;
}

export interface SSEToolsEvent {
  type: 'tools';
  content: ToolCallResponse['toolCalls'];
}

export interface SSEErrorEvent {
  type: 'error';
  content: string;
}

export interface SSEReasoningEvent {
  type: 'reasoning';
  content: string;
}

export interface SSEDoneEvent {
  type: 'done';
}

export type SSEEvent = SSETextEvent | SSEToolsEvent | SSEErrorEvent | SSEReasoningEvent | SSEDoneEvent;

// ── Agent 请求/响应 ──

export interface AgentRequestBody {
  provider: ProviderConfig;
  apiKey: string;
  params: Record<string, unknown>;
}

export interface AgentResponseBody<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

// ── 各 Agent 的 params 类型（前端调用时传入的额外参数） ──

export interface IntentClassifierParams {
  userInput: string;
}

export interface VerificationParams {
  goal: string;
  screenshotBase64: string;
  contextMessages?: LLMMessage[];
}

export interface ChatParams {
  messages: LLMMessage[];
  tools?: Record<string, unknown>[];
  goal?: string;
  systemPromptExtra?: string;
  skipCache?: boolean;
}

export interface CodeGenerationParams {
  prompt: string;
  context?: string;
}

export interface CodeIterationParams {
  code: string;
  error: string;
}

export interface UIVisionAnalyzeParams {
  screenshotBase64: string;
  goal: string;
  windowTitle?: string;
  existingAnnotations?: string;
}

export interface UIVisionAnnotateParams {
  elements: Record<string, unknown>[];
  goal: string;
}

export interface UIVisionOcrClassifyParams {
  ocrItems: Array<{ text: string; bbox: { left: number; top: number; right: number; bottom: number } }>;
  goal: string;
}

export interface ScreenAnalysisDiffParams {
  beforeScreenshot: string;
  afterScreenshot: string;
  goal: string;
}

export interface ScreenAnalysisRegionsParams {
  screenshot: string;
  goal: string;
}

export interface ScreenAnalysisOcrParams {
  ocrTexts: string[];
  goal: string;
}

export interface ScreenAnalysisInterruptionParams {
  screenshot: string;
  goal: string;
  completedSteps: string[];
}

export interface DesktopAutomationParams {
  messages: LLMMessage[];
  tools?: Record<string, unknown>[];
  goal: string;
  skipCache?: boolean;
}
