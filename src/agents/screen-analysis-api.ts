// ScreenAnalysisAgent — 屏幕分析 Agent API
// 涵盖：差异检测分析、区域自动发现、OCR 区域发现
// 请求通过 Vite 中间件后端 → 统一 LlmExecutor → 外部 LLM

import type { ProviderConfig } from '@/types/provider';
import { AgentEndpoint } from '@/api/types';
import { apiPost } from '@/api/client';

export interface DiffAnalysisResult {
  changed: boolean;
  description: string;
  confidence: number;
}

export interface RegionDiscoveryResult {
  regions: Array<{
    description: string;
    x: number;
    y: number;
    width: number;
    height: number;
    label: string;
  }>;
}

export class ScreenAnalysisAgent {
  /** 差异分析 —— 判断两张截图之间是否有语义上有意义的变化 */
  async analyzeDiff(params: {
    beforeScreenshot: string;
    afterScreenshot: string;
    goal: string;
    provider: ProviderConfig;
    apiKey: string;
  }): Promise<DiffAnalysisResult> {
    return apiPost<DiffAnalysisResult>(
      AgentEndpoint.screenAnalysisDiff,
      params.provider,
      params.apiKey,
      { beforeScreenshot: params.beforeScreenshot, afterScreenshot: params.afterScreenshot, goal: params.goal },
    );
  }

  /** 区域发现 —— 从截图中自动识别监控区域 */
  async discoverRegions(params: {
    screenshot: string;
    goal: string;
    provider: ProviderConfig;
    apiKey: string;
  }): Promise<RegionDiscoveryResult> {
    return apiPost<RegionDiscoveryResult>(
      AgentEndpoint.screenAnalysisRegions,
      params.provider,
      params.apiKey,
      { screenshot: params.screenshot, goal: params.goal },
    );
  }

  /** OCR 区域标注 */
  async analyzeOcrTexts(params: {
    ocrTexts: string[];
    goal: string;
    provider: ProviderConfig;
    apiKey: string;
  }): Promise<string> {
    const result = await apiPost<{ analysis: string }>(
      AgentEndpoint.screenAnalysisOcr,
      params.provider,
      params.apiKey,
      { ocrTexts: params.ocrTexts, goal: params.goal },
    );
    return result.analysis;
  }

  /** 工作流分析 —— 分析录制的中断步骤 */
  async analyzeInterruption(params: {
    screenshot: string;
    goal: string;
    completedSteps: string[];
    provider: ProviderConfig;
    apiKey: string;
  }): Promise<string> {
    const result = await apiPost<{ decision: string }>(
      AgentEndpoint.screenAnalysisInterruption,
      params.provider,
      params.apiKey,
      { screenshot: params.screenshot, goal: params.goal, completedSteps: params.completedSteps },
    );
    return result.decision;
  }
}
