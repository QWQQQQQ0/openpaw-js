// 来源: lib/skills/web_screen_skill.dart

import type { Skill, SkillTool } from './skill';
import { SkillOk, SkillFail } from './skill';
import type { SkillResult, ToolDefinition } from '@/types/skill';
import type { IExtensionBridge } from '@/interfaces/extension-bridge';
import type { IWebScreenService } from '@/interfaces/web-screen-service';
import type { IDesktopService } from '@/interfaces/desktop-service';

export class WebScreenSkill implements Skill {
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

  private extensionBridge: IExtensionBridge;
  private webScreenService: IWebScreenService;
  private desktopService: IDesktopService;

  constructor(
    extensionBridge: IExtensionBridge,
    webScreenService: IWebScreenService,
    desktopService: IDesktopService,
    config?: { id?: string; name?: string; category?: string; description?: string; tools?: ToolDefinition[]; nameCn?: string; descriptionCn?: string; categoryCn?: string; usage?: string; usageCn?: string }
  ) {
    this.extensionBridge = extensionBridge;
    this.webScreenService = webScreenService;
    this.desktopService = desktopService;
    this.id = config?.id ?? 'web_screen';
    this.name = config?.name ?? 'Web Screen Control';
    this.category = config?.category ?? 'Device Automation';
    this.description = config?.description ?? 'View and control web pages via browser extension or iframe.';
    this.tools = config?.tools?.map(t => ({ name: t.name, description: t.description, parameters: t.parameters, nameCn: t.nameCn, descriptionCn: t.descriptionCn })) ?? [];
    if (config?.nameCn) this.nameCn = config.nameCn;
    if (config?.descriptionCn) this.descriptionCn = config.descriptionCn;
    if (config?.categoryCn) this.categoryCn = config.categoryCn;
    if (config?.usage) this.usage = config.usage;
    if (config?.usageCn) this.usageCn = config.usageCn;
  }

  async execute(toolName: string, params: Record<string, unknown>): Promise<SkillResult> {
    // ── Playwright tools (Tauri → Python bridge) ──
    if (toolName.startsWith('web_pw_')) {
      return this.executePlaywright(toolName, params);
    }

    // Generic tools that don't need a browser backend
    switch (toolName) {
      case 'web_wait': {
        const ms = Math.min(Number(params['durationMs']) || 1000, 10000);
        await new Promise((r) => setTimeout(r, ms));
        return SkillOk(`Waited ${ms}ms`, { action: 'wait', durationMs: ms });
      }
      case 'web_done': {
        const summary = (params['summary'] as string) ?? 'Task completed';
        return SkillOk(summary, { action: 'done', message: summary });
      }
    }

    // Legacy tools: prefer iframe, then extension
    if (this.webScreenService.hasIframe) {
      return this.executeIframe(toolName, params);
    }
    if (this.extensionBridge.isConnected) {
      return this.executeExtension(toolName, params);
    }
    return SkillFail(
      'No web context available. Open a generated app or connect the browser extension.',
    );
  }

  /** Execute Playwright-backed web tools via Tauri Python bridge. */
  private async executePlaywright(toolName: string, params: Record<string, unknown>): Promise<SkillResult> {
    try {
      let data: Record<string, unknown> | undefined;

      switch (toolName) {
        case 'web_pw_launch':
          data = await this.desktopService.webPwLaunch(params['headless'] as boolean | undefined);
          break;
        case 'web_pw_navigate':
          data = await this.desktopService.webPwNavigate(String(params['url']));
          break;
        case 'web_pw_get_interactive':
          data = await this.desktopService.webPwGetInteractive();
          break;
        case 'web_pw_click_selector':
          data = await this.desktopService.webPwClickSelector(String(params['selector']));
          break;
        case 'web_pw_click_role':
          data = await this.desktopService.webPwClickRole(String(params['role']), params['name'] as string | undefined);
          break;
        case 'web_pw_fill':
          data = await this.desktopService.webPwFill(String(params['selector']), String(params['text']));
          break;
        case 'web_pw_scroll':
          data = await this.desktopService.webPwScroll(params['delta_y'] as number | undefined);
          break;
        case 'web_pw_close':
          data = await this.desktopService.webPwClose();
          break;
        default:
          return SkillFail(`Unknown Playwright tool: ${toolName}`);
      }

      return SkillOk(`${toolName} succeeded`, data ?? {});
    } catch (e) {
      const errMsg = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
      console.error(`[web-skill] ${toolName} threw:`, errMsg);
      return SkillFail(`Playwright tool ${toolName} failed: ${e}`);
    }
  }

  // ══ Extension backend ══

  private async executeExtension(toolName: string, params: Record<string, unknown>): Promise<SkillResult> {
    switch (toolName) {
      case 'web_screenshot': return this.extScreenshot();
      case 'web_get_ui': return this.extGetUI();
      case 'web_click': return this.extClick(params);
      case 'web_click_element': return this.extClickElement(params);
      case 'web_type': return this.extType(params);
      case 'web_fill': return this.extFill(params);
      case 'web_scroll': return this.extScroll(params);
      case 'web_scroll_into_view': return this.extScrollIntoView(params);
      case 'web_press_key': return this.extPressKey(params);
      case 'web_navigate': return this.extNavigate(params);
      case 'web_extract': return this.extExtract(params);
      case 'web_list_tabs': return this.extListTabs();
      default: return SkillFail(`Unknown tool: ${toolName}`);
    }
  }

  private async extScreenshot(): Promise<SkillResult> {
    const r = await this.extensionBridge.captureScreen();
    if (r['success'] !== true) return SkillFail(r['error'] as string ?? 'Screenshot failed');
    return SkillOk('Screenshot captured', { screenshot: r['screenshot'] });
  }

  private async extGetUI(): Promise<SkillResult> {
    const r = await this.extensionBridge.getDOM();
    if (r['success'] !== true) return SkillFail(r['error'] as string ?? 'Failed');
    const nodes = (r['nodes'] as Array<Record<string, unknown>>) ?? [];
    const interactiveCount = nodes.filter((n) => n['clickable'] === true).length;
    return SkillOk(`${nodes.length} interactive nodes`, { nodes, interactiveCount });
  }

  private async extClick(p: Record<string, unknown>): Promise<SkillResult> {
    const r = await this.extensionBridge.executeAction(null, { type: 'click', x: Number(p['x']), y: Number(p['y']) });
    if (r['success'] !== true && r['ok'] !== true) return SkillFail(r['error'] as string ?? 'Click failed');
    return SkillOk(`Clicked at (${p['x']},${p['y']})`, { info: r['info'] });
  }

  private async extClickElement(p: Record<string, unknown>): Promise<SkillResult> {
    const r = await this.extensionBridge.executeAction(null, { type: 'click_element', selector: p['selector'] as string });
    if (r['success'] !== true && r['ok'] !== true) return SkillFail(r['error'] as string ?? 'Click failed');
    return SkillOk(`Clicked ${p['selector']}`, { info: r['info'] });
  }

  private async extType(p: Record<string, unknown>): Promise<SkillResult> {
    const r = await this.extensionBridge.executeAction(null, { type: 'type', text: p['text'] as string });
    if (r['success'] !== true && r['ok'] !== true) return SkillFail(r['error'] as string ?? 'Type failed');
    return SkillOk(`Typed "${p['text']}"`);
  }

  private async extFill(p: Record<string, unknown>): Promise<SkillResult> {
    const r = await this.extensionBridge.executeAction(null, { type: 'fill', selector: p['selector'] as string, text: p['text'] as string });
    if (r['success'] !== true && r['ok'] !== true) return SkillFail(r['error'] as string ?? 'Fill failed');
    return SkillOk(`Filled ${p['selector']}`);
  }

  private async extScroll(p: Record<string, unknown>): Promise<SkillResult> {
    const dx = Number(p['dx']) || 0;
    const dy = Number(p['dy']) || 0;
    const r = await this.extensionBridge.executeAction(null, { type: 'scroll', dx, dy });
    if (r['success'] !== true && r['ok'] !== true) return SkillFail(r['error'] as string ?? 'Scroll failed');
    return SkillOk(r['message'] as string ?? 'Scrolled');
  }

  private async extScrollIntoView(p: Record<string, unknown>): Promise<SkillResult> {
    const r = await this.extensionBridge.executeAction(null, { type: 'scroll_into_view', selector: p['selector'] as string });
    if (r['success'] !== true && r['ok'] !== true) return SkillFail(r['error'] as string ?? 'Scroll failed');
    return SkillOk(`Scrolled to ${p['selector']}`);
  }

  private async extPressKey(p: Record<string, unknown>): Promise<SkillResult> {
    const r = await this.extensionBridge.executeAction(null, { type: 'press_key', key: p['key'] as string });
    if (r['success'] !== true && r['ok'] !== true) return SkillFail(r['error'] as string ?? 'Key press failed');
    return SkillOk(`Pressed ${p['key']}`);
  }

  private async extNavigate(p: Record<string, unknown>): Promise<SkillResult> {
    const r = await this.extensionBridge.openURL(p['url'] as string);
    if (r['success'] !== true) return SkillFail(r['error'] as string ?? 'Navigation failed');
    return SkillOk(`Navigated to ${p['url']}`, { tabId: r['tabId'] });
  }

  private async extExtract(p: Record<string, unknown>): Promise<SkillResult> {
    const r = await this.extensionBridge.executeAction(null, { type: 'extract', selector: p['selector'] as string });
    if (r['success'] !== true && r['ok'] !== true) return SkillFail(r['error'] as string ?? 'Extract failed');
    return SkillOk('Extracted text', { text: r['text'] });
  }

  private async extListTabs(): Promise<SkillResult> {
    const r = await this.extensionBridge.listTabs();
    if (r['success'] !== true) return SkillFail(r['error'] as string ?? 'Failed');
    const tabs = (r['tabs'] as Array<unknown>) ?? [];
    return SkillOk(`${tabs.length} tabs`, { tabs });
  }

  // ══ Iframe backend (generated apps) ══

  private async executeIframe(toolName: string, params: Record<string, unknown>): Promise<SkillResult> {
    switch (toolName) {
      case 'web_get_ui': return this.iframeGetUI();
      case 'web_click': return this.iframeClick(params);
      case 'web_type': return this.iframeType(params);
      case 'web_scroll': return this.iframeScroll(params);
      default: return SkillFail(`Unknown tool for iframe: ${toolName}`);
    }
  }

  private async iframeGetUI(): Promise<SkillResult> {
    const r = await this.webScreenService.getUI();
    if (!r) return SkillFail('Failed to get UI tree');
    const nodes = (r['nodes'] as Array<Record<string, unknown>>) ?? [];
    const count = this.countNodes(nodes);
    return SkillOk(`${count} interactive nodes`, { uiTree: { nodes }, interactiveCount: count });
  }

  private async iframeClick(p: Record<string, unknown>): Promise<SkillResult> {
    const r = await this.webScreenService.click(Number(p['x']), Number(p['y']));
    if (r['ok'] !== true) return SkillFail(r['error'] as string ?? 'Click failed');
    const info = r['info'];
    const desc = info ? `Clicked ${(info as Record<string, unknown>)['tag']} at (${p['x']},${p['y']})` : `Clicked at (${p['x']},${p['y']})`;
    return SkillOk(desc, { info });
  }

  private async iframeType(p: Record<string, unknown>): Promise<SkillResult> {
    const r = await this.webScreenService.typeText(p['text'] as string);
    if (r['ok'] !== true) return SkillFail(r['error'] as string ?? 'Type failed');
    return SkillOk(r['message'] as string ?? `Typed "${p['text']}"`);
  }

  private async iframeScroll(p: Record<string, unknown>): Promise<SkillResult> {
    const r = await this.webScreenService.scroll(Number(p['dx']) || 0, Number(p['dy']) || 0);
    if (r['ok'] !== true) return SkillFail(r['error'] as string ?? 'Scroll failed');
    return SkillOk(r['message'] as string ?? 'Scrolled');
  }

  private countNodes(nodes: Array<Record<string, unknown>>): number {
    let count = 0;
    for (const n of nodes) {
      if (n['clickable'] === true) count++;
      const children = n['children'] as Array<Record<string, unknown>> | undefined;
      if (children) count += this.countNodes(children);
    }
    return count;
  }
}
