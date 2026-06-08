'use client';

import { useState, useCallback, useEffect } from 'react';
import { MonitorUp } from 'lucide-react';
import { isTauri } from '@/utils/platform';

export function FloatWindowToggle() {
  const [mounted, setMounted] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  // Defer render until after mount to avoid SSR hydration mismatch
  useEffect(() => { setMounted(true); }, []);

  // Check if float window already exists on mount
  useEffect(() => {
    if (!mounted || !isTauri()) return;
    let cancelled = false;
    (async () => {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const win = await WebviewWindow.getByLabel('float');
        if (win && !cancelled) {
          const visible = await win.isVisible();
          if (!cancelled) setIsOpen(visible);
        }
      } catch { /* not in Tauri */ }
    })();
    return () => { cancelled = true; };
  }, [mounted]);

  const handleToggle = useCallback(async () => {
    if (!isTauri()) return;

    try {
      const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');

      const existing = await WebviewWindow.getByLabel('float').catch(() => null);

      // If window exists, toggle show/hide
      if (existing) {
        try {
          const visible = await existing.isVisible();
          if (visible) {
            await existing.hide();
            setIsOpen(false);
          } else {
            await existing.show();
            await existing.setFocus();
            setIsOpen(true);
          }
          return;
        } catch {
          // Stale handle — destroy and recreate below
          try { await existing.close(); } catch { /* ignore */ }
        }
      }

      // Create new float window
      const win = new WebviewWindow('float', {
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
        win.once('tauri://created', () => resolve());
        setTimeout(resolve, 800);
      });

      // Position top-right
      try {
        const { primaryMonitor } = await import('@tauri-apps/api/window');
        const { PhysicalPosition } = await import('@tauri-apps/api/dpi');
        const monitor = await primaryMonitor();
        if (monitor) {
          const winSize = await win.innerSize();
          const x = monitor.position.x + monitor.size.width - winSize.width - 20;
          const y = monitor.position.y + 60;
          await win.setPosition(new PhysicalPosition(x, y));
        }
      } catch { /* use default */ }

      // Track when float window closes itself (X button or handleClose)
      win.onCloseRequested(async (_e) => {
        setIsOpen(false);
      });

      await win.show();
      await win.setFocus();
      setIsOpen(true);
    } catch {
      // ignore
    }
  }, [isOpen]);

  // Listen for tray toggle event
  useEffect(() => {
    if (!mounted || !isTauri()) return;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const win = getCurrentWebviewWindow();
        unlisten = await win.listen('tray-toggle-float', () => {
          handleToggle();
        });
      } catch { /* not in Tauri */ }
    })();
    return () => { unlisten?.(); };
  }, [mounted, handleToggle]);

  // Return null during SSR and first render to match server HTML
  if (!mounted || !isTauri()) return null;

  return (
    <button
      onClick={handleToggle}
      className={`flex items-center gap-3 mx-2 px-3 py-2 rounded-lg text-[14px] font-medium transition-colors ${
        isOpen
          ? 'bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300'
          : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
      }`}
      title={isOpen ? 'Hide floating assistant' : 'Show floating assistant'}
    >
      <MonitorUp size={20} />
      Assistant
    </button>
  );
}
