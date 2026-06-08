// Multi-stage diff detection pipeline.
//
// Stage 1: FastVisualDetector  — Rust visual_diff (block-level, <5ms)
// Stage 2: SemanticTextDetector — Stage 1 + OCR text diff (~100ms)
// Stage 4: LlmVisionDetector   — Stage 1+2+3+4 full pipeline (~2s, cached via llm_call_cache)
//
// Replaces the old pixel_hash / ocr_text / llm_vision single-detector architecture.

import { invoke } from '@tauri-apps/api/core';
import type { DiffDetector, DiffResult, DiffStrategyType, DiffBbox } from '@/types/watcher';
import type { LLMMessage } from '@/types/message';

// ── Helpers ──

/** 过滤掉纯时间戳行（如 "21:19", "12:30:45"），保留实际消息内容 */
function filterTimestampLines(lines: string[]): string[] {
  return lines.filter(line => !/^\d{1,2}:\d{2}(:\d{2})?$/.test(line.trim()));
}

// ── Rust command return types ──

interface VisualDiffResult {
  changed: boolean;
  visual_change_ratio: number;
  changed_blocks: number;
  total_blocks: number;
  diff_pixel_count: number;
  total_pixels: number;
  bbox: DiffBbox | null;
  confidence: number;
}

interface OcrTextDiffResult {
  changed: boolean;
  similarity: number;
  prev_line_count: number;
  curr_line_count: number;
  new_lines: string[];
}

interface CompressedImage {
  data_url: string;
  original_width: number;
  original_height: number;
  compressed_width: number;
  compressed_height: number;
}

// ── Helpers ──

function bboxOrUndefined(b: DiffBbox | null): DiffBbox | undefined {
  return b ?? undefined;
}

// ── Stage 1: FastVisualDetector (Rust visual_diff) ──

class FastVisualDetector implements DiffDetector {
  type: DiffStrategyType = 'fast_visual';

  async detect(previous: string, current: string): Promise<DiffResult> {
    const start = Date.now();
    const result = await invoke<VisualDiffResult>('visual_diff', {
      baselineBmp: previous,
      currentBmp: current,
      blockSize: 16,
      threshold: 12,
    });


    return {
      changed: result.changed,
      confidence: result.confidence,
      diffDetail: result.changed
        ? `视觉变化 ${(result.visual_change_ratio * 100).toFixed(1)}% (${result.changed_blocks}/${result.total_blocks} blocks)`
        : undefined,
      currentSnapshot: current,
      diffBbox: bboxOrUndefined(result.bbox),
      rawVisualDiff: {
        visual_change_ratio: result.visual_change_ratio,
        changed_blocks: result.changed_blocks,
        total_blocks: result.total_blocks,
        confidence: result.confidence,
      },
    };
  }
}

// ── Stage 2: SemanticTextDetector (visual_diff + OCR text diff) ──

class SemanticTextDetector implements DiffDetector {
  type: DiffStrategyType = 'semantic_text';

  // Instance memory cache: baseline unchanged → OCR result reused
  private cachedPrevOCR: string | null = null;
  private cachedPrevBmp: string = '';

  async detect(previous: string, current: string): Promise<DiffResult> {
    const start = Date.now();

    // Stage 1: fast visual check
    const visual = await invoke<VisualDiffResult>('visual_diff', {
      baselineBmp: previous,
      currentBmp: current,
      blockSize: 16,
      threshold: 12,
    });

    // Dual threshold: skip OCR only if change < 0.1%; 2%→visual, 0.1-2%→OCR
    if (visual.visual_change_ratio < 0.001) {
      return {
        changed: false,
        confidence: 0.99,
        currentSnapshot: current,
        diffBbox: bboxOrUndefined(visual.bbox),
        rawVisualDiff: {
          visual_change_ratio: visual.visual_change_ratio,
          changed_blocks: visual.changed_blocks,
          total_blocks: visual.total_blocks,
          confidence: visual.confidence,
        },
      };
    }

    // Stage 2: OCR text comparison
    // Reuse cached OCR for baseline if image hasn't changed
    let prevOcrJson: string;
    if (previous === this.cachedPrevBmp && this.cachedPrevOCR) {
      prevOcrJson = this.cachedPrevOCR;
    } else {
      prevOcrJson = await this.runOCR(previous);
      this.cachedPrevOCR = prevOcrJson;
      this.cachedPrevBmp = previous;
    }

    const currOcrJson = await this.runOCR(current);

    const text = await invoke<OcrTextDiffResult>('ocr_text_diff', {
      prevOcrJson,
      currOcrJson,
    });

    const changed = text.similarity < 0.92;


    return {
      changed,
      confidence: changed ? 0.9 : 0.95,
      diffDetail: changed
        ? `新增 ${text.new_lines.length} 行: ${filterTimestampLines(text.new_lines).slice(0, 3).join(' | ') || text.new_lines.slice(0, 3).join(' | ')} (文本相似度 ${(text.similarity * 100).toFixed(1)}%)`
        : undefined,
      currentSnapshot: current,
      diffBbox: bboxOrUndefined(visual.bbox),
      rawVisualDiff: {
        visual_change_ratio: visual.visual_change_ratio,
        changed_blocks: visual.changed_blocks,
        total_blocks: visual.total_blocks,
        confidence: visual.confidence,
      },
    };
  }

  private async runOCR(imageBase64: string): Promise<string> {
    const result = await invoke<{ text?: string; full_text?: string; count?: number; texts?: unknown[] }>(
      'ocr_recognize',
      { imageBase64, imagePath: null },
    );
    // Return full OCR JSON so ocr_text_diff Rust command can parse it
    return JSON.stringify(result);
  }
}

// ── Stage 4: LlmVisionDetector (full pipeline with LLM cache) ──

class LlmVisionDetector implements DiffDetector {
  type: DiffStrategyType = 'llm_vision';

  async detect(previous: string, current: string): Promise<DiffResult> {
    const start = Date.now();

    // Stage 1: fast visual check
    const visual = await invoke<VisualDiffResult>('visual_diff', {
      baselineBmp: previous,
      currentBmp: current,
      blockSize: 16,
      threshold: 12,
    });

    // Dual threshold: skip OCR/LLM only if change < 0.1%; 2%→visual, 0.1-2%→text/LLM
    if (visual.visual_change_ratio < 0.001) {
      return {
        changed: false,
        confidence: 0.99,
        currentSnapshot: current,
        diffBbox: bboxOrUndefined(visual.bbox),
        rawVisualDiff: {
          visual_change_ratio: visual.visual_change_ratio,
          changed_blocks: visual.changed_blocks,
          total_blocks: visual.total_blocks,
          confidence: visual.confidence,
        },
      };
    }

    // Stage 2: OCR text check
    const [prevOcrJson, currOcrJson] = await Promise.all([
      this.runOCR(previous),
      this.runOCR(current),
    ]);

    const text = await invoke<OcrTextDiffResult>('ocr_text_diff', {
      prevOcrJson,
      currOcrJson,
    });


    // Text changed → skip LLM, return early
    if (text.similarity < 0.92) {
      return {
        changed: true,
        confidence: 0.9,
        diffDetail: `新增: ${filterTimestampLines(text.new_lines).slice(0, 3).join(' | ') || text.new_lines.slice(0, 3).join(' | ')} (文本变化 ${(text.similarity * 100).toFixed(1)}%)`,
        currentSnapshot: current,
        diffBbox: bboxOrUndefined(visual.bbox),
        rawVisualDiff: {
          visual_change_ratio: visual.visual_change_ratio,
          changed_blocks: visual.changed_blocks,
          total_blocks: visual.total_blocks,
          confidence: visual.confidence,
        },
      };
    }

    // No visual bbox: if visual.changed (>2%), report low-confidence change; if only sub-2%, treat as unchanged
    if (!visual.bbox) {
      if (visual.changed) {
        return {
          changed: true,
          confidence: 0.7,
          diffDetail: `视觉变化 ${(visual.visual_change_ratio * 100).toFixed(1)}%, OCR 无差异`,
          currentSnapshot: current,
          rawVisualDiff: {
            visual_change_ratio: visual.visual_change_ratio,
            changed_blocks: visual.changed_blocks,
            total_blocks: visual.total_blocks,
            confidence: visual.confidence,
          },
        };
      }
      return {
        changed: false,
        confidence: 0.95,
        currentSnapshot: current,
        rawVisualDiff: {
          visual_change_ratio: visual.visual_change_ratio,
          changed_blocks: visual.changed_blocks,
          total_blocks: visual.total_blocks,
          confidence: visual.confidence,
        },
      };
    }

    // Stage 3: extract changed region (Rust)
    const [croppedPrev, croppedCurr] = await invoke<[string, string]>(
      'extract_motion_region',
      { baselineBmp: previous, currentBmp: current, bbox: visual.bbox, padding: 10 },
    );

    // Compress both crops
    const [compPrev, compCurr] = await Promise.all([
      invoke<CompressedImage>('compress_to_jpeg', { imageBmp: croppedPrev, maxDimension: 800, quality: 70 }),
      invoke<CompressedImage>('compress_to_jpeg', { imageBmp: croppedCurr, maxDimension: 800, quality: 70 }),
    ]);

    // Stage 4: LLM vision verification (with llm_call_cache)
    const llmResult = await this.llmVerify(compPrev.data_url, compCurr.data_url);


    return {
      changed: llmResult.changed,
      confidence: llmResult.confidence,
      diffDetail: llmResult.detail,
      currentSnapshot: current,
      diffBbox: bboxOrUndefined(visual.bbox),
      rawVisualDiff: {
        visual_change_ratio: visual.visual_change_ratio,
        changed_blocks: visual.changed_blocks,
        total_blocks: visual.total_blocks,
        confidence: visual.confidence,
      },
    };
  }

  private async runOCR(imageBase64: string): Promise<string> {
    const result = await invoke<{ text?: string; full_text?: string }>(
      'ocr_recognize',
      { imageBase64, imagePath: null },
    );
    return JSON.stringify(result);
  }

  private async llmVerify(
    prevUrl: string,
    currUrl: string,
  ): Promise<{ changed: boolean; confidence: number; detail?: string }> {
    const { ModelScenario } = await import('@/services/llm-gateway/gateway');
    const { getModelService } = await import('@/services/model-service-singleton');
    const { useModelConfigStore } = await import('@/stores/model-config-store');

    const modelStore = useModelConfigStore.getState();
    if (modelStore.providers.length === 0) {
      await modelStore.load();
    }
    const provider = modelStore.defaultConfig();
    if (!provider) {
      return { changed: true, confidence: 0.5, detail: 'no model config' };
    }
    const apiKey = await modelStore.getApiKey(provider.id, '');
    if (!apiKey) {
      return { changed: true, confidence: 0.5, detail: 'no api key' };
    }

    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: prevUrl } },
          { type: 'image_url', image_url: { url: currUrl } },
          {
            type: 'text',
            text: `Two crops of the same screen region. First = baseline, second = current.
Analyze whether the content has MEANINGFULLY changed. Ignore cursor blinking, anti-aliasing, timestamps.
Focus on: new messages, notifications, content appearing/disappearing, UI state changes.
Respond with ONLY JSON: {"changed": true/false, "confidence": 0.0-1.0, "detail": "brief description or null"}`,
          },
        ],
      },
    ];

    // chatStream with watcher scenario: no injected system prompt, built-in llm_call_cache
    const modelService = getModelService();
    let responseText = '';
    const stream = modelService.chatStream({
      scenario: ModelScenario.watcher,
      messages,
      provider,
      apiKey,
    });
    for await (const chunk of stream) {
      if (chunk.startsWith('__ERROR__:')) {
        console.error('[watcher:detector] LlmVision LLM error:', chunk);
        return { changed: true, confidence: 0.5, detail: chunk };
      }
      if (chunk.startsWith('__REASONING__:')) continue;
      responseText += chunk;
    }

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { changed: true, confidence: 0.5, detail: 'LLM response parse failed' };
    }

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      changed: Boolean(parsed.changed),
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
      detail: parsed.detail ?? (parsed.changed ? 'LLM detected change' : undefined),
    };
  }
}

// ── Factory ──

const detectors: Record<DiffStrategyType, DiffDetector> = {
  fast_visual: new FastVisualDetector(),
  semantic_text: new SemanticTextDetector(),
  llm_vision: new LlmVisionDetector(),
};

export function getDetector(type: DiffStrategyType): DiffDetector {
  return detectors[type];
}
