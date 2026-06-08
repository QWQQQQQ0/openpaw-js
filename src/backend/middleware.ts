// Agent API 中间件 —— 请求路由 + JSON/SSE 响应。
// 可挂载到 Vite dev server 或独立 Node HTTP server。

import type { IncomingMessage, ServerResponse } from 'node:http';
import { AgentEndpoint } from '../api/types';
import type { AgentRequestBody, AgentResponseBody } from '../api/types';
import {
  handleIntentClassifier,
  handleVerification,
  handleChat,
  handleCodeGeneration,
  handleCodeIteration,
  handleUIVisionAnalyze,
  handleUIVisionAnnotate,
  handleUIVisionOcrClassify,
  handleScreenAnalysisDiff,
  handleScreenAnalysisRegions,
  handleScreenAnalysisOcr,
  handleScreenAnalysisInterruption,
  handleDesktopAutomation,
  handleDesktopAutomationTools,
} from './handlers';

// ── 路由表：端点 → handler → 是否流式 ──

interface RouteEntry {
  handler: (provider: import('@/types/provider').ProviderConfig, apiKey: string, params: unknown) => unknown;
  streaming: boolean;
}

type HandlerFn = (provider: import('@/types/provider').ProviderConfig, apiKey: string, params: unknown) => unknown;

const routes: Record<string, RouteEntry> = {
  [AgentEndpoint.intentClassifier]:           { handler: handleIntentClassifier as HandlerFn,        streaming: true },
  [AgentEndpoint.verification]:               { handler: handleVerification as HandlerFn,            streaming: false },
  [AgentEndpoint.chat]:                       { handler: handleChat as HandlerFn,                    streaming: true },
  [AgentEndpoint.codeGeneration]:             { handler: handleCodeGeneration as HandlerFn,          streaming: true },
  [AgentEndpoint.codeIteration]:              { handler: handleCodeIteration as HandlerFn,           streaming: true },
  [AgentEndpoint.uiVisionAnalyze]:            { handler: handleUIVisionAnalyze as HandlerFn,         streaming: false },
  [AgentEndpoint.uiVisionAnnotate]:           { handler: handleUIVisionAnnotate as HandlerFn,        streaming: false },
  [AgentEndpoint.uiVisionOcrClassify]:        { handler: handleUIVisionOcrClassify as HandlerFn,     streaming: false },
  [AgentEndpoint.screenAnalysisDiff]:         { handler: handleScreenAnalysisDiff as HandlerFn,      streaming: false },
  [AgentEndpoint.screenAnalysisRegions]:      { handler: handleScreenAnalysisRegions as HandlerFn,   streaming: false },
  [AgentEndpoint.screenAnalysisOcr]:          { handler: handleScreenAnalysisOcr as HandlerFn,       streaming: false },
  [AgentEndpoint.screenAnalysisInterruption]: { handler: handleScreenAnalysisInterruption as HandlerFn, streaming: false },
  [AgentEndpoint.desktopAutomation]:          { handler: handleDesktopAutomation as HandlerFn,       streaming: true },
  [AgentEndpoint.desktopAutomationTools]:     { handler: handleDesktopAutomationTools as HandlerFn,  streaming: true },
};

// ── 请求体解析 ──

async function parseBody(req: IncomingMessage): Promise<AgentRequestBody> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString('utf-8');
        resolve(JSON.parse(body) as AgentRequestBody);
      } catch (e) {
        reject(new Error(`Invalid JSON body: ${e}`));
      }
    });
    req.on('error', reject);
  });
}

// ── JSON 响应 ──

function sendJson(res: ServerResponse, status: number, body: AgentResponseBody): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ── SSE 响应 ──

function sendSSE(res: ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
}

function sendSSEEvent(res: ServerResponse, event: Record<string, unknown>): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ── 主入口：处理请求 ──

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = req.url ?? '';
  const method = req.method?.toUpperCase() ?? '';

  // 只处理 POST 请求
  if (method !== 'POST') return false;

  // 匹配路由
  const route = routes[url];
  if (!route) return false;

  try {
    const body = await parseBody(req);
    const { provider, apiKey, params } = body;

    if (!provider || !apiKey) {
      sendJson(res, 400, { ok: false, error: 'Missing provider or apiKey' });
      return true;
    }

    if (route.streaming) {
      // 流式响应 (SSE)
      sendSSE(res);

      try {
        const stream = route.handler(provider, apiKey, params) as AsyncGenerator<string>;
        for await (const chunk of stream) {
          if (chunk.startsWith('__TOOLS__:')) {
            try {
              const tools = JSON.parse(chunk.substring(10));
              sendSSEEvent(res, { type: 'tools', content: tools });
            } catch {
              sendSSEEvent(res, { type: 'text', content: chunk });
            }
          } else if (chunk.startsWith('__ERROR__:')) {
            sendSSEEvent(res, { type: 'error', content: chunk.substring(10) });
          } else if (chunk.startsWith('__REASONING__:')) {
            // reasoning 内容 → 作为 reasoning 类型发送，前端可选消费
            sendSSEEvent(res, { type: 'reasoning', content: chunk.substring(14) });
          } else {
            sendSSEEvent(res, { type: 'text', content: chunk });
          }
        }
        sendSSEEvent(res, { type: 'done' });
      } catch (e) {
        sendSSEEvent(res, { type: 'error', content: String(e) });
        sendSSEEvent(res, { type: 'done' });
      }
      res.end();
    } else {
      // 非流式响应 (JSON)
      try {
        const data = await (route.handler(provider, apiKey, params) as Promise<unknown>);
        sendJson(res, 200, { ok: true, data });
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String(e) });
      }
    }
  } catch (e) {
    sendJson(res, 400, { ok: false, error: String(e) });
  }

  return true;
}
