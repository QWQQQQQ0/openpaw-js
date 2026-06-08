// Region discovery via OCR text list + LLM semantic selection.
// Used when UIA is unavailable (custom-drawn UIs like WeChat).
//
// Flow: screenshot → OCR → numbered text list → LLM picks line numbers
//       → merge bboxes of selected lines → precise ScreenRegion
//
// LLM only outputs integers (line indices), never coordinates.

import { invoke } from '@tauri-apps/api/core';
import type { ScreenRegion } from '@/types/watcher';
import { getLLMCallCache, storeLLMCallCache, getStepCache, storeStepCache, getOcrFromUICache, storeOcrToUICache, computeOcrFingerprint } from '@/services/cache-service';
import systemPrompts from '@/config/system-prompts.json';

// ── Types ──

interface OcrItem {
  text: string;
  confidence: number;
  bbox: { left: number; top: number; right: number; bottom: number };
}

interface OcrResult {
  texts: OcrItem[];
  count: number;
  error?: string;
}

export interface RegionFromOcrInput {
  screenshot: string;       // BMP data URL of the full window
  regionDescription: string; // e.g. "微信 '文件管理群' 聊天"
  appName: string;
}

// ── Helpers ──

/** Run OCR on a screenshot, return parsed text items. */
async function runOCR(screenshot: string): Promise<OcrItem[]> {
  const result = await invoke<OcrResult>('ocr_recognize', {
    imageBase64: screenshot,
    imagePath: null,
  });
  if (result.error) {
    return [];
  }
  return result.texts ?? [];
}

/** Build a compact numbered text list for the LLM prompt. */
function buildTextList(items: OcrItem[], maxItems = 80): string {
  // Sort top-to-bottom, left-to-right
  const sorted = [...items].sort((a, b) => {
    const dy = a.bbox.top - b.bbox.top;
    if (Math.abs(dy) > 8) return dy;
    return a.bbox.left - b.bbox.left;
  });

  const lines: string[] = [];
  for (let i = 0; i < Math.min(sorted.length, maxItems); i++) {
    const item = sorted[i];
    const b = item.bbox;
    lines.push(`${i}. "${item.text}"  (${b.left},${b.top}, ${b.right - b.left}x${b.bottom - b.top})`);
  }
  return lines.join('\n');
}

/** Merge an array of bboxes into a single bounding box. */
function mergeBboxes(items: OcrItem[], indices: number[]): ScreenRegion | null {
  if (indices.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const idx of indices) {
    const b = items[idx]?.bbox;
    if (!b) continue;
    if (b.left < minX) minX = b.left;
    if (b.top < minY) minY = b.top;
    if (b.right > maxX) maxX = b.right;
    if (b.bottom > maxY) maxY = b.bottom;
  }
  if (!isFinite(minX)) return null;

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Hash for llm_call_cache — robust against minor OCR variations.
 * Sorts text lines, deduplicates, trims whitespace, and lowercases
 * so the same visible content always produces the same hash.
 */
function computeOcrRegionHash(taskDesc: string, items: OcrItem[]): string {
  const normalized = [...new Set(
    items
      .map(t => t.text.trim().toLowerCase())
      .filter(t => t.length > 0)
  )].sort().join('\n');
  const input = `ocr_region|${taskDesc.trim().toLowerCase()}|${normalized}`;
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return `ocr_region_${Math.abs(hash).toString(36)}`;
}

// ── Main ──

/**
 * Discover the monitoring region using OCR + LLM semantic selection.
 * Returns the merged bbox, or null if OCR/LLM fails.
 */
export async function discoverRegionFromOCR(
  input: RegionFromOcrInput,
): Promise<ScreenRegion | null> {
  const { screenshot, regionDescription, appName } = input;

  // 1. OCR (with ui_cache lookup)
  let items: OcrItem[];
  // Compute a content-based fingerprint for caching
  // We need items first to compute it, but we'd like to check cache before running OCR.
  // Use a two-pass approach: try a quick fingerprint from a cheap image hash, or
  // fall back to always running OCR on the first call and caching for subsequent calls.
  const fastFp = `${appName}:${regionDescription}`;
  const cachedOcr = await getOcrFromUICache(fastFp);
  if (cachedOcr && cachedOcr.length > 0) {
    items = cachedOcr;
  } else {
    items = await runOCR(screenshot);
    if (items.length === 0) {
      return null;
    }

    // Store in ui_cache with content-based fingerprint
    const contentFp = computeOcrFingerprint(items, appName);
    await storeOcrToUICache(fastFp, contentFp, appName, items).catch(() => {});
  }

  // 2. Check step_cache (position-based, stable across runs)
  const stepKey = `ocr_watch:${appName}:${regionDescription}`;
  const cachedStep = await getStepCache(stepKey, undefined, appName).catch(() => null);
  if (cachedStep?.bounds) {
    const b = cachedStep.bounds;
    return { x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top };
  }

  // 3. Build text list and request hash (normalized for stable caching)
  const textList = buildTextList(items);
  const requestHash = computeOcrRegionHash(regionDescription, items);

  // 4. Check llm_call_cache
  let llmResponse: string;
  const cached = await getLLMCallCache(requestHash);
  if (cached) {
    llmResponse = cached.response_text;
    console.log(`[region-from-ocr] llm_call_cache HIT — hash=${requestHash}`);
  } else {
    // 5. Call LLM
    llmResponse = await callLLMForOcrRegion(items, regionDescription, textList);
    await storeLLMCallCache(requestHash, llmResponse, 'ocr_region', 'discovery', 2, 0, `task=${regionDescription}`);
  }

  // 6. Parse LLM response — extract integer indices
  const indices = parseIndices(llmResponse, items.length);
  console.log(`[region-from-ocr] LLM selected indices: [${indices.join(',')}]`);

  if (indices.length === 0) {
    console.warn(`[region-from-ocr] LLM returned no valid indices for "${regionDescription}"`);
    return null;
  }

  // 7. Merge bboxes
  const region = mergeBboxes(items, indices);
  if (!region) return null;

  // 8. Store step_cache
  try {
    await storeStepCache({
      goalFragment: stepKey,
      role: 'ocr_region',
      name: regionDescription,
      bounds: { left: region.x, top: region.y, right: region.x + region.width, bottom: region.y + region.height },
      appName,
    });
  } catch { /* non-fatal */ }

  return region;
}

// ── LLM call ──

async function callLLMForOcrRegion(
  items: OcrItem[],
  regionDescription: string,
  textList: string,
): Promise<string> {
  const { ModelScenario } = await import('@/services/llm-gateway/gateway');
  const { getModelService } = await import('@/services/model-service-singleton');
  const { useModelConfigStore } = await import('@/stores/model-config-store');

  const modelStore = useModelConfigStore.getState();
  if (modelStore.providers.length === 0) await modelStore.load();
  const provider = modelStore.defaultConfig();
  if (!provider) throw new Error('No default model provider for OCR region');
  const apiKey = await modelStore.getApiKey(provider.id, '');
  if (!apiKey) throw new Error('No API key for OCR region');

  const systemPrompt = systemPrompts.regionFromOcr ?? '';
  const messages = [
    ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
    {
      role: 'user' as const,
      content: `目标: "${regionDescription}"

以下是 OCR 识别的文本列表（每行格式: 编号. "文本"  (x, y, 宽x高)）:

${textList}

请返回属于目标区域的所有文本编号，用 JSON 数组格式: [0, 3, 7, ...]`,
    },
  ];

  const modelService = getModelService();
  let responseText = '';
  const stream = modelService.chatStream({
    scenario: ModelScenario.raw,
    messages,
    provider,
    apiKey,
  });
  for await (const chunk of stream) {
    if (chunk.startsWith('__ERROR__:')) throw new Error(chunk);
    if (chunk.startsWith('__REASONING__:')) continue;
    responseText += chunk;
  }

  console.log(`[region-from-ocr] LLM response: ${responseText.substring(0, 200)}`);
  return responseText;
}

// ── Response parsing ──

function parseIndices(response: string, maxIndex: number): number[] {
  // Extract the first JSON array from the response
  const match = response.match(/\[[\d,\s]*\]/);
  if (!match) {
    // Try to find numbers anywhere
    const nums = response.match(/\d+/g);
    if (!nums) return [];
    return nums.map(Number).filter((n) => n >= 0 && n < maxIndex && Number.isInteger(n));
  }

  try {
    const arr = JSON.parse(match[0]);
    if (!Array.isArray(arr)) return [];
    return arr
      .map(Number)
      .filter((n) => n >= 0 && n < maxIndex && Number.isInteger(n));
  } catch {
    return [];
  }
}
