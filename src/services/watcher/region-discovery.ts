// Auto region discovery — LLM analyzes screenshot + UIA tree to identify watch targets.
// Caching: LLM calls via llm_call_cache, bbox mappings via step_cache.

import { invoke } from '@tauri-apps/api/core';
import type { ScreenRegion, WatchTarget, WatchProfile } from '@/types/watcher';
import type { LLMMessage } from '@/types/message';
import { compressUIATree, uiaToText, uiaSignature } from './uia-compressor';
import { getLLMCallCache, storeLLMCallCache, getStepCache, storeStepCache } from '@/services/cache-service';
import systemPrompts from '@/config/system-prompts.json';

const SYSTEM_PROMPT = systemPrompts.regionDiscovery;

export interface RegionDiscoveryInput {
  /** Full window screenshot (base64 BMP data URL) */
  screenshot: string;
  /** Raw UIA tree JSON (from uia_get_interactive), optional when cachedSemanticContext is available */
  uiaTree?: unknown;
  /** App name (e.g. "wechat", "chrome") */
  appName: string;
  /** User's task description (e.g. "等待微信新消息") */
  taskDescription: string;
  /** L1 cached semantic info (nodes + annotations text), injected into LLM prompt */
  cachedSemanticContext?: string;
  /** Skip all caches and force LLM re-analysis (used by re-resolve) */
  skipCache?: boolean;
}

export interface RegionDiscoveryResult {
  watchProfile: WatchProfile;
  bboxes: Map<string, ScreenRegion>;
  cacheHit: boolean;
}

/**
 * Discover watch targets for a task using LLM (screenshot + UIA + task).
 * Caches LLM calls via llm_call_cache (screenshot NOT in cache key).
 * Caches signal→bbox mappings via step_cache.
 */
export async function discoverRegions(input: RegionDiscoveryInput): Promise<RegionDiscoveryResult> {
  // 1. Compress UIA tree (if available)
  const compressed = input.uiaTree ? compressUIATree(input.uiaTree as never) : null;
  const signature = compressed ? uiaSignature(compressed) : `no_uia_${input.appName}`;

  // 2. Check llm_call_cache (screenshot excluded from key, skipCache 时跳过)
  const requestHash = computeDiscoveryHash(signature, input.taskDescription);

  let watchProfile: WatchProfile;
  let cacheHit = false;

  const cached = input.skipCache ? null : await getLLMCallCache(requestHash);
  if (cached) {
    try {
      watchProfile = JSON.parse(cached.response_text);
      cacheHit = true;
    } catch {
      watchProfile = await callLLMForDiscovery(input, compressed);
      await storeLLMCallCache(requestHash, JSON.stringify(watchProfile), 'discovery', 'discovery', 2, 0, `task=${input.taskDescription}`);
    }
  } else {
    watchProfile = await callLLMForDiscovery(input, compressed);
    await storeLLMCallCache(requestHash, JSON.stringify(watchProfile), 'discovery', 'discovery', 2, 0, `task=${input.taskDescription}`);
  }

  // 3. Map watch_targets → bboxes (via step_cache + UIA lookup)
  const bboxes = new Map<string, ScreenRegion>();
  const uiaNodes = (input.uiaTree as { nodes?: UIAFlatNode[] })?.nodes ?? [];
  const hasUIA = uiaNodes.length > 0;

  for (const target of watchProfile.watch_targets) {
    // When LLM returned bbox directly in the response, use it
    if (target.bbox && !hasUIA) {
      bboxes.set(target.semantic, target.bbox);
      continue;
    }
    const bbox = await resolveSemanticBbox(uiaNodes, target.semantic, signature, input.appName);
    if (bbox) {
      bboxes.set(target.semantic, bbox);
    }
  }

  return { watchProfile, bboxes, cacheHit };
}

/**
 * Resolve a semantic name to a bbox via step_cache → UIA lookup → store step_cache.
 */
async function resolveSemanticBbox(
  uiaNodes: UIAFlatNode[],
  semantic: string,
  signature: string,
  appName: string,
): Promise<ScreenRegion | null> {
  const cacheKey = `watch_region:${appName}:${semantic}`;

  // Check step_cache first
  const cachedStep = await getStepCache(cacheKey, signature, appName);
  if (cachedStep?.bounds) {
    const cb = cachedStep.bounds;
    return {
      x: cb.left,
      y: cb.top,
      width: cb.right - cb.left,
      height: cb.bottom - cb.top,
    };
  }

  // Local UIA lookup
  const bbox = findNodeBbox(uiaNodes, semantic);
  if (bbox) {
    await storeStepCache({
      goalFragment: cacheKey,
      role: 'region',
      name: semantic,
      bounds: {
        left: bbox.x,
        top: bbox.y,
        right: bbox.x + bbox.width,
        bottom: bbox.y + bbox.height,
      },
      windowFP: signature,
      appName,
    });
    return bbox;
  }

  return null;
}

interface UIAFlatNode {
  role?: string;
  controlType?: string;
  ControlType?: string;
  name?: string;
  Name?: string;
  bounds?: { x?: number; y?: number; width?: number; height?: number; left?: number; top?: number; right?: number; bottom?: number };
  children?: UIAFlatNode[];
  Children?: UIAFlatNode[];
}

function findNodeBbox(nodes: UIAFlatNode[], semantic: string): ScreenRegion | null {
  const keywords = semantic.toLowerCase().split(/[\s_]+/);

  for (const node of nodes) {
    const role = (node.role ?? node.controlType ?? node.ControlType ?? '').toLowerCase();
    const name = (node.name ?? node.Name ?? '').toLowerCase();

    // Match: any keyword appears in role or name
    const matched = keywords.some(
      kw => role.includes(kw) || name.includes(kw),
    );

    if (matched && node.bounds) {
      // Handle both {x,y,width,height} and {left,top,right,bottom} formats
      const b = node.bounds;
      const x = b.x ?? b.left ?? 0;
      const y = b.y ?? b.top ?? 0;
      const w = b.width ?? ((b.right ?? 0) - (b.left ?? 0));
      const h = b.height ?? ((b.bottom ?? 0) - (b.top ?? 0));
      if (w > 0 && h > 0) {
        return { x, y, width: w, height: h };
      }
    }

    // Recurse into children
    const children = node.children ?? node.Children ?? [];
    if (children.length > 0) {
      const found = findNodeBbox(children, semantic);
      if (found) return found;
    }
  }

  return null;
}

async function callLLMForDiscovery(
  input: RegionDiscoveryInput,
  compressed: ReturnType<typeof compressUIATree> | null,
): Promise<WatchProfile> {
  const { ModelScenario } = await import('@/services/llm-gateway/gateway');
  const { getModelService } = await import('@/services/model-service-singleton');
  const { useModelConfigStore } = await import('@/stores/model-config-store');
  const { compressImage } = await import('@/utils/image');

  const modelStore = useModelConfigStore.getState();
  if (modelStore.providers.length === 0) {
    await modelStore.load();
  }
  const provider = modelStore.defaultConfig();
  if (!provider) throw new Error('No default model provider for region discovery');
  const apiKey = await modelStore.getApiKey(provider.id, '');
  if (!apiKey) throw new Error('No API key for region discovery');

  const compressedImg = await compressImage(input.screenshot);
  const hasUIA = !!compressed;
  const uiaText = compressed ? uiaToText(compressed) : '';

  // 无 UIA 时需要 LLM 直接返回 bbox 坐标
  const contextSection = hasUIA
    ? `Compressed UIA tree:\n${uiaText}`
    : `已知 UI 元素（来自之前的 UIA 分析）：\n${input.cachedSemanticContext ?? '（无）'}`;

  const bboxInstruction = hasUIA
    ? ''
    : `\n\nIMPORTANT: Since no live UIA tree is available, for each target you MUST also include a "bbox" field with pixel coordinates:
"bbox": {"x": <left>, "y": <top>, "width": <width>, "height": <height>}
All values in pixels. The screenshot original dimensions are ${compressedImg.originalWidth}x${compressedImg.originalHeight} pixels (may have been resized for analysis). Return coordinates in the ORIGINAL pixel space.`;

  const messages: LLMMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: compressedImg.dataUrl } },
        {
          type: 'text',
          text: `Task: "${input.taskDescription}"
App: ${input.appName}

${contextSection}

Return only a JSON object with "watch_targets" array.
Each target must have "semantic" (content area name), "reason", "signals", and "importance".${bboxInstruction}`,
        },
      ],
    },
  ];

  const modelService = getModelService();
  let responseText = '';
  const stream = modelService.chatStream({
    scenario: ModelScenario.watcher,
    messages,
    provider,
    apiKey,
  });
  for await (const chunk of stream) {
    if (chunk.startsWith('__ERROR__:')) throw new Error(chunk);
    if (chunk.startsWith('__REASONING__:')) continue;
    responseText += chunk;
  }

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Failed to parse region discovery LLM response');

  const parsed = JSON.parse(jsonMatch[0]);
  const targets = (parsed.watch_targets ?? []).map((t: Record<string, unknown>) => {
    const target: import('@/types/watcher').WatchTarget = {
      semantic: String(t.semantic ?? ''),
      reason: String(t.reason ?? ''),
      signals: (t.signals ?? []) as import('@/types/watcher').WatchSignal[],
      importance: Number(t.importance ?? 0.5),
    };
    // Parse LLM-returned bbox (when no UIA available)
    if (t.bbox && typeof t.bbox === 'object') {
      const b = t.bbox as Record<string, number>;
      target.bbox = {
        x: Math.round(Number(b.x ?? 0)),
        y: Math.round(Number(b.y ?? 0)),
        width: Math.round(Number(b.width ?? 0)),
        height: Math.round(Number(b.height ?? 0)),
      };
    }
    return target;
  });

  return {
    watch_targets: targets,
    uia_signature: compressed ? uiaSignature(compressed) : `no_uia_${input.appName}`,
  };
}

function computeDiscoveryHash(uiaSig: string, taskDescription: string): string {
  const input = `${SYSTEM_PROMPT}|${uiaSig}|${taskDescription.trim().toLowerCase()}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return `region_disc_${Math.abs(hash).toString(36)}`;
}
