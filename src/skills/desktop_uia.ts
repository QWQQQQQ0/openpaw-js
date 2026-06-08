// Desktop UIA skill — UI Automation semantic element access.
// Extracted from desktop.ts to keep desktop_screen focused on pixel-level operations.

import type { Skill, SkillTool } from './skill';
import { SkillOk, SkillFail } from './skill';
import type { SkillResult, ToolDefinition } from '@/types/skill';
import type { IDesktopService } from '@/interfaces/desktop-service';

export class DesktopUIASkill implements Skill {
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
    this.id = config?.id ?? 'desktop_uia';
    this.name = config?.name ?? 'Desktop UI Automation';
    this.category = config?.category ?? 'Device Automation';
    this.description = config?.description ?? 'Interact with Windows UI elements via UI Automation (semantic, no coordinates needed).';
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
      const errMsg = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
      console.error(`[desktop-uia-skill] ${toolName} threw:`, errMsg);
      return SkillFail(`Tool execution failed: ${e}`);
    }
  }

  private async executeTool(toolName: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    switch (toolName) {
      case 'uia_get_interactive': {
        const hwnd = params['window_hwnd'] as number | undefined;
        const filters: Record<string, unknown> = {};
        if (params['roles']) filters.roles = params['roles'];
        if (params['name_keyword']) filters.name_keyword = params['name_keyword'];
        if (params['onscreen_only']) filters.onscreen_only = params['onscreen_only'];
        if (params['limit']) filters.limit = params['limit'];
        const raw = await this.desktopService.uiaGetInteractive(
          hwnd,
          Object.keys(filters).length > 0 ? filters as { roles?: string[]; name_keyword?: string; onscreen_only?: boolean; limit?: number } : undefined,
        ) as Record<string, unknown>;
        // 精简节点数据：只保留 LLM 需要的字段，减少 token 消耗
        const rawNodes = raw['nodes'] as Array<Record<string, unknown>> | undefined;
        if (rawNodes && rawNodes.length > 0) {
          const slimNodes = rawNodes.map((n) => {
            const slim: Record<string, unknown> = { role: n['role'], name: n['name'] };
            const b = n['bounds'] as Record<string, number> | undefined;
            if (b && b['width'] > 0 && b['height'] > 0) {
              slim.bounds = { left: b['left'], top: b['top'], width: b['width'], height: b['height'] };
            }
            if (n['automation_id']) slim.aid = n['automation_id'];
            return slim;
          });
          return { ...raw, nodes: slimNodes };
        }
        return raw;
      }
      case 'uia_click': {
        const role = String(params['role'] ?? '');
        const name = params['name'] as string | undefined;
        const hwnd = params['window_hwnd'] as number | undefined;
        return await this.desktopService.uiaClick(role, name, hwnd) as Record<string, unknown>;
      }
      case 'uia_type': {
        const text = String(params['text'] ?? '');
        const role = params['role'] as string | undefined;
        const name = params['name'] as string | undefined;
        const hwnd = params['window_hwnd'] as number | undefined;
        return await this.desktopService.uiaTypeText(text, role, name, hwnd) as Record<string, unknown>;
      }
      case 'uia_find_element': {
        const role = String(params['role'] ?? '');
        const name = params['name'] as string | undefined;
        const hwnd = params['window_hwnd'] as number | undefined;
        return await this.desktopService.uiaFindElement(role, name, hwnd) as Record<string, unknown>;
      }
      case 'uia_get_property': {
        const role = String(params['role'] ?? '');
        const name = params['name'] as string | undefined;
        const property = String(params['property'] ?? '');
        const hwnd = params['window_hwnd'] as number | undefined;
        return await this.desktopService.uiaGetProperty(role, name, property, hwnd) as Record<string, unknown>;
      }
      case 'uia_fingerprint': {
        const hwnd = params['window_hwnd'] as number | undefined;
        return await this.desktopService.uiaFingerprint(hwnd) as Record<string, unknown>;
      }
      default:
        throw new Error(`Unknown tool: ${toolName}`);
    }
  }
}
