/**
 * DOM 适配器 —— 浏览器环境
 *
 * 功能：
 * 1. 监听浏览器事件（click, keydown, input 等）
 * 2. 将 DOM 元素转换为统一的 UnifiedElement
 * 3. 通过语义（role + name）或 xpath 查找元素
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

/**
 * DOM 适配器实现
 */
export class DOMAdapter implements PlatformAdapter {
  readonly platform = 'dom';
  readonly name = 'DOM Adapter';
  readonly description = '浏览器环境适配器';

  private callback: ((event: PlatformEvent) => void) | null = null;
  private isInitialized = false;
  private eventHandlers: Map<string, EventListener> = new Map();

  // ── 生命周期 ──

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    // 绑定事件处理器
    this.eventHandlers.set('click', this.handleClick);
    this.eventHandlers.set('dblclick', this.handleDoubleClick);
    this.eventHandlers.set('contextmenu', this.handleContextMenu);
    this.eventHandlers.set('keydown', this.handleKeydown);
    this.eventHandlers.set('input', this.handleInput);
    this.eventHandlers.set('scroll', this.handleScroll);
    this.eventHandlers.set('focusin', this.handleFocusIn);

    this.isInitialized = true;
  }

  async startListening(callback: (event: PlatformEvent) => void): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    this.callback = callback;

    // 注册事件监听器
    for (const [eventType, handler] of this.eventHandlers) {
      document.addEventListener(eventType, handler, true);
    }
  }

  async stopListening(): Promise<void> {
    // 移除事件监听器
    for (const [eventType, handler] of this.eventHandlers) {
      document.removeEventListener(eventType, handler, true);
    }

    this.callback = null;
  }

  isListening(): boolean {
    return this.callback !== null;
  }

  async destroy(): Promise<void> {
    await this.stopListening();
    this.eventHandlers.clear();
    this.isInitialized = false;
  }

  // ── 事件处理器 ──

  private handleClick = (e: Event) => {
    const mouseEvent = e as MouseEvent;
    const target = mouseEvent.target as Element;

    this.callback?.({
      platform: 'dom',
      type: 'click',
      data: {
        x: mouseEvent.clientX,
        y: mouseEvent.clientY,
        button: 'left',
        element: target,
        altKey: mouseEvent.altKey,
        ctrlKey: mouseEvent.ctrlKey,
        shiftKey: mouseEvent.shiftKey,
        metaKey: mouseEvent.metaKey,
      },
      timestamp: Date.now(),
    });
  };

  private handleDoubleClick = (e: Event) => {
    const mouseEvent = e as MouseEvent;
    const target = mouseEvent.target as Element;

    this.callback?.({
      platform: 'dom',
      type: 'double_click',
      data: {
        x: mouseEvent.clientX,
        y: mouseEvent.clientY,
        element: target,
      },
      timestamp: Date.now(),
    });
  };

  private handleContextMenu = (e: Event) => {
    const mouseEvent = e as MouseEvent;
    const target = mouseEvent.target as Element;

    this.callback?.({
      platform: 'dom',
      type: 'right_click',
      data: {
        x: mouseEvent.clientX,
        y: mouseEvent.clientY,
        element: target,
      },
      timestamp: Date.now(),
    });
  };

  private handleKeydown = (e: Event) => {
    const keyEvent = e as KeyboardEvent;

    // 检测组合键
    const modifiers: string[] = [];
    if (keyEvent.ctrlKey) modifiers.push('Ctrl');
    if (keyEvent.altKey) modifiers.push('Alt');
    if (keyEvent.shiftKey) modifiers.push('Shift');
    if (keyEvent.metaKey) modifiers.push('Meta');

    if (modifiers.length > 0 || ['Tab', 'Enter', 'Escape', 'Delete', 'Backspace', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].includes(keyEvent.key)) {
      const key = modifiers.length > 0 ? [...modifiers, keyEvent.key].join('+') : keyEvent.key;

      this.callback?.({
        platform: 'dom',
        type: 'hotkey',
        data: {
          key,
          rawKey: keyEvent.key,
          modifiers,
          element: keyEvent.target,
        },
        timestamp: Date.now(),
      });
    }
  };

  private handleInput = (e: Event) => {
    const inputEvent = e as InputEvent;
    const target = inputEvent.target as HTMLInputElement;

    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      this.callback?.({
        platform: 'dom',
        type: 'input',
        data: {
          value: target.value || target.textContent,
          element: target,
        },
        timestamp: Date.now(),
      });
    }
  };

  private handleScroll = (e: Event) => {
    const target = e.target as Element;

    this.callback?.({
      platform: 'dom',
      type: 'scroll',
      data: {
        scrollTop: target.scrollTop,
        scrollLeft: target.scrollLeft,
        element: target,
      },
      timestamp: Date.now(),
    });
  };

  private handleFocusIn = (e: Event) => {
    const target = e.target as Element;

    this.callback?.({
      platform: 'dom',
      type: 'focus',
      data: {
        element: target,
      },
      timestamp: Date.now(),
    });
  };

  // ── 事件转换 ──

  toUnifiedEvent(event: PlatformEvent, context?: EventContext): SemanticEvent {
    const element = event.data.element as Element | null;

    return {
      id: crypto.randomUUID(),
      timestamp: event.timestamp,
      action: this.parseAction(event),
      element: element ? this.elementToUnified(element) : null,
      context: context || this.captureContext(),
    };
  }

  private parseAction(event: PlatformEvent): SemanticEvent['action'] {
    switch (event.type) {
      case 'click':
        return {
          type: 'click',
          target: {
            coordinate: { x: event.data.x as number, y: event.data.y as number },
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
      case 'input':
        return {
          type: 'type',
          params: { text: event.data.value as string },
        };
      case 'scroll':
        return {
          type: 'scroll',
          params: {
            direction: (event.data.scrollTop as number) > 0 ? 'down' : 'up',
            amount: Math.abs(event.data.scrollTop as number),
          },
        };
      case 'focus':
        return {
          type: 'focus',
        };
      default:
        return { type: event.type as SemanticEvent['action']['type'] };
    }
  }

  private captureContext(): EventContext {
    return {
      windowTitle: document.title,
      pageUrl: window.location.href,
      platform: 'dom',
    };
  }

  // ── 元素转换 ──

  private elementToUnified(el: Element): UnifiedElement {
    return {
      identity: {
        role: this.detectRole(el),
        name: this.detectName(el),
        description: el.getAttribute('aria-label') || el.getAttribute('title') || undefined,
      },
      location: {
        semanticPath: this.getSemanticPath(el),
        precisePath: this.getXPath(el),
        bounds: this.getBoundingRect(el),
      },
      structure: this.detectStructure(el),
      raw: {
        platform: 'dom',
        data: {
          tagName: el.tagName,
          id: el.id,
          className: el.className,
          attributes: this.getAttributes(el),
        },
      },
    };
  }

  private detectRole(el: Element): string {
    // 优先使用 ARIA role
    const ariaRole = el.getAttribute('role');
    if (ariaRole) return ariaRole;

    // 根据标签推断
    const tagRoleMap: Record<string, string> = {
      'BUTTON': UI_ROLE.BUTTON,
      'A': UI_ROLE.LINK,
      'INPUT': this.getInputRole(el as HTMLInputElement),
      'SELECT': UI_ROLE.COMBOBOX,
      'TEXTAREA': UI_ROLE.TEXTBOX,
      'TD': UI_ROLE.CELL,
      'TH': UI_ROLE.COLUMN_HEADER,
      'TR': UI_ROLE.ROW,
      'TABLE': UI_ROLE.TABLE,
      'LI': UI_ROLE.LIST_ITEM,
      'UL': UI_ROLE.LIST,
      'OL': UI_ROLE.LIST,
      'IMG': UI_ROLE.IMAGE,
      'H1': UI_ROLE.HEADING,
      'H2': UI_ROLE.HEADING,
      'H3': UI_ROLE.HEADING,
      'H4': UI_ROLE.HEADING,
      'H5': UI_ROLE.HEADING,
      'H6': UI_ROLE.HEADING,
      'P': UI_ROLE.PARAGRAPH,
      'SPAN': UI_ROLE.TEXT,
      'DIV': UI_ROLE.GROUP,
      'NAV': UI_ROLE.NAVIGATION || 'navigation',
      'MAIN': UI_ROLE.APPLICATION,
      'DIALOG': UI_ROLE.DIALOG,
      'FORM': UI_ROLE.FORM || 'form',
      'LABEL': UI_ROLE.LABEL,
      'PROGRESS': UI_ROLE.PROGRESS_BAR,
    };

    return tagRoleMap[el.tagName] || UI_ROLE.UNKNOWN;
  }

  private getInputRole(input: HTMLInputElement): string {
    const type = input.type?.toLowerCase();
    switch (type) {
      case 'checkbox':
        return UI_ROLE.CHECKBOX;
      case 'radio':
        return UI_ROLE.RADIO;
      case 'range':
        return UI_ROLE.SLIDER;
      case 'submit':
      case 'button':
      case 'reset':
        return UI_ROLE.BUTTON;
      default:
        return UI_ROLE.TEXTBOX;
    }
  }

  private detectName(el: Element): string {
    // 优先使用 ARIA 标签
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    // 使用 aria-labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const labelEl = document.getElementById(labelledBy);
      if (labelEl) return labelEl.textContent?.trim() || '';
    }

    // 使用 label
    if (el.id) {
      const label = document.querySelector(`label[for="${el.id}"]`);
      if (label) return label.textContent?.trim() || '';
    }

    // 使用 title
    const title = el.getAttribute('title');
    if (title) return title;

    // 使用 placeholder
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;

    // 使用 alt
    const alt = el.getAttribute('alt');
    if (alt) return alt;

    // 使用文本内容（截取前 100 字符）
    const text = el.textContent?.trim();
    if (text && text.length > 0) {
      // 对于表格单元格，直接返回文本
      if (el.tagName === 'TD' || el.tagName === 'TH') {
        return text.substring(0, 100);
      }
      // 对于其他元素，只返回直接文本节点
      const directText = Array.from(el.childNodes)
        .filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      if (directText) return directText.substring(0, 100);
    }

    return '';
  }

  private getSemanticPath(el: Element): SemanticPathSegment[] {
    const path: SemanticPathSegment[] = [];
    let current: Element | null = el;

    while (current && current !== document.body && current !== document.documentElement) {
      const role = this.detectRole(current);
      const name = this.detectName(current);

      // 计算同级索引
      const siblings = current.parentElement?.children;
      const index = siblings ? Array.from(siblings).filter(s => s.tagName === current!.tagName).indexOf(current) : 0;

      path.unshift({ role, name: name || undefined, index });

      current = current.parentElement;
    }

    return path;
  }

  private getXPath(el: Element): string {
    const parts: string[] = [];
    let current: Element | null = el;

    while (current && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const index = current.parentElement
        ? Array.from(current.parentElement.children).filter(c => c.tagName === current!.tagName).indexOf(current) + 1
        : 1;

      parts.unshift(index > 1 ? `${tag}[${index}]` : tag);
      current = current.parentElement;
    }

    return '/' + parts.join('/');
  }

  private getBoundingRect(el: Element): BoundingRect {
    const rect = el.getBoundingClientRect();
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    };
  }

  private getAttributes(el: Element): Record<string, string> {
    const attrs: Record<string, string> = {};
    for (const attr of el.attributes) {
      attrs[attr.name] = attr.value;
    }
    return attrs;
  }

  private detectStructure(el: Element): UnifiedElement['structure'] {
    // 检测是否在表格中
    const table = el.closest('table');
    if (table) {
      const row = el.closest('tr');
      const cell = el.closest('td, th');

      return {
        container: {
          role: UI_ROLE.TABLE,
          name: table.getAttribute('aria-label') || '',
          columns: Array.from(table.querySelectorAll('th')).map(th => th.textContent?.trim() || ''),
          rows: table.querySelectorAll('tr').length,
        },
        position: {
          row: row ? Array.from(row.parentElement?.children || []).indexOf(row) : undefined,
          column: cell && row ? Array.from(row.children).indexOf(cell) : undefined,
        },
      };
    }

    // 检测是否在列表中
    const list = el.closest('ul, ol, [role="list"]');
    if (list) {
      const item = el.closest('li, [role="listitem"]');
      return {
        container: {
          role: UI_ROLE.LIST,
          name: list.getAttribute('aria-label') || '',
        },
        position: {
          index: item ? Array.from(list.children).filter(c => c.tagName === 'LI').indexOf(item) : undefined,
        },
      };
    }

    // 检测是否在 grid 中
    const grid = el.closest('[role="grid"], [role="treegrid"]');
    if (grid) {
      const row = el.closest('[role="row"]');
      const cell = el.closest('[role="gridcell"], [role="cell"]');

      return {
        container: {
          role: UI_ROLE.GRID,
          name: grid.getAttribute('aria-label') || '',
        },
        position: {
          row: row ? Array.from(grid.querySelectorAll('[role="row"]')).indexOf(row) : undefined,
          column: cell && row ? Array.from(row.querySelectorAll('[role="gridcell"], [role="cell"]')).indexOf(cell) : undefined,
        },
      };
    }

    return undefined;
  }

  // ── 元素查找 ──

  async findElement(query: ElementQuery): Promise<UnifiedElement | null> {
    // 1. 尝试 xpath
    if (query.path) {
      const result = document.evaluate(
        query.path,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      if (result.singleNodeValue) {
        return this.elementToUnified(result.singleNodeValue as Element);
      }
    }

    // 2. 尝试语义匹配
    if (query.role) {
      const elements = document.querySelectorAll(`[role="${query.role}"]`);
      for (const el of elements) {
        const name = this.detectName(el);
        if (!query.name || name.includes(query.name) || query.name.includes(name)) {
          return this.elementToUnified(el);
        }
      }
    }

    // 3. 尝试属性匹配
    if (query.attributes) {
      let selector = '';
      for (const [key, value] of Object.entries(query.attributes)) {
        selector += `[${key}="${value}"]`;
      }
      if (selector) {
        const el = document.querySelector(selector);
        if (el) return this.elementToUnified(el);
      }
    }

    // 4. 尝试文本匹配
    if (query.text) {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_ELEMENT,
      );

      while (walker.nextNode()) {
        const el = walker.currentNode as Element;
        if (el.textContent?.includes(query.text)) {
          return this.elementToUnified(el);
        }
      }
    }

    // 5. 尝试坐标查找
    if (query.bounds) {
      const el = document.elementFromPoint(query.bounds.x, query.bounds.y);
      if (el) return this.elementToUnified(el);
    }

    return null;
  }

  async findElements(query: ElementQuery): Promise<UnifiedElement[]> {
    const results: UnifiedElement[] = [];

    // 1. 按 role 查找
    if (query.role) {
      const elements = document.querySelectorAll(`[role="${query.role}"]`);
      for (const el of elements) {
        const name = this.detectName(el);
        if (!query.name || name.includes(query.name) || query.name.includes(name)) {
          results.push(this.elementToUnified(el));
        }
      }
    }

    // 2. 按标签查找
    if (query.attributes?.tagName) {
      const elements = document.querySelectorAll(query.attributes.tagName);
      for (const el of elements) {
        results.push(this.elementToUnified(el));
      }
    }

    // 3. 按选择器查找
    if (query.path) {
      try {
        const elements = document.querySelectorAll(query.path);
        for (const el of elements) {
          results.push(this.elementToUnified(el));
        }
      } catch {
        // xpath 不支持 querySelectorAll，跳过
      }
    }

    return results;
  }

  async getElementAtPoint(x: number, y: number): Promise<UnifiedElement | null> {
    const el = document.elementFromPoint(x, y);
    return el ? this.elementToUnified(el) : null;
  }

  async getFocusedElement(): Promise<UnifiedElement | null> {
    const el = document.activeElement;
    return el ? this.elementToUnified(el) : null;
  }

  // ── 元素操作 ──

  async click(element: UnifiedElement): Promise<void> {
    const el = await this.findElementByUnified(element);
    if (el) {
      (el as HTMLElement).click();
    }
  }

  async doubleClick(element: UnifiedElement): Promise<void> {
    const el = await this.findElementByUnified(element);
    if (el) {
      const event = new MouseEvent('dblclick', { bubbles: true });
      el.dispatchEvent(event);
    }
  }

  async rightClick(element: UnifiedElement): Promise<void> {
    const el = await this.findElementByUnified(element);
    if (el) {
      const event = new MouseEvent('contextmenu', { bubbles: true, button: 2 });
      el.dispatchEvent(event);
    }
  }

  async hover(element: UnifiedElement): Promise<void> {
    const el = await this.findElementByUnified(element);
    if (el) {
      const event = new MouseEvent('mouseenter', { bubbles: true });
      el.dispatchEvent(event);
    }
  }

  async type(element: UnifiedElement, text: string): Promise<void> {
    const el = await this.findElementByUnified(element) as HTMLInputElement;
    if (el) {
      // 聚焦元素
      el.focus();

      // 设置值
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  }

  async keyPress(key: string, modifiers?: string[]): Promise<void> {
    const keyEvent = new KeyboardEvent('keydown', {
      key: key.replace(/^(Ctrl\+|Alt\+|Shift\+|Meta\+)/, ''),
      ctrlKey: modifiers?.includes('Ctrl') || key.startsWith('Ctrl+'),
      altKey: modifiers?.includes('Alt') || key.includes('+Alt+'),
      shiftKey: modifiers?.includes('Shift') || key.includes('+Shift+'),
      metaKey: modifiers?.includes('Meta') || key.includes('+Meta+'),
      bubbles: true,
    });
    document.activeElement?.dispatchEvent(keyEvent);
  }

  async scroll(element: UnifiedElement, direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void> {
    const el = await this.findElementByUnified(element);
    if (el) {
      const scrollOptions: ScrollToOptions = {
        behavior: 'smooth',
      };

      switch (direction) {
        case 'up':
          scrollOptions.top = -amount;
          break;
        case 'down':
          scrollOptions.top = amount;
          break;
        case 'left':
          scrollOptions.left = -amount;
          break;
        case 'right':
          scrollOptions.left = amount;
          break;
      }

      el.scrollBy(scrollOptions);
    }
  }

  async drag(source: UnifiedElement, target: UnifiedElement | { x: number; y: number }): Promise<void> {
    const sourceEl = await this.findElementByUnified(source);
    if (!sourceEl) return;

    const sourceRect = sourceEl.getBoundingClientRect();
    const startX = sourceRect.x + sourceRect.width / 2;
    const startY = sourceRect.y + sourceRect.height / 2;

    let endX: number, endY: number;
    if ('x' in target) {
      endX = target.x;
      endY = target.y;
    } else {
      const targetEl = await this.findElementByUnified(target);
      if (!targetEl) return;
      const targetRect = targetEl.getBoundingClientRect();
      endX = targetRect.x + targetRect.width / 2;
      endY = targetRect.y + targetRect.height / 2;
    }

    // 触发拖拽事件
    sourceEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, clientX: startX, clientY: startY }));
    sourceEl.dispatchEvent(new DragEvent('drag', { bubbles: true, clientX: endX, clientY: endY }));
    sourceEl.dispatchEvent(new DragEvent('dragend', { bubbles: true, clientX: endX, clientY: endY }));
  }

  async focus(element: UnifiedElement): Promise<void> {
    const el = await this.findElementByUnified(element);
    if (el) {
      (el as HTMLElement).focus();
    }
  }

  // ── 数据操作 ──

  async copy(element?: UnifiedElement): Promise<string> {
    if (element) {
      const el = await this.findElementByUnified(element);
      if (el) {
        const text = el.textContent || '';
        await navigator.clipboard.writeText(text);
        return text;
      }
    }
    return await navigator.clipboard.readText();
  }

  async paste(element?: UnifiedElement, data?: string): Promise<void> {
    const text = data || await navigator.clipboard.readText();

    if (element) {
      const el = await this.findElementByUnified(element) as HTMLInputElement;
      if (el) {
        el.focus();
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
          el.value = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (el.isContentEditable) {
          el.textContent = text;
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    } else {
      // 使用剪贴板 API
      await navigator.clipboard.writeText(text);
    }
  }

  async select(element: UnifiedElement): Promise<void> {
    const el = await this.findElementByUnified(element) as HTMLInputElement;
    if (el) {
      el.select();
    }
  }

  async extractData(element: UnifiedElement): Promise<unknown> {
    const el = await this.findElementByUnified(element);
    if (!el) return null;

    // 根据元素类型提取数据
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      return (el as HTMLInputElement).value;
    }

    if (el.tagName === 'IMG') {
      return (el as HTMLImageElement).src;
    }

    if (el.tagName === 'A') {
      return {
        text: el.textContent?.trim(),
        href: (el as HTMLAnchorElement).href,
      };
    }

    return el.textContent?.trim();
  }

  async extractTable(element: UnifiedElement): Promise<TableData> {
    const el = await this.findElementByUnified(element) as HTMLTableElement;
    if (!el || el.tagName !== 'TABLE') {
      return { headers: [], rows: [] };
    }

    // 提取表头
    const headers: string[] = [];
    const headerCells = el.querySelectorAll('thead th, thead td');
    headerCells.forEach(cell => {
      headers.push(cell.textContent?.trim() || '');
    });

    // 如果没有 thead，尝试第一行作为表头
    if (headers.length === 0) {
      const firstRow = el.querySelector('tr');
      if (firstRow) {
        firstRow.querySelectorAll('th, td').forEach(cell => {
          headers.push(cell.textContent?.trim() || '');
        });
      }
    }

    // 提取数据行
    const rows: unknown[][] = [];
    const bodyRows = el.querySelectorAll('tbody tr, tr');
    bodyRows.forEach((row, index) => {
      // 跳过第一行（如果已作为表头）
      if (index === 0 && el.querySelector('thead') === null) return;

      const rowData: unknown[] = [];
      row.querySelectorAll('td, th').forEach(cell => {
        rowData.push(cell.textContent?.trim());
      });
      if (rowData.length > 0) {
        rows.push(rowData);
      }
    });

    return {
      headers,
      rows,
      metadata: {
        totalRows: rows.length,
        totalColumns: headers.length,
      },
    };
  }

  async extractList(element: UnifiedElement): Promise<ListData> {
    const el = await this.findElementByUnified(element);
    if (!el) return { items: [] };

    const items: unknown[] = [];
    const listItems = el.querySelectorAll('li, [role="listitem"]');

    listItems.forEach(item => {
      items.push(item.textContent?.trim());
    });

    return {
      items,
      metadata: {
        totalItems: items.length,
      },
    };
  }

  // ── 上下文操作 ──

  async getContext(): Promise<EventContext> {
    return this.captureContext();
  }

  async getWindowTitle(): Promise<string> {
    return document.title;
  }

  async getPageUrl(): Promise<string> {
    return window.location.href;
  }

  async takeScreenshot(): Promise<string> {
    // DOM 适配器不支持截图，需要使用其他方式
    throw new Error('Screenshot not supported in DOM adapter');
  }

  // ── 辅助方法 ──

  private async findElementByUnified(unified: UnifiedElement): Promise<Element | null> {
    // 优先使用 xpath
    if (unified.location.precisePath) {
      try {
        const result = document.evaluate(
          unified.location.precisePath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        );
        if (result.singleNodeValue) return result.singleNodeValue as Element;
      } catch {
        // xpath 解析失败，继续尝试其他方法
      }
    }

    // 使用语义匹配
    if (unified.identity.role) {
      const elements = document.querySelectorAll(`[role="${unified.identity.role}"]`);
      for (const el of elements) {
        const name = this.detectName(el);
        if (name === unified.identity.name || name.includes(unified.identity.name)) {
          return el;
        }
      }
    }

    // 使用坐标
    if (unified.location.bounds) {
      const el = document.elementFromPoint(
        unified.location.bounds.x + unified.location.bounds.width / 2,
        unified.location.bounds.y + unified.location.bounds.height / 2,
      );
      if (el) return el;
    }

    return null;
  }
}

/**
 * DOM 适配器工厂
 */
class DOMAdapterFactory implements PlatformAdapterFactory {
  create(): PlatformAdapter {
    return new DOMAdapter();
  }

  async isAvailable(): Promise<boolean> {
    return typeof document !== 'undefined';
  }

  getPriority(): number {
    return 10; // 浏览器环境优先级较高
  }
}

// 注册 DOM 适配器
adapterRegistry.register('dom', new DOMAdapterFactory());
