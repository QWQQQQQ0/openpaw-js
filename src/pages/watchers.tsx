import { useState, useEffect, useCallback } from 'react';
import { Eye, EyeOff, Play, Pause, Trash2, Plus, RefreshCw, Monitor, ChevronDown, ChevronRight, Clock, Zap, AlertCircle, CheckCircle, MonitorSmartphone, Crosshair } from 'lucide-react';
import type { WatcherConfig, WatcherState, ScreenRegion, DiffStrategyType, ActionConfig, ActionType, MonitorTargetType, MonitorTarget } from '@/types/watcher';
import type { AppEvent } from '@/types/events';
import { watcherManager } from '@/services/watcher';
import { appEventBus } from '@/services/event-bus';
import { getAllWatcherConfigs, deleteWatcherConfig, queryAppLogs } from '@/services/cache-service';
import { desktopService, type WindowInfo } from '@/services/desktop-service';
import { WatcherDialog } from '@/components/watcher-dialog';
import type { AppLogEntry } from '@/types/events';

// ── Helpers ──

function formatTime(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString();
}

function formatRelative(ts: number): string {
  if (!ts) return '-';
  const sec = Math.floor(Date.now() / 1000) - ts;
  if (sec < 60) return `${sec}s前`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m前`;
  return `${Math.floor(sec / 3600)}h前`;
}

function strategyLabel(s: DiffStrategyType): string {
  const map: Record<DiffStrategyType, string> = {
    fast_visual: 'Fast Visual',
    semantic_text: 'Semantic Text',
    llm_vision: 'LLM Vision',
  };
  return map[s] ?? s;
}

function statusColor(s: WatcherState['status']): string {
  switch (s) {
    case 'running': return 'text-green-500';
    case 'paused': return 'text-yellow-500';
    case 'triggered': return 'text-blue-500';
    case 'error': return 'text-red-500';
    default: return 'text-zinc-400';
  }
}

function statusIcon(s: WatcherState['status']) {
  switch (s) {
    case 'running': return <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />;
    case 'paused': return <Pause size={12} className="text-yellow-500" />;
    case 'triggered': return <Zap size={12} className="text-blue-500" />;
    case 'error': return <AlertCircle size={12} className="text-red-500" />;
    default: return <div className="w-2 h-2 rounded-full bg-zinc-400" />;
  }
}

// ── Watcher Card ──

function WatcherCard({ config, state, onToggle, onEdit, onDelete, onReResolve }: {
  config: WatcherConfig;
  state?: WatcherState;
  onToggle: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReResolve: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const s = state?.status ?? 'idle';
  const targetLabel = config.monitorTarget?.type === 'window'
    ? `窗口: ${config.monitorTarget.windowTitle || '未知'}`
    : '整个屏幕';

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        {statusIcon(s)}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate">{config.name}</span>
            <span className={`text-[10px] ${statusColor(s)}`}>{s}</span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-zinc-400 mt-0.5">
            <span className="flex items-center gap-1">
              {config.monitorTarget?.type === 'window' ? <MonitorSmartphone size={10} /> : <Monitor size={10} />}
              {targetLabel}
            </span>
            <span>{strategyLabel(config.diffStrategy)}</span>
            <span>{config.pollIntervalMs / 1000}s</span>
            {state && <span>触发: {state.triggerCount}次</span>}
            {state && state.processing && <span className="text-blue-500 animate-pulse">处理中</span>}
            {state && state.queueSize > 0 && <span className="text-amber-500">队列: {state.queueSize}</span>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onToggle}
            className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title={config.enabled ? '禁用' : '启用'}>
            {config.enabled ? <Eye size={16} className="text-green-500" /> : <EyeOff size={16} className="text-zinc-400" />}
          </button>
          {config.regionMode === 'auto' && (
            <button onClick={onReResolve}
              className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
              title="重新定位监控区域">
              <Crosshair size={16} className="text-blue-400" />
            </button>
          )}
          <button onClick={onEdit}
            className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title="编辑">
            <RefreshCw size={16} className="text-zinc-400" />
          </button>
          <button onClick={onDelete}
            className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800"
            title="删除">
            <Trash2 size={16} className="text-red-400" />
          </button>
          <button onClick={() => setExpanded(!expanded)}
            className="p-1.5 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800">
            {expanded ? <ChevronDown size={16} className="text-zinc-400" /> : <ChevronRight size={16} className="text-zinc-400" />}
          </button>
        </div>
      </div>
      {expanded && (
        <div className="px-4 pb-3 pt-1 border-t border-zinc-100 dark:border-zinc-800 text-[12px] space-y-1">
          <div className="text-zinc-500">
            <span className="font-medium">动作:</span> {config.action.type}
            {config.action.goalTemplate && <span className="ml-2 font-mono text-zinc-400">"{config.action.goalTemplate.substring(0, 60)}..."</span>}
          </div>
          {config.context && <div className="text-zinc-500"><span className="font-medium">上下文:</span> {config.context}</div>}
          {state && (
            <div className="text-zinc-500">
              <span className="font-medium">上次检查:</span> {formatRelative(state.lastCheckAt)}
              {state.lastTriggerAt > 0 && <span className="ml-3"><span className="font-medium">上次触发:</span> {formatRelative(state.lastTriggerAt)}</span>}
            </div>
          )}
          {state?.lastError && <div className="text-red-500">错误: {state.lastError}</div>}
          {state && state.queueItems.length > 0 && (
            <div className="text-zinc-500">
              <span className="font-medium">任务队列:</span>
              <div className="mt-1 space-y-0.5">
                {state.queueItems.map((item, i) => (
                  <div key={item.id} className="flex items-center gap-2 text-[11px] font-mono text-zinc-400">
                    <span className="text-zinc-300">#{i + 1}</span>
                    <span>任务 #{item.id}</span>
                    <span>{new Date(item.enqueuedAt).toLocaleTimeString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Log Panel ──

function LogPanel({ watcherId }: { watcherId?: string }) {
  const [logs, setLogs] = useState<AppEvent[]>([]);

  useEffect(() => {
    const unsub = appEventBus.on('watcher', '*', (e) => {
      if (watcherId && e.sourceId !== watcherId) return;
      setLogs(prev => [e, ...prev].slice(0, 200));
    });
    return unsub;
  }, [watcherId]);

  return (
    <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-2 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 flex items-center gap-2">
        <span className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-400">实时日志</span>
        <span className="text-[10px] text-zinc-400">{logs.length} entries</span>
        <div className="flex-1" />
      </div>
      <div className="h-[240px] overflow-y-auto font-mono text-[11px]">
        {logs.length === 0 ? (
          <div className="p-4 text-center text-zinc-400">暂无日志</div>
        ) : (
          logs.map((e, i) => (
            <div key={i} className="px-4 py-1 border-b border-zinc-50 dark:border-zinc-800/50 hover:bg-zinc-50 dark:hover:bg-zinc-900/50">
              <span className="text-zinc-400">{formatTime(e.timestamp)}</span>
              <span className="mx-2 text-zinc-300 dark:text-zinc-600">|</span>
              <span className={e.level === 'error' ? 'text-red-500' : e.level === 'warn' ? 'text-yellow-500' : 'text-zinc-600 dark:text-zinc-400'}>
                {e.type}
              </span>
              <span className="mx-2 text-zinc-300 dark:text-zinc-600">|</span>
              <span className="text-zinc-700 dark:text-zinc-300">{e.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── Main Page ──

export default function WatchersPage() {
  const [configs, setConfigs] = useState<WatcherConfig[]>([]);
  const [states, setStates] = useState<Map<string, WatcherState>>(new Map());
  const [showDialog, setShowDialog] = useState(false);
  const [editConfig, setEditConfig] = useState<WatcherConfig | undefined>();
  const [dbLogs, setDbLogs] = useState<AppLogEntry[]>([]);
  const [showDbLogs, setShowDbLogs] = useState(false);

  const refreshConfigs = useCallback(async () => {
    const cfgs = await getAllWatcherConfigs();
    setConfigs(cfgs);
  }, []);

  // Refresh states periodically
  useEffect(() => {
    refreshConfigs();
    const interval = setInterval(() => {
      const newStates = new Map<string, WatcherState>();
      for (const { config, state } of watcherManager.getStates()) {
        newStates.set(config.id, state);
      }
      setStates(newStates);
    }, 1000);
    return () => clearInterval(interval);
  }, [refreshConfigs]);

  const handleSave = async (config: WatcherConfig) => {
    if (editConfig) {
      await watcherManager.update(editConfig.id, config);
    } else {
      await watcherManager.create(config);
    }
    await refreshConfigs();
    setShowDialog(false);
    setEditConfig(undefined);
  };

  const handleToggle = async (config: WatcherConfig) => {
    await watcherManager.update(config.id, { enabled: !config.enabled });
    await refreshConfigs();
  };

  const handleDelete = async (id: string) => {
    await watcherManager.remove(id);
    await refreshConfigs();
  };

  const handleReResolve = async (id: string) => {
    try {
      await watcherManager.reResolveRegion(id);
    } catch { /* ignore */ }
  };

  const loadDbLogs = async () => {
    const logs = await queryAppLogs({ source: 'watcher', limit: 100 });
    setDbLogs(logs);
    setShowDbLogs(true);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800">
        <div className="flex items-center gap-2">
          <Monitor size={20} className="text-blue-600 dark:text-blue-400" />
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Watcher 监控中心</h1>
          <span className="px-2 py-0.5 rounded-full bg-blue-100 dark:bg-blue-900 text-[11px] text-blue-700 dark:text-blue-300">
            {configs.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadDbLogs}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <Clock size={14} /> 历史日志
          </button>
          <button onClick={() => { setEditConfig(undefined); setShowDialog(true); }}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-700">
            <Plus size={14} /> 新建监控
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {configs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-zinc-400">
            <Monitor size={48} className="mb-4 opacity-30" />
            <p className="text-sm">暂无监控任务</p>
            <p className="text-[12px] mt-1">点击"新建监控"创建你的第一个屏幕监控</p>
          </div>
        ) : (
          <div className="space-y-3">
            {configs.map(config => (
              <WatcherCard
                key={config.id}
                config={config}
                state={states.get(config.id)}
                onToggle={() => handleToggle(config)}
                onEdit={() => { setEditConfig(config); setShowDialog(true); }}
                onDelete={() => handleDelete(config.id)}
                onReResolve={() => handleReResolve(config.id)}
              />
            ))}
          </div>
        )}

        {/* Real-time log */}
        <LogPanel />

        {/* DB log viewer */}
        {showDbLogs && (
          <div className="border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
              <span className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-400">历史日志 (DB)</span>
              <button onClick={() => setShowDbLogs(false)} className="text-[11px] text-zinc-400 hover:text-zinc-600">关闭</button>
            </div>
            <div className="h-[240px] overflow-y-auto font-mono text-[11px]">
              {dbLogs.length === 0 ? (
                <div className="p-4 text-center text-zinc-400">无历史日志</div>
              ) : (
                dbLogs.map((e) => (
                  <div key={e.id} className="px-4 py-1 border-b border-zinc-50 dark:border-zinc-800/50">
                    <span className="text-zinc-400">{formatTime(e.timestamp)}</span>
                    <span className="mx-2 text-zinc-300 dark:text-zinc-600">|</span>
                    <span className={e.level === 'error' ? 'text-red-500' : e.level === 'warn' ? 'text-yellow-500' : 'text-zinc-600 dark:text-zinc-400'}>
                      {e.event}
                    </span>
                    <span className="mx-2 text-zinc-300 dark:text-zinc-600">|</span>
                    <span className="text-zinc-700 dark:text-zinc-300">{e.message}</span>
                    {e.source_name && <span className="ml-2 text-zinc-400">[{e.source_name}]</span>}
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Dialog */}
      {showDialog && (
        <WatcherDialog
          config={editConfig}
          onSave={handleSave}
          onClose={() => { setShowDialog(false); setEditConfig(undefined); }}
        />
      )}
    </div>
  );
}
