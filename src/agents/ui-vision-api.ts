// UIVisionAgent — UI 视觉分析 Agent API
// 涵盖：截图分析（识别交互元素）、语义标注生成、OCR 元素分类
// 请求通过 Vite 中间件后端 → 统一 LlmExecutor → 外部 LLM

import type { ProviderConfig } from '@/types/provider';
import type { VisionElement, SemanticAnnotation } from '@/types/cache';
import type { InteractiveNode } from '@/types/cache';
import { AgentEndpoint } from '@/api/types';
import { apiPost } from '@/api/client';

export class UIVisionAgent {
  /** 分析截图，识别交互元素（UIA 不可用时兜底） */
  async analyzeScreenshot(params: {
    screenshotBase64: string;
    goal: string;
    provider: ProviderConfig;
    apiKey: string;
    windowTitle?: string;
    existingAnnotations?: string;
  }): Promise<VisionElement[]> {
    return apiPost<VisionElement[]>(
      AgentEndpoint.uiVisionAnalyze,
      params.provider,
      params.apiKey,
      {
        screenshotBase64: params.screenshotBase64,
        goal: params.goal,
        windowTitle: params.windowTitle,
        existingAnnotations: params.existingAnnotations,
      },
    );
  }

  /** 生成 UI 元素的语义标注 */
  async annotateElements(params: {
    elements: InteractiveNode[];
    goal: string;
    provider: ProviderConfig;
    apiKey: string;
  }): Promise<SemanticAnnotation[]> {
    return apiPost<SemanticAnnotation[]>(
      AgentEndpoint.uiVisionAnnotate,
      params.provider,
      params.apiKey,
      { elements: params.elements, goal: params.goal },
    );
  }

  /** OCR 元素分类 */
  async classifyOcrElements(params: {
    ocrItems: Array<{ text: string; bbox: { left: number; top: number; right: number; bottom: number } }>;
    goal: string;
    provider: ProviderConfig;
    apiKey: string;
  }): Promise<VisionElement[]> {
    return apiPost<VisionElement[]>(
      AgentEndpoint.uiVisionOcrClassify,
      params.provider,
      params.apiKey,
      { ocrItems: params.ocrItems, goal: params.goal },
    );
  }
}
