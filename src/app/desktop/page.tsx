// 来源: lib/screens/desktop_screen.dart

'use client';

import { useState, useRef, useCallback } from 'react';
import { Monitor, Camera, Play, StopCircle, Wrench, CheckCircle, XCircle } from 'lucide-react';
import { useT } from '@/i18n/strings';
import { desktopService, type WindowInfo } from '@/services/desktop-service';

interface ActionLog {
  action: string;
  success: boolean;
  error?: string;
}

export default function DesktopPage() {
  const t = useT();
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [actionLog, setActionLog] = useState<ActionLog[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const goalRef = useRef<HTMLInputElement>(null);

  const handleCapture = useCallback(async () => {
    setIsCapturing(true);
    setError(null);
    try {
      const base64 = await desktopService.screenshot();
      setScreenshot(base64);
    } catch (e) {
      setError(`Screenshot failed: ${e}`);
    } finally {
      setIsCapturing(false);
    }
  }, []);

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

  const handleFocusWindow = useCallback(async (hwnd: number) => {
    try {
      await desktopService.focusWindow(hwnd);
      setActionLog((prev) => [...prev, { action: `Focus window ${hwnd}`, success: true }]);
    } catch (e) {
      setActionLog((prev) => [...prev, { action: `Focus window ${hwnd}`, success: false, error: String(e) }]);
    }
  }, []);

  const handleStartAutomation = useCallback(async () => {
    const goal = goalRef.current?.value.trim();
    if (!goal || isOpening) return;

    setIsOpening(true);
    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

      let win = await WebviewWindow.getByLabel('float');
      if (!win) {
        win = new WebviewWindow('float', {
          url: '/float',
          title: 'OpenPaw Assistant',
          width: 360,
          height: 480,
          decorations: false,
          alwaysOnTop: true,
          skipTaskbar: true,
          resizable: true,
          visible: false,
        });

        win.once('tauri://error', () => {
          // ignore
        });

        await new Promise<void>((resolve) => {
          win!.once('tauri://created', () => resolve());
          setTimeout(resolve, 800);
        });

        // Position bottom-right
        try {
          const { primaryMonitor } = await import('@tauri-apps/api/window');
          const { PhysicalPosition } = await import('@tauri-apps/api/dpi');
          const monitor = await primaryMonitor();
          if (monitor) {
            const winSize = await win.innerSize();
            const x = monitor.position.x + monitor.size.width - winSize.width - 20;
            const y = monitor.position.y + monitor.size.height - winSize.height - 60;
            await win.setPosition(new PhysicalPosition(x, y));
          }
        } catch { /* use default */ }

        win.onCloseRequested(async (e) => {
          e.preventDefault();
          await win!.hide();
        });
      }

      const visible = await win.isVisible();
      if (!visible) {
        await win.show();
      }
      await win.setFocus();

      // Send goal to float window
      await win.emit('automation-goal', { goal });

      setActionLog((prev) => [...prev, { action: `Sent to float assistant: "${goal}"`, success: true }]);
    } catch (e) {
      setError(String(e));
    } finally {
      setIsOpening(false);
    }
  }, [isOpening]);

  const clearLog = useCallback(() => setActionLog([]), []);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 shrink-0">
        <h1 className="text-[16px] font-bold text-zinc-900 dark:text-zinc-100">
          {t('desktop.title')}
        </h1>
        <button
          onClick={handleRefresh}
          disabled={isCapturing}
          className="p-2 rounded-lg text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 disabled:opacity-40"
          title="Capture"
        >
          <Camera size={18} />
        </button>
      </div>

      <div className="flex-1 flex flex-col overflow-y-auto">
        {/* Screenshot preview */}
        {screenshot ? (
          <div className="m-2 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden">
            <img src={screenshot} alt="Desktop screenshot" className="w-full object-contain" />
          </div>
        ) : isCapturing ? (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-400">
            <div className="w-8 h-8 border-[3px] border-zinc-200 dark:border-zinc-700 border-t-blue-500 rounded-full animate-spin mb-4" />
            <p className="text-[13px]">Capturing...</p>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 dark:text-zinc-500">
            <Monitor size={56} className="mb-4 opacity-30" />
            <p className="text-[13px] mb-3">Capture your desktop to begin</p>
            <button
              onClick={handleCapture}
              className="flex items-center gap-2 px-4 py-2 rounded-full bg-blue-600 text-white text-[14px] font-medium hover:bg-blue-700"
            >
              <Camera size={16} />
              Capture
            </button>
          </div>
        )}

        {/* Windows list */}
        {windows.length > 0 && (
          <div className="px-2">
            <div className="flex items-center gap-2 px-2 py-1">
              <Monitor size={14} className="text-blue-500" />
              <span className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-400">
                Windows ({windows.length})
              </span>
            </div>
            <div className="flex gap-2 overflow-x-auto pb-2 px-2">
              {windows.map((w, i) => (
                <button
                  key={i}
                  onClick={() => handleFocusWindow(w.hwnd)}
                  className="shrink-0 w-48 p-3 rounded-xl border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-left hover:bg-zinc-50 dark:hover:bg-zinc-800"
                >
                  <p className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200 truncate">{w.title}</p>
                  <p className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-1">{w.width}x{w.height}</p>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Action log */}
        {actionLog.length > 0 && (
          <div className="px-3">
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[12px] font-semibold text-zinc-600 dark:text-zinc-400">Action Log</span>
              <button onClick={clearLog} className="text-[11px] text-red-500 hover:underline">
                Clear
              </button>
            </div>
            <div className="space-y-1 px-2 pb-2">
              {actionLog.map((log, i) => (
                <div key={i} className="flex items-center gap-2 text-[12px]">
                  {log.success ? (
                    <CheckCircle size={12} className="text-green-500 shrink-0" />
                  ) : (
                    <XCircle size={12} className="text-red-500 shrink-0" />
                  )}
                  <span className="text-zinc-600 dark:text-zinc-400 truncate">{log.action}</span>
                  {log.error && (
                    <span className="text-[11px] text-red-400 truncate">{log.error}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Error banner */}
        {error && (
          <div className="mx-3 mb-2 px-3 py-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-[13px] text-red-700 dark:text-red-300 flex items-center justify-between">
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
              placeholder="Enter automation goal... (e.g., Open Notepad and type hello)"
              className="flex-1 px-3 py-2 text-[14px] rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 outline-none focus:border-blue-500"
              onKeyDown={(e) => { if (e.key === 'Enter') handleStartAutomation(); }}
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleStartAutomation}
              disabled={isOpening}
              className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg bg-blue-600 text-white text-[14px] font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {isOpening ? (
                <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Play size={16} />
              )}
              {isOpening ? 'Opening...' : 'Start Automation'}
            </button>
            <button
              onClick={() => setIsOpening(false)}
              disabled={!isOpening}
              className="p-2.5 rounded-lg border border-zinc-200 dark:border-zinc-700 text-zinc-400 hover:text-red-500 disabled:opacity-30"
              title="Stop"
            >
              <StopCircle size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
