/**
 * 录制控制面板组件
 *
 * 功能：
 * 1. 录制控制（开始/停止/暂停）
 * 2. 事件列表显示
 * 3. 事件标记
 * 4. 录制描述输入
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Circle,
  Square,
  Pause,
  Play,
  X,
  Undo2,
  Save,
  Settings,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { unifiedRecorder } from '@/services/unified-recorder';
import type { SemanticEvent, EventTag } from '@/types/semantic-event';
import type { RecordingSession, RecordingConfig } from '@/types/recording-session';
import { EventList } from './event-list';

interface RecorderPanelProps {
  onSessionComplete?: (session: RecordingSession) => void;
  onSessionCancel?: () => void;
  compact?: boolean;
}

/**
 * 格式化时长
 */
function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/**
 * 录制控制面板组件
 */
export function RecorderPanel({
  onSessionComplete,
  onSessionCancel,
  compact = false,
}: RecorderPanelProps) {
  // ── 状态 ──
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [events, setEvents] = useState<SemanticEvent[]>([]);
  const [duration, setDuration] = useState(0);
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [description, setDescription] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [config, setConfig] = useState<RecordingConfig>({
    captureScreenshot: false,
    captureContext: true,
    autoTag: true,
    maxEvents: 1000,
  });

  // ── Refs ──
  const eventListRef = useRef<HTMLDivElement>(null);

  // ── 初始化 ──
  useEffect(() => {
    // 初始化录制器
    unifiedRecorder.initialize().catch(() => {});

    // 注册事件回调
    const unsubscribe = unifiedRecorder.onEvent((event) => {
      setEvents(prev => [...prev, event]);

      // 自动滚动到底部
      if (eventListRef.current) {
        setTimeout(() => {
          eventListRef.current?.scrollTo({
            top: eventListRef.current.scrollHeight,
            behavior: 'smooth',
          });
        }, 50);
      }
    });

    // 注册状态回调
    const unsubscribeState = unifiedRecorder.on((type, data) => {
      switch (type) {
        case 'start':
          setIsRecording(true);
          setIsPaused(false);
          setEvents([]);
          setDuration(0);
          break;
        case 'stop':
          setIsRecording(false);
          setIsPaused(false);
          if (data && typeof data === 'object' && 'status' in data) {
            const session = data as RecordingSession;
            if (session.status === 'completed') {
              onSessionComplete?.(session);
            }
          }
          break;
        case 'pause':
          setIsPaused(true);
          break;
        case 'resume':
          setIsPaused(false);
          break;
        case 'tick':
          if (data && typeof data === 'object' && 'duration' in data) {
            setDuration((data as { duration: number }).duration);
          }
          break;
      }
    });

    return () => {
      unsubscribe();
      unsubscribeState();
    };
  }, [onSessionComplete]);

  // ── 操作处理 ──

  const handleStart = useCallback(async () => {
    try {
      await unifiedRecorder.startRecording({
        ...config,
        description,
      });
    } catch {
      // ignore
    }
  }, [config, description]);

  const handleStop = useCallback(async () => {
    try {
      await unifiedRecorder.stopRecording();
    } catch {
      // ignore
    }
  }, []);

  const handlePause = useCallback(() => {
    unifiedRecorder.pauseRecording();
  }, []);

  const handleResume = useCallback(() => {
    unifiedRecorder.resumeRecording();
  }, []);

  const handleCancel = useCallback(async () => {
    await unifiedRecorder.cancelRecording();
    onSessionCancel?.();
  }, [onSessionCancel]);

  const handleUndo = useCallback(() => {
    unifiedRecorder.undoLastEvent();
    setEvents(prev => prev.slice(0, -1));
  }, []);

  const handleTagEvent = useCallback((eventId: string, tag: EventTag) => {
    unifiedRecorder.tagEvent(eventId, tag);
    setEvents(prev => prev.map(e =>
      e.id === eventId
        ? { ...e, tags: [...(e.tags || []), tag] }
        : e
    ));
  }, []);

  const handleUntagEvent = useCallback((eventId: string, tag: EventTag) => {
    unifiedRecorder.untagEvent(eventId, tag);
    setEvents(prev => prev.map(e =>
      e.id === eventId
        ? { ...e, tags: (e.tags || []).filter(t => t !== tag) }
        : e
    ));
  }, []);

  const handleDeleteEvent = useCallback((eventId: string) => {
    unifiedRecorder.deleteEvent(eventId);
    setEvents(prev => prev.filter(e => e.id !== eventId));
  }, []);

  // ── 渲染 ──

  return (
    <div className={`flex flex-col bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden ${compact ? 'h-full' : 'max-h-[600px]'}`}>
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-2">
          <Circle
            size={12}
            className={isRecording ? 'text-red-500 animate-pulse' : 'text-zinc-400'}
            fill={isRecording ? 'currentColor' : 'none'}
          />
          <h3 className="font-semibold text-[14px] text-zinc-900 dark:text-zinc-100">
            语义化录制
          </h3>
          {isRecording && (
            <span className="text-[12px] text-zinc-500">
              {formatDuration(duration)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {/* 设置按钮 */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
          >
            <Settings size={14} />
          </button>

          {/* 关闭按钮 */}
          {!isRecording && (
            <button
              onClick={handleCancel}
              className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {/* 设置面板 */}
      {showSettings && (
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={config.captureScreenshot}
                onChange={(e) => setConfig(prev => ({ ...prev, captureScreenshot: e.target.checked }))}
                className="rounded"
              />
              <span>捕获截图</span>
            </label>
            <label className="flex items-center gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={config.autoTag}
                onChange={(e) => setConfig(prev => ({ ...prev, autoTag: e.target.checked }))}
                className="rounded"
              />
              <span>自动标记</span>
            </label>
            <label className="flex items-center gap-2 text-[12px]">
              <span>最大事件数:</span>
              <input
                type="number"
                value={config.maxEvents}
                onChange={(e) => setConfig(prev => ({ ...prev, maxEvents: parseInt(e.target.value) || 1000 }))}
                className="w-20 px-2 py-1 text-[12px] rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800"
              />
            </label>
          </div>
        </div>
      )}

      {/* 描述输入 */}
      {!isRecording && (
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
          <label className="block text-[12px] text-zinc-500 mb-1">
            录制描述（可选）
          </label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="描述这次录制的意图..."
            className="w-full px-3 py-2 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
          />
        </div>
      )}

      {/* 事件列表 */}
      <div ref={eventListRef} className="flex-1 overflow-y-auto min-h-0">
        <EventList
          events={events}
          onTagEvent={handleTagEvent}
          onUntagEvent={handleUntagEvent}
          onDeleteEvent={handleDeleteEvent}
          selectedEventId={selectedEventId}
          onSelectEvent={setSelectedEventId}
        />
      </div>

      {/* 状态栏 */}
      {isRecording && (
        <div className="px-4 py-2 border-t border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 shrink-0">
          <div className="flex items-center justify-between text-[11px] text-zinc-500">
            <span>{events.length} 个事件</span>
            <span>
              适配器: {unifiedRecorder.getAvailableAdapters().join(', ')}
            </span>
          </div>
        </div>
      )}

      {/* 控制按钮 */}
      <div className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
        {!isRecording ? (
          <button
            onClick={handleStart}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-red-600 text-white text-[14px] font-medium hover:bg-red-700"
          >
            <Circle size={16} />
            开始录制
          </button>
        ) : (
          <div className="flex gap-2">
            {/* 暂停/恢复 */}
            <button
              onClick={isPaused ? handleResume : handlePause}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-300 text-[13px] font-medium hover:bg-zinc-50 dark:hover:bg-zinc-900"
            >
              {isPaused ? <Play size={14} /> : <Pause size={14} />}
              {isPaused ? '恢复' : '暂停'}
            </button>

            {/* 撤销 */}
            <button
              onClick={handleUndo}
              disabled={events.length === 0}
              className="p-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 disabled:opacity-30"
            >
              <Undo2 size={14} />
            </button>

            {/* 停止 */}
            <button
              onClick={handleStop}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-[13px] font-medium hover:bg-zinc-800 dark:hover:bg-zinc-200"
            >
              <Square size={14} />
              停止录制
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
