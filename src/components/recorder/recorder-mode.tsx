/**
 * 录制模式组件 - 用于浮窗
 *
 * 集成完整的录制流程：
 * 1. 录制用户操作
 * 2. LLM 分析
 * 3. 生成模板
 * 4. 预览/编辑模板
 * 5. 测试执行
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  Circle,
  Square,
  Play,
  Pause,
  Undo2,
  Save,
  ArrowRight,
  Wand2,
  Eye,
  Trash2,
  Check,
  Loader2,
  Keyboard,
  Mouse,
  Globe,
  AlertCircle,
  X,
} from 'lucide-react';
import { unifiedRecorder } from '@/services/unified-recorder';
import { unifiedAnalyzer } from '@/services/unified-analyzer';
import { unifiedExecutor } from '@/services/unified-executor';
import { webRecorder } from '@/services/web-recorder';
import type { SemanticEvent, EventTag } from '@/types/semantic-event';
import type { RecordingSession } from '@/types/recording-session';
import type { AutomationTemplate } from '@/types/automation-template';
import type { DetectedPattern } from '@/types/recording-session';
import { EventList } from './event-list';
import { TemplatePreview } from './template-preview';
import { ManualRecorder } from './manual-recorder';

/**
 * 录制模式状态
 */
type RecorderMode =
  | 'idle'           // 空闲
  | 'recording'      // 录制中
  | 'paused'         // 暂停
  | 'recorded'       // 录制完成
  | 'analyzing'      // 分析中
  | 'preview'        // 预览模板
  | 'executing'      // 执行中
  | 'completed';     // 完成

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
 * 录制模式组件
 */
export function RecorderMode() {
  // ── 状态 ──
  const [mode, setMode] = useState<RecorderMode>('idle');
  const [events, setEvents] = useState<SemanticEvent[]>([]);
  const [duration, setDuration] = useState(0);
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [description, setDescription] = useState('');
  const [session, setSession] = useState<RecordingSession | null>(null);
  const [template, setTemplate] = useState<AutomationTemplate | null>(null);
  const [pattern, setPattern] = useState<DetectedPattern | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showParamDialog, setShowParamDialog] = useState(false);
  const [paramValues, setParamValues] = useState<Record<string, string>>({});
  const [webBrowserOpen, setWebBrowserOpen] = useState(false);
  const [webBrowserLoading, setWebBrowserLoading] = useState(false);
  const [eventLoading, setEventLoading] = useState(false);

  // ── 定时器 & 退订 ──
  const [durationTimer, setDurationTimer] = useState<ReturnType<typeof setInterval> | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);

  // ── 初始化 ──
  useEffect(() => {
    unifiedRecorder.initialize().catch(() => {});

    return () => {
      if (durationTimer) {
        clearInterval(durationTimer);
      }
      unsubscribeRef.current?.();
    };
  }, []);

  // ── 录制控制 ──

  const handleStartRecording = useCallback(async () => {
    try {
      setError(null);
      setEvents([]);
      setDuration(0);

      // 清理上一次的事件回调
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;

      const newSession = await unifiedRecorder.startRecording({
        description,
        autoTag: true,
      });

      setSession(newSession);
      setMode('recording');

      // 启动时长计时器
      const timer = setInterval(() => {
        setDuration(prev => prev + 1000);
      }, 1000);
      setDurationTimer(timer);

      // 注册全局事件回调并保存退订函数
      const unsubscribeGlobal = unifiedRecorder.onEvent((event) => {
        setEvents(prev => [...prev, event]);
      });

      // 注册事件移除回调（用于去重时移除旧事件）
      const unsubscribeRemove = unifiedRecorder.onEventRemove((eventId) => {
        setEvents(prev => prev.filter(e => e.id !== eventId));
      });

      // 注册录制器事件回调（用于 loading 状态）
      const unsubscribeRecorder = unifiedRecorder.onRecorderEvent((type) => {
        if (type === 'event-loading') {
          setEventLoading(true);
        } else if (type === 'event-loading-end') {
          setEventLoading(false);
        }
      });

      // 如果受控浏览器已打开，同时启动 Web 录制
      let unsubscribeWeb: (() => void) | null = null;
      if (webBrowserOpen) {
        try {
          await webRecorder.startRecording();
          unsubscribeWeb = webRecorder.onEvent((event) => {
            // 注入到统一录制器（含去重）
            unifiedRecorder.addExternalEvent(event);
          });
        } catch {
          // ignore
        }
      }

      // 保存退订函数
      unsubscribeRef.current = () => {
        unsubscribeGlobal();
        unsubscribeRemove();
        unsubscribeRecorder();
        unsubscribeWeb?.();
      };

    } catch (err) {
      setError(`启动录制失败: ${err}`);
    }
  }, [description, webBrowserOpen]);

  const handleStopRecording = useCallback(async () => {
    try {
      // 同时停止 Web 录制
      if (webRecorder.isRecording) {
        await webRecorder.stopRecording();
      }

      const completedSession = await unifiedRecorder.stopRecording();
      setSession(completedSession);
      setMode('recorded');

      // 停止计时器
      if (durationTimer) {
        clearInterval(durationTimer);
        setDurationTimer(null);
      }

      // 清理事件回调
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;

    } catch (err) {
      setError(`停止录制失败: ${err}`);
    }
  }, [durationTimer]);

  const handlePauseRecording = useCallback(() => {
    unifiedRecorder.pauseRecording();
    webRecorder.pauseRecording();
    setMode('paused');
  }, []);

  const handleResumeRecording = useCallback(async () => {
    unifiedRecorder.resumeRecording();
    await webRecorder.resumeRecording();
    setMode('recording');
  }, []);

  const handleUndoLastEvent = useCallback(() => {
    unifiedRecorder.undoLastEvent();
    setEvents(prev => prev.slice(0, -1));
  }, []);

  const handleDeleteEvent = useCallback((eventId: string) => {
    unifiedRecorder.deleteEvent(eventId);
    setEvents(prev => prev.filter(e => e.id !== eventId));
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

  // ── 受控浏览器 ──

  const handleOpenBrowser = useCallback(async () => {
    try {
      setWebBrowserLoading(true);
      setError(null);
      await webRecorder.openBrowser();
      setWebBrowserOpen(true);
    } catch (err) {
      setError(`打开浏览器失败: ${err}`);
    } finally {
      setWebBrowserLoading(false);
    }
  }, []);

  const handleCloseBrowser = useCallback(async () => {
    try {
      await webRecorder.closeBrowser();
      setWebBrowserOpen(false);
    } catch (err) {
      setError(`关闭浏览器失败: ${err}`);
    }
  }, []);

  // ── 分析 ──

  const handleAnalyze = useCallback(async () => {
    if (!session) return;

    try {
      setMode('analyzing');
      setError(null);

      // 配置 LLM 分析器
      let llmConfigured = false;
      try {
        const { useModelConfigStore } = await import('@/stores/model-config-store');
        await useModelConfigStore.getState().load();
        const config = useModelConfigStore.getState().defaultConfig();
        if (config) {
          const apiKey = await useModelConfigStore.getState().getApiKey(config.id, '');
          if (apiKey) {
            const { getModelService } = await import('@/services/model-service-singleton');
            unifiedAnalyzer.configure(getModelService(), config, apiKey);
            llmConfigured = true;
          }
        }
      } catch (e) {
        console.warn('[RecorderMode] Failed to configure LLM for analysis:', e);
      }

      if (!llmConfigured) {
        setError('未配置 LLM，将使用本地分析（结果可能不够智能）');
      }

      // 更新 session 中的描述（用户可能在录制后编辑了）
      if (description !== session.metadata.userDescription) {
        session.metadata.userDescription = description;
      }

      // 分析录制会话
      const result = await unifiedAnalyzer.analyze(session);

      setTemplate(result);
      setPattern(result.dataFlow ? {
        type: 'loop',
        confidence: 0.8,
        description: `从 ${result.dataFlow.source.type} 复制数据到 ${result.dataFlow.target.type}`,
        dataFlow: result.dataFlow,
      } : null);

      setMode('preview');

    } catch (err) {
      setError(`分析失败: ${err}`);
      setMode('recorded');
    }
  }, [session, description]);

  // ── 执行 ──

  const handleTestExecute = useCallback(() => {
    if (!template) return;
    // 如果模板有参数，先弹出参数输入
    if (template.parameters && template.parameters.length > 0) {
      setParamValues({});
      setShowParamDialog(true);
      return;
    }
    // 无参数，直接执行
    doTestExecute({});
  }, [template]);

  const doTestExecute = useCallback(async (params: Record<string, unknown>) => {
    if (!template) return;

    try {
      setMode('executing');
      setError(null);
      setShowParamDialog(false);

      const context = await unifiedExecutor.execute(template, params, {
        dryRun: true,
        verbose: true,
        onStepStart: () => {},
        onStepEnd: () => {},
      });

      if (context.status === 'completed') {
        setMode('completed');
      } else {
        setError(`执行失败: ${context.error?.message}`);
        setMode('preview');
      }

    } catch (err) {
      setError(`执行失败: ${err}`);
      setMode('preview');
    }
  }, [template]);

  // ── 保存 ──

  const handleSaveTemplate = useCallback(async () => {
    if (!template) return;

    try {
      // 从模板名称生成工具名（snake_case）
      const toolName = template.name
        .replace(/[\s\-]+/g, '_')
        .replace(/[^a-zA-Z0-9_一-鿿]/g, '')
        .toLowerCase() || 'recorded_task';

      // 从模板参数构建 JSON Schema
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const p of template.parameters) {
        properties[p.name] = {
          type: p.type === 'array' ? 'array' : p.type === 'number' ? 'number' : 'string',
          description: p.description,
          ...(p.constraints?.enum ? { enum: p.constraints.enum } : {}),
        };
        if (p.required) required.push(p.name);
      }

      // 一个 skill = 一个 tool，所有步骤绑定到同一个 toolName
      const { useSkillStore } = await import('@/stores/skill-store');
      await useSkillStore.getState().createSkill({
        id: template.id,
        name: template.name,
        description: template.description,
        category: 'recorded',
        tools: [{
          name: toolName,
          description: template.description,
          parameters: { type: 'object', properties, required: required.length > 0 ? required : undefined },
        }],
        builtin: false,
        exposedToAI: false,
        steps: template.steps.map(step => ({
          toolName,
          arguments: step.params || {},
          description: step.description,
        })),
      });

      setMode('completed');
    } catch (err) {
      setError(`保存失败: ${err}`);
    }
  }, [template]);

  // ── 重置 ──

  const handleReset = useCallback(() => {
    setMode('idle');
    setEvents([]);
    setDuration(0);
    setSelectedEventId(undefined);
    setSession(null);
    setTemplate(null);
    setPattern(null);
    setError(null);
    setShowParamDialog(false);
    setParamValues({});
  }, []);

  // ── 渲染 ──

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* 标题栏 */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Circle
            size={12}
            className={`shrink-0 ${mode === 'recording' ? 'text-red-500 animate-pulse' : 'text-zinc-400'}`}
            fill={mode === 'recording' ? 'currentColor' : 'none'}
          />
          <span className="text-[12px] font-medium truncate">
            {mode === 'idle' && '语义化录制'}
            {mode === 'recording' && `录制中 ${formatDuration(duration)}`}
            {mode === 'paused' && '已暂停'}
            {mode === 'recorded' && `已录制 ${events.length} 个事件`}
            {mode === 'analyzing' && '分析中...'}
            {mode === 'preview' && '模板预览'}
            {mode === 'executing' && '执行中...'}
            {mode === 'completed' && '完成'}
          </span>
        </div>

        {mode !== 'idle' && (
          <button
            onClick={handleReset}
            className="p-1 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-500 shrink-0"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mx-2 mt-1 px-2 py-1.5 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-[11px] text-red-600 dark:text-red-400 shrink-0 flex items-center gap-1">
          <span className="truncate flex-1">{error}</span>
          <button
            onClick={() => setError(null)}
            className="underline shrink-0"
          >
            关闭
          </button>
        </div>
      )}

      {/* 内容区域 */}
      {mode === 'idle' && (
        <div className="flex-1 overflow-y-auto min-h-0 scrollbar-hide p-3 space-y-3">
          <div className="text-center py-2">
            <Circle size={36} className="mx-auto text-zinc-300 dark:text-zinc-600 mb-2" />
            <p className="text-[13px] text-zinc-600 dark:text-zinc-400 mb-0.5">
              录制用户操作
            </p>
            <p className="text-[11px] text-zinc-400">
              系统将自动识别语义并生成自动化模板
            </p>
          </div>

          <div className="bg-green-50 dark:bg-green-950 border border-green-200 dark:border-green-800 rounded-lg p-2">
            <p className="text-[11px] text-green-600 dark:text-green-400 truncate" title="支持录制跨应用操作（浏览器复制到 Word 等）">
              <strong>全局监听：</strong>支持录制跨应用操作（浏览器复制到 Word 等）
            </p>
          </div>

          {/* 受控浏览器 */}
          {!webBrowserOpen ? (
            <div className="bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg p-2 space-y-1.5">
              <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                <AlertCircle size={12} className="shrink-0" />
                如果操作涉及浏览器，请先打开受控浏览器
              </p>
              <button
                onClick={handleOpenBrowser}
                disabled={webBrowserLoading}
                className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-amber-600 text-white text-[11px] font-medium hover:bg-amber-700 disabled:opacity-50 transition-colors"
              >
                {webBrowserLoading ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Globe size={12} />
                )}
                打开受控浏览器
              </button>
            </div>
          ) : (
            <div className="bg-blue-50 dark:bg-blue-950 border border-blue-200 dark:border-blue-800 rounded-lg p-2 flex items-center justify-between">
              <p className="text-[11px] text-blue-600 dark:text-blue-400 flex items-center gap-1">
                <Check size={12} className="shrink-0" />
                受控浏览器已连接
              </p>
              <button
                onClick={handleCloseBrowser}
                className="p-1 rounded hover:bg-blue-100 dark:hover:bg-blue-900 text-blue-500"
              >
                <X size={12} />
              </button>
            </div>
          )}

          <div>
            <label className="block text-[11px] text-zinc-500 mb-1">
              录制描述（可选）
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="描述这次录制的意图..."
              className="w-full px-2 py-1.5 text-[12px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
            />
          </div>

          <button
            onClick={handleStartRecording}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-red-600 text-white text-[13px] font-medium hover:bg-red-700 transition-colors"
          >
            <Circle size={14} fill="white" />
            开始录制
          </button>
        </div>
      )}

      {/* 录制中 - 事件列表 */}
      {(mode === 'recording' || mode === 'paused') && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <div className="flex-1 overflow-y-auto min-h-0">
            <EventList
              events={events}
              onTagEvent={handleTagEvent}
              onUntagEvent={handleUntagEvent}
              onDeleteEvent={handleDeleteEvent}
              selectedEventId={selectedEventId}
              onSelectEvent={setSelectedEventId}
            />
            {/* 事件加载中提示 */}
            {eventLoading && (
              <div className="flex items-center justify-center gap-2 py-2 text-xs text-zinc-500">
                <div className="w-3 h-3 border-2 border-zinc-300 border-t-zinc-600 rounded-full animate-spin" />
                <span>正在获取事件信息...</span>
              </div>
            )}
          </div>

          {/* 录制控制 */}
          <div className="px-2 py-1.5 border-t border-zinc-200 dark:border-zinc-800 shrink-0">
            <div className="flex gap-1.5">
              {mode === 'recording' ? (
                <button
                  onClick={handlePauseRecording}
                  className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[11px]"
                >
                  <Pause size={12} />
                  暂停
                </button>
              ) : (
                <button
                  onClick={handleResumeRecording}
                  className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[11px]"
                >
                  <Play size={12} />
                  恢复
                </button>
              )}

              <button
                onClick={handleUndoLastEvent}
                disabled={events.length === 0}
                className="p-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-500 disabled:opacity-30"
              >
                <Undo2 size={12} />
              </button>

              <button
                onClick={handleStopRecording}
                className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-[11px] font-medium"
              >
                <Square size={12} />
                停止录制
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 录制完成 - 分析 */}
      {mode === 'recorded' && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* 已录制事件列表 */}
          <div className="flex-1 overflow-y-auto min-h-0 scrollbar-hide">
            <EventList
              events={events}
              onTagEvent={handleTagEvent}
              onUntagEvent={handleUntagEvent}
              onDeleteEvent={handleDeleteEvent}
              selectedEventId={selectedEventId}
              onSelectEvent={setSelectedEventId}
            />
          </div>

          {/* 操作按钮 */}
          <div className="px-2 py-2 border-t border-zinc-200 dark:border-zinc-800 space-y-1.5 shrink-0">
            {/* 录制描述（可编辑） */}
            <div>
              <label className="block text-[10px] text-zinc-500 mb-0.5">
                录制描述
              </label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="描述这次录制的意图..."
                className="w-full px-2 py-1 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
              />
            </div>

            <div className="text-[10px] text-zinc-500 text-center">
              已录制 {events.length} 个操作
            </div>

            <button
              onClick={handleAnalyze}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-blue-600 text-white text-[12px] font-medium hover:bg-blue-700"
            >
              <Wand2 size={13} />
              AI 分析生成模板
            </button>

            <button
              onClick={handleReset}
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[11px] text-zinc-500"
            >
              重新录制
            </button>
          </div>
        </div>
      )}

      {/* 分析中 */}
      {mode === 'analyzing' && (
        <div className="flex-1 flex flex-col items-center justify-center min-h-0">
          <Loader2 size={28} className="animate-spin text-blue-500 mb-3" />
          <div className="text-[13px] font-medium">正在分析...</div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            LLM 正在分析操作模式
          </div>
        </div>
      )}

      {/* 模板预览 */}
      {mode === 'preview' && template && (
        <div className="flex-1 overflow-y-auto min-h-0 scrollbar-hide">
          <TemplatePreview
            template={template}
            pattern={pattern || undefined}
            onSave={handleSaveTemplate}
            onTest={handleTestExecute}
            onClose={handleReset}
          />
        </div>
      )}

      {/* 参数输入对话框 */}
      {showParamDialog && template && (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <div className="px-3 py-2 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
            <div className="text-[12px] font-medium">输入参数</div>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 p-3 space-y-2">
            {template.parameters.map((param) => (
              <div key={param.name}>
                <label className="block text-[11px] font-medium text-zinc-700 dark:text-zinc-300 mb-0.5">
                  {param.name}
                  {param.required && <span className="text-red-500 ml-0.5">*</span>}
                  <span className="text-zinc-400 font-normal ml-1">({param.type})</span>
                </label>
                <input
                  type="text"
                  value={paramValues[param.name] ?? ''}
                  onChange={(e) => setParamValues({ ...paramValues, [param.name]: e.target.value })}
                  placeholder={param.description}
                  className="w-full px-2 py-1 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
                />
              </div>
            ))}
          </div>
          <div className="px-2 py-1.5 border-t border-zinc-200 dark:border-zinc-800 flex gap-1.5 shrink-0">
            <button
              onClick={() => setShowParamDialog(false)}
              className="flex-1 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[11px] text-zinc-500"
            >
              取消
            </button>
            <button
              onClick={() => {
                const params: Record<string, unknown> = {};
                for (const param of template.parameters) {
                  const raw = paramValues[param.name]?.trim();
                  if (!raw) continue;
                  if (param.type === 'integer') params[param.name] = parseInt(raw, 10);
                  else if (param.type === 'number') params[param.name] = parseFloat(raw);
                  else params[param.name] = raw;
                }
                doTestExecute(params);
              }}
              className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-lg bg-blue-600 text-white text-[11px] font-medium hover:bg-blue-700"
            >
              <Play size={12} />
              执行测试
            </button>
          </div>
        </div>
      )}

      {/* 执行中 */}
      {mode === 'executing' && (
        <div className="flex-1 flex flex-col items-center justify-center min-h-0">
          <Loader2 size={28} className="animate-spin text-green-500 mb-3" />
          <div className="text-[13px] font-medium">正在执行...</div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            试运行模板
          </div>
        </div>
      )}

      {/* 完成 */}
      {mode === 'completed' && (
        <div className="flex-1 flex flex-col items-center justify-center min-h-0 p-3">
          <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900 flex items-center justify-center mb-3">
            <Check size={24} className="text-green-500" />
          </div>
          <div className="text-[13px] font-medium mb-1">完成</div>
          <div className="text-[11px] text-zinc-500 text-center mb-3">
            模板已保存为技能，可以在技能页面查看和使用
          </div>
          <button
            onClick={handleReset}
            className="px-3 py-1.5 rounded-lg bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-[12px] font-medium"
          >
            新建录制
          </button>
        </div>
      )}
    </div>
  );
}
