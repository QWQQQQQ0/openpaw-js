import { useState, useCallback, useEffect } from 'react';
import { Camera, Save, Loader2, Globe, Monitor, Play, Square, Zap, ChevronRight, Pause, StopCircle } from 'lucide-react';
import type { LearningProgress, ElementCapability, InteractiveNode, VisionElement } from '@/types/cache';
import { desktopService, type WindowInfo } from '@/services/desktop-service';
import * as capabilityLearner from '@/services/capability-learner';

interface Props {
  onProgressChange: (progress: LearningProgress) => void;
}

export default function LearnMode({ onProgressChange }: Props) {
  const [learningProgress, setLearningProgress] = useState<LearningProgress>({
    status: 'idle',
    session: null,
    totalDiscovered: 0,
    lastInteraction: null,
  });
  const [learnDiscoveries, setLearnDiscoveries] = useState<Array<{ automationId: string; name: string; role: string; capability: ElementCapability; bounds?: { left: number; top: number; width: number; height: number } }>>([]);

  // Window selection
  const [windows, setWindows] = useState<WindowInfo[]>([]);
  const [selectedHwnd, setSelectedHwnd] = useState<number | null>(null);
  const [loadingWindows, setLoadingWindows] = useState(false);

  // 半自动学习状态
  const [userNote, setUserNote] = useState('');
  const [isCapturing, setIsCapturing] = useState(false);
  const [semiElements, setSemiElements] = useState<VisionElement[]>([]);
  const [selectedElements, setSelectedElements] = useState<Set<number>>(new Set());
  const [lastScreenshotPath, setLastScreenshotPath] = useState<string | null>(null);

  // 级联学习状态
  const [isCascading, setIsCascading] = useState(false);
  const [cascadeProgress, setCascadeProgress] = useState({ current: 0, total: 0, element: '' });
  const [cascadeResults, setCascadeResults] = useState<Array<{ parent: string; childFp: string; elements: number }>>([]);

  // 受控浏览学习状态
  const [browserUrl, setBrowserUrl] = useState('');
  const [isBrowserLaunching, setIsBrowserLaunching] = useState(false);
  const [isBrowserActive, setIsBrowserActive] = useState(false);
  const [browserElements, setBrowserElements] = useState<InteractiveNode[]>([]);

  // Load windows on mount
  useEffect(() => {
    refreshWindows();
    checkBrowserStatus();
  }, []);

  const refreshWindows = useCallback(async () => {
    setLoadingWindows(true);
    try {
      const list = await desktopService.listWindows();
      const filtered = list.filter(w =>
        w.is_visible &&
        !w.title.includes('OpenPaw') &&
        !w.title.includes('openpaw') &&
        w.title.trim().length > 0
      );
      setWindows(filtered);
    } catch {
      // ignore
    } finally {
      setLoadingWindows(false);
    }
  }, []);

  const checkBrowserStatus = useCallback(async () => {
    try {
      const result = await desktopService.webPwGetInteractive();
      if (result && !result.error) {
        setIsBrowserActive(true);
        setBrowserElements(result.nodes as unknown as InteractiveNode[] || []);
      }
    } catch {
      setIsBrowserActive(false);
    }
  }, []);

  useEffect(() => {
    const unsub = capabilityLearner.onLearningProgress((progress) => {
      setLearningProgress(progress);
      setLearnDiscoveries(capabilityLearner.getDiscoveredList());
      onProgressChange(progress);
    });
    return unsub;
  }, [onProgressChange]);

  // ── 受控浏览学习 ──

  const handleLaunchBrowser = useCallback(async () => {
    if (!browserUrl) {
      alert('请输入 URL');
      return;
    }

    setIsBrowserLaunching(true);
    try {
      // 启动 Playwright 浏览器
      await desktopService.webPwLaunch(false, 'chrome');
      // 导航到指定 URL
      await desktopService.webPwNavigate(browserUrl);
      setIsBrowserActive(true);

      // 获取交互元素
      const result = await desktopService.webPwGetInteractive();
      if (result && !result.error) {
        setBrowserElements(result.nodes as unknown as InteractiveNode[] || []);
      }
    } catch (e) {
      alert(`启动浏览器失败: ${e}`);
    } finally {
      setIsBrowserLaunching(false);
    }
  }, [browserUrl]);

  const handleCloseBrowser = useCallback(async () => {
    try {
      await desktopService.webPwClose();
      setIsBrowserActive(false);
      setBrowserElements([]);
    } catch { /* ignore */ }
  }, []);

  const handleRefreshBrowserElements = useCallback(async () => {
    try {
      const result = await desktopService.webPwGetInteractive();
      if (result && !result.error) {
        setBrowserElements(result.nodes as unknown as InteractiveNode[] || []);
      }
    } catch { /* ignore */ }
  }, []);

  // ── 半自动学习（桌面应用）──

  const isActive = learningProgress.status === 'learning' || learningProgress.status === 'paused';

  const handleSemiAutoCapture = useCallback(async () => {
    // 学习中用 session 的 hwnd，空闲时用选中的 hwnd
    const hwnd = learningProgress.session?.hwnd || selectedHwnd;
    if (!hwnd) return;

    const win = windows.find(w => w.hwnd === hwnd);
    const appName = win?.title || learningProgress.session?.appName || 'Unknown';
    const isLearning = isActive;

    setIsCapturing(true);
    if (!isLearning) {
      setSemiElements([]);
      setSelectedElements(new Set());
    }

    try {
      const { useModelConfigStore } = await import('@/stores/model-config-store');
      await useModelConfigStore.getState().load();
      const config = useModelConfigStore.getState().defaultConfig();
      if (!config) {
        alert('请先配置模型');
        return;
      }

      let apiKey = '';
      try {
        apiKey = await useModelConfigStore.getState().getApiKey(config.id, '');
      } catch (e) {
        alert(`获取 API key 失败: ${e}`);
        return;
      }
      if (!apiKey) {
        alert('API key 为空');
        return;
      }

      const result = await capabilityLearner.semiAutoCapture(
        hwnd,
        appName,
        userNote,
        config,
        apiKey,
      );

      if (result.success) {
        if (isLearning) {
          // 学习中：直接全选保存，不展示预览
          const elementsToSave = result.visionElements.map(el => ({
            label: el.label,
            description: el.description,
            relativeX: el.relativeX,
            relativeY: el.relativeY,
            relativeWidth: el.relativeWidth,
            relativeHeight: el.relativeHeight,
            type: el.type || 'interactive' as const,
            known_function: el.known_function,
          }));
          if (elementsToSave.length > 0) {
            const count = await capabilityLearner.semiAutoSave(elementsToSave, result.screenshotPath);
          }
        } else {
          // 空闲：展示预览让用户选择
          setSemiElements(result.visionElements);
          setLastScreenshotPath(result.screenshotPath);
          setSelectedElements(new Set(result.visionElements.map((_, i) => i)));
        }
      } else {
        alert(`截屏分析失败: ${result.error}`);
      }
    } catch (e) {
      console.error('[LearnMode] Semi-auto capture failed:', e);
      alert(`截屏失败: ${e}`);
    } finally {
      setIsCapturing(false);
    }
  }, [selectedHwnd, windows, userNote, learningProgress.session, isActive]);

  // ── 级联学习 ──

  const handleCascadeLearn = useCallback(async () => {
    if (!selectedHwnd || semiElements.length === 0) {
      alert('请先截屏分析，然后选择要级联学习的元素');
      return;
    }

    const win = windows.find(w => w.hwnd === selectedHwnd);
    const appName = win?.title || 'Unknown';

    const { useModelConfigStore } = await import('@/stores/model-config-store');
    await useModelConfigStore.getState().load();
    const config = useModelConfigStore.getState().defaultConfig();
    if (!config) {
      alert('请先配置模型');
      return;
    }

    let apiKey = '';
    try {
      apiKey = await useModelConfigStore.getState().getApiKey(config.id, '');
    } catch (e) {
      alert(`获取 API key 失败: ${e}`);
      return;
    }
    if (!apiKey) {
      alert('API key 为空');
      return;
    }

    // 获取实际窗口尺寸
    let winWidth = 1920, winHeight = 1080;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const wb = await invoke<{ width: number; height: number }>('get_window_bounds', { hwnd: selectedHwnd });
      if (wb && wb.width > 0 && wb.height > 0) { winWidth = wb.width; winHeight = wb.height; }
    } catch { /* fallback */ }

    // 获取选中的元素
    const elementsToLearn = semiElements
      .filter((_, i) => selectedElements.has(i))
      .map(el => ({
        label: el.label,
        role: el.type,
        known_function: el.known_function,
        bounds: {
          left: Math.round(el.relativeX * winWidth),
          top: Math.round(el.relativeY * winHeight),
          width: Math.round(el.relativeWidth * winWidth),
          height: Math.round(el.relativeHeight * winHeight),
        },
      }));

    if (elementsToLearn.length === 0) {
      alert('请至少选择一个元素');
      return;
    }

    setIsCascading(true);
    setCascadeResults([]);
    setCascadeProgress({ current: 0, total: elementsToLearn.length, element: '' });

    try {
      const result = await capabilityLearner.batchCascadeLearn(
        selectedHwnd,
        appName,
        elementsToLearn,
        config,
        apiKey,
        (current, total, element) => {
          setCascadeProgress({ current, total, element });
        },
      );

      setCascadeResults(result.children);
      alert(`级联学习完成：成功 ${result.success}，失败 ${result.failed}，发现 ${result.children.length} 个子组件`);
    } catch (e) {
      alert(`级联学习失败: ${e}`);
    } finally {
      setIsCascading(false);
    }
  }, [selectedHwnd, windows, semiElements, selectedElements]);

  // ── 受控浏览学习（截屏 + DOM）──

  const handleBrowserCapture = useCallback(async () => {
    if (!isBrowserActive) return;

    setIsCapturing(true);
    setSemiElements([]);
    setSelectedElements(new Set());

    try {
      const { useModelConfigStore } = await import('@/stores/model-config-store');
      await useModelConfigStore.getState().load();
      const config = useModelConfigStore.getState().defaultConfig();
      if (!config) {
        alert('请先配置模型');
        return;
      }

      let apiKey = '';
      try {
        apiKey = await useModelConfigStore.getState().getApiKey(config.id, '');
      } catch (e) {
        alert(`获取 API key 失败: ${e}`);
        return;
      }
      if (!apiKey) {
        alert('API key 为空');
        return;
      }

      // 截取浏览器窗口
      const screenshot = await desktopService.screenshot();
      if (!screenshot) {
        alert('截屏失败');
        return;
      }

      // 保存截图
      let screenshotPath: string | null = null;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const dataUrl = screenshot.startsWith('data:') ? screenshot : `data:image/bmp;base64,${screenshot}`;
        const filename = `browser_${Date.now()}.jpg`.replace(/[<>:"/\\|?*]/g, '_');
        const saved: string[] = await invoke('save_llm_images', {
          images: [{ data: dataUrl, filename }],
        });
        if (saved.length > 0) {
          screenshotPath = saved[0];
        }
      } catch (e) {
        console.warn('[LearnMode] Screenshot save failed:', e);
      }

      // LLM 视觉分析
      const visionResult = await capabilityLearner.semiAutoCapture(
        0, // hwnd 不重要
        browserUrl || 'Browser',
        userNote,
        config,
        apiKey,
      );

      if (!visionResult.success) {
        alert(`分析失败: ${visionResult.error}`);
        return;
      }

      // 获取最新的 DOM 元素
      const domResult = await desktopService.webPwGetInteractive();
      const domElements = (domResult?.nodes as unknown as InteractiveNode[]) || [];

      // 匹配视觉元素和 DOM 元素
      const matchResult = await capabilityLearner.browserLearnWithDOM(
        visionResult.visionElements,
        domElements,
        screenshotPath,
      );

      // 将匹配结果转换为 VisionElement 格式显示
      const allElements: VisionElement[] = [
        ...matchResult.matched.map(m => m.vision),
        ...matchResult.visionOnly,
        ...matchResult.domOnly.map(dom => ({
          label: dom.name || dom.role,
          description: `DOM: ${dom.role}`,
          keywords: [dom.role],
          relativeX: dom.bounds ? dom.bounds.left / 1920 : 0,
          relativeY: dom.bounds ? dom.bounds.top / 1080 : 0,
          relativeWidth: dom.bounds ? dom.bounds.width / 1920 : 0.1,
          relativeHeight: dom.bounds ? dom.bounds.height / 1080 : 0.05,
          type: 'interactive' as const,
          known_function: `DOM: ${dom.role}`,
        })),
      ];

      setSemiElements(allElements);
      setLastScreenshotPath(visionResult.screenshotPath || screenshotPath);
      setSelectedElements(new Set(allElements.map((_, i) => i)));

      // 保存匹配结果到 session（用于后续保存）
      (window as any).__browserMatchResult = matchResult;
    } catch (e) {
      console.error('[LearnMode] Browser capture failed:', e);
      alert(`截屏失败: ${e}`);
    } finally {
      setIsCapturing(false);
    }
  }, [isBrowserActive, browserUrl, userNote]);

  // ── 公共函数 ──

  const handleToggleElement = useCallback((index: number) => {
    setSelectedElements(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  // 定位到相对坐标对应的屏幕位置（用于半自动元素）
  const handleLocateRelative = useCallback(async (relativeX: number, relativeY: number, relativeWidth: number, relativeHeight: number) => {
    const hwnd = learningProgress.session?.hwnd || selectedHwnd;
    if (!hwnd) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const winBounds = await invoke<{ x: number; y: number; width: number; height: number }>('get_window_bounds', { hwnd });
      if (!winBounds || winBounds.width <= 0) return;
      const centerX = winBounds.x + Math.round(relativeX * winBounds.width + relativeWidth * winBounds.width / 2);
      const centerY = winBounds.y + Math.round(relativeY * winBounds.height + relativeHeight * winBounds.height / 2);
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const win = getCurrentWebviewWindow();
      await win.setAlwaysOnTop(false);
      await desktopService.moveMouse(centerX, centerY);
      setTimeout(() => { win.setAlwaysOnTop(true).catch(() => {}); }, 1500);
    } catch { /* ignore */ }
  }, [learningProgress.session?.hwnd, selectedHwnd]);

  const handleSelectAll = useCallback(() => {
    setSelectedElements(new Set(semiElements.map((_, i) => i)));
  }, [semiElements]);

  const handleDeselectAll = useCallback(() => {
    setSelectedElements(new Set());
  }, []);

  const handleLocateElement = useCallback(async (bounds?: { left: number; top: number; width: number; height: number }) => {
    if (!bounds) {
      return;
    }
    const centerX = bounds.left + Math.round(bounds.width / 2);
    const centerY = bounds.top + Math.round(bounds.height / 2);
    try {
      // 临时取消浮窗置顶，避免鼠标被浮窗挡住
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const win = getCurrentWebviewWindow();
      await win.setAlwaysOnTop(false);
      await desktopService.moveMouse(centerX, centerY);
      // 延迟恢复置顶
      setTimeout(() => { win.setAlwaysOnTop(true).catch(() => {}); }, 1500);
    } catch { /* ignore */ }
  }, []);

  const handleSaveSemiAuto = useCallback(async () => {
    // 检查是否有受控浏览学习的匹配结果
    const browserMatchResult = (window as any).__browserMatchResult;

    if (browserMatchResult) {
      // 使用受控浏览学习的保存逻辑
      const count = await capabilityLearner.saveBrowserLearnResult(
        browserMatchResult.matched,
        browserMatchResult.visionOnly,
        browserMatchResult.domOnly,
        lastScreenshotPath,
      );
      alert(`已保存 ${count} 个元素（含 DOM 匹配）`);
      delete (window as any).__browserMatchResult;
    } else {
      // 使用普通的半自动学习保存逻辑
      const elementsToSave = semiElements
        .filter((_, i) => selectedElements.has(i))
        .map(el => ({
          label: el.label,
          description: el.description,
          relativeX: el.relativeX,
          relativeY: el.relativeY,
          relativeWidth: el.relativeWidth,
          relativeHeight: el.relativeHeight,
          type: el.type || 'interactive' as const,
          known_function: el.known_function,
        }));

      if (elementsToSave.length === 0) {
        alert('请至少选择一个元素');
        return;
      }

      const count = await capabilityLearner.semiAutoSave(elementsToSave, lastScreenshotPath);
      alert(`已保存 ${count} 个元素`);
    }

    setSemiElements([]);
    setSelectedElements(new Set());
    setUserNote('');
  }, [semiElements, selectedElements, lastScreenshotPath]);

  // 注意：isActive 在 handleSemiAutoCapture 中也有使用，需要在它之前声明

  return (
    <div className="flex flex-col flex-1 overflow-hidden px-3 py-2 min-h-0">
      {/* 调试信息（临时） */}
      <div className="text-[9px] text-zinc-400 mb-1">
        status={learningProgress.status} | active={String(isActive)} | discoveries={learnDiscoveries.length} | semi={semiElements.length}
      </div>
      {/* 学习中：紧凑控制栏（暂停/停止 + 截屏分析） */}
      {isActive && (
        <div className="flex items-center justify-between mb-2 px-2 py-1.5 rounded-lg bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center gap-2 min-w-0">
            <div className={`w-2 h-2 rounded-full shrink-0 ${
              learningProgress.status === 'learning' ? 'bg-green-500 animate-pulse' : 'bg-yellow-500'
            }`} />
            <span className="text-[11px] font-medium text-zinc-700 dark:text-zinc-300 truncate">
              {learningProgress.status === 'learning' ? '学习中' : '已暂停'}
            </span>
            {learningProgress.session && (
              <span className="text-[10px] text-zinc-500 shrink-0">
                {learningProgress.totalDiscovered} 个能力
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={handleSemiAutoCapture}
              disabled={isCapturing}
              className="p-1.5 rounded hover:bg-purple-100 dark:hover:bg-purple-900 text-purple-600 dark:text-purple-400 disabled:opacity-50"
              title="截屏分析"
            >
              {isCapturing ? <Loader2 size={14} className="animate-spin" /> : <Camera size={14} />}
            </button>
            {learningProgress.status === 'learning' ? (
              <button
                onClick={capabilityLearner.pauseLearning}
                className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-yellow-600 dark:text-yellow-400"
                title="暂停"
              >
                <Pause size={14} />
              </button>
            ) : (
              <button
                onClick={capabilityLearner.resumeLearning}
                className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-green-600 dark:text-green-400"
                title="继续"
              >
                <Play size={14} />
              </button>
            )}
            <button
              onClick={capabilityLearner.stopLearning}
              className="p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-red-500"
              title="停止学习"
            >
              <StopCircle size={14} />
            </button>
          </div>
        </div>
      )}

      {/* 空闲状态：显示配置区域 */}
      {!isActive && (
        <div className="flex-1 overflow-y-auto scrollbar-hide min-h-0">
          {/* Status indicator */}
          <div className="flex items-center gap-2 mb-3">
            <div className="w-2 h-2 rounded-full bg-zinc-400" />
            <span className="text-[12px] font-medium text-zinc-700 dark:text-zinc-300">未开始</span>
          </div>

          {/* 受控浏览学习 */}
          <div className="mb-3 p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950 border border-emerald-200 dark:border-emerald-800">
            <div className="flex items-center gap-2 mb-2">
              <Globe size={14} className="text-emerald-500" />
              <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">受控浏览学习</span>
            </div>

            {!isBrowserActive ? (
              <>
                <div className="mb-2">
                  <input
                    type="text"
                    value={browserUrl}
                    onChange={(e) => setBrowserUrl(e.target.value)}
                    placeholder="输入 URL（如 https://google.com）"
                    className="w-full px-2 py-1.5 text-[11px] rounded border border-emerald-200 dark:border-emerald-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
                    onKeyDown={(e) => e.key === 'Enter' && handleLaunchBrowser()}
                  />
                </div>
                <button
                  onClick={handleLaunchBrowser}
                  disabled={!browserUrl || isBrowserLaunching}
                  className="w-full flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-emerald-600 text-white text-[12px] font-medium hover:bg-emerald-700 disabled:opacity-50"
                >
                  {isBrowserLaunching ? (
                    <><Loader2 size={12} className="animate-spin" /> 启动中...</>
                  ) : (
                    <><Globe size={12} /> 启动受控浏览器</>
                  )}
                </button>
              </>
            ) : (
              <>
                <div className="mb-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                  浏览器已启动: {browserUrl || '未知'}
                </div>

                <div className="mb-2">
                  <input
                    type="text"
                    value={userNote}
                    onChange={(e) => setUserNote(e.target.value)}
                    placeholder="备注：当前页面需要学习的内容..."
                    className="w-full px-2 py-1.5 text-[11px] rounded border border-emerald-200 dark:border-emerald-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
                  />
                </div>

                <div className="flex gap-2 mb-2">
                  <button
                    onClick={handleBrowserCapture}
                    disabled={isCapturing}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-blue-600 text-white text-[12px] font-medium hover:bg-blue-700 disabled:opacity-50"
                  >
                    {isCapturing ? (
                      <><Loader2 size={12} className="animate-spin" /> 分析中...</>
                    ) : (
                      <><Camera size={12} /> 截屏 + DOM 分析</>
                    )}
                  </button>
                  <button
                    onClick={handleRefreshBrowserElements}
                    className="px-3 py-2 rounded-lg bg-zinc-600 text-white text-[12px] font-medium hover:bg-zinc-700"
                  >
                    刷新
                  </button>
                </div>

                <button
                  onClick={handleCloseBrowser}
                  className="w-full flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-red-600 text-white text-[12px] font-medium hover:bg-red-700"
                >
                  <Square size={12} />
                  关闭浏览器
                </button>

                {browserElements.length > 0 && (
                  <div className="mt-2">
                    <div className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 mb-1">
                      DOM 元素 ({browserElements.length})
                    </div>
                    <div className="space-y-1 max-h-[100px] overflow-y-auto scrollbar-hide">
                      {browserElements.slice(0, 20).map((node, i) => (
                        <div key={i} className="text-[10px] text-zinc-600 dark:text-zinc-400 truncate">
                          [{node.role}] {node.name || '无名称'}
                        </div>
                      ))}
                      {browserElements.length > 20 && (
                        <div className="text-[10px] text-zinc-400">
                          ... 还有 {browserElements.length - 20} 个元素
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* 半自动学习（桌面应用） */}
          <div className="mb-3 p-2 rounded-lg bg-purple-50 dark:bg-purple-950 border border-purple-200 dark:border-purple-800">
            <div className="flex items-center gap-2 mb-2">
              <Monitor size={14} className="text-purple-500" />
              <span className="text-[11px] font-semibold text-purple-700 dark:text-purple-300">桌面应用学习</span>
            </div>

            <div className="mb-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-medium text-zinc-600 dark:text-zinc-400">选择目标窗口</span>
                <button
                  onClick={refreshWindows}
                  disabled={loadingWindows}
                  className="text-[10px] text-blue-500 hover:text-blue-600 disabled:opacity-50"
                >
                  {loadingWindows ? '刷新中...' : '刷新'}
                </button>
              </div>
              <div className="space-y-1 max-h-[80px] overflow-y-auto scrollbar-hide">
                {windows.length === 0 ? (
                  <div className="text-[11px] text-zinc-400 text-center py-2">
                    {loadingWindows ? '加载窗口列表...' : '未找到可用窗口'}
                  </div>
                ) : (
                  windows.map((win) => (
                    <button
                      key={win.hwnd}
                      onClick={() => setSelectedHwnd(win.hwnd)}
                      className={`w-full flex items-center gap-2 px-2 py-1 rounded text-left transition-colors ${
                        selectedHwnd === win.hwnd
                          ? 'bg-purple-50 dark:bg-purple-950 border border-purple-300 dark:border-purple-700'
                          : 'bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 hover:border-zinc-300 dark:hover:border-zinc-700'
                      }`}
                    >
                      <Monitor size={10} className={selectedHwnd === win.hwnd ? 'text-purple-500' : 'text-zinc-400'} />
                      <div className="flex-1 min-w-0">
                        <div className="text-[11px] font-medium text-zinc-900 dark:text-zinc-100 truncate">{win.title}</div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            <div className="mb-2">
              <input
                type="text"
                value={userNote}
                onChange={(e) => setUserNote(e.target.value)}
                placeholder="备注：当前页面需要学习的内容..."
                className="w-full px-2 py-1.5 text-[11px] rounded border border-purple-200 dark:border-purple-700 bg-white dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
              />
            </div>

            <button
              onClick={handleSemiAutoCapture}
              disabled={!selectedHwnd || isCapturing}
              className="w-full flex items-center justify-center gap-1 px-3 py-2 rounded-lg bg-purple-600 text-white text-[12px] font-medium hover:bg-purple-700 disabled:opacity-50"
            >
              {isCapturing ? (
                <><Loader2 size={12} className="animate-spin" /> 分析中...</>
              ) : (
                <><Camera size={12} /> 截屏并分析</>
              )}
            </button>
          </div>
        </div>
      )}

      {/* 分析结果（有数据就显示，学习中/空闲都可见） */}
      {semiElements.length > 0 && (
        <div className={`mb-3 flex flex-col ${isActive ? 'flex-1 min-h-0' : ''}`}>
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
              识别到 {semiElements.length} 个元素
            </span>
            <div className="flex gap-1">
              <button
                onClick={handleSelectAll}
                className="text-[10px] text-blue-500 hover:text-blue-600"
              >
                全选
              </button>
              <button
                onClick={handleDeselectAll}
                className="text-[10px] text-zinc-500 hover:text-zinc-600"
              >
                全不选
              </button>
            </div>
          </div>

          <div className={`space-y-1 overflow-y-auto scrollbar-hide ${isActive ? 'flex-1 min-h-0' : 'max-h-[120px]'}`}>
            {semiElements.map((el, i) => (
              <div
                key={i}
                className={`flex items-center gap-1.5 px-2 py-1.5 rounded transition-colors ${
                  selectedElements.has(i)
                    ? 'bg-blue-50 dark:bg-blue-900/30 border border-blue-300 dark:border-blue-700'
                    : 'bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedElements.has(i)}
                  onChange={() => handleToggleElement(i)}
                  onClick={(e) => e.stopPropagation()}
                  className="w-3 h-3 rounded border-zinc-300 text-blue-600 focus:ring-blue-500 shrink-0"
                />
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => handleToggleElement(i)}
                >
                  <div className="text-[11px] font-medium text-zinc-900 dark:text-zinc-100 truncate">
                    {el.label}
                  </div>
                  <div className="text-[10px] text-zinc-500 truncate">
                    {el.known_function || el.description}
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleLocateRelative(el.relativeX, el.relativeY, el.relativeWidth, el.relativeHeight);
                  }}
                  className="p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-400 hover:text-blue-500 shrink-0"
                  title="定位到屏幕"
                >
                  <Monitor size={10} />
                </button>
              </div>
            ))}
          </div>

          <div className="flex gap-1.5 mt-2 shrink-0">
            <button
              onClick={handleSaveSemiAuto}
              disabled={selectedElements.size === 0}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-green-600 text-white text-[11px] font-medium hover:bg-green-700 disabled:opacity-50"
            >
              <Save size={11} />
              保存 ({selectedElements.size})
            </button>

            <button
              onClick={handleCascadeLearn}
              disabled={selectedElements.size === 0 || isCascading}
              className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-lg bg-orange-600 text-white text-[11px] font-medium hover:bg-orange-700 disabled:opacity-50"
            >
              {isCascading ? (
                <><Loader2 size={11} className="animate-spin" /> 级联中...</>
              ) : (
                <><Zap size={11} /> 级联学习</>
            )}
          </button>
          </div>

          {isCascading && cascadeProgress.total > 0 && (
            <div className="mt-2 p-2 rounded bg-orange-50 dark:bg-orange-950 border border-orange-200 dark:border-orange-800 shrink-0">
              <div className="text-[11px] text-orange-700 dark:text-orange-300">
                进度: {cascadeProgress.current}/{cascadeProgress.total}
              </div>
              <div className="text-[10px] text-orange-600 dark:text-orange-400 truncate">
                当前: {cascadeProgress.element}
              </div>
              <div className="w-full bg-orange-200 dark:bg-orange-800 rounded-full h-1.5 mt-1">
                <div
                  className="bg-orange-600 h-1.5 rounded-full transition-all"
                  style={{ width: `${(cascadeProgress.current / cascadeProgress.total) * 100}%` }}
                />
              </div>
            </div>
          )}

          {cascadeResults.length > 0 && (
            <div className="mt-2">
              <div className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400 mb-1">
                发现 {cascadeResults.length} 个子组件
              </div>
              <div className="space-y-1 max-h-[80px] overflow-y-auto scrollbar-hide">
                {cascadeResults.map((child, i) => (
                  <div key={i} className="flex items-center gap-2 px-2 py-1 rounded bg-zinc-50 dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800">
                    <ChevronRight size={10} className="text-zinc-400" />
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-medium text-zinc-900 dark:text-zinc-100 truncate">
                        {child.parent}
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {child.elements} 个元素
                      </div>
                    </div>
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
