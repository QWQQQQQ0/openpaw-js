import { useState, useRef, useCallback, useEffect } from 'react';
import { Camera, Play, StopCircle, CheckCircle, XCircle, Circle } from 'lucide-react';
import { desktopService, WindowInfo } from '@/services/desktop-service';
import { getBuiltinSkill, getBuiltinExecutor } from '@/skills/builtin-executor';
import { ToolModeBar } from '@/components/chat/tool-mode-bar';
import { ToolSelectorPanel } from '@/components/chat/tool-selector-panel';
import { ToolMode } from '@/stores/chat-store';
import { useSettingsStore } from '@/stores/settings-store';
import { AgentTaskService } from '@/services/agent-task-service';
import { automationRecorder } from '@/services/recorder';
import { useSkillStore } from '@/stores/skill-store';
import type { UserSkillConfig, AutomationStep } from '@/types/skill';
import type { SkillTool } from '@/skills/skill';
import { writeLocal } from './utils';
import type { ActionLog, FloatMode } from './types';

interface Props {
  toolMode: ToolMode;
  customTools: Set<string>;
  executorReady: boolean;
  allTools: SkillTool[];
  onToolModeChange: (mode: ToolMode) => void;
  onCustomToolsChange: (tools: Set<string>) => void;
  onRefreshWatcherConfigs: () => Promise<void>;
  onModeChange: (mode: FloatMode) => void;
  onAutomatingChange: (isAutomating: boolean) => void;
}

export default function TaskMode({
  toolMode, customTools, executorReady, allTools,
  onToolModeChange, onCustomToolsChange,
  onRefreshWatcherConfigs, onModeChange, onAutomatingChange,
}: Props) {
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [actionLog, setActionLog] = useState<ActionLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isAutomating, setIsAutomating] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [recordedSteps, setRecordedSteps] = useState<AutomationStep[]>([]);
  const [savingSkill, setSavingSkill] = useState(false);
  const saveSkillNameRef = useRef<HTMLInputElement>(null);
  const goalRef = useRef<HTMLInputElement>(null);
  const [showSelectorPanel, setShowSelectorPanel] = useState(false);

  const { favoriteTools, setFavoriteTools } = useSettingsStore();

  // Keep parent in sync
  useEffect(() => { onAutomatingChange(isAutomating); }, [isAutomating, onAutomatingChange]);

  const handleRefresh = useCallback(async () => {
    setIsCapturing(true);
    try {
      const [base64, windowList] = await Promise.all([
        desktopService.screenshot(),
        desktopService.listWindows(),
      ]);
      setScreenshot(base64);
      setWindows(windowList);
    } catch (e) {
      setError(`Refresh failed: ${e}`);
    } finally {
      setIsCapturing(false);
    }
  }, []);

  // Auto-capture on mount
  useEffect(() => { handleRefresh(); }, []);

  const handleToolModeChange = useCallback((mode: ToolMode) => {
    onToolModeChange(mode);
    if (mode === ToolMode.custom) {
      if (customTools.size === 0) {
        const skill = getBuiltinSkill('desktop_screen');
        const allNames = new Set(skill?.tools.map((t) => t.name) ?? []);
        onCustomToolsChange(allNames);
        writeLocal('float_custom_tools', [...allNames]);
      }
      setShowSelectorPanel(true);
    } else {
      setShowSelectorPanel(false);
    }
  }, [customTools, onToolModeChange, onCustomToolsChange]);

  const handleFavoritesDoubleClick = useCallback(() => {
    onToolModeChange(ToolMode.favorites);
    writeLocal('float_tool_mode', ToolMode.favorites);
    setShowSelectorPanel(true);
  }, [onToolModeChange]);

  const handleStartAutomation = useCallback(async () => {
    const goal = goalRef.current?.value.trim();
    if (!goal || isAutomating) return;

    setIsAutomating(true);
    setError(null);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    // ── 订阅事件总线，实时显示每一步执行日志 ──
    const { appEventBus } = await import('@/services/event-bus');
    const unsubscribes: (() => void)[] = [];
    unsubscribes.push(
      appEventBus.on('agent', '*', (event) => {
        // 展示工具调用事件 + 推理思考过程
        if (event.type === 'before_tool' || event.type === 'after_tool') {
          const isError = event.level === 'warn' || event.level === 'error';
          setActionLog((prev) => [...prev, { action: event.message, success: !isError }]);
        } else if (event.type === 'reasoning') {
          // 思考过程：只展示最新的累积内容，避免刷屏
          const reasoning = (event.data as { reasoning?: string; accumulated?: string } | undefined)?.accumulated;
          if (reasoning) {
            setActionLog((prev) => {
              const others = prev.filter(a => !a.action.startsWith('🧠'));
              return [...others, { action: `🧠 ${reasoning.slice(-200)}`, success: true }];
            });
          }
        }
      }),
    );
    // 应用级任务事件
    unsubscribes.push(
      appEventBus.on('app', '*', (event) => {
        if (event.type === 'task_execute_start') {
          setActionLog((prev) => [...prev, { action: event.message, success: true }]);
        } else if (event.type === 'task_execute_done') {
          setActionLog((prev) => [...prev, { action: event.message, success: true }]);
        }
      }),
    );

    try {
      setActionLog((prev) => [...prev, { action: `Goal: "${goal}"`, success: true }]);

      const { useModelConfigStore } = await import('@/stores/model-config-store');
      await useModelConfigStore.getState().load();
      const config = useModelConfigStore.getState().defaultConfig();
      if (!config) {
        setActionLog((prev) => [...prev, { action: 'No model configured', success: false }]);
        return;
      }

      let apiKey = '';
      try {
        apiKey = await useModelConfigStore.getState().getApiKey(config.id, '');
      } catch (e) {
        setActionLog((prev) => [...prev, { action: `Decrypt API key failed: ${e}`, success: false }]);
        return;
      }
      if (!apiKey) {
        setActionLog((prev) => [...prev, { action: 'API key is empty', success: false }]);
        return;
      }

      const { getModelService } = await import('@/services/model-service-singleton');
      const { getCacheService } = await import('@/services/cache-service-singleton');
      const modelService = getModelService();
      const cacheService = getCacheService();
      const skillExecutor = getBuiltinExecutor() as unknown as import('@/interfaces/skill-executor').ISkillExecutor;

      const settingsState = useSettingsStore.getState();
      let toolFilter: Set<string> | undefined;
      if (toolMode === ToolMode.none) {
        toolFilter = new Set();
      } else if (toolMode === ToolMode.favorites && settingsState.favoriteTools.size > 0) {
        toolFilter = settingsState.favoriteTools;
      } else if (toolMode === ToolMode.custom && customTools.size > 0) {
        toolFilter = customTools;
      }

      const agentTaskService = new AgentTaskService(modelService, skillExecutor, cacheService);
      const response = await agentTaskService.handleUserGoal(goal, config, apiKey, toolFilter, abortController.signal);

      setActionLog((prev) => [...prev, { action: response.message, success: true }]);

      for (const task of response.tasks) {
        if (task.status === 'scheduled') {
          setActionLog((prev) => [...prev, { action: `Scheduled task: ${task.taskId}`, success: true }]);
          if (task.taskId) {
            setTimeout(() => {
              onModeChange('watcher');
              onRefreshWatcherConfigs();
            }, 500);
          }
        } else if (task.status === 'error') {
          setActionLog((prev) => [...prev, { action: `Error: ${task.error}`, success: false }]);
        } else if (task.status === 'done' && task.turns) {
          const totalToolCalls = task.turns.reduce((n, t) => n + t.toolCalls.length, 0);
          setActionLog((prev) => [...prev, { action: `Done: ${totalToolCalls} tool calls`, success: true }]);
        }
      }
    } catch (e) {
      setError(String(e));
      setActionLog((prev) => [...prev, { action: `Error: ${e}`, success: false }]);
    } finally {
      unsubscribes.forEach((fn) => fn());
      abortControllerRef.current = null;
      setIsAutomating(false);
    }
  }, [isAutomating, onRefreshWatcherConfigs, onModeChange, toolMode, customTools]);

  return (
    <>
      {/* Screenshot preview */}
      <div className="basis-[30%] min-h-0 border-b border-zinc-200 dark:border-zinc-800">
        {screenshot ? (
          <div className="relative group h-full">
            <img src={screenshot} alt="Desktop" className="w-full h-full object-cover" />
            <button
              onClick={handleRefresh}
              disabled={isCapturing}
              className="absolute top-1 right-1 p-1.5 rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
            >
              <Camera size={14} />
            </button>
          </div>
        ) : (
          <div className="h-full flex items-center justify-center bg-zinc-100 dark:bg-zinc-900">
            <div className="w-6 h-6 border-2 border-zinc-300 border-t-blue-500 rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Action log */}
      <div className="flex-1 overflow-y-auto px-2 py-1 min-h-0 scrollbar-hide">
        {actionLog.length === 0 ? (
          <div className="flex items-center justify-center h-full text-zinc-400 dark:text-zinc-500 text-[12px]">
            Enter a goal and press Go
          </div>
        ) : (
          [...actionLog].reverse().map((log, i) => (
            <div key={i} className="flex items-center gap-1.5 py-0.5 text-[11px]">
              {log.success ? (
                <CheckCircle size={10} className="text-green-500 shrink-0" />
              ) : (
                <XCircle size={10} className="text-red-500 shrink-0" />
              )}
              <span className="text-zinc-600 dark:text-zinc-400 truncate">{log.action}</span>
            </div>
          ))
        )}
      </div>

      {error && (
        <div className="mx-2 px-2 py-1 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-[11px] text-red-700 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
        </div>
      )}

      <ToolModeBar
        mode={toolMode}
        selectedCount={customTools.size}
        onModeChanged={handleToolModeChange}
        onFavoritesDoubleClick={handleFavoritesDoubleClick}
      />

      {showSelectorPanel && (toolMode === ToolMode.favorites || toolMode === ToolMode.custom) && (
        <ToolSelectorPanel
          tools={allTools}
          selected={toolMode === ToolMode.favorites ? favoriteTools : customTools}
          setSelected={toolMode === ToolMode.favorites ? setFavoriteTools : onCustomToolsChange}
          onClose={() => setShowSelectorPanel(false)}
        />
      )}

      {/* Controls */}
      <div className="shrink-0 p-2 border-t border-zinc-200 dark:border-zinc-800">
        <div className="flex gap-1.5">
          <input
            ref={goalRef}
            type="text"
            placeholder="Goal... (e.g., click the Start button)"
            className="flex-1 px-2 py-1.5 text-[12px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
            onKeyDown={(e) => { if (e.key === 'Enter') handleStartAutomation(); }}
          />
          <button
            id="float-go-btn"
            onClick={handleStartAutomation}
            disabled={isAutomating}
            className="px-3 py-1.5 rounded bg-blue-600 text-white text-[12px] font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"
          >
            {isAutomating ? (
              <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <Play size={12} />
            )}
            Go
          </button>
          <button
            onClick={() => {
              if (isRecording) {
                const steps = automationRecorder.stop();
                setRecordedSteps(steps);
                setShowSaveDialog(true);
              } else {
                automationRecorder.start();
              }
              setIsRecording(!isRecording);
            }}
            disabled={isAutomating && !isRecording}
            className={`p-1.5 rounded border transition-colors ${
              isRecording
                ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950 text-red-500'
                : 'border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-red-500 disabled:opacity-30'
            }`}
            title={isRecording ? 'Stop recording' : 'Record automation'}
          >
            <Circle size={14} fill={isRecording ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={() => {
              abortControllerRef.current?.abort();
              setIsAutomating(false);
              if (isRecording) {
                automationRecorder.cancel();
                setIsRecording(false);
              }
            }}
            disabled={!isAutomating}
            className="p-1.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-red-500 disabled:opacity-30"
          >
            <StopCircle size={14} />
          </button>
        </div>
      </div>

      {/* Save recording dialog */}
      {showSaveDialog && (
        <>
          <div className="fixed inset-0 z-50 bg-black/50" onClick={() => setShowSaveDialog(false)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="bg-white dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded-xl shadow-2xl w-full max-w-sm">
              <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
                <h3 className="font-semibold text-[15px] text-zinc-900 dark:text-zinc-100">Save Recording</h3>
                <button onClick={() => setShowSaveDialog(false)} className="text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">✕</button>
              </div>
              <div className="p-4 space-y-3">
                <p className="text-[12px] text-zinc-500 dark:text-zinc-400">{recordedSteps.length} step(s) recorded</p>
                <input
                  ref={saveSkillNameRef}
                  type="text"
                  placeholder="Skill name..."
                  className="w-full px-3 py-2 text-[13px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
                />
              </div>
              <div className="flex justify-end gap-2 px-4 py-3 border-t border-zinc-100 dark:border-zinc-800">
                <button onClick={() => setShowSaveDialog(false)} className="px-3 py-1.5 text-[13px] rounded-lg text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">Cancel</button>
                <button
                  onClick={async () => {
                    const name = saveSkillNameRef.current?.value.trim() || 'Recorded Skill';
                    setSavingSkill(true);
                    try {
                      const tools = [...new Set(recordedSteps.map((s) => s.toolName))].map((name) => ({
                        name,
                        description: `Recorded: ${name}`,
                        parameters: { type: 'object', properties: {} },
                      }));
                      const cfg: UserSkillConfig = {
                        id: crypto.randomUUID(),
                        name,
                        description: `Recorded automation: ${recordedSteps.map((s) => s.description).join(' → ')}`,
                        category: 'user',
                        tools,
                        builtin: false,
                        exposedToAI: false,
                        steps: recordedSteps,
                      };
                      await useSkillStore.getState().createSkill(cfg);
                      setShowSaveDialog(false);
                      setRecordedSteps([]);
                    } catch { /* ignore */ }
                    setSavingSkill(false);
                  }}
                  disabled={savingSkill}
                  className="px-3 py-1.5 text-[12px] rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {savingSkill ? 'Saving...' : 'Save as Macro'}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
