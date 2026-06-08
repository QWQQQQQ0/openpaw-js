// API Client barrel export
export { AgentEndpoint } from './types';
export type {
  SSEEvent, SSETextEvent, SSEToolsEvent, SSEErrorEvent, SSEDoneEvent,
  AgentRequestBody, AgentResponseBody,
  IntentClassifierParams, VerificationParams, ChatParams,
  CodeGenerationParams, CodeIterationParams,
  UIVisionAnalyzeParams, UIVisionAnnotateParams, UIVisionOcrClassifyParams,
  ScreenAnalysisDiffParams, ScreenAnalysisRegionsParams,
  ScreenAnalysisOcrParams, ScreenAnalysisInterruptionParams,
  DesktopAutomationParams,
} from './types';
export { apiPost, apiStream, apiStreamCompat, setApiBaseUrl, getApiBaseUrl } from './client';
