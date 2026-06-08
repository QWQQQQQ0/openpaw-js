import { useState, useRef, useCallback, useEffect } from 'react';
import { Eye, Plus, Trash2, Crosshair } from 'lucide-react';
import { ToolMode } from '@/stores/chat-store';
import { watcherManager } from '@/services/watcher';
import { appEventBus } from '@/services/event-bus';
import { getAllWatcherConfigs } from '@/services/cache-service';
import type { WatcherConfig, WatcherState } from '@/types/watcher';
import { WatcherDialog } from '@/components/watcher-dialog';

interface Props {
  mode: string;
  toolMode: ToolMode;
  customTools: Set<string>;
}

export default function WatcherMode({ mode, toolMode, customTools }: Props) {
  const [watcherConfigs, setWatcherConfigs] = useState<WatcherConfig[]>([]);
  const [watcherStates, setWatcherStates] = useState<Map<string, WatcherState>>(new Map());
  const [watcherLogs, setWatcherLogs] = useState<Array<{
    time: string;
    source: string;
    type: string;
    level: string;
    message: string;
    sourceName?: string;
    snapshotPath?: string;
    data?: { baseline?: string; current?: string; confidence?: number; diffDetail?: string; changed?: boolean; screenshot?: string };
  }>>([]);
  const watcherLogsRef = useRef<HTMLDivElement>(null);
  const [showWatcherDialog, setShowWatcherDialog] = useState(false);
  const [editWatcherConfig, setEditWatcherConfig] = useState<WatcherConfig | undefined>();
  const [previewImage, setPreviewImage] = useState<string | null>(null);
  const [compareImages, setCompareImages] = useState<{ baseline: string; current: string } | null>(null);

  const refreshWatcherConfigs = useCallback(async () => {
    const cfgs = await getAllWatcherConfigs();
    setWatcherConfigs(cfgs);
  }, []);

  // Expose refreshWatcherConfigs via a stable reference
  const refreshRef = useRef(refreshWatcherConfigs);
  refreshRef.current = refreshWatcherConfigs;

  useEffect(() => { watcherLogsRef.current?.scrollTo({ top: 0 }); }, [watcherLogs]);

  useEffect(() => {
    if (mode === 'watcher') {
      refreshWatcherConfigs();
      const interval = setInterval(() => {
        const newStates = new Map<string, WatcherState>();
        for (const { config, state } of watcherManager.getStates()) {
          newStates.set(config.id, state);
        }
        setWatcherStates(newStates);
      }, 1000);

      const unsub = appEventBus.on('*', '*', (e) => {
        const time = new Date(e.timestamp).toLocaleTimeString();
        setWatcherLogs(prev => [{
          time,
          source: e.source,
          type: e.type,
          level: e.level,
          message: e.message,
          sourceName: e.sourceName,
          snapshotPath: e.snapshotPath,
          data: e.data as { baseline?: string; current?: string; confidence?: number; diffDetail?: string; changed?: boolean; screenshot?: string } | undefined,
        }, ...prev].slice(0, 200));
      });

      return () => {
        clearInterval(interval);
        unsub();
      };
    }
  }, [mode, refreshWatcherConfigs]);

  const handleWatcherToggle = useCallback(async (config: WatcherConfig) => {
    const newEnabled = !config.enabled;
    try {
      await watcherManager.update(config.id, { enabled: newEnabled });
    } catch { /* ignore */ }
    await refreshWatcherConfigs();
  }, [refreshWatcherConfigs]);

  const handleWatcherDelete = useCallback(async (id: string) => {
    await watcherManager.remove(id);
    await refreshWatcherConfigs();
  }, [refreshWatcherConfigs]);

  const handleReResolve = useCallback(async (id: string) => {
    try {
      await watcherManager.reResolveRegion(id);
    } catch { /* ignore */ }
  }, []);

  const handleWatcherSave = useCallback(async (config: WatcherConfig) => {
    const configWithTools: WatcherConfig = {
      ...config,
      toolMode: config.action.type === 'agent_execute' ? toolMode : undefined,
      customTools: config.action.type === 'agent_execute' && toolMode === ToolMode.custom ? Array.from(customTools) : undefined,
    };
    if (editWatcherConfig) {
      await watcherManager.update(editWatcherConfig.id, configWithTools);
    } else {
      await watcherManager.create(configWithTools);
    }
    await refreshWatcherConfigs();
    setShowWatcherDialog(false);
    setEditWatcherConfig(undefined);
  }, [editWatcherConfig, refreshWatcherConfigs, toolMode, customTools]);

  return (
    <>
      <div className="flex-1 overflow-y-auto px-2 py-1 min-h-0 scrollbar-hide">
        <button
          onClick={() => { setEditWatcherConfig(undefined); setShowWatcherDialog(true); }}
          className="w-full flex items-center justify-center gap-1 px-2 py-1.5 mb-2 rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 text-[11px] text-zinc-500 hover:text-blue-500 hover:border-blue-400 dark:hover:border-blue-600 transition-colors"
        >
          <Plus size={12} />
          New Watcher
        </button>

        {watcherConfigs.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-zinc-400 dark:text-zinc-500 text-[12px]">
            <Eye size={24} className="mb-2 opacity-30" />
            <p>No watchers configured</p>
            <p className="text-[10px] mt-1">Click "New Watcher" to add one</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {watcherConfigs.map((config) => {
              const state = watcherStates.get(config.id);
              return (
                <div key={config.id} className="flex items-center gap-2 px-2 py-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                  <div className={`w-2 h-2 rounded-full shrink-0 ${state?.status === 'running' ? 'bg-green-500 animate-pulse' : state?.status === 'triggered' ? 'bg-blue-500' : 'bg-zinc-400'}`} />
                  <div
                    className="flex-1 min-w-0 cursor-pointer"
                    onClick={() => { setEditWatcherConfig(config); setShowWatcherDialog(true); }}
                  >
                    <div className="text-[11px] font-medium text-zinc-900 dark:text-zinc-100 truncate">{config.name}</div>
                    <div className="text-[10px] text-zinc-400">
                      {config.monitorTarget?.type === 'window' ? config.monitorTarget.windowTitle : 'Fullscreen'}
                      {state && <span className="ml-2">Triggers: {state.triggerCount}</span>}
                      {state?.processing && <span className="ml-1 text-blue-500 animate-pulse">●</span>}
                      {state && state.queueSize > 0 && <span className="ml-1 text-amber-500">Q:{state.queueSize}</span>}
                    </div>
                  </div>
                  {config.monitorTarget?.type === 'window' && (
                    <button onClick={() => handleReResolve(config.id)} className="p-1 rounded hover:bg-blue-100 dark:hover:bg-blue-900" title="重新定位">
                      <Crosshair size={12} className="text-blue-500" />
                    </button>
                  )}
                  <button onClick={() => handleWatcherToggle(config)} className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700">
                    <Eye size={12} className={config.enabled ? 'text-green-500' : 'text-zinc-400'} />
                  </button>
                  <button onClick={() => handleWatcherDelete(config.id)} className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900">
                    <Trash2 size={12} className="text-red-400" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Watcher logs */}
      <div className="basis-[40%] min-h-0 border-t border-zinc-200 dark:border-zinc-800 flex flex-col">
        <div className="px-2 py-1 bg-zinc-50 dark:bg-zinc-900 shrink-0 flex items-center gap-2">
          <div className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-400">Activity Log</div>
          <div className="flex-1" />
        </div>
        <div ref={watcherLogsRef} className="flex-1 overflow-y-auto px-2 py-1 font-mono text-[10px] min-h-0 scrollbar-hide">
          {watcherLogs.length === 0 ? (
            <div className="text-center text-zinc-400 py-2">No activity</div>
          ) : (
            watcherLogs.map((log, i) => {
              const sourceColor = log.source === 'watcher' ? 'text-purple-500' : log.source === 'agent' ? 'text-cyan-500' : 'text-zinc-400';
              const typeColor = log.level === 'error' ? 'text-red-500'
                : log.type === 'trigger_end' ? 'text-blue-500'
                : log.type === 'diff_detected' ? 'text-orange-500'
                : log.type === 'intent_classified' ? 'text-green-500'
                : log.type === 'task_scheduled' ? 'text-green-500'
                : log.type === 'task_execute_start' ? 'text-cyan-500'
                : log.type === 'task_execute_done' ? 'text-cyan-400'
                : log.type === 'tick' && log.data?.changed ? 'text-orange-400'
                : 'text-zinc-500';

              return (
                <div key={i} className="py-1 border-b border-zinc-100 dark:border-zinc-800">
                  <div className="flex gap-1.5 items-start">
                    <span className="text-zinc-400 shrink-0">{log.time}</span>
                    <span className={`shrink-0 font-semibold ${sourceColor}`}>[{log.source}]</span>
                    <span className={`shrink-0 ${typeColor}`}>{log.type}</span>
                    {log.sourceName && <span className="text-zinc-400 shrink-0 truncate max-w-[80px]">{log.sourceName}</span>}
                    <span className="text-zinc-700 dark:text-zinc-300 truncate min-w-0">{log.message}</span>
                  </div>

                  {(log.type === 'diff_detected' || log.type === 'tick') && log.data?.baseline && log.data?.current && (
                    <div className="flex gap-1 mt-1 ml-8">
                      <div className="relative cursor-pointer group" onClick={() => setCompareImages({ baseline: log.data!.baseline!, current: log.data!.current! })}>
                        <img src={log.data.baseline} alt="baseline" className="w-10 h-7 object-cover rounded border border-zinc-200 dark:border-zinc-700" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors rounded flex items-center justify-center">
                          <span className="text-white text-[8px] opacity-0 group-hover:opacity-100">Before</span>
                        </div>
                      </div>
                      <span className="text-zinc-400 self-center">→</span>
                      <div className="relative cursor-pointer group" onClick={() => setCompareImages({ baseline: log.data!.baseline!, current: log.data!.current! })}>
                        <img src={log.data.current} alt="current" className="w-10 h-7 object-cover rounded border border-zinc-200 dark:border-zinc-700" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors rounded flex items-center justify-center">
                          <span className="text-white text-[8px] opacity-0 group-hover:opacity-100">After</span>
                        </div>
                      </div>
                      {log.data.confidence !== undefined && (
                        <span className="text-zinc-400 self-center text-[9px]">{(log.data.confidence * 100).toFixed(0)}%</span>
                      )}
                    </div>
                  )}

                  {log.data?.screenshot && (
                    <div className="mt-1 ml-8">
                      <div className="relative cursor-pointer group inline-block" onClick={() => setPreviewImage(log.data!.screenshot!)}>
                        <img src={log.data.screenshot} alt="screenshot" className="w-16 h-10 object-cover rounded border border-zinc-200 dark:border-zinc-700" />
                        <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors rounded flex items-center justify-center">
                          <span className="text-white text-[8px] opacity-0 group-hover:opacity-100">View</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Image Compare Modal */}
      {compareImages && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => setCompareImages(null)}>
          <div className="flex gap-4 p-4 max-w-[90vw]" onClick={e => e.stopPropagation()}>
            <div className="text-center">
              <div className="text-white text-[12px] mb-2 font-medium">Before (Baseline)</div>
              <img src={compareImages.baseline} alt="baseline" className="max-h-[70vh] max-w-[40vw] object-contain rounded-lg shadow-xl" />
            </div>
            <div className="text-center">
              <div className="text-white text-[12px] mb-2 font-medium">After (Current)</div>
              <img src={compareImages.current} alt="current" className="max-h-[70vh] max-w-[40vw] object-contain rounded-lg shadow-xl" />
            </div>
          </div>
          <button onClick={() => setCompareImages(null)} className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors">✕</button>
        </div>
      )}

      {/* Single Image Preview Modal */}
      {previewImage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80" onClick={() => setPreviewImage(null)}>
          <img src={previewImage} alt="preview" className="max-h-[85vh] max-w-[85vw] object-contain rounded-lg shadow-xl" />
          <button onClick={() => setPreviewImage(null)} className="absolute top-4 right-4 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors">✕</button>
        </div>
      )}

      {showWatcherDialog && (
        <WatcherDialog
          config={editWatcherConfig}
          onSave={handleWatcherSave}
          onClose={() => { setShowWatcherDialog(false); setEditWatcherConfig(undefined); }}
          compact={true}
        />
      )}
    </>
  );
}
