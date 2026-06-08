// 来源: lib/skills/desktop_screen_skill.dart

import type { Skill, SkillTool } from './skill';
import { SkillOk, SkillFail } from './skill';
import type { SkillResult, ToolDefinition } from '@/types/skill';
import type { IDesktopService } from '@/interfaces/desktop-service';
import { parseSvgPath, defaultDuration } from '@/utils/svg-path';
import { addWindowOffset, type WindowBounds } from '@/utils/coordinate-scale';
import { compressImage } from '@/utils/image';

/**
 * 从全屏 BMP 中裁剪指定区域并 resize 到目标尺寸，输出 JPEG。
 * 先用 compressImage 将 BMP→JPEG（浏览器无法直接加载 BMP），再 canvas 裁剪。
 */
async function cropFromFullScreen(
  fullBmp: string,
  srcX: number,
  srcY: number,
  srcW: number,
  srcH: number,
  targetSize: number,
): Promise<string | null> {
  try {
    // BMP→JPEG，maxDimension 设大值避免缩放，仅转换格式
    const t0 = Date.now();
    const converted = await compressImage(fullBmp, 8192);
    console.debug('[desktop-skill] cropFromFullScreen: converted.dataUrl len=', converted?.dataUrl?.length, 'ms=', Date.now() - t0);
    if (!converted?.dataUrl) { console.warn('[desktop-skill] cropFromFullScreen: compressImage returned empty!'); return null; }

    // DEBUG: 保存全屏 JPEG 到磁盘，检查是否左右翻转
    saveDebugImage('debug_fullscreen', converted.dataUrl);

    const t1 = Date.now();
    const img = await loadImage(converted.dataUrl);
    console.debug('[desktop-skill] cropFromFullScreen: img=', img?.width, 'x', img?.height, 'ms=', Date.now() - t1);
    if (!img) { console.warn('[desktop-skill] cropFromFullScreen: loadImage failed!'); return null; }

    const canvas = document.createElement('canvas');
    canvas.width = targetSize;
    canvas.height = targetSize;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, targetSize, targetSize);
    const result = canvas.toDataURL('image/jpeg', 0.55);
    console.debug('[desktop-skill] cropFromFullScreen: result len=', result?.length);

    // DEBUG: 保存裁剪后的区域截图，检查是否左右翻转
    saveDebugImage('debug_region', result);

    return result;
  } catch (e) {
    console.error('[desktop-skill] cropFromFullScreen error:', e);
    return null;
  }
}

/** DEBUG: 保存调试图片到磁盘（通过 Tauri invoke） */
async function saveDebugImage(label: string, dataUrl: string): Promise<void> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const seq = Date.now();
    await invoke('save_llm_images', {
      images: [{ data: dataUrl, filename: `${label}_${seq}.jpg` }],
    });
    console.debug(`[desktop-skill] debug: saved ${label}_${seq}.jpg`);
  } catch {
    // 非 Tauri 环境或无此命令时静默失败
  }
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export class DesktopScreenSkill implements Skill {
  id: string;
  name: string;
  category: string;
  description: string;
  tools: SkillTool[];
  nameCn?: string;
  descriptionCn?: string;
  categoryCn?: string;
  usage?: string;
  usageCn?: string;

  private desktopService: IDesktopService;

  constructor(desktopService: IDesktopService, config?: { id?: string; name?: string; category?: string; description?: string; tools?: ToolDefinition[]; nameCn?: string; descriptionCn?: string; categoryCn?: string; usage?: string; usageCn?: string }) {
    this.desktopService = desktopService;
    this.id = config?.id ?? 'desktop_screen';
    this.name = config?.name ?? 'Desktop Screen Control';
    this.category = config?.category ?? 'Device Automation';
    this.description = config?.description ?? 'Control the Windows desktop via win32 native APIs.';
    this.tools = config?.tools?.map(t => ({ name: t.name, description: t.description, parameters: t.parameters, nameCn: t.nameCn, descriptionCn: t.descriptionCn })) ?? [];
    if (config?.nameCn) this.nameCn = config.nameCn;
    if (config?.descriptionCn) this.descriptionCn = config.descriptionCn;
    if (config?.categoryCn) this.categoryCn = config.categoryCn;
    if (config?.usage) this.usage = config.usage;
    if (config?.usageCn) this.usageCn = config.usageCn;
  }

  async execute(toolName: string, params: Record<string, unknown>): Promise<SkillResult> {
    try {
      const data = await this.executeTool(toolName, params);
      return SkillOk('Tool executed successfully', data);
    } catch (e) {
      return SkillFail(`Tool execution failed: ${e}`);
    }
  }

  /**
   * 将窗口相对坐标转换为绝对屏幕坐标。
   * 当 params 包含 window_hwnd 时，x/y 被视为窗口相对坐标，
   * 通过 addWindowOffset() 加上窗口左上角屏幕绝对位置。
   */
  private async resolveCoords(params: Record<string, unknown>): Promise<{ x: number; y: number }> {
    const x = Number(params['x'] ?? 0);
    const y = Number(params['y'] ?? 0);
    const hwnd = params['window_hwnd'] as number | undefined;

    if (hwnd && hwnd !== 0) {
      try {
        const bounds = await this.desktopService.getWindowBounds(hwnd);
        return addWindowOffset(x, y, bounds);
      } catch { /* 获取窗口位置失败，使用原始坐标作为绝对坐标 */ }
    }
    return { x, y };
  }

  /**
   * 抓取屏幕绝对坐标 (x, y) 周围的区域截图。
   * 使用 Rust 全屏截图 + 前端 canvas 裁剪，不依赖 Python bridge。
   *
   * 1:1 像素映射：按 scale 放大抓取范围再 resize，输出图中 1px ≈ LLM 坐标 1 单位。
   * 返回 JPEG data URL，失败时返回 null（不影响主操作）。
   */
  private async captureRegionAround(
    x: number,
    y: number,
    size = 150,
    scaleX?: number,
    scaleY?: number,
  ): Promise<string | null> {
    try {
      const sx = (scaleX && scaleX > 0) ? scaleX : 1;
      const sy = (scaleY && scaleY > 0) ? scaleY : 1;
      const captureW = Math.round(size * sx);
      const captureH = Math.round(size * sy);
      const srcX = Math.max(0, x - Math.floor(captureW / 2));
      const srcY = Math.max(0, y - Math.floor(captureH / 2));

      // Rust 全屏截图（BMP）→ BMP→JPEG 转换 → canvas 裁剪 + resize
      const t0 = Date.now();
      const fullBmp = await this.desktopService.screenshot();
      console.debug('[desktop-skill] captureRegionAround: fullBmp len=', fullBmp?.length, 'ms=', Date.now() - t0);

      const t1 = Date.now();
      const cropped = await cropFromFullScreen(fullBmp, srcX, srcY, captureW, captureH, size);
      console.debug('[desktop-skill] captureRegionAround: cropped len=', cropped?.length, 'ms=', Date.now() - t1);
      if (!cropped) console.warn('[desktop-skill] captureRegionAround: cropFromFullScreen returned null!');
      return cropped;
    } catch (e) {
      console.warn('[desktop-skill] captureRegionAround failed:', e);
      return null;
    }
  }

  private async executeTool(toolName: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    // ── Backward compatibility: translate old tool names to unified forms ──
    switch (toolName) {
      case 'desktop_double_click':
        toolName = 'desktop_click';
        params = { ...params, clicks: 2 };
        break;
      case 'desktop_right_click':
        toolName = 'desktop_click';
        params = { ...params, button: 'right' };
        break;
      case 'desktop_middle_click':
        toolName = 'desktop_click';
        params = { ...params, button: 'middle' };
        break;
      case 'desktop_screenshot_window':
        toolName = 'desktop_screenshot';
        params = { hwnd: params['hwnd'] };
        break;
      case 'desktop_screenshot_region':
        toolName = 'desktop_screenshot';
        params = { region: { left: Number(params['left']), top: Number(params['top']), width: Number(params['width']), height: Number(params['height']) } };
        break;
    }

    switch (toolName) {
      // ── Semantic UIA tools ──
      case 'uia_get_interactive': {
        const hwnd = params['window_hwnd'] as number | undefined;
        const filters: Record<string, unknown> = {};
        if (params['roles']) filters.roles = params['roles'];
        if (params['name_keyword']) filters.name_keyword = params['name_keyword'];
        if (params['onscreen_only']) filters.onscreen_only = params['onscreen_only'];
        if (params['limit']) filters.limit = params['limit'];
        return await this.desktopService.uiaGetInteractive(
          hwnd,
          Object.keys(filters).length > 0 ? filters as { roles?: string[]; name_keyword?: string; onscreen_only?: boolean; limit?: number } : undefined,
        ) as Record<string, unknown>;
      }
      case 'uia_click': {
        const clickRole = String(params['role'] ?? '');
        const clickName = params['name'] as string | undefined;
        const clickHwnd = params['window_hwnd'] as number | undefined;
        return await this.desktopService.uiaClick(clickRole, clickName, clickHwnd) as Record<string, unknown>;
      }
      case 'uia_type': {
        const typeText = String(params['text'] ?? '');
        const typeRole = params['role'] as string | undefined;
        const typeName = params['name'] as string | undefined;
        const typeHwnd = params['window_hwnd'] as number | undefined;
        return await this.desktopService.uiaTypeText(typeText, typeRole, typeName, typeHwnd) as Record<string, unknown>;
      }
      case 'uia_find_element': {
        const findRole = String(params['role'] ?? '');
        const findName = params['name'] as string | undefined;
        const findHwnd = params['window_hwnd'] as number | undefined;
        return await this.desktopService.uiaFindElement(findRole, findName, findHwnd) as Record<string, unknown>;
      }
      case 'uia_get_property': {
        const propRole = String(params['role'] ?? '');
        const propName = params['name'] as string | undefined;
        const propName2 = String(params['property'] ?? '');
        const propHwnd = params['window_hwnd'] as number | undefined;
        return await this.desktopService.uiaGetProperty(propRole, propName, propName2, propHwnd) as Record<string, unknown>;
      }
      case 'uia_fingerprint': {
        const fpHwnd = params['window_hwnd'] as number | undefined;
        return await this.desktopService.uiaFingerprint(fpHwnd) as Record<string, unknown>;
      }
      // ── Visual fallback tools ──
      case 'desktop_screenshot': {
        const hwnd = (params['hwnd'] ?? params['window_hwnd']) as number | undefined;
        const region = params['region'] as { left: number; top: number; width: number; height: number } | undefined;

        if (region) {
          return await this.desktopService.screenshotRegionV2(
            Number(region.left), Number(region.top), Number(region.width), Number(region.height),
          ) as Record<string, unknown>;
        }

        let base64: string;
        if (hwnd && hwnd !== 0) {
          base64 = await this.desktopService.screenshotWindow(hwnd);
          return { image_data: base64, format: 'bmp', hwnd, note: 'Window screenshot captured' };
        }
        base64 = await this.desktopService.screenshot();
        return { image_data: base64, format: 'bmp', note: 'Desktop screenshot captured' };
      }
      case 'desktop_list_windows': {
        const windows = await this.desktopService.listWindows();
        return { windows, count: windows.length };
      }
      case 'desktop_focus_window': {
        const ok = await this.desktopService.focusWindow(Number(params['hwnd']));
        // 聚焦目标窗口后浮窗可能被覆盖，重新置顶
        try {
          const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          const floatWin = await getCurrentWebviewWindow();
          await floatWin.setAlwaysOnTop(true);
        } catch { /* 非 Tauri 环境 */ }
        return { success: ok, hwnd: params['hwnd'] };
      }
      case 'desktop_click': {
        // 保存 LLM 原始指定的坐标（窗口相对），用于返回给 LLM 避免坐标反馈循环
        const reqX = Number(params['x'] ?? 0);
        const reqY = Number(params['y'] ?? 0);
        const { x, y } = await this.resolveCoords(params);
        const button = (params['button'] as string) || 'left';
        const clicks = Number(params['clicks'] ?? 1);

        if (button === 'right') {
          await this.desktopService.rightClick(x, y);
          if (clicks === 2) await this.desktopService.rightClick(x, y); // edge case: right double-click
        } else if (button === 'middle') {
          await this.desktopService.middleClick(x, y);
          if (clicks === 2) await this.desktopService.middleClick(x, y);
        } else {
          if (clicks === 2) {
            await this.desktopService.doubleClick(x, y);
          } else {
            await this.desktopService.click(x, y);
          }
        }
        // 返回 LLM 原始请求坐标，避免 LLM 看到屏幕绝对坐标后困惑重试
        const regionScreenshot = await this.captureRegionAround(x, y, 150, params['_scale_x'] as number | undefined, params['_scale_y'] as number | undefined);
        const note = 'Click executed. The attached region_screenshot is 1:1 mapped to your coordinate space — the image center is the click point. If the intended target is off-center, count the pixel offset to correct: next_x = x + offset_x_px, next_y = y + offset_y_px.';
        return { action: 'desktop_click', x: reqX, y: reqY, button, clicks, note, region_screenshot: regionScreenshot };
      }
      case 'desktop_mouse_down': {
        const reqX = Number(params['x'] ?? 0);
        const reqY = Number(params['y'] ?? 0);
        const mdCoords = await this.resolveCoords(params);
        await this.desktopService.mouseDown(
          mdCoords.x, mdCoords.y,
          params['button'] as string | undefined,
        );
        const mdRegion = await this.captureRegionAround(mdCoords.x, mdCoords.y, 150, params['_scale_x'] as number | undefined, params['_scale_y'] as number | undefined);
        return { action: 'desktop_mouse_down', x: reqX, y: reqY, button: params['button'] ?? 'left', note: 'Button pressed. Region screenshot attached — center is the press point, 1:1 pixel mapping.', region_screenshot: mdRegion };
      }
      case 'desktop_mouse_up': {
        const reqX = Number(params['x'] ?? 0);
        const reqY = Number(params['y'] ?? 0);
        const muCoords = await this.resolveCoords(params);
        await this.desktopService.mouseUp(
          muCoords.x, muCoords.y,
          params['button'] as string | undefined,
        );
        const muRegion = await this.captureRegionAround(muCoords.x, muCoords.y, 150, params['_scale_x'] as number | undefined, params['_scale_y'] as number | undefined);
        return { action: 'desktop_mouse_up', x: reqX, y: reqY, button: params['button'] ?? 'left', note: 'Button released. Region screenshot attached — center is the release point, 1:1 pixel mapping.', region_screenshot: muRegion };
      }
      case 'desktop_drag': {
        const reqStartX = Number(params['start_x'] ?? 0);
        const reqStartY = Number(params['start_y'] ?? 0);
        const reqEndX = Number(params['end_x'] ?? 0);
        const reqEndY = Number(params['end_y'] ?? 0);
        const dragFrom = await this.resolveCoords({ x: params['start_x'], y: params['start_y'], window_hwnd: params['window_hwnd'] });
        const dragTo = await this.resolveCoords({ x: params['end_x'], y: params['end_y'], window_hwnd: params['window_hwnd'] });
        await this.desktopService.drag(
          dragFrom.x, dragFrom.y,
          dragTo.x, dragTo.y,
          params['duration_ms'] as number | undefined,
          params['button'] as string | undefined,
        );
        const dragRegion = await this.captureRegionAround(dragTo.x, dragTo.y, 150, params['_scale_x'] as number | undefined, params['_scale_y'] as number | undefined);
        return { action: 'desktop_drag', from: { x: reqStartX, y: reqStartY }, to: { x: reqEndX, y: reqEndY }, note: 'Drag completed. Region screenshot attached — center is the end point, 1:1 pixel mapping.', region_screenshot: dragRegion };
      }
      case 'desktop_move_cursor': {
        const path = String(params['path'] ?? '');
        if (!path) throw new Error('desktop_move_cursor: missing "path" parameter');
        const waypoints = parseSvgPath(path);
        if (waypoints.length === 0) throw new Error('desktop_move_cursor: path produced no waypoints');

        const hwnd = params['window_hwnd'] as number | undefined;
        let adjusted = waypoints;
        if (hwnd && hwnd !== 0) {
          try {
            const bounds = await this.desktopService.getWindowBounds(hwnd);
            if (bounds.width > 0 && bounds.height > 0) {
              adjusted = waypoints.map(p => addWindowOffset(p.x, p.y, bounds));
            }
          } catch { /* use original coords */ }
        }

        const holdButton = params['hold_button'] as string | undefined;
        const duration = (params['duration_ms'] as number | undefined) ?? defaultDuration(waypoints);
        const hasScale = params['_scale_x'] != null;
        console.debug(`[desktop-skill] move_cursor: waypoints=${waypoints.length} hwnd=${hwnd ?? 0} hold=${holdButton ?? 'none'} dur=${duration}ms hasScale=${hasScale} first=(${adjusted[0].x},${adjusted[0].y}) last=(${adjusted[adjusted.length-1].x},${adjusted[adjusted.length-1].y})`);

        const t0 = Date.now();
        await this.desktopService.moveCursor(
          adjusted.map(p => [p.x, p.y]),
          duration,
          holdButton,
        );
        console.debug(`[desktop-skill] move_cursor: Rust returned in ${Date.now() - t0}ms`);

        const held = holdButton ? ` (${holdButton} button held — drawing/dragging)` : ' (no button held — move only)';
        const lastPt = adjusted[adjusted.length - 1];
        const mcRegion = await this.captureRegionAround(lastPt.x, lastPt.y, 150, params['_scale_x'] as number | undefined, params['_scale_y'] as number | undefined);
        return { action: 'desktop_move_cursor', waypoint_count: waypoints.length, hold_button: holdButton ?? null, note: `Cursor moved along ${waypoints.length} waypoints${held}. Region screenshot attached — center is the endpoint, 1:1 pixel mapping.`, region_screenshot: mcRegion };
      }
      case 'desktop_type': {
        await this.desktopService.typeText(String(params['text']));
        return { action: 'desktop_type', text: params['text'], note: 'Text typed. Verify the input appeared correctly with a screenshot.' };
      }
      case 'desktop_press_key': {
        await this.desktopService.pressKey(String(params['key']));
        return { action: 'desktop_press_key', key: params['key'], note: 'Key press executed. Verify the effect with a screenshot before next action.' };
      }
      case 'desktop_key_down': {
        await this.desktopService.keyDown(String(params['key']));
        return { action: 'desktop_key_down', key: params['key'] };
      }
      case 'desktop_key_up': {
        await this.desktopService.keyUp(String(params['key']));
        return { action: 'desktop_key_up', key: params['key'] };
      }
      case 'desktop_scroll': {
        const reqX = Number(params['x'] ?? 0);
        const reqY = Number(params['y'] ?? 0);
        const scCoords = await this.resolveCoords(params);
        await this.desktopService.scroll(scCoords.x, scCoords.y, Number(params['delta']));
        const scRegion = await this.captureRegionAround(scCoords.x, scCoords.y, 150, params['_scale_x'] as number | undefined, params['_scale_y'] as number | undefined);
        return { action: 'desktop_scroll', x: reqX, y: reqY, delta: params['delta'], note: 'Scroll executed. Region screenshot attached — center is the scroll point, 1:1 pixel mapping.', region_screenshot: scRegion };
      }
      case 'desktop_move_mouse': {
        const reqX = Number(params['x'] ?? 0);
        const reqY = Number(params['y'] ?? 0);
        const mmCoords = await this.resolveCoords(params);
        await this.desktopService.moveMouse(mmCoords.x, mmCoords.y);
        const mmRegion = await this.captureRegionAround(mmCoords.x, mmCoords.y, 150, params['_scale_x'] as number | undefined, params['_scale_y'] as number | undefined);
        return { action: 'desktop_move_mouse', x: reqX, y: reqY, note: 'Cursor moved. Region screenshot attached — center is the target position, 1:1 pixel mapping.', region_screenshot: mmRegion };
      }
      case 'desktop_wait': {
        const ms = Math.min(Number(params['milliseconds']) || 1000, 30000);
        await new Promise((r) => setTimeout(r, ms));
        return { action: 'desktop_wait', milliseconds: ms };
      }
      case 'desktop_done':
        return { action: 'desktop_done', message: params['message'] ?? 'Task completed' };
      case 'desktop_list_apps': {
        const apps = await this.desktopService.listApps();
        return { apps, count: apps.length };
      }
      case 'desktop_open_app': {
        const hwnd = await this.desktopService.openApp(String(params['name']));
        // 打开应用后浮窗可能被新窗口覆盖，重新置顶
        try {
          const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
          const floatWin = await getCurrentWebviewWindow();
          await floatWin.setAlwaysOnTop(true);
        } catch { /* 非 Tauri 环境或浮窗未就绪 */ }
        return { action: 'desktop_open_app', name: params['name'], success: hwnd !== 0, hwnd };
      }
      case 'code_exec': {
        const code = String(params['code'] || '');
        if (!code) throw new Error('code_exec: missing "code" parameter');
        const vars: Record<string, unknown> = {};
        // 从 params 中提取 context 变量（Agent 可通过 context 传递中间结果）
        if (params['context'] && typeof params['context'] === 'object') {
          Object.assign(vars, params['context']);
        }
        const sandboxFn = new Function('vars', 'params', code);
        const result = sandboxFn(vars, params);
        return { result, vars };
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}
