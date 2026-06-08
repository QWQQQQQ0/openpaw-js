/**
 * 统一录制器服务
 *
 * 功能：
 * 1. 整合多个平台适配器
 * 2. 录制用户操作并生成语义化事件
 * 3. 管理录制会话生命周期
 * 4. 支持事件标记和编辑
 */

import type { PlatformAdapter, PlatformEvent } from '@/adapters/platform-adapter';
import { adapterRegistry } from '@/adapters/platform-adapter';
import type { SemanticEvent, EventTag } from '@/types/semantic-event';
import type { RecordingSession, RecordingConfig, RecordingState, RecordingCallback, RecordingEventType } from '@/types/recording-session';
import type { UnifiedElement } from '@/types/unified-element';
import { globalListener, type GlobalInputEvent } from './global-listener';

/**
 * 统一录制器
 */
class UnifiedRecorder {
  // ── 状态 ──
  private state: RecordingState = {
    isRecording: false,
    isPaused: false,
    session: null,
    currentEvent: null,
    eventCount: 0,
    duration: 0,
  };

  // ── 适配器 ──
  private adapters: Map<string, PlatformAdapter> = new Map();
  private activeAdapters: Set<string> = new Set();

  // ── 全局监听器 ──
  private globalListenerUnsubscribe: (() => void) | null = null;
  private keyDownTimestamps: Map<string, number> = new Map();
  private pendingDragStart: { event: GlobalInputEvent; timestamp: number } | null = null;

  // ── 回调 ──
  private callbacks: Set<RecordingCallback> = new Set();
  private eventCallbacks: Set<(event: SemanticEvent) => void> = new Set();
  private eventRemoveCallbacks: Set<(eventId: string) => void> = new Set();

  // ── 定时器 ──
  private durationTimer: ReturnType<typeof setInterval> | null = null;
  private startTime: number = 0;

  // ── 配置 ──
  private config: RecordingConfig = {
    captureScreenshot: false,
    captureContext: true,
    autoTag: true,
    maxEvents: 1000,
    timeout: 0,
  };

  // ── 生命周期 ──

  /**
   * 初始化录制器
   */
  async initialize(): Promise<void> {
    // 获取所有可用的适配器
    const availableAdapters = await adapterRegistry.getAvailableAdapters();

    for (const adapter of availableAdapters) {
      this.adapters.set(adapter.platform, adapter);
    }

  }

  /**
   * 开始录制
   */
  async startRecording(config?: RecordingConfig): Promise<RecordingSession> {
    if (this.state.isRecording) {
      throw new Error('Already recording');
    }

    // 合并配置
    this.config = { ...this.config, ...config };

    // 创建新会话
    const session: RecordingSession = {
      id: crypto.randomUUID(),
      startTime: Date.now(),
      status: 'recording',
      events: [],
      metadata: {
        userDescription: this.config.description,
      },
    };

    // 启动全局监听器
    try {
      await globalListener.start();
      this.globalListenerUnsubscribe = globalListener.onEvent(this.handleGlobalEvent.bind(this));
    } catch { /* ignore */ }

    // 启动适配器
    for (const [platform, adapter] of this.adapters) {
      try {
        await adapter.startListening(this.handlePlatformEvent.bind(this));
        this.activeAdapters.add(platform);
      } catch { /* ignore */ }
    }

    // 更新状态
    this.state = {
      isRecording: true,
      isPaused: false,
      session,
      currentEvent: null,
      eventCount: 0,
      duration: 0,
    };

    this.startTime = Date.now();

    // 启动时长计时器
    this.durationTimer = setInterval(() => {
      if (this.state.isRecording && !this.state.isPaused) {
        this.state.duration = Date.now() - this.startTime;
        this.emit('event', { type: 'tick', duration: this.state.duration });
      }
    }, 1000);

    // 通知回调
    this.emit('start', session);

    return session;
  }

  /**
   * 停止录制
   */
  async stopRecording(): Promise<RecordingSession> {
    if (!this.state.isRecording) {
      throw new Error('Not recording');
    }

    // 停止全局监听器
    if (this.globalListenerUnsubscribe) {
      this.globalListenerUnsubscribe();
      this.globalListenerUnsubscribe = null;
    }
    this.pendingDragStart = null;
    try {
      await globalListener.stop();
    } catch { /* ignore */ }

    // 停止适配器
    for (const platform of this.activeAdapters) {
      const adapter = this.adapters.get(platform);
      if (adapter) {
        try {
          await adapter.stopListening();
        } catch { /* ignore */ }
      }
    }
    this.activeAdapters.clear();

    // 停止计时器
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }

    // 更新会话状态
    const session = this.state.session!;
    session.endTime = Date.now();
    session.status = 'completed';
    session.metadata.stats = this.calculateStats(session);

    // 更新状态
    this.state = {
      isRecording: false,
      isPaused: false,
      session: null,
      currentEvent: null,
      eventCount: 0,
      duration: 0,
    };

    // 通知回调
    this.emit('stop', session);

    return session;
  }

  /**
   * 暂停录制
   */
  pauseRecording(): void {
    if (!this.state.isRecording || this.state.isPaused) {
      return;
    }

    this.state.isPaused = true;

    // 暂停适配器
    for (const platform of this.activeAdapters) {
      const adapter = this.adapters.get(platform);
      if (adapter) {
        adapter.stopListening();
      }
    }

    this.emit('pause');
  }

  /**
   * 恢复录制
   */
  resumeRecording(): void {
    if (!this.state.isRecording || !this.state.isPaused) {
      return;
    }

    this.state.isPaused = false;

    // 恢复适配器
    for (const platform of this.activeAdapters) {
      const adapter = this.adapters.get(platform);
      if (adapter) {
        adapter.startListening(this.handlePlatformEvent.bind(this));
      }
    }

    this.emit('resume');
  }

  /**
   * 取消录制
   */
  async cancelRecording(): Promise<void> {
    if (!this.state.isRecording) {
      return;
    }

    // 停止适配器
    for (const platform of this.activeAdapters) {
      const adapter = this.adapters.get(platform);
      if (adapter) {
        await adapter.stopListening();
      }
    }
    this.activeAdapters.clear();
    this.pendingDragStart = null;

    // 停止计时器
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = null;
    }

    const session = this.state.session;
    if (session) {
      session.status = 'cancelled';
    }

    // 更新状态
    this.state = {
      isRecording: false,
      isPaused: false,
      session: null,
      currentEvent: null,
      eventCount: 0,
      duration: 0,
    };

    this.emit('stop', session);
  }

  // ── 事件处理 ──

  /**
   * 处理全局事件
   */
  private async handleGlobalEvent(event: GlobalInputEvent): Promise<void> {
    if (!this.state.isRecording || this.state.isPaused) {
      return;
    }

    // 过滤无意义的事件
    if (this.shouldIgnoreGlobalEvent(event)) {
      return;
    }

    // ── Drag merging: buffer drag_start, merge with drag_end ──
    if (event.event_type === 'mouse_drag_start') {
      this.pendingDragStart = { event, timestamp: Date.now() };
      return; // don't record yet, wait for drag_end
    }

    if (event.event_type === 'mouse_drag_end' && this.pendingDragStart) {
      const startEvt = this.pendingDragStart.event;
      this.pendingDragStart = null;

      // Create merged drag event with both start and end coordinates
      const mergedEvent: GlobalInputEvent = {
        event_type: 'mouse_drag_end', // keep as drag_end for buildAction
        x: event.x,
        y: event.y,
        key: event.key,
        modifiers: event.modifiers,
        hwnd: event.hwnd,
        window_title: event.window_title,
        timestamp: Date.now(),
        scroll_dx: startEvt.x, // reuse scroll_dx for start_x
        scroll_dy: startEvt.y, // reuse scroll_dy for start_y
      };

      await this.recordGlobalEvent(mergedEvent, {
        start_x: startEvt.x,
        start_y: startEvt.y,
        end_x: event.x,
        end_y: event.y,
      });
      return;
    }

    // If we have a pending drag_start but received a non-drag_end event, flush it
    if (this.pendingDragStart) {
      const pending = this.pendingDragStart;
      this.pendingDragStart = null;
      await this.recordGlobalEvent(pending.event);
    }

    await this.recordGlobalEvent(event);
  }

  /**
   * Record a single global event (after drag merging)
   */
  private async recordGlobalEvent(event: GlobalInputEvent, dragCoords?: { start_x: number; start_y: number; end_x: number; end_y: number }): Promise<void> {
    // 在事件收到时立即记录时间戳（UIA 查询可能耗时很长，不能等它完成）
    const receivedAt = Date.now();

    // 通知 UI 开始加载（显示 loading）
    this.emit('event-loading', event);

    // 转换为语义化事件（含 UIA 元素查询，可能较慢）
    const semanticEvent = await globalListener.toSemanticEvent(event);
    semanticEvent.timestamp = receivedAt;

    // For merged drag events, override the action to include both coordinates
    if (dragCoords) {
      semanticEvent.action = {
        type: 'drag',
        target: {
          coordinate: { x: dragCoords.end_x, y: dragCoords.end_y },
        },
        params: {
          start_x: dragCoords.start_x,
          start_y: dragCoords.start_y,
          end_x: dragCoords.end_x,
          end_y: dragCoords.end_y,
          button: event.key || 'left',
        },
      };
    }

    // 检查是否超过最大事件数
    if (this.config.maxEvents && this.state.session!.events.length >= this.config.maxEvents) {
      this.stopRecording();
      return;
    }

    // 去重：动作类型 + 时间窗口
    const session = this.state.session!;
    const events = session.events;
    const timeThreshold = 300; // ms
    const scanLimit = Math.min(events.length, 10);
    let hasDuplicate = false;

    for (let i = events.length - 1; i >= Math.max(0, events.length - scanLimit); i--) {
      const existing = events[i];

      if (existing.action.type !== semanticEvent.action.type) continue;

      const timeDiff = Math.abs(existing.timestamp - semanticEvent.timestamp);
      if (timeDiff > timeThreshold) continue;

      if (existing.context.platform === 'dom') {
        hasDuplicate = true;
        break;
      }
      if (existing.context.platform === 'global') {
        events.splice(i, 1);
        this.state.eventCount--;
        this.emit('event-remove', existing.id);
      }
    }

    if (hasDuplicate) {
      this.emit('event-loading-end');
      return;
    }

    // 自动标记
    if (this.config.autoTag) {
      this.autoTagEvent(semanticEvent);
    }

    // 添加到会话
    session.events.push(semanticEvent);
    this.state.currentEvent = semanticEvent;
    this.state.eventCount++;

    // 隐藏 loading 并显示事件
    this.emit('event-loading-end');
    this.emit('event', semanticEvent);
    this.eventCallbacks.forEach(cb => cb(semanticEvent));
  }

  /**
   * 是否应该忽略全局事件
   */
  private shouldIgnoreGlobalEvent(event: GlobalInputEvent): boolean {
    // 忽略浮窗自身的事件
    const floatWindow = document.querySelector('[data-tauri-drag-region]');
    if (floatWindow) {
      const rect = floatWindow.getBoundingClientRect();
      if (event.x >= rect.left && event.x <= rect.right &&
          event.y >= rect.top && event.y <= rect.bottom) {
        return true;
      }
    }

    // 忽略单纯的修饰键按下/释放
    const modifierKeys = ['Shift', 'Ctrl', 'Alt', 'LShift', 'RShift', 'LCtrl', 'RCtrl', 'LAlt', 'RAlt'];
    if (event.key && modifierKeys.includes(event.key)) {
      return true;
    }

    // key_down: 记录时间戳，不忽略
    if (event.event_type === 'key_down') {
      if (event.key) this.keyDownTimestamps.set(event.key, event.timestamp);
      return false;
    }

    // key_up: 只有长按（>500ms）才保留，短按的 up 直接丢弃
    if (event.event_type === 'key_up') {
      const downTime = event.key ? this.keyDownTimestamps.get(event.key) : undefined;
      if (event.key) this.keyDownTimestamps.delete(event.key);
      if (!downTime || event.timestamp - downTime < 500) {
        return true; // 短按，忽略 key_up
      }
      return false; // 长按，保留 key_up
    }

    return false;
  }

  private handlePlatformEvent(event: PlatformEvent): void {
    if (!this.state.isRecording || this.state.isPaused) {
      return;
    }

    const adapter = this.adapters.get(event.platform);
    if (!adapter) {
      return;
    }

    // 转换为统一事件
    const unifiedEvent = adapter.toUnifiedEvent(event);

    // 检查是否超过最大事件数
    if (this.config.maxEvents && this.state.session!.events.length >= this.config.maxEvents) {
      this.stopRecording();
      return;
    }

    // 自动标记
    if (this.config.autoTag) {
      this.autoTagEvent(unifiedEvent);
    }

    // 添加到会话
    this.state.session!.events.push(unifiedEvent);
    this.state.currentEvent = unifiedEvent;
    this.state.eventCount++;

    // 通知回调
    this.emit('event', unifiedEvent);
    this.eventCallbacks.forEach(cb => cb(unifiedEvent));

  }

  private autoTagEvent(event: SemanticEvent): void {
    const tags: EventTag[] = [];

    // 根据动作类型自动标记
    if (event.action.type === 'copy') {
      tags.push('copy');
    } else if (event.action.type === 'paste' ||
               (event.action.type === 'hotkey' && event.action.params?.key === 'Ctrl+v')) {
      tags.push('paste');
    }

    // 根据元素结构自动标记
    if (event.element?.structure?.container) {
      const container = event.element.structure.container;

      if (container.role === 'table' || container.role === 'grid') {
        // 表格中的元素可能是数据源或目标
        if (event.action.type === 'click') {
          tags.push('variable');
        }
      }

      if (container.role === 'list') {
        // 列表中的元素可能是变量
        if (event.action.type === 'click') {
          tags.push('variable');
        }
      }
    }

    // 根据上下文自动标记
    if (event.context.windowTitle) {
      // 可以根据窗口标题判断是否是源或目标
    }

    if (tags.length > 0) {
      event.tags = tags;
    }
  }

  // ── 外部事件注入（Web 录制器）──

  /**
   * 添加外部事件到当前录制会话（由 Web 录制器调用）
   * 自动去重：基于动作类型 + 坐标接近度，移除重复的全局事件（DOM 信息更丰富）
   */
  addExternalEvent(event: SemanticEvent): void {
    if (!this.state.isRecording || !this.state.session) {
      return;
    }

    // 统一使用前端时间戳，避免 Rust/Python 时钟差异
    const pythonTimestamp = event.timestamp;
    const receivedAt = Date.now();
    event.timestamp = receivedAt;

    const session = this.state.session!;
    const events = session.events;

    // 去重：动作类型 + 时间窗口（不比较坐标，因为两个源坐标系不同）
    // DOM 事件信息更丰富，遇到重复的 global 事件时移除 global 保留 DOM
    const timeThreshold = 300; // ms - 时间窗口
    const scanLimit = Math.min(events.length, 10);
    for (let i = events.length - 1; i >= Math.max(0, events.length - scanLimit); i--) {
      const existing = events[i];

      if (existing.context.platform !== 'global') continue;
      if (existing.action.type !== event.action.type) continue;

      const timeDiff = Math.abs(existing.timestamp - event.timestamp);
      if (timeDiff > timeThreshold) continue;

      events.splice(i, 1);
      this.state.eventCount--;
      this.emit('event-remove', existing.id);
    }

    // 添加到会话
    session.events.push(event);
    this.state.currentEvent = event;
    this.state.eventCount++;

    // 通知回调
    this.emit('event', event);
    this.eventCallbacks.forEach(cb => cb(event));
  }

  // ── 事件标记 ──

  /**
   * 标记事件
   */
  tagEvent(eventId: string, tag: EventTag): void {
    if (!this.state.session) {
      return;
    }

    const event = this.state.session.events.find(e => e.id === eventId);
    if (event) {
      if (!event.tags) {
        event.tags = [];
      }
      if (!event.tags.includes(tag)) {
        event.tags.push(tag);
      }
      this.emit('tag', { eventId, tag });
    }
  }

  /**
   * 取消标记
   */
  untagEvent(eventId: string, tag: EventTag): void {
    if (!this.state.session) {
      return;
    }

    const event = this.state.session.events.find(e => e.id === eventId);
    if (event && event.tags) {
      event.tags = event.tags.filter(t => t !== tag);
      this.emit('tag', { eventId, tag, removed: true });
    }
  }

  /**
   * 清除事件的所有标记
   */
  clearEventTags(eventId: string): void {
    if (!this.state.session) {
      return;
    }

    const event = this.state.session.events.find(e => e.id === eventId);
    if (event) {
      event.tags = [];
    }
  }

  // ── 事件编辑 ──

  /**
   * 删除事件
   */
  deleteEvent(eventId: string): void {
    if (!this.state.session) {
      return;
    }

    const index = this.state.session.events.findIndex(e => e.id === eventId);
    if (index !== -1) {
      this.state.session.events.splice(index, 1);
      this.state.eventCount--;
      this.emit('undo', { eventId });
    }
  }

  /**
   * 撤销最后一个事件
   */
  undoLastEvent(): void {
    if (!this.state.session || this.state.session.events.length === 0) {
      return;
    }

    const event = this.state.session.events.pop()!;
    this.state.eventCount--;
    this.emit('undo', { eventId: event.id });
  }

  // ── 回调管理 ──

  /**
   * 注册回调
   */
  on(callback: RecordingCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  /**
   * 注册事件回调
   */
  onEvent(callback: (event: SemanticEvent) => void): () => void {
    this.eventCallbacks.add(callback);
    return () => this.eventCallbacks.delete(callback);
  }

  /**
   * 注册事件移除回调
   */
  onEventRemove(callback: (eventId: string) => void): () => void {
    this.eventRemoveCallbacks.add(callback);
    return () => this.eventRemoveCallbacks.delete(callback);
  }

  /**
   * 注册录制器事件回调（用于 loading 等状态）
   */
  onRecorderEvent(callback: (type: RecordingEventType) => void): () => void {
    const wrappedCallback: RecordingCallback = (type) => callback(type);
    this.callbacks.add(wrappedCallback);
    return () => this.callbacks.delete(wrappedCallback);
  }

  private emit(type: RecordingEventType, data?: unknown): void {
    this.callbacks.forEach(cb => {
      try {
        cb(type, data);
      } catch { /* ignore */ }
    });

    // 处理事件移除通知
    if (type === 'event-remove' && typeof data === 'string') {
      this.eventRemoveCallbacks.forEach(cb => {
        try {
          cb(data);
        } catch { /* ignore */ }
      });
    }
  }

  // ── 状态查询 ──

  /**
   * 获取当前状态
   */
  getState(): RecordingState {
    return { ...this.state };
  }

  /**
   * 获取当前会话
   */
  getSession(): RecordingSession | null {
    return this.state.session;
  }

  /**
   * 是否正在录制
   */
  isRecording(): boolean {
    return this.state.isRecording;
  }

  /**
   * 是否已暂停
   */
  isPaused(): boolean {
    return this.state.isPaused;
  }

  /**
   * 获取事件数量
   */
  getEventCount(): number {
    return this.state.eventCount;
  }

  /**
   * 获取录制时长
   */
  getDuration(): number {
    return this.state.duration;
  }

  /**
   * 获取可用的适配器
   */
  getAvailableAdapters(): string[] {
    return Array.from(this.adapters.keys());
  }

  // ── 统计 ──

  private calculateStats(session: RecordingSession) {
    const events = session.events;
    const duration = (session.endTime || Date.now()) - session.startTime;

    // 统计动作类型
    const actionTypeCounts: Record<string, number> = {};
    for (const event of events) {
      const type = event.action.type;
      actionTypeCounts[type] = (actionTypeCounts[type] || 0) + 1;
    }

    // 统计标签
    const tagCounts: Record<string, number> = {};
    for (const event of events) {
      if (event.tags) {
        for (const tag of event.tags) {
          tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        }
      }
    }

    // 计算平均间隔
    let totalInterval = 0;
    for (let i = 1; i < events.length; i++) {
      totalInterval += events[i].timestamp - events[i - 1].timestamp;
    }
    const averageInterval = events.length > 1 ? totalInterval / (events.length - 1) : 0;

    return {
      totalEvents: events.length,
      actionTypeCounts,
      tagCounts,
      duration,
      averageInterval,
    };
  }
}

// 导出单例
export const unifiedRecorder = new UnifiedRecorder();
