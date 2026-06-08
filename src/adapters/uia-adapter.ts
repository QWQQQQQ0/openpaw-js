/**
 * UIA 适配器 —— Windows 桌面环境
 *
 * 功能：
 * 1. 通过 Tauri 调用 Rust 端的 UIA API
 * 2. 将 UIA 元素转换为统一的 UnifiedElement
 * 3. 通过语义（role + name）查找元素
 * 4. 提取表格、列表等结构化数据
 */

import type {
  PlatformAdapter,
  PlatformEvent,
  ElementQuery,
  PlatformAdapterFactory,
} from './platform-adapter';
import type { UnifiedElement, BoundingRect, SemanticPathSegment } from '@/types/unified-element';
import type { SemanticEvent, EventContext } from '@/types/semantic-event';
import type { TableData, ListData } from '@/types/unified-data';
import { UI_ROLE } from '@/types/unified-element';
import { adapterRegistry } from './platform-adapter';
import { desktopService, type WindowInfo } from '@/services/desktop-service';
import { isTauri } from '@/utils/platform';

/**
 * UIA 元素原始数据
 */
interface UIAElementRaw {
  role: string;
  name: string;
  bounds?: { left: number; top: number; right: number; bottom: number };
  hwnd?: number;
  automation_id?: string;
  class_name?: string;
  control_type?: string;
  is_enabled?: boolean;
  is_focused?: boolean;
  children?: UIAElementRaw[];
  properties?: Record<string, unknown>;
}

/**
 * UIA 适配器实现
 */
export class UIAAdapter implements PlatformAdapter {
  readonly platform = 'uia';
  readonly name = 'UIA Adapter';
  readonly description = 'Windows 桌面环境适配器 (UI Automation)';

  private callback: ((event: PlatformEvent) => void) | null = null;
  private isInitialized = false;
  private currentWindow: WindowInfo | null = null;
  private cachedElements: Map<string, UnifiedElement> = new Map();

  // ── 生命周期 ──

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // 检查是否在 Tauri 环境中
    if (!isTauri()) {
      throw new Error('UIA adapter requires Tauri environment');
    }

    this.isInitialized = true;
  }

  async startListening(callback: (event: PlatformEvent) => void): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    this.callback = callback;

    // UIA 适配器通过轮询方式监听（因为 Rust 端没有事件推送机制）
    // 实际实现中可以考虑添加 Rust 端的事件监听
  }

  async stopListening(): Promise<void> {
    this.callback = null;
  }

  isListening(): boolean {
    return this.callback !== null;
  }

  async destroy(): Promise<void> {
    await this.stopListening();
    this.cachedElements.clear();
    this.isInitialized = false;
  }

  // ── 事件转换 ──

  toUnifiedEvent(event: PlatformEvent, context?: EventContext): SemanticEvent {
    return {
      id: crypto.randomUUID(),
      timestamp: event.timestamp,
      action: this.parseAction(event),
      element: event.data.element ? this.uiaToUnified(event.data.element as UIAElementRaw) : null,
      context: context || this.captureContextSync(),
    };
  }

  private parseAction(event: PlatformEvent): SemanticEvent['action'] {
    switch (event.type) {
      case 'click':
        return {
          type: 'click',
          target: {
            coordinate: { x: event.data.x as number, y: event.data.y as number },
            semantic: event.data.element ? {
              role: (event.data.element as UIAElementRaw).role,
              name: (event.data.element as UIAElementRaw).name,
            } : undefined,
          },
        };
      case 'double_click':
        return {
          type: 'double_click',
          target: {
            coordinate: { x: event.data.x as number, y: event.data.y as number },
          },
        };
      case 'right_click':
        return {
          type: 'right_click',
          target: {
            coordinate: { x: event.data.x as number, y: event.data.y as number },
          },
        };
      case 'hotkey':
        return {
          type: 'hotkey',
          params: { key: event.data.key as string },
        };
      case 'type':
        return {
          type: 'type',
          params: { text: event.data.text as string },
        };
      default:
        return { type: event.type as SemanticEvent['action']['type'] };
    }
  }

  private captureContextSync(): EventContext {
    return {
      windowTitle: this.currentWindow?.title || '',
      windowHwnd: this.currentWindow?.hwnd,
      platform: 'uia',
    };
  }

  async captureContext(): Promise<EventContext> {
    // 获取当前活动窗口
    try {
      const windows = await desktopService.listWindows();
      // 选择第一个可见窗口作为活动窗口
      const activeWindow = windows.find(w => w.is_visible) || windows[0];
      this.currentWindow = activeWindow || null;

      return {
        windowTitle: activeWindow?.title || '',
        windowHwnd: activeWindow?.hwnd,
        platform: 'uia',
      };
    } catch {
      return {
        windowTitle: '',
        platform: 'uia',
      };
    }
  }

  // ── 元素转换 ──

  private uiaToUnified(uia: UIAElementRaw): UnifiedElement {
    const bounds = uia.bounds ? {
      x: uia.bounds.left,
      y: uia.bounds.top,
      width: uia.bounds.right - uia.bounds.left,
      height: uia.bounds.bottom - uia.bounds.top,
    } : undefined;

    return {
      identity: {
        role: this.mapUIARole(uia.role || uia.control_type || ''),
        name: uia.name || '',
        description: uia.automation_id || undefined,
      },
      location: {
        semanticPath: this.buildSemanticPath(uia),
        bounds,
      },
      structure: this.detectStructure(uia),
      raw: {
        platform: 'uia',
        data: {
          hwnd: uia.hwnd,
          automationId: uia.automation_id,
          className: uia.class_name,
          controlType: uia.control_type,
          isEnabled: uia.is_enabled,
          isFocused: uia.is_focused,
          properties: uia.properties,
        },
      },
    };
  }

  private mapUIARole(uiaRole: string): string {
    // UIA 控件类型到统一角色的映射
    const roleMap: Record<string, string> = {
      'Button': UI_ROLE.BUTTON,
      'Calendar': UI_ROLE.CALENDAR || 'calendar',
      'CheckBox': UI_ROLE.CHECKBOX,
      'ComboBox': UI_ROLE.COMBOBOX,
      'Edit': UI_ROLE.TEXTBOX,
      'Hyperlink': UI_ROLE.LINK,
      'Image': UI_ROLE.IMAGE,
      'ListItem': UI_ROLE.LIST_ITEM,
      'List': UI_ROLE.LIST,
      'Menu': UI_ROLE.MENU,
      'MenuBar': UI_ROLE.MENU_BAR || 'menubar',
      'MenuItem': UI_ROLE.MENU_ITEM,
      'ProgressBar': UI_ROLE.PROGRESS_BAR,
      'RadioButton': UI_ROLE.RADIO,
      'ScrollBar': UI_ROLE.SCROLLBAR || 'scrollbar',
      'Slider': UI_ROLE.SLIDER,
      'Spinner': UI_ROLE.SPINBUTTON || 'spinbutton',
      'StatusBar': UI_ROLE.STATUS,
      'Tab': UI_ROLE.TAB,
      'TabItem': UI_ROLE.TAB_ITEM || 'tabitem',
      'Table': UI_ROLE.TABLE,
      'Text': UI_ROLE.TEXT,
      'ToolBar': UI_ROLE.TOOLBAR,
      'ToolTip': UI_ROLE.TOOLTIP,
      'Tree': UI_ROLE.TREE,
      'TreeItem': UI_ROLE.TREE_ITEM,
      'DataGrid': UI_ROLE.GRID,
      'DataItem': UI_ROLE.ROW,
      'Document': UI_ROLE.DOCUMENT,
      'Group': UI_ROLE.GROUP,
      'Header': UI_ROLE.COLUMN_HEADER,
      'HeaderItem': UI_ROLE.COLUMN_HEADER,
      'Pane': UI_ROLE.PANEL,
      'Window': UI_ROLE.WINDOW,
    };

    return roleMap[uiaRole] || UI_ROLE.UNKNOWN;
  }

  private buildSemanticPath(uia: UIAElementRaw): SemanticPathSegment[] {
    // UIA 适配器无法获取完整路径，只返回当前元素
    return [{
      role: this.mapUIARole(uia.role || uia.control_type || ''),
      name: uia.name || undefined,
    }];
  }

  private detectStructure(uia: UIAElementRaw): UnifiedElement['structure'] {
    const role = this.mapUIARole(uia.role || uia.control_type || '');

    // 表格结构
    if (role === UI_ROLE.TABLE || role === UI_ROLE.GRID) {
      return {
        container: {
          role: UI_ROLE.TABLE,
          name: uia.name || '',
        },
      };
    }

    // 列表结构
    if (role === UI_ROLE.LIST) {
      return {
        container: {
          role: UI_ROLE.LIST,
          name: uia.name || '',
        },
      };
    }

    // 树结构
    if (role === UI_ROLE.TREE) {
      return {
        container: {
          role: UI_ROLE.TREE,
          name: uia.name || '',
        },
      };
    }

    return undefined;
  }

  // ── 元素查找 ──

  async findElement(query: ElementQuery): Promise<UnifiedElement | null> {
    try {
      // 1. 按 role + name 查找
      if (query.role) {
        const result = await desktopService.uiaFindElement(query.role, query.name);
        if (result && result.success) {
          return this.uiaToUnified(result.element as UIAElementRaw);
        }
      }

      // 2. 按坐标查找
      if (query.bounds) {
        const elements = await this.getInteractiveElements();
        const element = this.findElementAtPoint(elements, query.bounds.x, query.bounds.y);
        if (element) return element;
      }

      return null;
    } catch {
      return null;
    }
  }

  async findElements(query: ElementQuery): Promise<UnifiedElement[]> {
    try {
      const elements = await this.getInteractiveElements(query);
      return elements;
    } catch {
      return [];
    }
  }

  async getElementAtPoint(x: number, y: number): Promise<UnifiedElement | null> {
    try {
      const elements = await this.getInteractiveElements();
      return this.findElementAtPoint(elements, x, y);
    } catch {
      return null;
    }
  }

  async getFocusedElement(): Promise<UnifiedElement | null> {
    try {
      // UIA 无法直接获取焦点元素，返回第一个可见元素
      const elements = await this.getInteractiveElements();
      return elements[0] || null;
    } catch {
      return null;
    }
  }

  private async getInteractiveElements(query?: ElementQuery): Promise<UnifiedElement[]> {
    const filters: Record<string, unknown> = {};

    if (query?.role) {
      filters.roles = [query.role];
    }
    if (query?.name) {
      filters.name_keyword = query.name;
    }
    if (query?.bounds) {
      filters.onscreen_only = true;
    }

    const result = await desktopService.uiaGetInteractive(
      this.currentWindow?.hwnd,
      filters as { roles?: string[]; name_keyword?: string; onscreen_only?: boolean; limit?: number },
    );

    if (!result || !result.nodes) {
      return [];
    }

    const nodes = result.nodes as UIAElementRaw[];
    return nodes.map(node => this.uiaToUnified(node));
  }

  private findElementAtPoint(elements: UnifiedElement[], x: number, y: number): UnifiedElement | null {
    for (const element of elements) {
      const bounds = element.location.bounds;
      if (bounds) {
        if (x >= bounds.x && x <= bounds.x + bounds.width &&
            y >= bounds.y && y <= bounds.y + bounds.height) {
          return element;
        }
      }
    }
    return null;
  }

  // ── 元素操作 ──

  async click(element: UnifiedElement): Promise<void> {
    try {
      const role = element.identity.role;
      const name = element.identity.name;

      // 优先使用 UIA 点击
      await desktopService.uiaClick(role, name || undefined, this.currentWindow?.hwnd);
    } catch (error) {
      // 如果 UIA 点击失败，使用坐标点击
      if (element.location.bounds) {
        const { x, y, width, height } = element.location.bounds;
        await desktopService.click(x + width / 2, y + height / 2);
      } else {
        throw error;
      }
    }
  }

  async doubleClick(element: UnifiedElement): Promise<void> {
    if (element.location.bounds) {
      const { x, y, width, height } = element.location.bounds;
      await desktopService.doubleClick(x + width / 2, y + height / 2);
    }
  }

  async rightClick(element: UnifiedElement): Promise<void> {
    if (element.location.bounds) {
      const { x, y, width, height } = element.location.bounds;
      await desktopService.rightClick(x + width / 2, y + height / 2);
    }
  }

  async hover(element: UnifiedElement): Promise<void> {
    if (element.location.bounds) {
      const { x, y, width, height } = element.location.bounds;
      await desktopService.moveMouse(x + width / 2, y + height / 2);
    }
  }

  async type(element: UnifiedElement, text: string): Promise<void> {
    try {
      // 先点击元素获取焦点
      await this.click(element);

      // 等待一下
      await new Promise(resolve => setTimeout(resolve, 100));

      // 输入文本
      await desktopService.typeText(text);
    } catch (error) {
      throw error;
    }
  }

  async keyPress(key: string, modifiers?: string[]): Promise<void> {
    // 构建完整的按键序列
    let fullKey = '';
    if (modifiers?.includes('Ctrl')) fullKey += 'Ctrl+';
    if (modifiers?.includes('Alt')) fullKey += 'Alt+';
    if (modifiers?.includes('Shift')) fullKey += 'Shift+';
    fullKey += key;

    await desktopService.pressKey(fullKey);
  }

  async scroll(element: UnifiedElement, direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
    if (element.location.bounds) {
      const { x, y, width, height } = element.location.bounds;
      const centerX = x + width / 2;
      const centerY = y + height / 2;

      const delta = direction === 'down' || direction === 'right' ? -amount : amount;
      await desktopService.scroll(centerX, centerY, delta);
    }
  }

  async drag(source: UnifiedElement, target: UnifiedElement | { x: number; y: number }): Promise<void> {
    // UIA 适配器暂不支持拖拽
    throw new Error('Drag not supported in UIA adapter');
  }

  async focus(element: UnifiedElement): Promise<void> {
    // 尝试通过点击来聚焦
    await this.click(element);
  }

  // ── 数据操作 ──

  async copy(element?: UnifiedElement): Promise<string> {
    if (element) {
      await this.click(element);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // 模拟 Ctrl+C
    await desktopService.pressKey('Ctrl+C');
    await new Promise(resolve => setTimeout(resolve, 200));

    // UIA 适配器无法直接获取剪贴板内容
    // 需要通过其他方式获取
    return '';
  }

  async paste(element?: UnifiedElement, data?: string): Promise<void> {
    if (element) {
      await this.click(element);
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    // 如果有数据，先写入剪贴板
    if (data) {
      // UIA 适配器无法直接写入剪贴板
      // 需要通过其他方式实现
    }

    // 模拟 Ctrl+V
    await desktopService.pressKey('Ctrl+V');
  }

  async select(element: UnifiedElement): Promise<void> {
    await this.click(element);
    await new Promise(resolve => setTimeout(resolve, 100));
    await desktopService.pressKey('Ctrl+A');
  }

  async extractData(element: UnifiedElement): Promise<unknown> {
    // UIA 适配器无法直接提取元素数据
    // 需要通过 OCR 或其他方式
    return element.identity.name;
  }

  async extractTable(element: UnifiedElement): Promise<TableData> {
    // UIA 适配器暂不支持表格提取
    // 需要通过 OCR 或其他方式
    return { headers: [], rows: [] };
  }

  async extractList(element: UnifiedElement): Promise<ListData> {
    // UIA 适配器暂不支持列表提取
    // 需要通过其他方式
    return { items: [] };
  }

  // ── 上下文操作 ──

  async getContext(): Promise<EventContext> {
    return this.captureContext();
  }

  async getWindowTitle(): Promise<string> {
    return this.currentWindow?.title || '';
  }

  async takeScreenshot(): Promise<string> {
    return await desktopService.screenshot();
  }

  // ── 辅助方法 ──

  /**
   * 更新当前窗口
   */
  async updateCurrentWindow(hwnd?: number): Promise<void> {
    if (hwnd) {
      await desktopService.focusWindow(hwnd);
    }

    const windows = await desktopService.listWindows();
    this.currentWindow = hwnd
      ? windows.find(w => w.hwnd === hwnd) || null
      : windows.find(w => w.is_visible) || windows[0] || null;
  }

  /**
   * 获取当前窗口
   */
  getCurrentWindow(): WindowInfo | null {
    return this.currentWindow;
  }
}

/**
 * UIA 适配器工厂
 */
class UIAAdapterFactory implements PlatformAdapterFactory {
  create(): PlatformAdapter {
    return new UIAAdapter();
  }

  async isAvailable(): Promise<boolean> {
    return isTauri();
  }

  getPriority(): number {
    return 20; // 桌面环境优先级
  }
}

// 注册 UIA 适配器
adapterRegistry.register('uia', new UIAAdapterFactory());
