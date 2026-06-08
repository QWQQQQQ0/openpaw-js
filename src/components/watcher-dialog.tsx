// Shared WatcherDialog component — used by both main app and float window

import { useState, useEffect } from 'react';
import { Monitor, MonitorSmartphone, Timer, Activity } from 'lucide-react';
import type { WatcherConfig, ScreenRegion, DiffStrategyType, ActionConfig, ActionType, MonitorTargetType, MonitorTarget, RegionMode } from '@/types/watcher';
import { desktopService, type WindowInfo } from '@/services/desktop-service';
import { RegionSelector } from './region-selector';

interface WatcherDialogProps {
  config?: WatcherConfig;
  onSave: (c: WatcherConfig) => void;
  onClose: () => void;
  compact?: boolean; // For float window mode
}

export function WatcherDialog({ config, onSave, onClose, compact = false }: WatcherDialogProps) {
  const [triggerType, setTriggerType] = useState<'timer' | 'screen_change'>('screen_change');
  const [name, setName] = useState(config?.name ?? '');
  const [monitorTargetType, setMonitorTargetType] = useState<MonitorTargetType>(config?.monitorTarget?.type ?? 'fullscreen');
  const [selectedWindowHwnd, setSelectedWindowHwnd] = useState<number | undefined>(config?.monitorTarget?.windowHwnd);
  const [selectedWindowTitle, setSelectedWindowTitle] = useState<string>(config?.monitorTarget?.windowTitle ?? '');
  const [selectedAppName, setSelectedAppName] = useState<string>(config?.monitorTarget?.appName ?? '');
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [loadingWindows, setLoadingWindows] = useState(false);
  const [regionX, setRegionX] = useState(config?.region.x ?? 0);
  const [regionY, setRegionY] = useState(config?.region.y ?? 0);
  const [regionW, setRegionW] = useState(config?.region.width ?? 400);
  const [regionH, setRegionH] = useState(config?.region.height ?? 300);
  const [pollMs, setPollMs] = useState(config?.pollIntervalMs ?? 2000);
  const [strategy, setStrategy] = useState<DiffStrategyType>(config?.diffStrategy ?? 'fast_visual');
  const [debounceMs, setDebounceMs] = useState(config?.debounceMs ?? 300);
  const [cooldownMs, setCooldownMs] = useState(config?.cooldownMs ?? 5000);
  const [minConfidence, setMinConfidence] = useState(config?.minConfidence ?? 0.9);
  const [actionType, setActionType] = useState<ActionType>(config?.action.type ?? 'agent_execute');
  const [goalTemplate, setGoalTemplate] = useState(config?.action.goalTemplate ?? '');
  const [notifyTemplate, setNotifyTemplate] = useState(config?.action.notifyTemplate ?? '');
  const [context, setContext] = useState(config?.context ?? '');
  const [regionMode, setRegionMode] = useState<RegionMode>(config?.regionMode ?? 'manual');
  const [regionDescription, setRegionDescription] = useState(config?.regionDescription ?? '');
  const [screenshotForSelector, setScreenshotForSelector] = useState<string | null>(null);
  const [screenshotDimensions, setScreenshotDimensions] = useState({ width: 0, height: 0 });
  const [loadingScreenshot, setLoadingScreenshot] = useState(false);

  // Load window list
  const loadWindows = async () => {
    setLoadingWindows(true);
    try {
      const wins = await desktopService.listWindows();
      setWindows(wins);
    } catch {
      // ignore
    } finally {
      setLoadingWindows(false);
    }
  };

  useEffect(() => {
    if (monitorTargetType === 'window') {
      loadWindows();
    }
  }, [monitorTargetType]);

  // Handle window selection
  const handleWindowSelect = (hwnd: number) => {
    const win = windows.find(w => w.hwnd === hwnd);
    if (win) {
      setSelectedWindowHwnd(hwnd);
      setSelectedWindowTitle(win.title);
      setSelectedAppName(win.app_name || '');
    }
  };

  // Take screenshot for region selection
  const handleTakeScreenshot = async () => {
    setLoadingScreenshot(true);
    try {
      const base64 = await desktopService.screenshot();
      // Get image dimensions
      const img = new Image();
      img.onload = () => {
        setScreenshotDimensions({ width: img.naturalWidth, height: img.naturalHeight });
        setScreenshotForSelector(base64.startsWith('data:') ? base64 : `data:image/bmp;base64,${base64}`);
        setLoadingScreenshot(false);
      };
      img.onerror = () => {
        console.error('Failed to load screenshot image');
        setLoadingScreenshot(false);
      };
      img.src = base64.startsWith('data:') ? base64 : `data:image/bmp;base64,${base64}`;
    } catch (e) {
      console.error('Screenshot failed:', e);
      setLoadingScreenshot(false);
    }
  };

  const handleSave = () => {
    const now = Math.floor(Date.now() / 1000);
    const action: ActionConfig = {
      type: actionType,
      goalTemplate: actionType === 'agent_execute' ? goalTemplate : undefined,
      notifyTemplate: actionType === 'notify' ? notifyTemplate : undefined,
    };

    const monitorTarget: MonitorTarget = {
      type: monitorTargetType,
      windowHwnd: monitorTargetType === 'window' ? selectedWindowHwnd : undefined,
      windowTitle: monitorTargetType === 'window' ? selectedWindowTitle : undefined,
      appName: monitorTargetType === 'window' ? (selectedAppName || undefined) : undefined,
    };

    onSave({
      id: config?.id ?? crypto.randomUUID(),
      name,
      enabled: config?.enabled ?? true,
      monitorTarget,
      region: { x: regionX, y: regionY, width: regionW, height: regionH },
      pollIntervalMs: pollMs,
      diffStrategy: strategy,
      debounceMs,
      cooldownMs,
      minConfidence,
      action,
      context: context || undefined,
      regionMode,
      regionDescription: regionMode === 'auto' ? regionDescription : undefined,
      createdAt: config?.createdAt ?? now,
      updatedAt: now,
    });
  };

  // Compact mode for float window
  if (compact) {
    return (
      <div className="p-2 space-y-2 max-h-[400px] overflow-y-auto">
        {/* Name */}
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Watcher name..."
          className="w-full px-2 py-1 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
        />

        {/* Trigger Type */}
        <div className="flex gap-1">
          <button onClick={() => setTriggerType('timer')}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] border transition-colors ${triggerType === 'timer' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
            <Timer size={10} /> Timer
          </button>
          <button onClick={() => setTriggerType('screen_change')}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] border transition-colors ${triggerType === 'screen_change' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
            <Activity size={10} /> Screen
          </button>
        </div>

        {/* Monitor Target (screen_change only) */}
        {triggerType === 'screen_change' && (<>
        <div className="flex gap-1">
          <button
            onClick={() => setMonitorTargetType('fullscreen')}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] border transition-colors ${
              monitorTargetType === 'fullscreen'
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600'
                : 'border-zinc-200 dark:border-zinc-700 text-zinc-500'
            }`}
          >
            <Monitor size={10} />
            Fullscreen
          </button>
          <button
            onClick={() => { setMonitorTargetType('window'); loadWatcherWindows(); }}
            className={`flex-1 flex items-center justify-center gap-1 px-2 py-1 rounded text-[10px] border transition-colors ${
              monitorTargetType === 'window'
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600'
                : 'border-zinc-200 dark:border-zinc-700 text-zinc-500'
            }`}
          >
            <MonitorSmartphone size={10} />
            Window
          </button>
        </div>

        {/* Window Selector */}
        {monitorTargetType === 'window' && (
          <select
            value={selectedWindowHwnd ?? ''}
            onChange={e => handleWindowSelect(Number(e.target.value))}
            className="w-full px-2 py-1 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 outline-none"
          >
            <option value="">{loadingWindows ? 'Loading...' : '-- Select window --'}</option>
            {windows.map(win => (
              <option key={win.hwnd} value={win.hwnd}>{win.title || `Window ${win.hwnd}`}</option>
            ))}
          </select>
        )}

        {/* Region Mode */}
        <div>
          <div className="flex gap-1">
            <button onClick={() => setRegionMode('manual')}
              className={`flex-1 px-2 py-1 rounded text-[10px] border transition-colors ${regionMode === 'manual' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
              手动框选
            </button>
            <button onClick={() => setRegionMode('auto')}
              className={`flex-1 px-2 py-1 rounded text-[10px] border transition-colors ${regionMode === 'auto' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
              AI 自动识别
            </button>
          </div>
          {regionMode === 'manual' ? (
            <div className="mt-1">
              <button onClick={handleTakeScreenshot} disabled={loadingScreenshot}
                className="w-full px-2 py-1 rounded text-[10px] border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50">
                {loadingScreenshot ? '截图中...' : screenshotForSelector ? '重新截图' : '截图选取区域'}
              </button>
              {screenshotForSelector && (
                <div className="mt-1">
                  <RegionSelector
                    imageBase64={screenshotForSelector}
                    originalWidth={screenshotDimensions.width}
                    originalHeight={screenshotDimensions.height}
                    initialRegion={{ x: regionX, y: regionY, width: regionW, height: regionH }}
                    onRegionChange={r => { setRegionX(r.x); setRegionY(r.y); setRegionW(r.width); setRegionH(r.height); }}
                    compact
                  />
                </div>
              )}
              <div className="grid grid-cols-4 gap-1 mt-1">
                <input type="number" value={regionX} onChange={e => setRegionX(Number(e.target.value))}
                  className="px-1 py-0.5 text-[10px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" placeholder="X" />
                <input type="number" value={regionY} onChange={e => setRegionY(Number(e.target.value))}
                  className="px-1 py-0.5 text-[10px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" placeholder="Y" />
                <input type="number" value={regionW} onChange={e => setRegionW(Number(e.target.value))}
                  className="px-1 py-0.5 text-[10px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" placeholder="W" />
                <input type="number" value={regionH} onChange={e => setRegionH(Number(e.target.value))}
                  className="px-1 py-0.5 text-[10px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" placeholder="H" />
              </div>
            </div>
          ) : (
            <div className="mt-1">
              <input value={regionDescription} onChange={e => setRegionDescription(e.target.value)}
                placeholder="描述要监控的区域，例如: 微信消息列表"
                className="w-full px-2 py-1 text-[10px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100" />
              <p className="text-[9px] text-zinc-400 mt-0.5">AI 启动时自动识别区域</p>
            </div>
          )}
        </div>

        {/* Poll interval */}
        <div>
          <label className="text-[10px] text-zinc-400">Poll: {pollMs}ms</label>
          <input type="range" min={500} max={10000} step={500} value={pollMs}
            onChange={e => setPollMs(Number(e.target.value))} className="w-full h-1" />
        </div>

        {/* Strategy */}
        <select
          value={strategy}
          onChange={e => setStrategy(e.target.value as DiffStrategyType)}
          className="w-full px-2 py-1 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 outline-none"
        >
          <option value="fast_visual">Fast Visual (rapid, ~5ms)</option>
          <option value="semantic_text">Semantic Text (precise, ~100ms)</option>
          <option value="llm_vision">LLM Vision (smart, ~2s)</option>
        </select>

        {/* Debounce & Cooldown */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-zinc-400">Debounce: {debounceMs}ms</label>
            <input type="range" min={0} max={2000} step={100} value={debounceMs}
              onChange={e => setDebounceMs(Number(e.target.value))} className="w-full h-1" />
          </div>
          <div>
            <label className="text-[10px] text-zinc-400">Cooldown: {cooldownMs / 1000}s</label>
            <input type="range" min={1000} max={30000} step={1000} value={cooldownMs}
              onChange={e => setCooldownMs(Number(e.target.value))} className="w-full h-1" />
          </div>
        </div>

        {/* Min Confidence */}
        <div>
          <label className="text-[10px] text-zinc-400">Min confidence: {(minConfidence * 100).toFixed(0)}%</label>
          <input type="range" min={50} max={98} step={1} value={Math.round(minConfidence * 100)}
            onChange={e => setMinConfidence(Number(e.target.value) / 100)} className="w-full h-1" />
        </div>
        </>)}

        {/* Timer-specific fields */}
        {triggerType === 'timer' && (
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-[10px] text-zinc-400">Interval: {pollMs / 1000}s</label>
            <input type="range" min={5000} max={300000} step={5000} value={pollMs}
              onChange={e => setPollMs(Number(e.target.value))} className="w-full h-1" />
          </div>
          <div>
            <label className="text-[10px] text-zinc-400">Cooldown: {cooldownMs / 1000}s</label>
            <input type="range" min={1000} max={300000} step={1000} value={cooldownMs}
              onChange={e => setCooldownMs(Number(e.target.value))} className="w-full h-1" />
          </div>
        </div>
        )}

        {/* Action type */}
        <select
          value={actionType}
          onChange={e => setActionType(e.target.value as ActionType)}
          className="w-full px-2 py-1 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 outline-none"
        >
          <option value="agent_execute">Agent Execute</option>
          <option value="notify">System Notification</option>
          <option value="custom">Custom Handler</option>
        </select>

        {/* Goal / Notify template */}
        {actionType === 'agent_execute' && (
          <textarea
            value={goalTemplate}
            onChange={e => setGoalTemplate(e.target.value)}
            placeholder="Goal template (e.g., 检测到新消息请回复)"
            rows={2}
            className="w-full px-2 py-1 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500 resize-none"
          />
        )}
        {actionType === 'notify' && (
          <input
            type="text"
            value={notifyTemplate}
            onChange={e => setNotifyTemplate(e.target.value)}
            placeholder="Notify template (e.g., 检测到变化: {diff})"
            className="w-full px-2 py-1 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
          />
        )}

        {/* Context */}
        <input
          type="text"
          value={context}
          onChange={e => setContext(e.target.value)}
          placeholder="Context (optional)"
          className="w-full px-2 py-1 text-[11px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
        />

        {/* Buttons */}
        <div className="flex gap-2">
          <button
            onClick={onClose}
            className="flex-1 px-2 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-[11px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="flex-1 px-2 py-1.5 rounded-lg bg-blue-600 text-white text-[11px] font-medium hover:bg-blue-700 disabled:opacity-50"
          >
            {config ? 'Save' : 'Create'}
          </button>
        </div>
      </div>
    );
  }

  // Full mode for main app
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-white dark:bg-zinc-900 rounded-xl w-[500px] max-h-[85vh] overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="p-4 border-b border-zinc-200 dark:border-zinc-800">
          <h3 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
            {config ? '编辑监控' : '新建监控'}
          </h3>
        </div>
        <div className="p-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-[12px] font-medium text-zinc-500 mb-1">名称</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100"
              placeholder="例: 微信消息监控" />
          </div>

          {/* Trigger Type */}
          <div>
            <label className="block text-[12px] font-medium text-zinc-500 mb-1">触发类型</label>
            <div className="flex gap-2">
              <button onClick={() => setTriggerType('timer')}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm border transition-colors ${triggerType === 'timer' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600'}`}>
                <Timer size={16} /> 定时执行
              </button>
              <button onClick={() => setTriggerType('screen_change')}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm border transition-colors ${triggerType === 'screen_change' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600'}`}>
                <Activity size={16} /> 屏幕变化
              </button>
            </div>
          </div>

          {/* Monitor Target (screen_change only) */}
          {triggerType === 'screen_change' && (<>
          <div>
            <label className="block text-[12px] font-medium text-zinc-500 mb-1">监控目标</label>
            <div className="flex gap-2">
              <button
                onClick={() => setMonitorTargetType('fullscreen')}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm border transition-colors ${
                  monitorTargetType === 'fullscreen'
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600'
                }`}
              >
                <Monitor size={16} />
                整个屏幕
              </button>
              <button
                onClick={() => setMonitorTargetType('window')}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-sm border transition-colors ${
                  monitorTargetType === 'window'
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                    : 'border-zinc-200 dark:border-zinc-700 text-zinc-600 dark:text-zinc-400 hover:border-zinc-300 dark:hover:border-zinc-600'
                }`}
              >
                <MonitorSmartphone size={16} />
                特定窗口
              </button>
            </div>
          </div>

          {/* Window Selector (only when window mode) */}
          {monitorTargetType === 'window' && (
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-[12px] font-medium text-zinc-500">选择窗口</label>
                <button onClick={loadWindows} disabled={loadingWindows}
                  className="text-[11px] text-blue-500 hover:text-blue-600 disabled:text-zinc-400">
                  {loadingWindows ? '加载中...' : '刷新列表'}
                </button>
              </div>
              <select
                value={selectedWindowHwnd ?? ''}
                onChange={e => handleWindowSelect(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100"
              >
                <option value="">-- 请选择窗口 --</option>
                {windows.map(win => (
                  <option key={win.hwnd} value={win.hwnd}>
                    {win.title || `窗口 ${win.hwnd}`}
                  </option>
                ))}
              </select>
              {selectedWindowTitle && (
                <p className="text-[10px] text-zinc-400 mt-1">已选: {selectedWindowTitle}</p>
              )}
            </div>
          )}

          {/* Region */}
          <div>
            <label className="block text-[12px] font-medium text-zinc-500 mb-1">
              监控区域
              {monitorTargetType === 'window' && <span className="text-zinc-400 ml-1">(相对于窗口)</span>}
            </label>

            {/* Region Mode Toggle */}
            <div className="flex gap-2 mb-2">
              <button onClick={() => setRegionMode('manual')}
                className={`flex-1 px-3 py-1.5 rounded-lg text-sm border transition-colors ${regionMode === 'manual' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
                手动框选
              </button>
              <button onClick={() => setRegionMode('auto')}
                className={`flex-1 px-3 py-1.5 rounded-lg text-sm border transition-colors ${regionMode === 'auto' ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600' : 'border-zinc-200 dark:border-zinc-700 text-zinc-500'}`}>
                AI 自动识别
              </button>
            </div>

            {regionMode === 'manual' ? (
              <>
                <button onClick={handleTakeScreenshot} disabled={loadingScreenshot}
                  className="mb-2 px-3 py-1.5 rounded-lg text-sm border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-50 dark:hover:bg-zinc-800 disabled:opacity-50">
                  {loadingScreenshot ? '截图中...' : screenshotForSelector ? '重新截图' : '截图选取区域'}
                </button>
                {screenshotForSelector && (
                  <div className="mb-2">
                    <RegionSelector
                      imageBase64={screenshotForSelector}
                      originalWidth={screenshotDimensions.width}
                      originalHeight={screenshotDimensions.height}
                      initialRegion={{ x: regionX, y: regionY, width: regionW, height: regionH }}
                      onRegionChange={r => { setRegionX(r.x); setRegionY(r.y); setRegionW(r.width); setRegionH(r.height); }}
                    />
                  </div>
                )}
                <div className="grid grid-cols-4 gap-2">
                  {[
                    { label: 'X', value: regionX, set: setRegionX },
                    { label: 'Y', value: regionY, set: setRegionY },
                    { label: 'W', value: regionW, set: setRegionW },
                    { label: 'H', value: regionH, set: setRegionH },
                  ].map(({ label, value, set }) => (
                    <div key={label}>
                      <span className="text-[10px] text-zinc-400">{label}</span>
                      <input type="number" value={value} onChange={e => set(Number(e.target.value))}
                        className="w-full px-2 py-1 rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100" />
                    </div>
                  ))}
                </div>
                {monitorTargetType === 'fullscreen' && (
                  <p className="text-[10px] text-zinc-400 mt-1">全屏模式下使用屏幕绝对坐标</p>
                )}
              </>
            ) : (
              <div>
                <input value={regionDescription} onChange={e => setRegionDescription(e.target.value)}
                  placeholder="描述要监控的区域，例如: 微信消息列表"
                  className="w-full px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100" />
                <p className="text-[10px] text-zinc-400 mt-1">AI 将在监控启动时自动识别并定位该区域</p>
              </div>
            )}
          </div>

          {/* Poll interval */}
          <div>
            <label className="block text-[12px] font-medium text-zinc-500 mb-1">轮询间隔: {pollMs}ms</label>
            <input type="range" min={500} max={10000} step={500} value={pollMs} onChange={e => setPollMs(Number(e.target.value))}
              className="w-full" />
          </div>

          {/* Strategy */}
          <div>
            <label className="block text-[12px] font-medium text-zinc-500 mb-1">差异策略</label>
            <select value={strategy} onChange={e => setStrategy(e.target.value as DiffStrategyType)}
              className="w-full px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100">
              <option value="fast_visual">Fast Visual (快速视觉, ~5ms)</option>
              <option value="semantic_text">Semantic Text (语义文本, ~100ms)</option>
              <option value="llm_vision">LLM Vision (智能视觉, ~2s)</option>
            </select>
          </div>

          {/* Debounce & Cooldown */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] font-medium text-zinc-500 mb-1">防抖: {debounceMs}ms</label>
              <input type="range" min={0} max={2000} step={100} value={debounceMs} onChange={e => setDebounceMs(Number(e.target.value))}
                className="w-full" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-zinc-500 mb-1">冷却: {cooldownMs / 1000}s</label>
              <input type="range" min={1000} max={30000} step={1000} value={cooldownMs} onChange={e => setCooldownMs(Number(e.target.value))}
                className="w-full" />
            </div>
          </div>

          {/* Min Confidence */}
          <div>
            <label className="block text-[12px] font-medium text-zinc-500 mb-1">
              最低置信度: {(minConfidence * 100).toFixed(0)}%
              <span className="text-zinc-400 font-normal ml-1">(低于此值仅记日志不触发)</span>
            </label>
            <div className="flex items-center gap-3">
              <input type="range" min={50} max={98} step={1} value={Math.round(minConfidence * 100)}
                onChange={e => setMinConfidence(Number(e.target.value) / 100)} className="flex-1" />
              <span className="text-[11px] text-zinc-400 w-8 text-right">{Math.round(minConfidence * 100)}%</span>
            </div>
            <div className="flex justify-between text-[9px] text-zinc-400 mt-0.5 px-0.5">
              <span>50% 更敏感</span>
              <span>98% 更保守</span>
            </div>
          </div>
          </>/* end screen_change */)}

          {/* Timer-specific fields */}
          {triggerType === 'timer' && (
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-[12px] font-medium text-zinc-500 mb-1">执行间隔: {pollMs / 1000}s</label>
              <input type="range" min={5000} max={300000} step={5000} value={pollMs} onChange={e => setPollMs(Number(e.target.value))}
                className="w-full" />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-zinc-500 mb-1">冷却: {cooldownMs / 1000}s</label>
              <input type="range" min={1000} max={300000} step={1000} value={cooldownMs} onChange={e => setCooldownMs(Number(e.target.value))}
                className="w-full" />
            </div>
          </div>
          )}

          {/* Action type */}
          <div>
            <label className="block text-[12px] font-medium text-zinc-500 mb-1">触发动作</label>
            <select value={actionType} onChange={e => setActionType(e.target.value as ActionType)}
              className="w-full px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100">
              <option value="agent_execute">Agent 执行</option>
              <option value="notify">系统通知</option>
              <option value="custom">自定义</option>
            </select>
          </div>

          {actionType === 'agent_execute' && (
            <div>
              <label className="block text-[12px] font-medium text-zinc-500 mb-1">Goal 模板</label>
              <textarea value={goalTemplate} onChange={e => setGoalTemplate(e.target.value)} rows={3}
                className="w-full px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100 font-mono"
                placeholder="例: 检测到微信新消息：&#10;{diff}&#10;请阅读并回复这条消息。" />
              <p className="text-[10px] text-zinc-400 mt-1">{'可用占位符: {snapshot} {diff} {ocr} {context}'}</p>
            </div>
          )}

          {actionType === 'notify' && (
            <div>
              <label className="block text-[12px] font-medium text-zinc-500 mb-1">通知模板</label>
              <input value={notifyTemplate} onChange={e => setNotifyTemplate(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100"
                placeholder="例: 检测到变化: {diff}" />
            </div>
          )}

          {/* Context */}
          <div>
            <label className="block text-[12px] font-medium text-zinc-500 mb-1">附加上下文</label>
            <input value={context} onChange={e => setContext(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 text-sm text-zinc-900 dark:text-zinc-100"
              placeholder="例: 正在监控微信群聊窗口" />
          </div>
        </div>
        <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 flex justify-end gap-2">
          <button onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            取消
          </button>
          <button onClick={handleSave} disabled={!name || (monitorTargetType === 'window' && !selectedWindowHwnd)}
            className="px-4 py-1.5 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            保存
          </button>
        </div>
      </div>
    </div>
  );

  function loadWatcherWindows() {
    loadWindows();
  }
}
