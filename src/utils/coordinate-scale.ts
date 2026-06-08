// 坐标修正工具 — 统一的坐标转换入口
//
// 两层修正：
//   1. 压缩比例缩放 — LLM 看到的是压缩截图，坐标需要按比例还原到原始空间
//   2. 窗口偏移 — 当截图是单个窗口时，LLM 坐标是窗口相对坐标，需加上窗口左上角绝对位置
//
// 用法：
//   const scale = getScreenshotScale(compressed);           // 计算压缩比例
//   applyCoordinateScale(args, toolName, scale);            // 缩放坐标（原地修改）
//   const abs = addWindowOffset(x, y, windowBounds);        // 窗口相对 → 绝对
//
// 注意：调用方应在执行前快照 LLM 原始坐标，执行后将返回值中的坐标还原为 LLM 原始值，
// 避免 LLM 看到修正后的坐标而困惑重试。

import type { CompressedImage } from './image';

// ═══════════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════════

/** 截图压缩比例 */
export interface ScreenshotScale {
  /** 原始宽度 / 压缩宽度 */
  scaleX: number;
  /** 原始高度 / 压缩高度 */
  scaleY: number;
}

/** 窗口屏幕坐标 bounds（来自 Win32 GetWindowRect） */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 需要坐标处理的桌面工具名集合 */
const COORD_TOOLS = new Set([
  'desktop_click', 'desktop_double_click', 'desktop_right_click', 'desktop_middle_click',
  'desktop_scroll', 'desktop_move_mouse', 'desktop_mouse_down', 'desktop_mouse_up',
]);

// ═══════════════════════════════════════════════════════════════
// 压缩比例
// ═══════════════════════════════════════════════════════════════

/**
 * 从 CompressedImage 计算截图压缩比例。
 * 返回 null 表示无需缩放（未压缩或缺少尺寸信息）。
 */
export function getScreenshotScale(compressed: CompressedImage): ScreenshotScale | null {
  const ow = compressed.originalWidth;
  const oh = compressed.originalHeight;
  const cw = compressed.compressedWidth;
  const ch = compressed.compressedHeight;

  if (cw > 0 && ch > 0 && ow > 0 && oh > 0) {
    const scale = { scaleX: ow / cw, scaleY: oh / ch };
    console.debug(
      `[coordinate-scale] getScreenshotScale — 入参: orig=${ow}x${oh} compressed=${cw}x${ch}`,
      `→ 出参: scaleX=${scale.scaleX.toFixed(4)} scaleY=${scale.scaleY.toFixed(4)}`,
      scale.scaleX === 1 && scale.scaleY === 1 ? '(1:1 无需缩放)' : '',
    );
    return scale;
  }
  console.debug(
    `[coordinate-scale] getScreenshotScale — 入参: orig=${ow}x${oh} compressed=${cw}x${ch}`,
    `→ 出参: null (缺少有效尺寸)`,
  );
  return null;
}

/**
 * 将 LLM 输出的坐标从压缩截图空间还原到原始截图空间（原地修改 args）。
 *
 * 覆盖工具：
 *   点击类 (desktop_click / double/right/middle) — x, y
 *   鼠标   (desktop_move_mouse / mouse_down / mouse_up) — x, y
 *   拖拽   (desktop_drag) — start_x, start_y, end_x, end_y
 *   滚动   (desktop_scroll) — x, y
 *   平滑移动 (desktop_move_cursor) — path (SVG)
 */
export function applyCoordinateScale(
  args: Record<string, unknown>,
  toolName: string,
  scale: ScreenshotScale,
): void {
  if (scale.scaleX === 1 && scale.scaleY === 1) return;

  const before = { ...args };

  if (COORD_TOOLS.has(toolName)) {
    if (typeof args['x'] === 'number') {
      args['x'] = Math.round((args['x'] as number) * scale.scaleX);
    }
    if (typeof args['y'] === 'number') {
      args['y'] = Math.round((args['y'] as number) * scale.scaleY);
    }
  } else if (toolName === 'desktop_drag') {
    if (typeof args['start_x'] === 'number') args['start_x'] = Math.round((args['start_x'] as number) * scale.scaleX);
    if (typeof args['start_y'] === 'number') args['start_y'] = Math.round((args['start_y'] as number) * scale.scaleY);
    if (typeof args['end_x'] === 'number') args['end_x'] = Math.round((args['end_x'] as number) * scale.scaleX);
    if (typeof args['end_y'] === 'number') args['end_y'] = Math.round((args['end_y'] as number) * scale.scaleY);
  } else if (toolName === 'desktop_move_cursor' && typeof args['path'] === 'string') {
    args['path'] = scaleSvgPath(args['path'] as string, scale);
  }

  const changed: string[] = [];
  for (const k of Object.keys(args)) {
    if (before[k] !== args[k] && (typeof args[k] === 'number' || typeof args[k] === 'string')) {
      changed.push(`${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(args[k])}`);
    }
  }
  if (changed.length > 0) {
    console.debug(
      `[coordinate-scale] applyCoordinateScale — ${toolName}`,
      `scale=(${scale.scaleX.toFixed(4)}, ${scale.scaleY.toFixed(4)})`,
      changed.join(', '),
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// 窗口偏移
// ═══════════════════════════════════════════════════════════════

/**
 * 窗口相对坐标 → 屏幕绝对坐标。
 * 当 LLM 截图是单个窗口时，LLM 输出的坐标是窗口相对坐标，
 * 需要加上窗口左上角在屏幕上的绝对位置。
 *
 * bounds 来自 Win32 GetWindowRect，{ x, y } 即窗口左上角屏幕坐标。
 * 如果 bounds 无效（width/height 为 0），原样返回视为已是绝对坐标。
 */
export function addWindowOffset(
  x: number,
  y: number,
  bounds: WindowBounds,
): { x: number; y: number } {
  if (bounds.width > 0 && bounds.height > 0) {
    const absX = x + bounds.x;
    const absY = y + bounds.y;
    console.debug(
      `[coordinate-scale] addWindowOffset — 入参: (${x}, ${y}) + window(${bounds.x}, ${bounds.y})`,
      `→ 出参: (${absX}, ${absY})`,
    );
    return { x: absX, y: absY };
  }
  console.debug(
    `[coordinate-scale] addWindowOffset — 入参: (${x}, ${y}) bounds无效 (${bounds.width}x${bounds.height})，原样返回`,
  );
  return { x, y };
}

// ═══════════════════════════════════════════════════════════════
// SVG path
// ═══════════════════════════════════════════════════════════════

/**
 * 缩放 SVG path 中的所有坐标点，保留原始命令类型（M/C/Q/L 等）。
 *
 * 与 parseSvgPath（贝塞尔→折线采样）不同，此函数只缩放数值参数，
 * 不改变命令结构。这保证缩放后的 path 仍可被 desktop.ts 再次
 * 调用 parseSvgPath 正常采样 → Rust 平滑移动。
 */
export function scaleSvgPath(path: string, scale: ScreenshotScale): string {
  let coordIndex = 0;
  const beforeLen = path.length;

  const result = path.replace(/-?\d+(?:\.\d+)?/g, (num) => {
    const val = parseFloat(num);
    if (isNaN(val)) return num;
    // 偶数索引 → X，奇数索引 → Y
    const scaled = coordIndex % 2 === 0
      ? Math.round(val * scale.scaleX)
      : Math.round(val * scale.scaleY);
    coordIndex++;
    return scaled.toString();
  });

  const coordsScaled = coordIndex;
  console.debug(
    `[coordinate-scale] scaleSvgPath — 入参: ${beforeLen} chars, ${coordsScaled / 2} 坐标对`,
    `scale=(${scale.scaleX.toFixed(4)}, ${scale.scaleY.toFixed(4)})`,
    `→ 出参: ${result.length} chars (保留原始命令结构)`,
    `path=${result.substring(0, 120)}${result.length > 120 ? '...' : ''}`,
  );
  return result;
}
