// Agent 缓存辅助：L1 节点获取、L2 存储、工具转换、L3 提升

import { invoke } from '@tauri-apps/api/core';
import type { AgentDeps, AgentTurn, ToolCallInfo } from './agent-types';
import type { InteractiveNode, SemanticAction, SemanticAnnotation, UIFingerprint, VisionElement } from '@/types/cache';
import type { ProviderConfig } from '@/types/provider';
import { matchGoal } from '@/core/skill-resolver';
import { maybePromoteToSkill } from '@/core/skill-learner';
import { annotatePage } from '@/services/semantic-annotation-service';
import { PageKnowledgeService } from '@/services/page-knowledge';
import type { LLMAbstractor } from '@/core/skill-learner';
import { UIVisionAgent } from '@/agents/ui-vision-api';
import { AgentEndpoint } from '@/api/types';
import { apiStreamCompat } from '@/api/client';
import { captureRegion } from '@/services/watcher/region-capture';
import { compressImage } from '@/utils/image';

/** 工具名称 → 语义动作类型映射 */
export function toolNameToAction(name: string): string {
  switch (name) {
    case 'uia_click': return 'click';
    case 'uia_type': return 'type';
    case 'desktop_open_app': return 'open_app';
    case 'desktop_focus_window': return 'focus_window';
    case 'desktop_press_key': return 'press_key';
    default: return name;
  }
}

/** 将工具调用转换为语义动作（过滤诊断/辅助工具） */
export function toolCallsToSemanticActions(toolCalls: ToolCallInfo[]): SemanticAction[] {
  const steps: SemanticAction[] = [];
  for (const tc of toolCalls) {
    if (tc.name === 'desktop_done' || tc.name === 'desktop_screenshot'
        || tc.name === 'uia_get_interactive' || tc.name === 'uia_fingerprint'
        || tc.name === 'uia_find_element' || tc.name === 'uia_get_property'
        || tc.name === 'desktop_list_windows' || tc.name === 'desktop_list_apps'
        || tc.name === 'desktop_wait') {
      continue;
    }
    const action: SemanticAction = { action: toolNameToAction(tc.name) };
    if (tc.arguments['role']) {
      action.target = { role: tc.arguments['role'] as string, name: tc.arguments['name'] as string | undefined };
    }
    if (tc.arguments['text']) {
      action.params = { text: tc.arguments['text'] };
    } else if (Object.keys(tc.arguments).length > 0) {
      const { window_hwnd, ...rest } = tc.arguments;
      if (Object.keys(rest).length > 0) action.params = rest;
    }
    steps.push(action);
  }
  return steps;
}

/** 确保获取窗口交互元素（L1 缓存/实时获取，UIA 失败时用截图+LLM视觉兜底） */
export async function ensureInteractiveNodes(
  deps: AgentDeps,
  windowHwnd: number,
  provider?: ProviderConfig,
  apiKey?: string,
): Promise<{ nodes: InteractiveNode[]; annotations: SemanticAnnotation[]; fingerprint: string; isVision?: boolean } | null> {
  // Auto-resolve provider/apiKey from model config if not passed
  if (!provider || !apiKey) {
    try {
      const { useModelConfigStore } = await import('@/stores/model-config-store');
      const modelStore = useModelConfigStore.getState();
      const defaultConfig = modelStore.defaultConfig();
      if (defaultConfig) {
        provider = provider ?? defaultConfig;
        apiKey = apiKey ?? await modelStore.getApiKey(defaultConfig.id, '');
      }
    } catch { /* ignore */ }
  }

  console.log(`[Agent:L1] ensureInteractiveNodes — hwnd=${windowHwnd}, hasProvider=${!!provider}, hasApiKey=${!!apiKey}`);

  const fpResult = await deps.skillExecutor.executeToolCall('uia_fingerprint', { window_hwnd: windowHwnd });
  if (!fpResult.success || !fpResult.data) {
    console.warn(`[Agent:L1] ensureInteractiveNodes SKIP — uia_fingerprint failed: success=${fpResult.success}, hasData=${!!fpResult.data}, msg=${fpResult.message?.substring(0, 100)}`);
    return null;
  }

  const fp = fpResult.data as unknown as UIFingerprint;
  if (!fp.window_fp) {
    console.warn(`[Agent:L1] ensureInteractiveNodes SKIP — uia_fingerprint returned empty window_fp`);
    return null;
  }

  const { fingerprint } = deps.cacheService.resolveFingerprint(fp.window_fp, fp.pages);

  const cached = await deps.cacheService.getUICache(fingerprint);
  if (cached) {
    const isVision = cached.nodes.length === 0 && cached.annotations.length > 0;

    // Lazy annotation: cache has nodes but no annotations → gradient annotate
    if (cached.nodes.length > 0 && cached.annotations.length === 0 && provider && apiKey) {
      let freshAnnotations: SemanticAnnotation[] = [];

      // Step 1: try text-based annotation via UIA nodes
      if (cached.nodes.length >= 3) {
        try {
          freshAnnotations = await annotatePage(cached.nodes, cached.row.app_name, provider, apiKey);
          if (freshAnnotations.length > 0) {
            await deps.cacheService.updateSemanticAnnotations(fingerprint, freshAnnotations);
            return { nodes: cached.nodes, annotations: freshAnnotations, fingerprint };
          }
        } catch { /* ignore */ }
      }

      // Step 2: vision fallback (UIA too few or annotation failed)
      try {
        const visionResult = await analyzeWindowVision(deps, windowHwnd, provider, apiKey);
        if (visionResult && visionResult.elements.length > 0) {
          freshAnnotations = visionResult.elements.map((el) => ({
            label: el.label, description: el.description, role: 'vision', name: el.label,
            automationId: '', relativeX: el.relativeX, relativeY: el.relativeY,
            relativeWidth: el.relativeWidth, relativeHeight: el.relativeHeight,
            keywords: el.keywords, type: el.type,
          }));
          await deps.cacheService.updateSemanticAnnotations(fingerprint, freshAnnotations);
          return { nodes: cached.nodes, annotations: freshAnnotations, fingerprint };
        }
      } catch { /* ignore */ }
    }

    return { nodes: cached.nodes, annotations: cached.annotations, fingerprint, isVision };
  }

  const uiaResult = await deps.skillExecutor.executeToolCall('uia_get_interactive', { window_hwnd: windowHwnd });
  if (!uiaResult.success || !uiaResult.data) {

    // UIA 失败 → 截图+LLM 视觉识别兜底
    if (!provider || !apiKey) {
      return null;
    }

    const visionResult = await analyzeWindowVision(deps, windowHwnd, provider, apiKey);
    if (visionResult && visionResult.elements.length > 0) {
      // 将 VisionElement 转为 SemanticAnnotation 格式存储（复用 ui_cache.semantic_annotations）
      const annotations: SemanticAnnotation[] = visionResult.elements.map((el) => ({
        label: el.label,
        description: el.description,
        role: 'vision',
        name: el.label,
        automationId: '',
        relativeX: el.relativeX,
        relativeY: el.relativeY,
        relativeWidth: el.relativeWidth,
        relativeHeight: el.relativeHeight,
        keywords: el.keywords,
        type: el.type,
      }));

      // 被动学习：截图保存
      const screenshotPath = await captureAndSaveScreenshot(windowHwnd, fingerprint);

      // 存入 ui_cache：interactive_nodes='[]' 作为视觉缓存标记，annotations 存视觉元素
      try {
        await deps.cacheService.storeUICache(fingerprint, fp.window_fp, null, visionResult.appName, '', [], annotations, undefined, undefined, screenshotPath);
        console.log(`[Agent:L1] ✓ Vision STORED in DB — fingerprint=${fingerprint.substring(0, 12)}..., elements=${visionResult.elements.length}, app="${visionResult.appName}"${screenshotPath ? ', screenshot=yes' : ', screenshot=NO'}`);
      } catch (dbErr) {
        console.error(`[Agent:L1] ✗ storeUICache FAILED (vision path) — fingerprint=${fingerprint.substring(0, 12)}..., error:`, dbErr);
      }

      // 被动记录页面知识
      try { new PageKnowledgeService(deps.cacheService).recordPageIfNew(fingerprint, visionResult.appName, annotations); } catch { /* non-critical */ }
      return { nodes: [], annotations, fingerprint, isVision: true };
    }

    return null;
  }

  const nodes = (uiaResult.data['nodes'] as InteractiveNode[]) || [];
  const windowTitle = (uiaResult.data['window_title'] as string) || '';
  const windowClass = (uiaResult.data['window_class'] as string) || '';

  // 尝试从浏览器地址栏提取 URL，用于正确的页面归属
  const browserUrl = extractBrowserUrl(nodes, windowClass);
  const winInfo = browserUrl
    ? { appName: browserUrl.hostname, windowClass: browserUrl.path }
    : { appName: windowTitle, windowClass };

  // 被动学习：截图保存（为知识库可视化用）
  const screenshotPath = await captureAndSaveScreenshot(windowHwnd, fingerprint);

  try {
    await deps.cacheService.storeUICache(fingerprint, fp.window_fp, null, winInfo.appName, winInfo.windowClass, nodes, undefined, undefined, undefined, screenshotPath);
    console.log(`[Agent:L1] ✓ L1 STORE in DB — fp=${fingerprint}, nodes=${nodes.length}, app="${winInfo.appName}"${screenshotPath ? `, screenshot=yes` : ', screenshot=NO'}${browserUrl ? `, url="${browserUrl.href}"` : ''}`);
  } catch (dbErr) {
    console.error(`[Agent:L1] ✗ storeUICache FAILED (UIA path) — fp=${fingerprint}, error:`, dbErr);
  }

  // 被动记录页面知识
  try { new PageKnowledgeService(deps.cacheService).recordPageIfNew(fingerprint, winInfo.appName, []); } catch { /* non-critical */ }

  // 梯度标注：UIA 节点多 → 文本标注；UIA 少/失败 → 截图视觉兜底
  let annotations: SemanticAnnotation[] = [];

  if (nodes.length >= 3 && provider && apiKey) {
    // 有足够 UIA 节点 → 用 LLM 文本标注
    try {
      annotations = await annotatePage(nodes, winInfo.appName, provider, apiKey);
      if (annotations.length > 0) {
        await deps.cacheService.updateSemanticAnnotations(fingerprint, annotations);
      }
    } catch { /* ignore */ }
  }

  // UIA 节点太少 或 标注失败 → 截图+LLM 视觉兜底
  if (annotations.length === 0 && provider && apiKey) {
    try {
      const visionResult = await analyzeWindowVision(deps, windowHwnd, provider, apiKey);
      if (visionResult && visionResult.elements.length > 0) {
        annotations = visionResult.elements.map((el) => ({
          label: el.label,
          description: el.description,
          role: 'vision',
          name: el.label,
          automationId: '',
          relativeX: el.relativeX,
          relativeY: el.relativeY,
          relativeWidth: el.relativeWidth,
          relativeHeight: el.relativeHeight,
          keywords: el.keywords,
          type: el.type,
        }));
        await deps.cacheService.updateSemanticAnnotations(fingerprint, annotations);
      }
    } catch { /* ignore */ }
  }

  return { nodes, annotations, fingerprint };
}

// ── Screenshot capture for knowledge base ──

/** 截取窗口截图并保存到磁盘，返回保存路径（失败返回 null） */
async function captureAndSaveScreenshot(windowHwnd: number, fingerprint: string): Promise<string | null> {
  try {
    const { isTauri } = await import('@/utils/platform');
    if (!isTauri()) {
      console.warn(`[Agent:L1] captureAndSaveScreenshot SKIP — not in Tauri environment`);
      return null;
    }

    // PrintWindow 截取窗口完整内容（抗遮挡）
    console.log(`[Agent:L1] captureAndSaveScreenshot — capturing window hwnd=${windowHwnd}...`);
    const imageData = await captureRegion(
      { x: 0, y: 0, width: 0, height: 0 },
      windowHwnd,
      { x: 0, y: 0, width: 0, height: 0 },
    );

    // 压缩为 JPEG 后保存
    console.log(`[Agent:L1] captureAndSaveScreenshot — captured ${imageData.length} chars, compressing...`);
    const compressed = await compressImage(imageData);
    const saved: string[] = await invoke('save_llm_images', {
      images: [{ data: compressed.dataUrl, filename: `learn_${fingerprint}_${Date.now()}.jpg` }],
    });
    console.log(`[Agent:L1] ✓ screenshot SAVED — ${saved.length} file(s), path=${saved[0]?.substring(0, 80) ?? 'none'}, fingerprint=${fingerprint.substring(0, 16)}...`);
    return saved.length > 0 ? saved[0] : null;
  } catch (e) {
    console.error(`[Agent:L1] ✗ captureAndSaveScreenshot FAILED — fingerprint=${fingerprint.substring(0, 16)}..., hwnd=${windowHwnd}, error:`, e);
    return null;
  }
}

// ── Vision fallback: 截图+LLM 识别交互元素 ──

async function analyzeWindowVision(
  deps: AgentDeps,
  windowHwnd: number,
  provider: ProviderConfig,
  apiKey: string,
): Promise<{ elements: VisionElement[]; appName: string; windowWidth: number; windowHeight: number } | null> {
  // 1. 获取窗口信息
  const listResult = await deps.skillExecutor.executeToolCall('desktop_list_windows', {});
  if (!listResult.success || !listResult.data) return null;

  const windows = (listResult.data['windows'] as Array<{ hwnd: number; title: string; width: number; height: number }>) || [];
  const targetWin = windows.find((w) => w.hwnd === windowHwnd);
  if (!targetWin) return null;

  const windowWidth = targetWin.width;
  const windowHeight = targetWin.height;
  const appName = targetWin.title || '';

  // 2. 截图窗口区域（PrintWindow 抗遮挡）
  let imageData: string;
  let usedWindowCapture = false;
  try {
    imageData = await captureRegion(
      { x: 0, y: 0, width: 0, height: 0 },
      windowHwnd,
      { x: 0, y: 0, width: 0, height: 0 },
    );
    usedWindowCapture = true;
  } catch (e) {
    console.warn(`[Vision] 回退到 desktop_screenshot (全屏), LLM 将收到整个屏幕而非应用窗口`);
    const ssResult = await deps.skillExecutor.executeToolCall('desktop_screenshot', {});
    if (!ssResult.success || !ssResult.data) return null;
    imageData = ssResult.data['image_data'] as string;
  }

  // 3. 压缩图片
  let imageUrl: string;
  try {
    const compressed = await compressImage(imageData);
    imageUrl = compressed.dataUrl;
  } catch (e) {
    imageUrl = imageData.startsWith('data:') ? imageData : `data:image/bmp;base64,${imageData}`;
  }

  // 4. LLM 视觉识别 — 通过 UIVisionAgent
  console.log(`[Vision] ▶ UIVisionAgent 识别: app="${appName}", window=${windowWidth}x${windowHeight}, 截图来源=${usedWindowCapture ? '窗口' : '全屏'}`);
  const visionAgent = new UIVisionAgent();
  let elements: VisionElement[] = [];
  try {
    elements = await visionAgent.analyzeScreenshot({
      screenshotBase64: imageUrl,
      goal: appName,
      provider,
      apiKey,
      windowTitle: appName,
    });
  } catch {
    return null;
  }

  if (elements.length === 0) return null;
  return { elements, appName, windowWidth, windowHeight };
}

function buildVisionPrompt(windowTitle: string, windowWidth: number, windowHeight: number): string {
  return `You are a UI region detector. Analyze this screenshot of the "${windowTitle}" window (${windowWidth}x${windowHeight} pixels).

Identify TWO types of regions:

**Type 1 — Interactive elements**: buttons, text inputs, dropdown menus, tabs, links, checkboxes, toggles, scrollable areas, and any other clickable/tappable UI components.

**Type 2 — Content areas**: regions where content changes over time. These are NOT clickable but their visible content updates dynamically. Examples:
- Message/chat lists (new messages appear)
- Notification panels (new notifications arrive)
- Feed/timeline areas (new posts load)
- Status bars (status text changes)
- Progress indicators (progress updates)
- Search result lists (results populate)
- File lists (files appear/disappear)
- Data tables (rows update)

For each region, output a JSON object with these fields:
- label: Short semantic name in Chinese (e.g., "消息列表", "搜索按钮", "通知面板", "联系人列表")
- type: "interactive" or "content" (which type this region is)
- description: One-line location description (e.g., "聊天窗口中间的消息气泡滚动区域")
- keywords: Array of matching keywords in Chinese and English (e.g., ["消息", "聊天", "messages", "chat"])
- relativeX: Left edge as 0-1 fraction of window width (0=left edge, 1=right edge)
- relativeY: Top edge as 0-1 fraction of window height (0=top edge, 1=bottom edge)
- relativeWidth: Width as 0-1 fraction of window width
- relativeHeight: Height as 0-1 fraction of window height

Rules:
- Estimate bounding boxes visually from the screenshot. Be as accurate as possible.
- Include ALL visible interactive elements, even small ones.
- Include ALL content areas that could change over time, even large ones.
- label should be intuitive — use the text on the element if visible, or describe the content area.
- keywords should cover various ways a user might refer to this region.
- Output ONLY a JSON array, no other text.

Example output:
[{"label":"搜索按钮","type":"interactive","description":"顶部导航栏右侧的放大镜搜索图标","keywords":["搜索","search","查找"],"relativeX":0.93,"relativeY":0.03,"relativeWidth":0.04,"relativeHeight":0.04},{"label":"消息列表","type":"content","description":"聊天窗口中间的消息气泡滚动区域","keywords":["消息","聊天","消息列表","messages","chat"],"relativeX":0.15,"relativeY":0.08,"relativeWidth":0.7,"relativeHeight":0.72},{"label":"消息输入框","type":"interactive","description":"聊天窗口底部的文本输入区域","keywords":["输入","消息","input","message"],"relativeX":0.2,"relativeY":0.88,"relativeWidth":0.6,"relativeHeight":0.06}]`;
}

/** LLM 抽象：将高频动作序列抽象为参数化技能模板 */
export async function maybePromoteToSkillTemplate(
  deps: AgentDeps,
  goal: string,
  windowFP: string,
  fingerprint: string,
  steps: SemanticAction[],
  provider: ProviderConfig,
  apiKey: string,
): Promise<void> {
  const abstractor: LLMAbstractor = async (g, s) => {
    const prompt = `You are a skill abstractor. Given a task goal and its action sequence, create a reusable parameterized skill template.

Rules:
- Identify which parts of the goal are VARIABLE (user names, message text, file paths, etc.)
- Replace variable text/name values in the action sequence with {param} placeholders
- Give the skill a short, descriptive English name (snake_case)
- Output ONLY valid JSON, no explanation

Example:
Goal: "给张三发消息hello"
Actions: [{"action":"click","target":{"role":"list_item","name":"张三"}},{"action":"click","target":{"role":"edit","name":"输入"}},{"action":"type","params":{"text":"hello"}},{"action":"click","target":{"role":"button","name":"发送"}}]
Output: {"name":"send_wechat_message","description":"给微信联系人发送消息","params":["contact","message"],"template":[{"action":"click","target":{"role":"list_item","name":"{contact}"}},{"action":"click","target":{"role":"edit","name":"输入"}},{"action":"type","params":{"text":"{message}"}},{"action":"click","target":{"role":"button","name":"发送"}}]}

Goal: "${g}"
Actions: ${JSON.stringify(s)}

Output ONLY the JSON:`;

    try {
      const stream = apiStreamCompat(
        AgentEndpoint.chat,
        provider,
        apiKey,
        { messages: [{ role: 'user', content: prompt }], goal: g },
      );

      let text = '';
      for await (const chunk of stream) {
        if (!chunk.startsWith('__')) {
          text += chunk;
        }
      }

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as { name: string; description: string; params: string[]; template: SemanticAction[] };
      }
      return null;
    } catch {
      return null;
    }
  };

  await maybePromoteToSkill(goal, windowFP, fingerprint, steps, abstractor);
}

// ── 浏览器 URL 提取 ──

/** 浏览器窗口类名特征 */
const BROWSER_WINDOW_CLASSES = [
  'Chrome_WidgetWin_1',   // Chrome, Edge, Chromium
  'MozillaWindowClass',   // Firefox
  'ApplicationFrameWindow', // UWP Edge
];

/** 浏览器地址栏 automation_id 特征 */
const URL_BAR_IDS = ['OmniboxViewViews', 'urlbar-input', 'view19282', 'editComponent'];

/**
 * 从 UIA 节点中提取浏览器地址栏的 URL
 * 跨应用自动化时拿不到 DOM，但浏览器地址栏是 UIA 可访问的 Edit 控件
 */
function extractBrowserUrl(
  nodes: InteractiveNode[],
  windowClass: string,
): { href: string; hostname: string; path: string } | null {
  // 判断是否是浏览器窗口
  const isBrowser = BROWSER_WINDOW_CLASSES.some(cls => windowClass.includes(cls))
    || nodes.some(n => URL_BAR_IDS.some(id => n.automation_id?.includes(id)));
  if (!isBrowser) return null;

  // 方法 1: 通过 automation_id 找地址栏
  for (const id of URL_BAR_IDS) {
    const bar = nodes.find(n => n.automation_id?.includes(id) && n.role.toLowerCase() === 'edit');
    if (bar?.name) {
      const parsed = tryParseUrl(bar.name);
      if (parsed) return parsed;
    }
  }

  // 方法 2: 找 Edit 控件中值像 URL 的
  for (const node of nodes) {
    if (node.role.toLowerCase() !== 'edit') continue;
    const val = node.name || '';
    if (val.startsWith('http://') || val.startsWith('https://')) {
      const parsed = tryParseUrl(val);
      if (parsed) return parsed;
    }
  }

  // 方法 3: 从窗口标题推断（"页面标题 - Google Chrome"）
  // 这种情况拿不到具体 URL，返回 null 让调用方回退到窗口标题
  return null;
}

function tryParseUrl(url: string): { href: string; hostname: string; path: string } | null {
  try {
    const parsed = new URL(url);
    return { href: parsed.href, hostname: parsed.hostname, path: parsed.pathname + (parsed.search || '') };
  } catch {
    return null;
  }
}
