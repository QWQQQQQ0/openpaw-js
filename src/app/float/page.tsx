'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { Camera, Play, StopCircle, Wrench, CheckCircle, XCircle, GripHorizontal, X, Minus, MessageSquare, Link, ImageIcon, Trash2, Cpu, Settings } from 'lucide-react';
import { extractBbox, BboxOverlay } from '@/components/bbox-overlay';
import { desktopService, WindowInfo } from '@/services/desktop-service';
import { DesktopScreenSkill } from '@/skills/desktop';
import { WebScreenSkill } from '@/skills/web';
import { Switch } from '@/components/ui/switch';
import { MessageInput } from '@/components/chat/message-input';
import type { MessageContent, LLMMessage, ContentPart } from '@/types/message';
import { DesktopAutomationAgent } from '@/services/desktop-automation-agent';

// ── Persisted settings ──

function readLocal<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch { return fallback; }
}

function writeLocal<T>(key: string, value: T) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// ── Float chat message type ──

interface FloatChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images?: string[];
  status: 'done' | 'streaming' | 'error';
}

// ── Action log (Task mode) ──

interface ActionLog {
  action: string;
  success: boolean;
  error?: string;
}

// ── Main component ──

export default function FloatPage() {
  // ── Mode & toggles (persisted) ──
  const [mode, setMode] = useState<'chat' | 'task'>(() => readLocal('float_mode', 'chat'));
  const [sendToModel, setSendToModel] = useState(() => readLocal('float_send_to_model', true));
  const [allowImagePaste, setAllowImagePaste] = useState(() => readLocal('float_allow_image_paste', true));
  const [noSystemPrompt, setNoSystemPrompt] = useState(() => readLocal('float_no_system_prompt', false));

  const persistMode = useCallback((v: 'chat' | 'task') => { setMode(v); writeLocal('float_mode', v); }, []);
  const persistSendToModel = useCallback((v: boolean) => { setSendToModel(v); writeLocal('float_send_to_model', v); }, []);
  const persistAllowImagePaste = useCallback((v: boolean) => { setAllowImagePaste(v); writeLocal('float_allow_image_paste', v); }, []);
  const persistNoSystemPrompt = useCallback((v: boolean) => { setNoSystemPrompt(v); writeLocal('float_no_system_prompt', v); }, []);

  // ── Chat state ──
  const [chatMessages, setChatMessages] = useState<FloatChatMsg[]>([]);
  const [chatStreaming, setChatStreaming] = useState(false);

  // ── Task state (from original float) ──
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [actionLog, setActionLog] = useState<ActionLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isAutomating, setIsAutomating] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const goalRef = useRef<HTMLInputElement>(null);
  const settingsRef = useRef<HTMLDivElement>(null);

  // Close settings popover on outside click
  useEffect(() => {
    if (!showSettings) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setShowSettings(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSettings]);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // ── Auto-scroll chat ──
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  // ── Auto-capture on mount ──
  useEffect(() => { if (mode === 'task') handleRefresh(); }, [mode]);

  // ── Listen for automation-goal from main window ──
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        unlisten = await getCurrentWebviewWindow().listen<{ goal: string }>('automation-goal', (event) => {
          const { goal } = event.payload;
          persistMode('task');
          setTimeout(() => {
            if (goalRef.current) goalRef.current.value = goal;
            document.getElementById('float-go-btn')?.click();
          }, 100);
        });
      } catch { /* not in Tauri */ }
    })();
    return () => { unlisten?.(); };
  }, [persistMode]);

  // ── Task: Refresh ──
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

  // ── Task: Start Automation ──
  const handleStartAutomation = useCallback(async () => {
    const goal = goalRef.current?.value.trim();
    if (!goal || isAutomating) return;

    setIsAutomating(true);
    setError(null);

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
        setActionLog((prev) => [...prev, { action: 'API key is empty after decrypt', success: false }]);
        return;
      }

      const skill = new DesktopScreenSkill();
      const webSkill = new WebScreenSkill();
      const { getCacheService } = await import('@/services/cache-service-singleton');
      const agent = new DesktopAutomationAgent(skill, getCacheService());

      const turns = await agent.executeCommand({
        goal,
        provider: config,
        apiKey,
        windows,
        maxTurns: 10,
        onStep: async (event) => {
          switch (event.type) {
            case 'before_tool': {
              const data = event.data as { name: string; arguments: Record<string, unknown> };
              setActionLog((prev) => [...prev, { action: `${data.name}(${JSON.stringify(data.arguments)})`, success: true }]);
              return null;
            }
            case 'after_tool': {
              const data = event.data as { name: string; success: boolean; message: string };
              setActionLog((prev) => [...prev, { action: data.success ? data.message : `Failed: ${data.message}`, success: data.success }]);
              if (['desktop_click', 'desktop_type', 'desktop_double_click', 'desktop_right_click', 'desktop_open_app'].includes(data.name)) {
                try {
                  const newScreenshot = await desktopService.screenshot();
                  setScreenshot(newScreenshot);
                } catch { /* ignore */ }
              }
              return null;
            }
            default:
              return null;
          }
        },
      });

      if (!turns || turns.length === 0) {
        setActionLog((prev) => [...prev, { action: 'No actions taken', success: false }]);
      } else {
        const lastTurn = turns[turns.length - 1];
        const lastResult = lastTurn.results[lastTurn.results.length - 1];
        setActionLog((prev) => [...prev, { action: `Done: ${lastResult.message}`, success: lastResult.success }]);
      }
    } catch (e) {
      setError(String(e));
      setActionLog((prev) => [...prev, { action: `Error: ${e}`, success: false }]);
    } finally {
      setIsAutomating(false);
    }
  }, [isAutomating, screenshot, windows]);

  // ── Chat: Send message ──
  const handleChatSend = useCallback(async (content: MessageContent) => {
    const id = crypto.randomUUID();
    const text = typeof content === 'string' ? content : (content.find((p) => p.type === 'text') as { text: string } | undefined)?.text ?? '';
    const imageParts = typeof content === 'string' ? [] : content.filter((p) => p.type === 'image_url') as { image_url: { url: string } }[];
    const images = imageParts.map((p) => p.image_url.url);

    const userMsg: FloatChatMsg = { id, role: 'user', text, images, status: 'done' };
    setChatMessages((prev) => [...prev, userMsg]);

    if (!readLocal('float_send_to_model', true)) return;

    setChatStreaming(true);
    const assistantId = crypto.randomUUID();
    setChatMessages((prev) => [...prev, { id: assistantId, role: 'assistant', text: '', status: 'streaming' }]);

    try {
      const { useModelConfigStore } = await import('@/stores/model-config-store');
      await useModelConfigStore.getState().load();
      const config = useModelConfigStore.getState().defaultConfig();
      if (!config) throw new Error('No model configured');

      let apiKey = '';
      try {
        apiKey = await useModelConfigStore.getState().getApiKey(config.id, '');
      } catch (e) {
        throw new Error(`Decrypt API key failed: ${e}`);
      }
      if (!apiKey) throw new Error('API key is empty after decrypt');

      const { ModelScenario } = await import('@/adapters/model-call-service');
      const { getModelService } = await import('@/services/model-service-singleton');
      const modelService = getModelService();

      // Build LLM messages from history
      const llmMessages: LLMMessage[] = chatMessages.map((m) => {
        const parts: ContentPart[] = [];
        if (m.text) parts.push({ type: 'text', text: m.text });
        if (m.images) {
          for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: img } });
        }
        return {
          role: m.role,
          content: parts.length === 1 && parts[0].type === 'text' ? (parts[0] as { type: 'text'; text: string }).text : parts.length > 0 ? parts : null,
        };
      });

      // Add current message
      const currentParts: ContentPart[] = [];
      if (text) currentParts.push({ type: 'text', text });
      for (const img of images) currentParts.push({ type: 'image_url', image_url: { url: img } });
      llmMessages.push({
        role: 'user',
        content: currentParts.length === 1 && currentParts[0].type === 'text' ? currentParts[0].text : currentParts,
      });

      const stream = modelService.chatStream({
        scenario: noSystemPrompt ? ModelScenario.raw : ModelScenario.chat,
        messages: llmMessages,
        provider: config,
        apiKey,
      });

      let responseText = '';
      for await (const chunk of stream) {
        if (chunk.startsWith('__ERROR__:')) {
          throw new Error(chunk.substring(10));
        }
        if (chunk.startsWith('__TOOLS__:') || chunk.startsWith('__REASONING__:')) {
          continue;
        }
        responseText += chunk;
        setChatMessages((prev) => prev.map((m) =>
          m.id === assistantId ? { ...m, text: responseText } : m,
        ));
      }

      setChatMessages((prev) => prev.map((m) =>
        m.id === assistantId ? { ...m, status: 'done' } : m,
      ));
    } catch (e) {
      setChatMessages((prev) => prev.map((m) =>
        m.id === assistantId ? { ...m, status: 'error', text: `Error: ${e}` } : m,
      ));
    } finally {
      setChatStreaming(false);
    }
  }, [sendToModel, chatMessages, noSystemPrompt]);

  // ── Window controls ──
  const handleClose = useCallback(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().close();
  }, []);

  const handleMinimize = useCallback(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().minimize();
  }, []);

  // ── Render ──
  return (
    <div className="flex flex-col h-screen bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100">
      {/* Custom title bar */}
      <div
        className="flex items-center justify-between px-3 py-2 bg-zinc-100 dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 shrink-0"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2">
          <GripHorizontal size={14} className="text-zinc-400" />
          <span className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-400">OpenPaw</span>
        </div>
        <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <button onClick={handleMinimize} className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-500">
            <Minus size={14} />
          </button>
          <button onClick={handleClose} className="p-1 rounded hover:bg-red-500 hover:text-white text-zinc-500">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Mode tabs + settings */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-0.5 bg-zinc-100 dark:bg-zinc-800 rounded-lg p-0.5">
            <button
              onClick={() => persistMode('chat')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
                mode === 'chat' ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              <MessageSquare size={13} />
              Chat
            </button>
            <button
              onClick={() => persistMode('task')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[12px] font-medium transition-colors ${
                mode === 'task' ? 'bg-white dark:bg-zinc-700 text-zinc-900 dark:text-zinc-100 shadow-sm' : 'text-zinc-500 dark:text-zinc-400'
              }`}
            >
              <Wrench size={13} />
              Task
            </button>
          </div>
          {mode === 'chat' && chatMessages.length > 0 && (
            <button
              onClick={() => setChatMessages([])}
              className="p-1 rounded text-zinc-400 hover:text-red-500 transition-colors"
              title="Clear context"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
        <div className="relative" ref={settingsRef}>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className={`p-1 rounded transition-colors ${showSettings ? 'bg-zinc-200 dark:bg-zinc-700 text-zinc-700 dark:text-zinc-300' : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'}`}
            title="Settings"
          >
            <Settings size={14} />
          </button>
          {showSettings && (
            <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 rounded-lg shadow-lg p-2.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                  <Cpu size={11} className={noSystemPrompt ? 'text-zinc-400' : 'text-blue-500'} />
                  System Prompt
                </div>
                <Switch checked={!noSystemPrompt} onChange={(v) => persistNoSystemPrompt(!v)} />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                  <Link size={11} className={sendToModel ? 'text-blue-500' : 'text-zinc-400'} />
                  Send to Model
                </div>
                <Switch checked={sendToModel} onChange={persistSendToModel} />
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400">
                  <ImageIcon size={11} className={allowImagePaste ? 'text-blue-500' : 'text-zinc-400'} />
                  Image Paste
                </div>
                <Switch checked={allowImagePaste} onChange={persistAllowImagePaste} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Content area */}
      {mode === 'chat' ? (
        <>
          {/* Chat messages */}
          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 min-h-0">
            {chatMessages.length === 0 && (
              <div className="flex items-center justify-center h-full text-zinc-400 dark:text-zinc-500 text-[13px]">
                {sendToModel ? 'Start a conversation' : 'Paste or type content to save locally'}
              </div>
            )}
            {chatMessages.map((msg, i) => {
              const prevMsg = i > 0 ? chatMessages[i - 1] : undefined;
              const bbox = msg.role === 'assistant' && msg.status === 'done' && prevMsg?.images?.length ? extractBbox(msg.text) : null;
              return (
              <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-[13px] leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-blue-600 text-white'
                    : msg.status === 'error'
                    ? 'bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400'
                    : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
                }`}>
                  {msg.images && msg.images.length > 0 && (
                    <div className="flex gap-1 mb-1 flex-wrap">
                      {msg.images.map((img, i) => (
                        <img key={i} src={img} alt="" className="max-w-[120px] max-h-[80px] rounded object-cover" />
                      ))}
                    </div>
                  )}
                  {msg.text && <div className="whitespace-pre-wrap break-words">{msg.text}</div>}
                  {bbox && <BboxOverlay imageUrl={prevMsg!.images![0]} bbox={bbox} />}
                  {msg.status === 'streaming' && !msg.text && (
                    <span className="inline-block w-2 h-4 bg-zinc-400 animate-pulse rounded-sm" />
                  )}
                </div>
              </div>
            );
            })}
            <div ref={chatEndRef} />
          </div>

          {/* Chat input */}
          <MessageInput
            onSend={handleChatSend}
            enabled={!chatStreaming}
            hintText={sendToModel ? 'Send message...' : 'Type to save locally...'}
            allowImagePaste={allowImagePaste}
          />
        </>
      ) : (
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
          {actionLog.length > 0 && (
            <div className="flex-1 overflow-y-auto px-2 py-1 min-h-0">
              {[...actionLog].reverse().map((log, i) => (
                <div key={i} className="flex items-center gap-1.5 py-0.5 text-[11px]">
                  {log.success ? (
                    <CheckCircle size={10} className="text-green-500 shrink-0" />
                  ) : (
                    <XCircle size={10} className="text-red-500 shrink-0" />
                  )}
                  <span className="text-zinc-600 dark:text-zinc-400 truncate">{log.action}</span>
                </div>
              ))}
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="mx-2 px-2 py-1 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded text-[11px] text-red-700 dark:text-red-300">
              {error}
              <button onClick={() => setError(null)} className="ml-2 underline">Dismiss</button>
            </div>
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
                onClick={() => setIsAutomating(false)}
                disabled={!isAutomating}
                className="p-1.5 rounded border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-red-500 disabled:opacity-30"
              >
                <StopCircle size={14} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
