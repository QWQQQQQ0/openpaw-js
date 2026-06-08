import { useState, useRef, useCallback, useEffect } from 'react';
import {
  Globe, Camera, Play, StopCircle, Wrench, CheckCircle, XCircle,
  Monitor, RefreshCw, MousePointer, Keyboard, Code, ChevronDown, ChevronUp,
  CornerDownLeft, AlertTriangle, Search, ExternalLink, Link, ListTree,
} from 'lucide-react';
import { useT } from '@/i18n/strings';
import { extensionBridge, type TabInfo } from '@/services/extension-bridge';
import { getBuiltinSkill } from '@/skills/builtin-executor';
import type { WebScreenSkill } from '@/skills/web';
import { WebAutomationAgent, type AgentTurn } from '@/services/web-automation-agent';
import { getModelService } from '@/services/model-service-singleton';
import { useModelConfigStore } from '@/stores/model-config-store';
import type { ProviderConfig } from '@/types/provider';

interface DOMNode {
  tag?: string;
  text?: string;
  selector?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  clickable?: boolean;
  inViewport?: boolean;
  inputType?: string;
  href?: string;
}

interface ActionLog {
  action: string;
  success: boolean;
  error?: string;
}

type AutomationStatus = 'idle' | 'capturing' | 'thinking' | 'executing' | 'done' | 'error';
type Mode = 'selector' | 'coordinate';

export default function WebPage() {
  const t = useT();

  const [connected, setConnected] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [domNodes, setDomNodes] = useState<DOMNode[]>([]);
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [currentTabId, setCurrentTabId] = useState<number | null>(null);
  const [currentUrl, setCurrentUrl] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('selector');
  const [status, setStatus] = useState<AutomationStatus>('idle');
  const [actionLog, setActionLog] = useState<ActionLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [stepCount, setStepCount] = useState(0);
  const [showDomDialog, setShowDomDialog] = useState(false);

  const urlRef = useRef<HTMLInputElement>(null);
  const goalRef = useRef<HTMLInputElement>(null);
  const xRef = useRef<HTMLInputElement>(null);
  const yRef = useRef<HTMLInputElement>(null);
  const selectorRef = useRef<HTMLInputElement>(null);
  const typeRef = useRef<HTMLInputElement>(null);
  const stopRef = useRef(false);

  const interactiveNodes = domNodes.filter((n) => n.clickable);
  const inViewNodes = domNodes.filter((n) => n.inViewport);

  // Initialize and check extension connection
  useEffect(() => {
    extensionBridge.init();
    extensionBridge.onStateChanged((state) => {
      const tabId = state['currentTabId'] as number | undefined;
      const url = state['currentUrl'] as string | undefined;
      if (tabId !== undefined) setCurrentTabId(tabId);
      if (url !== undefined) setCurrentUrl(url);
    });

    const checkTimer = setInterval(() => {
      setConnected(extensionBridge.isConnected);
      if (extensionBridge.isConnected) {
        refreshTabs();
      }
    }, 3000);

    setConnected(extensionBridge.isConnected);
    if (extensionBridge.isConnected) refreshTabs();

    return () => {
      clearInterval(checkTimer);
      extensionBridge.dispose();
    };
  }, []);

  const refreshTabs = useCallback(async () => {
    try {
      const r = await extensionBridge.listTabs();
      if (r['success'] === true) {
        const tabList = (r['tabs'] as TabInfo[]) ?? [];
        setTabs(tabList);
        const active = tabList.find((t) => t.active) ?? tabList[0];
        if (active) {
          setCurrentTabId(active.id);
          setCurrentUrl(active.url);
        }
      }
    } catch { /* ignore */ }
  }, []);

  const switchTab = useCallback(async (tabId: number) => {
    const r = await extensionBridge.switchTab(tabId);
    if (r['success'] === true) setCurrentTabId(tabId);
  }, []);

  const openURL = useCallback(async () => {
    const url = urlRef.current?.value.trim();
    if (!url) return;
    const fullUrl = url.startsWith('http') ? url : `https://${url}`;
    setStatus('executing');
    const r = await extensionBridge.openURL(fullUrl);
    if (r['success'] === true) {
      setCurrentTabId(r['tabId'] as number);
      setCurrentUrl(fullUrl);
      setStatus('idle');
      await refreshTabs();
    } else {
      setStatus('idle');
      setError(r['error'] as string);
    }
  }, [refreshTabs]);

  const captureOnce = useCallback(async () => {
    if (!connected) {
      setError('Extension not connected');
      return;
    }
    setStatus('capturing');
    try {
      const tabsR = await extensionBridge.listTabs();
      if (tabsR['success'] === true) {
        const tlist = (tabsR['tabs'] as TabInfo[]) ?? [];
        setTabs(tlist);
        const active = tlist.find((t) => t.active) ?? tlist[0];
        if (active) {
          setCurrentTabId(active.id);
          setCurrentUrl(active.url);
        }
      }

      const [scr, dom] = await Promise.all([
        extensionBridge.captureScreen(),
        extensionBridge.getDOM(currentTabId ?? undefined),
      ]);

      setScreenshot((scr['screenshot'] as string) ?? null);
      const nodes = (dom['nodes'] as DOMNode[]) ?? [];
      setDomNodes(nodes);
      setStatus('idle');
    } catch (e) {
      setStatus('idle');
      setError(`Capture failed: ${e}`);
    }
  }, [connected, currentTabId]);

  const executeAction = useCallback(async (type: string, params: Record<string, unknown>) => {
    if (!connected) return;
    try {
      const r = await extensionBridge.executeAction(currentTabId, { type, ...params });
      const ok = r['success'] === true || r['ok'] === true;
      setActionLog((prev) => [...prev, { action: `${type}: ${JSON.stringify(params)}`, success: ok, error: ok ? undefined : (r['error'] as string) }]);
    } catch (e) {
      setActionLog((prev) => [...prev, { action: `${type}: ${JSON.stringify(params)}`, success: false, error: String(e) }]);
    }
  }, [connected, currentTabId]);

  const handleManualClick = useCallback(() => {
    const x = Number(xRef.current?.value);
    const y = Number(yRef.current?.value);
    if (!isNaN(x) && !isNaN(y)) executeAction('click', { x, y });
  }, [executeAction]);

  const handleSelectorClick = useCallback(() => {
    const sel = selectorRef.current?.value.trim();
    if (sel) executeAction('click_element', { selector: sel });
  }, [executeAction]);

  const handleFill = useCallback(() => {
    const sel = selectorRef.current?.value.trim();
    const text = typeRef.current?.value ?? '';
    if (sel) executeAction('fill', { selector: sel, text });
  }, [executeAction]);

  const handleExtract = useCallback(() => {
    const sel = selectorRef.current?.value.trim();
    if (sel) executeAction('extract', { selector: sel });
  }, [executeAction]);

  const handleScrollIntoView = useCallback(() => {
    const sel = selectorRef.current?.value.trim();
    if (sel) executeAction('scroll_into_view', { selector: sel });
  }, [executeAction]);

  const handleType = useCallback(() => {
    const text = typeRef.current?.value;
    if (text) {
      executeAction('type', { text });
      if (typeRef.current) typeRef.current.value = '';
    }
  }, [executeAction]);

  const handleScroll = useCallback((dy: number) => {
    executeAction('scroll', { dx: 0, dy });
  }, [executeAction]);

  const handlePressKey = useCallback((key: string) => {
    executeAction('press_key', { key });
  }, [executeAction]);

  const handleStartAutomation = useCallback(async () => {
    const goal = goalRef.current?.value.trim();
    if (!goal || !connected) return;

    try {
      const modelStore = useModelConfigStore.getState();
      const provider = modelStore.defaultConfig();
      if (!provider) {
        setError('No model configured. Please add a model provider first.');
        return;
      }

      const apiKey = await modelStore.getApiKey(provider.id, '');
      setIsRunning(true);
      stopRef.current = false;
      setActionLog([]);
      setStepCount(0);
      setError(null);

      const skill = getBuiltinSkill('web_screen') as WebScreenSkill;
      const { getCacheService } = await import('@/services/cache-service-singleton');
      const agent = new WebAutomationAgent(getModelService(), skill, getCacheService());

      await extensionBridge.showFloatingPanel();

      const runLoop = async () => {
        const maxSteps = 100;
        let steps = 0;

        while (!stopRef.current && steps < maxSteps) {
          setStatus('capturing');
          const [scr, dom] = await Promise.all([
            extensionBridge.captureScreen(),
            extensionBridge.getDOM(currentTabId ?? undefined),
          ]);

          if (scr['success'] !== true) {
            setError(`Screenshot failed: ${scr['error'] ?? 'unknown'}`);
            setStatus('error');
            return;
          }

          const base64 = scr['screenshot'] as string;
          const nodes = (dom['nodes'] as DOMNode[]) ?? [];
          setScreenshot(base64);
          setDomNodes(nodes);

          setStatus('thinking');
          const turns = await agent.executeCommand({
            screenshotBase64: base64,
            domNodes: nodes,
            goal,
            provider,
            apiKey,
            currentUrl: currentUrl ?? undefined,
            actionHistory: actionLog.map((l) => l.action),
            maxTurns: 1,
          });

          if (!turns || turns.length === 0) {
            setActionLog((prev) => [...prev, { action: `[${steps + 1}] Done`, success: true }]);
            setStepCount(steps + 1);
            setStatus('done');
            await extensionBridge.hideFloatingPanel();
            return;
          }

          setStatus('executing');

          for (const turn of turns) {
            for (const result of turn.results) {
              const actionName = result.data?.['action'] ?? result.message;
              setActionLog((prev) => [...prev, {
                action: `[${steps + 1}] ${result.success ? actionName : 'FAILED'}: ${result.message}`,
                success: result.success,
              }]);
              steps++;

              if (result.data?.['action'] === 'done') {
                setStatus('done');
                await extensionBridge.hideFloatingPanel();
                setStepCount(steps);
                return;
              }
            }
          }

          setStepCount(steps);
          await new Promise((r) => setTimeout(r, 500));
        }

        if (steps >= maxSteps) {
          setStatus('done');
          setError(`Max steps (${maxSteps}) reached.`);
        }
      };

      await runLoop();
    } catch (e) {
      setError(String(e));
      setStatus('error');
    } finally {
      setIsRunning(false);
      setStatus((s) => (s === 'error' || s === 'done' ? s : 'idle'));
      await extensionBridge.hideFloatingPanel();
    }
  }, [connected, currentTabId, currentUrl, actionLog]);

  const handleStop = useCallback(() => {
    stopRef.current = true;
    setIsRunning(false);
    setStatus('idle');
    extensionBridge.hideFloatingPanel();
  }, []);

  const clearLog = useCallback(() => setActionLog([]), []);

  const handleSelectNode = useCallback((sel: string) => {
    setShowDomDialog(false);
    if (selectorRef.current) selectorRef.current.value = sel;
  }, []);

  const statusLabel = (s: AutomationStatus) => {
    const map: Record<AutomationStatus, { label: string; color: string }> = {
      idle: { label: 'Idle', color: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400' },
      capturing: { label: 'Capturing', color: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300' },
      thinking: { label: 'Thinking', color: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300' },
      executing: { label: 'Executing', color: 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300' },
      done: { label: 'Done', color: 'bg-teal-100 text-teal-700 dark:bg-teal-950 dark:text-teal-300' },
      error: { label: 'Error', color: 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300' },
    };
    const m = map[s];
    return <span className={`px-2 py-0.5 rounded-full text-[11px] font-medium ${m.color}`}>{m.label}</span>;
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <h1 className="text-[16px] font-bold text-zinc-900 dark:text-zinc-100">
          Web Automation
        </h1>
        <div className="flex items-center gap-2">
          {connected ? (
            <span className="flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              Connected
            </span>
          ) : (
            <span className="flex items-center gap-1 text-[11px] text-amber-600 dark:text-amber-400">
              <AlertTriangle size={12} />
              Extension not detected
            </span>
          )}
          <button
            onClick={() => { refreshTabs(); captureOnce(); }}
            disabled={status === 'capturing'}
            className="p-2 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Extension status banner */}
        {!connected && (
          <div className="mx-3 mt-3 px-3 py-2 bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-800 rounded-lg text-[13px] text-amber-700 dark:text-amber-300 flex items-center gap-2">
            <AlertTriangle size={16} />
            Browser extension not detected. Install and load the OpenPaw extension for web automation.
          </div>
        )}

        {/* Tab selector */}
        {tabs.length > 0 && (
          <div className="px-3 mt-3">
            <div className="flex items-center gap-2 px-2 py-1">
              <ListTree size={14} className="text-blue-500" />
              <span className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-400">
                Browser Tabs ({tabs.length})
              </span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-2 px-2">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => switchTab(tab.id)}
                  className={`shrink-0 w-44 p-2.5 rounded-xl border text-left transition-colors ${
                    tab.id === currentTabId
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-950'
                      : 'border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 hover:bg-zinc-50 dark:hover:bg-zinc-800'
                  }`}
                >
                  <p className="text-[12px] font-medium text-zinc-800 dark:text-zinc-200 truncate">{tab.title || 'Untitled'}</p>
                  <p className="text-[10px] text-zinc-400 dark:text-zinc-500 truncate mt-0.5">{tab.url}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* URL bar */}
        <div className="px-3 mt-2">
          <div className="flex gap-2">
            <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900">
              <Link size={14} className="text-zinc-400 shrink-0" />
              <input
                ref={urlRef}
                type="text"
                placeholder="https://example.com"
                className="flex-1 text-[14px] bg-transparent outline-none text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
                onKeyDown={(e) => { if (e.key === 'Enter') openURL(); }}
              />
            </div>
            <button
              onClick={openURL}
              disabled={!connected}
              className="px-3 py-2 rounded-lg bg-blue-600 text-white text-[13px] font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1.5"
            >
              <ExternalLink size={14} />
              Open
            </button>
          </div>
        </div>

        {/* Mode selector + Capture */}
        <div className="flex items-center gap-3 px-3 mt-3">
          <div className="flex rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
            <button
              onClick={() => setMode('selector')}
              className={`px-3 py-1.5 text-[12px] font-medium transition-colors ${mode === 'selector' ? 'bg-blue-600 text-white' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
            >
              <Code size={14} className="inline mr-1" />
              CSS Selector
            </button>
            <button
              onClick={() => setMode('coordinate')}
              className={`px-3 py-1.5 text-[12px] font-medium border-l border-zinc-200 dark:border-zinc-700 transition-colors ${mode === 'coordinate' ? 'bg-blue-600 text-white' : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'}`}
            >
              <MousePointer size={14} className="inline mr-1" />
              Coordinate
            </button>
          </div>
          <button
            onClick={captureOnce}
            disabled={!connected || status === 'capturing'}
            className="px-3 py-1.5 rounded-lg bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300 text-[12px] font-medium hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-50 flex items-center gap-1.5"
          >
            <Camera size={14} />
            Capture
          </button>
          <div className="ml-auto">{statusLabel(status)}</div>
        </div>

        {/* Screenshot preview */}
        {screenshot ? (
          <div className="mx-3 mt-2 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
            <div className="px-3 py-1.5 bg-zinc-50 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-700 flex items-center gap-2">
              <Camera size={14} className="text-zinc-400" />
              <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">Screenshot</span>
              {currentUrl && (
                <span className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate ml-auto">{currentUrl}</span>
              )}
            </div>
            <img src={screenshot} alt="Web screenshot" className="w-full object-contain max-h-[400px]" />
          </div>
        ) : null}

        {/* DOM interactive elements */}
        {domNodes.length > 0 && (
          <div className="px-3 mt-2">
            <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900 p-3">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <ListTree size={14} className="text-zinc-500" />
                  <span className="text-[12px] text-zinc-600 dark:text-zinc-400">
                    Interactive: {interactiveNodes.length} ({inViewNodes.length} in viewport)
                  </span>
                </div>
                <button
                  onClick={() => setShowDomDialog(true)}
                  className="text-[12px] text-blue-600 dark:text-blue-400 hover:underline"
                >
                  View All
                </button>
              </div>
              {inViewNodes.length > 0 && (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {inViewNodes.slice(0, 20).map((n, i) => (
                    <div
                      key={i}
                      className="shrink-0 w-28 p-2 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-950"
                    >
                      <div className="flex items-center gap-1 mb-1">
                        <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950 text-[9px] font-bold text-blue-700 dark:text-blue-300">
                          {n.tag ?? '?'}
                        </span>
                        {n.inputType && (
                          <span className="text-[9px] text-zinc-400">{n.inputType}</span>
                        )}
                      </div>
                      <p className="text-[10px] text-zinc-600 dark:text-zinc-400 line-clamp-2">
                        {n.text || `<${n.tag}>`}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Manual controls */}
        <div className="px-3 mt-3">
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-700 p-3">
            <h3 className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200 mb-2">Manual Control</h3>

            {mode === 'coordinate' ? (
              <>
                <div className="flex gap-2 mb-2">
                  <input ref={xRef} type="number" placeholder="X" className="flex-1 px-2 py-1.5 text-[13px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500" />
                  <input ref={yRef} type="number" placeholder="Y" className="flex-1 px-2 py-1.5 text-[13px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500" />
                  <button onClick={handleManualClick} disabled={!connected} className="px-3 py-1.5 rounded bg-blue-600 text-white text-[13px] font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
                    <MousePointer size={14} /> Tap
                  </button>
                </div>
                <div className="flex gap-2">
                  <input ref={typeRef} type="text" placeholder="Type text" className="flex-1 px-2 py-1.5 text-[13px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500" />
                  <button onClick={handleType} disabled={!connected} className="px-3 py-1.5 rounded bg-blue-600 text-white text-[13px] font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1">
                    <Keyboard size={14} /> Type
                  </button>
                </div>
              </>
            ) : (
              <>
                <input ref={selectorRef} type="text" placeholder="CSS Selector (#search, .btn, input[name='q'])" className="w-full px-2 py-1.5 text-[13px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500 mb-2" />
                <div className="flex flex-wrap gap-1.5 mb-2">
                  <button onClick={handleSelectorClick} disabled={!connected} className="px-2.5 py-1 rounded bg-blue-600 text-white text-[12px] font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"><MousePointer size={12} /> Click</button>
                  <button onClick={handleFill} disabled={!connected} className="px-2.5 py-1 rounded bg-blue-600 text-white text-[12px] font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"><Keyboard size={12} /> Fill</button>
                  <button onClick={handleExtract} disabled={!connected} className="px-2.5 py-1 rounded bg-blue-600 text-white text-[12px] font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"><Search size={12} /> Extract</button>
                  <button onClick={handleScrollIntoView} disabled={!connected} className="px-2.5 py-1 rounded bg-blue-600 text-white text-[12px] font-medium hover:bg-blue-700 disabled:opacity-50 flex items-center gap-1"><ChevronDown size={12} /> Scroll To</button>
                </div>
                <input ref={typeRef} type="text" placeholder="Fill text" className="w-full px-2 py-1.5 text-[13px] rounded border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500" />
              </>
            )}

            <div className="border-t border-zinc-200 dark:border-zinc-700 my-2" />

            <div className="flex flex-wrap gap-1.5">
              <button onClick={() => handleScroll(300)} className="px-2.5 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-[12px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"><ChevronDown size={12} /> Scroll Down</button>
              <button onClick={() => handleScroll(-300)} className="px-2.5 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-[12px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"><ChevronUp size={12} /> Scroll Up</button>
              <button onClick={() => handlePressKey('Enter')} className="px-2.5 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-[12px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1"><CornerDownLeft size={12} /> Enter</button>
              <button onClick={() => handlePressKey('Escape')} className="px-2.5 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-[12px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1">Esc</button>
              <button onClick={() => handlePressKey('Tab')} className="px-2.5 py-1 rounded border border-zinc-200 dark:border-zinc-700 text-[12px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-1">Tab</button>
            </div>
          </div>
        </div>

        {/* Action log */}
        {actionLog.length > 0 && (
          <div className="px-3 mt-3">
            <div className="flex items-center justify-between px-1 mb-1">
              <span className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-400">Action Log ({stepCount} steps)</span>
              <button onClick={clearLog} className="text-[11px] text-red-500 hover:underline">Clear</button>
            </div>
            <div className="max-h-32 overflow-y-auto space-y-0.5">
              {actionLog.map((log, i) => (
                <div key={i} className="flex items-center gap-2 text-[12px]">
                  {log.success ? <CheckCircle size={12} className="text-green-500 shrink-0" /> : <XCircle size={12} className="text-red-500 shrink-0" />}
                  <span className="text-zinc-600 dark:text-zinc-400 truncate font-mono">{log.action}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mx-3 mt-3 px-3 py-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-[13px] text-red-700 dark:text-red-300 flex items-center justify-between">
            <span>{error}</span>
            <button onClick={() => setError(null)} className="font-medium hover:underline">Dismiss</button>
          </div>
        )}

        {/* Automation controls */}
        <div className="p-4 border-t border-zinc-200 dark:border-zinc-800 mt-auto">
          <div className="flex items-center gap-2 mb-3">
            <Wrench size={14} className="text-zinc-400 shrink-0" />
            <input
              ref={goalRef}
              type="text"
              placeholder="Enter automation goal... (e.g., Go to GitHub, search for flutter)"
              className="flex-1 px-3 py-2 text-[14px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
              onKeyDown={(e) => { if (e.key === 'Enter') handleStartAutomation(); }}
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleStartAutomation}
              disabled={isRunning || !connected}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-blue-600 text-white text-[14px] font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {isRunning ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Play size={16} />}
              {isRunning ? 'Running...' : 'Start Automation'}
            </button>
            <button
              onClick={handleStop}
              disabled={!isRunning}
              className="p-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-red-500 disabled:opacity-30"
              title="Stop"
            >
              <StopCircle size={18} />
            </button>
          </div>
          {!connected && (
            <p className="mt-2 text-[12px] text-amber-600 dark:text-amber-400">
              Browser extension not detected. Install and load the OpenPaw extension.
            </p>
          )}
        </div>
      </div>

      {/* DOM Tree Dialog */}
      {showDomDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowDomDialog(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl border border-zinc-200 dark:border-zinc-800 w-[600px] max-h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
              <h3 className="text-[14px] font-semibold text-zinc-900 dark:text-zinc-100">DOM Tree ({domNodes.length} elements)</h3>
              <button onClick={() => setShowDomDialog(false)} className="p-1 rounded text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">✕</button>
            </div>
            <div className="flex-1 overflow-y-auto p-2">
              {domNodes.map((n, i) => {
                const tag = n.tag ?? '?';
                const text = n.text ?? '';
                const sel = n.selector ?? '';
                const bounds = n.bounds ?? { x: 0, y: 0, width: 0, height: 0 };
                return (
                  <button key={i} onClick={() => sel && handleSelectNode(sel)} className="w-full text-left px-3 py-2 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 flex items-center gap-3">
                    <span className="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950 text-[10px] font-bold text-blue-700 dark:text-blue-300 shrink-0">{tag}</span>
                    <span className="text-[12px] text-zinc-600 dark:text-zinc-400 truncate flex-1">{text || `<${tag}>`}</span>
                    <span className="text-[10px] text-zinc-400 dark:text-zinc-500 font-mono shrink-0">{bounds.x},{bounds.y}</span>
                    {sel && <span className="text-[10px] text-zinc-300 dark:text-zinc-600 font-mono truncate max-w-[120px] shrink-0">{sel}</span>}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
