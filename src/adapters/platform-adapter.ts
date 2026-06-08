/**
 * 平台适配器接口 —— 每个平台实现这个接口
 *
 * 设计原则：
 * 1. 统一接口：所有平台都实现相同接口
 * 2. 可插拔：适配器可以动态注册/注销
 * 3. 事件驱动：通过回调通知上层
 * 4. 语义优先：优先返回语义化信息
 */

import type { UnifiedElement, BoundingRect } from '@/types/unified-element';
import type { SemanticEvent, EventContext } from '@/types/semantic-event';
import type { TableData, ListData, TreeData } from '@/types/unified-data';

/**
 * 元素查询参数
 */
export interface ElementQuery {
  role?: string;                       // 元素角色
  name?: string;                       // 元素名称
  path?: string;                       // 精确路径（xpath, css selector）
  bounds?: BoundingRect;               // 坐标范围
  attributes?: Record<string, string>; // 属性
  text?: string;                       // 文本内容
  index?: number;                      // 索引
}

/**
 * 平台事件
 */
export interface PlatformEvent {
  platform: string;                    // 平台标识
  type: string;                        // 事件类型
  data: Record<string, unknown>;       // 事件数据
  timestamp: number;                   // 时间戳
}

/**
 * 平台适配器接口
 */
export interface PlatformAdapter {
  // ── 平台标识 ──
  readonly platform: string;
  readonly name: string;
  readonly description?: string;

  // ── 生命周期 ──

  /**
   * 初始化适配器
   */
  initialize(): Promise<void>;

  /**
   * 开始监听事件
   * @param callback 事件回调函数
   */
  startListening(callback: (event: PlatformEvent) => void): Promise<void>;

  /**
   * 停止监听事件
   */
  stopListening(): Promise<void>;

  /**
   * 是否正在监听
   */
  isListening(): boolean;

  /**
   * 销毁适配器，释放资源
   */
  destroy(): Promise<void>;

  // ── 事件转换 ──

  /**
   * 将平台事件转换为统一的语义化事件
   * @param event 平台事件
   * @param context 当前上下文
   */
  toUnifiedEvent(event: PlatformEvent, context?: EventContext): SemanticEvent;

  // ── 元素查找 ──

  /**
   * 查找单个元素
   * @param query 查询参数
   */
  findElement(query: ElementQuery): Promise<UnifiedElement | null>;

  /**
   * 查找多个元素
   * @param query 查询参数
   */
  findElements(query: ElementQuery): Promise<UnifiedElement[]>;

  /**
   * 根据坐标获取元素
   * @param x X 坐标
   * @param y Y 坐标
   */
  getElementAtPoint(x: number, y: number): Promise<UnifiedElement | null>;

  /**
   * 获取当前焦点元素
   */
  getFocusedElement(): Promise<UnifiedElement | null>;

  // ── 元素操作 ──

  /**
   * 点击元素
   * @param element 目标元素
   */
  click(element: UnifiedElement): Promise<void>;

  /**
   * 双击元素
   * @param element 目标元素
   */
  doubleClick(element: UnifiedElement): Promise<void>;

  /**
   * 右键点击元素
   * @param element 目标元素
   */
  rightClick(element: UnifiedElement): Promise<void>;

  /**
   * 悬停在元素上
   * @param element 目标元素
   */
  hover(element: UnifiedElement): Promise<void>;

  /**
   * 输入文本
   * @param element 目标元素
   * @param text 要输入的文本
   */
  type(element: UnifiedElement, text: string): Promise<void>;

  /**
   * 按键
   * @param key 按键名称
   * @param modifiers 修饰键
   */
  keyPress(key: string, modifiers?: string[]): Promise<void>;

  /**
   * 滚动
   * @param element 目标元素
   * @param direction 方向
   * @param amount 滚动量
   */
  scroll(element: UnifiedElement, direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<void>;

  /**
   * 拖拽
   * @param source 源元素
   * @param target 目标元素或坐标
   */
  drag(source: UnifiedElement, target: UnifiedElement | { x: number; y: number }): Promise<void>;

  /**
   * 聚焦元素
   * @param element 目标元素
   */
  focus(element: UnifiedElement): Promise<void>;

  // ── 数据操作 ──

  /**
   * 复制元素内容
   * @param element 目标元素
   */
  copy(element?: UnifiedElement): Promise<string>;

  /**
   * 粘贴到元素
   * @param element 目标元素
   * @param data 要粘贴的数据
   */
  paste(element?: UnifiedElement, data?: string): Promise<void>;

  /**
   * 选择元素内容
   * @param element 目标元素
   */
  select(element: UnifiedElement): Promise<void>;

  /**
   * 提取元素数据
   * @param element 目标元素
   */
  extractData(element: UnifiedElement): Promise<unknown>;

  /**
   * 提取表格数据
   * @param element 表格元素
   */
  extractTable(element: UnifiedElement): Promise<TableData>;

  /**
   * 提取列表数据
   * @param element 列表元素
   */
  extractList(element: UnifiedElement): Promise<ListData>;

  // ── 上下文操作 ──

  /**
   * 获取当前上下文
   */
  getContext(): Promise<EventContext>;

  /**
   * 获取当前窗口标题
   */
  getWindowTitle(): Promise<string>;

  /**
   * 获取当前页面 URL（Web 平台）
   */
  getPageUrl?(): Promise<string>;

  /**
   * 截图
   */
  takeScreenshot?(): Promise<string>;

  // ── 平台特有操作 ──

  /**
   * 执行平台特有操作
   * @param action 操作名称
   * @param params 操作参数
   */
  executeAction?(action: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * 适配器工厂接口
 */
export interface PlatformAdapterFactory {
  /**
   * 创建适配器实例
   */
  create(): PlatformAdapter;

  /**
   * 检查平台是否可用
   */
  isAvailable(): Promise<boolean>;

  /**
   * 获取平台优先级（数字越小优先级越高）
   */
  getPriority(): number;
}

/**
 * 适配器注册表
 */
export class AdapterRegistry {
  private factories: Map<string, PlatformAdapterFactory> = new Map();
  private adapters: Map<string, PlatformAdapter> = new Map();

  /**
   * 注册适配器工厂
   */
  register(platform: string, factory: PlatformAdapterFactory): void {
    this.factories.set(platform, factory);
  }

  /**
   * 注销适配器工厂
   */
  unregister(platform: string): void {
    this.factories.delete(platform);
    this.adapters.delete(platform);
  }

  /**
   * 获取适配器实例（懒加载）
   */
  async getAdapter(platform: string): Promise<PlatformAdapter | null> {
    // 如果已创建，直接返回
    if (this.adapters.has(platform)) {
      return this.adapters.get(platform)!;
    }

    // 查找工厂
    const factory = this.factories.get(platform);
    if (!factory) {
      return null;
    }

    // 检查平台是否可用
    const isAvailable = await factory.isAvailable();
    if (!isAvailable) {
      return null;
    }

    // 创建并初始化适配器
    const adapter = factory.create();
    await adapter.initialize();

    this.adapters.set(platform, adapter);
    return adapter;
  }

  /**
   * 获取所有可用的适配器
   */
  async getAvailableAdapters(): Promise<PlatformAdapter[]> {
    const adapters: PlatformAdapter[] = [];

    for (const [platform, factory] of this.factories) {
      try {
        const isAvailable = await factory.isAvailable();
        if (isAvailable) {
          const adapter = await this.getAdapter(platform);
          if (adapter) {
            adapters.push(adapter);
          }
        }
      } catch {
        // ignore
      }
    }

    // 按优先级排序
    adapters.sort((a, b) => {
      const factoryA = this.factories.get(a.platform);
      const factoryB = this.factories.get(b.platform);
      const priorityA = factoryA?.getPriority() ?? 999;
      const priorityB = factoryB?.getPriority() ?? 999;
      return priorityA - priorityB;
    });

    return adapters;
  }

  /**
   * 获取所有已注册的平台
   */
  getRegisteredPlatforms(): string[] {
    return Array.from(this.factories.keys());
  }

  /**
   * 销毁所有适配器
   */
  async destroyAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.destroy();
      } catch {
        // ignore
      }
    }
    this.adapters.clear();
  }
}

// 全局适配器注册表
export const adapterRegistry = new AdapterRegistry();
