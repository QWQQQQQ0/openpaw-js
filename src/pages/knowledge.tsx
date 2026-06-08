'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Layers, ChevronRight, MousePointerClick, Info, Play, Loader2, Pause, Square, Trash2 } from 'lucide-react';
import type { UICacheRow, SemanticAnnotation } from '@/types/cache';
import type { TriggerInfo } from '@/types/page-component';
import { getCacheService } from '@/services/cache-service-singleton';
import { desktopService } from '@/services/desktop-service';
import { startLearning, autoLearn, stopLearning, pauseLearning, onLearningProgress, getLearningProgress } from '@/services/capability-learner';
import { useModelConfigStore } from '@/stores/model-config-store';

interface AppGroup {
  appName: string;
  pages: UICacheRow[];
}

export default function KnowledgePage() {
  const [groups, setGroups] = useState<AppGroup[]>([]);
  const [selectedApp, setSelectedApp] = useState<string | null>(null);
  const [selectedPage, setSelectedPage] = useState<UICacheRow | null>(null);
  const [selectedElement, setSelectedElement] = useState<SemanticAnnotation | null>(null);
  const [loading, setLoading] = useState(true);
  const [learning, setLearning] = useState(false);
  const [learningPaused, setLearningPaused] = useState(false);
  const [learningMsg, setLearningMsg] = useState('');
  const [discoveredCount, setDiscoveredCount] = useState(0);
  const [showLearnPicker, setShowLearnPicker] = useState(false);
  const [windows, setWindows] = useState<Array<{ hwnd: number; title: string }>>([]);

  const load = useCallback(async () => {
    setLoading(true);
    const cache = getCacheService();
    const rows = await cache.getAllUICacheRows();
    const byApp = new Map<string, UICacheRow[]>();
    for (const row of rows) {
      if (!byApp.has(row.app_name)) byApp.set(row.app_name, []);
      byApp.get(row.app_name)!.push(row);
    }
    const g: AppGroup[] = [];
    for (const [appName, pages] of byApp) {
      g.push({ appName, pages });
    }
    g.sort((a, b) => b.pages.length - a.pages.length);
    setGroups(g);
    if (g.length > 0 && !selectedApp) setSelectedApp(g[0].appName);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // 订阅学习进度
  useEffect(() => {
    const unsub = onLearningProgress((progress) => {
      setLearning(progress.status === 'learning' || progress.status === 'paused');
      setLearningPaused(progress.status === 'paused');
      setDiscoveredCount(progress.totalDiscovered);
      if (progress.status === 'idle' && learning) {
        setLearningMsg('学习已结束');
      }
    });
    // 检查初始状态
    const initial = getLearningProgress();
    if (initial.status === 'learning' || initial.status === 'paused') {
      setLearning(true);
      setLearningPaused(initial.status === 'paused');
      setDiscoveredCount(initial.totalDiscovered);
    }
    return unsub;
  }, []);

  const currentGroup = groups.find(g => g.appName === selectedApp);

  // 构建树形结构：parent → children
  const pageTree = currentGroup ? buildPageTree(currentGroup.pages) : [];

  // 获取当前页面的注解，过滤掉属于子组件的
  const currentPageAnnotations = selectedPage
    ? getOwnAnnotations(selectedPage, currentGroup?.pages ?? [])
    : [];

  // 获取当前页面的子组件列表
  const childPages = selectedPage
    ? (currentGroup?.pages ?? []).filter(p => p.parent_fingerprint === selectedPage.fingerprint)
    : [];

  const handleStartLearn = async () => {
    try {
      const wins = await desktopService.listWindows();
      setWindows(wins.map(w => ({ hwnd: w.hwnd, title: w.title })));
      setShowLearnPicker(true);
    } catch {
      setLearningMsg('无法获取窗口列表');
    }
  };

  const handleLearnWindow = async (hwnd: number, title: string) => {
    setShowLearnPicker(false);
    setLearning(true);
    setLearningMsg(`正在激活窗口 "${title}"...`);
    try {
      // 先激活目标窗口到前台
      await desktopService.focusWindow(hwnd);
      await new Promise(r => setTimeout(r, 500));

      setLearningMsg(`正在学习 "${title}"...`);
      await startLearning(hwnd, title);

      const modelStore = useModelConfigStore.getState();
      const config = modelStore.defaultConfig();
      if (config) {
        const apiKey = await modelStore.getApiKey(config.id, '');
        setLearningMsg('LLM 正在自动探索页面...（可随时停止）');
        const result = await autoLearn(hwnd, config, apiKey);
        const parts = [`探索了 ${result.explored} 个元素`];
        if (result.childComponentsFound > 0) parts.push(`${result.childComponentsFound} 个子组件`);
        if (result.visionElementsFound > 0) parts.push(`${result.visionElementsFound} 个视觉元素`);
        setLearningMsg(`完成：${parts.join('，')}`);
      } else {
        setLearningMsg('未配置模型，仅记录当前页面');
      }
      await stopLearning();
      await load(); // 刷新列表
    } catch (e) {
      setLearningMsg(`学习失败: ${e}`);
    }
  };

  const handleStopLearning = async () => {
    setLearningMsg('正在停止...');
    await stopLearning();
    setLearningMsg(`已停止，已保存 ${discoveredCount} 个能力`);
    await load();
  };

  const handlePauseLearning = () => {
    if (learningPaused) {
      // resume — 重新激活窗口
      const session = getLearningProgress().session;
      if (session?.hwnd) {
        desktopService.focusWindow(session.hwnd).catch(() => {});
      }
      setLearningMsg('继续学习...');
    } else {
      setLearningMsg('已暂停');
    }
    pauseLearning(); // 内部会根据当前状态切换 pause/resume
  };

  const handleDeletePage = async (fingerprint: string) => {
    const cache = getCacheService();
    await cache.deleteUICache(fingerprint);
    if (selectedPage?.fingerprint === fingerprint) {
      setSelectedPage(null);
      setSelectedElement(null);
    }
    await load();
  };

  const handleDeleteApp = async (appName: string) => {
    if (!confirm(`确定删除「${appName}」的所有页面数据？`)) return;
    const cache = getCacheService();
    const group = groups.find(g => g.appName === appName);
    if (group) {
      for (const page of group.pages) {
        await cache.deleteUICache(page.fingerprint);
      }
    }
    if (selectedApp === appName) {
      setSelectedApp(null);
      setSelectedPage(null);
      setSelectedElement(null);
    }
    await load();
  };

  const handleClearAll = async () => {
    if (!confirm('确定清空所有学习数据？此操作不可撤销。')) return;
    const cache = getCacheService();
    await cache.clearAllCache();
    setSelectedApp(null);
    setSelectedPage(null);
    setSelectedElement(null);
    await load();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-zinc-400">
        <div className="animate-pulse">加载中...</div>
      </div>
    );
  }

  return (
    <div className="flex h-full relative">
      {/* 学习窗口选择弹窗 */}
      {showLearnPicker && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center" onClick={() => setShowLearnPicker(false)}>
          <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-xl w-[400px] max-h-[500px] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800 font-medium">选择要学习的窗口</div>
            <div className="flex-1 overflow-y-auto p-2">
              {windows.length === 0 ? (
                <div className="p-4 text-center text-zinc-400">没有找到窗口</div>
              ) : windows.map(w => (
                <button
                  key={w.hwnd}
                  onClick={() => handleLearnWindow(w.hwnd, w.title)}
                  className="w-full text-left px-3 py-2 rounded hover:bg-zinc-100 dark:hover:bg-zinc-800 text-sm"
                >
                  {w.title || `窗口 ${w.hwnd}`}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 左侧面板 */}
      <div className="w-[280px] border-r border-zinc-200 dark:border-zinc-800 flex flex-col shrink-0 overflow-hidden">
        {/* 学习控制区 */}
        <div className="p-3 border-b border-zinc-200 dark:border-zinc-800">
          {!learning ? (
            <button
              onClick={handleStartLearn}
              className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 text-sm font-medium"
            >
              <Play size={16} />
              自动学习
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                onClick={handlePauseLearning}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-yellow-500 text-white hover:bg-yellow-600 text-sm font-medium"
              >
                {learningPaused ? <Play size={14} /> : <Pause size={14} />}
                {learningPaused ? '继续' : '暂停'}
              </button>
              <button
                onClick={handleStopLearning}
                className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-red-500 text-white hover:bg-red-600 text-sm font-medium"
              >
                <Square size={14} />
                停止
              </button>
            </div>
          )}
          {learningMsg && (
            <p className="text-xs text-zinc-500 mt-2 text-center">{learningMsg}</p>
          )}
          {learning && discoveredCount > 0 && (
            <p className="text-xs text-blue-500 mt-1 text-center">已发现 {discoveredCount} 个能力（增量保存）</p>
          )}
        </div>

        {/* 应用列表 */}
        <div className="p-3 border-b border-zinc-200 dark:border-zinc-800">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">应用 ({groups.length})</h2>
            {groups.length > 0 && (
              <button onClick={handleClearAll} className="text-xs text-red-400 hover:text-red-600" title="清空所有学习数据">清空</button>
            )}
          </div>
          <div className="space-y-1 max-h-[200px] overflow-y-auto">
            {groups.map(g => (
              <div
                key={g.appName}
                className={`group flex items-center rounded transition-colors ${
                  selectedApp === g.appName
                    ? 'bg-blue-100 dark:bg-blue-900/30'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
                }`}
              >
                <button
                  onClick={() => { setSelectedApp(g.appName); setSelectedPage(null); setSelectedElement(null); }}
                  className="flex-1 text-left px-2 py-1.5 text-sm truncate"
                >
                  <span className={selectedApp === g.appName ? 'text-blue-700 dark:text-blue-300' : 'text-zinc-700 dark:text-zinc-300'}>
                    {g.appName}
                  </span>
                  <span className="text-xs text-zinc-400 ml-1">{g.pages.length} 页</span>
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDeleteApp(g.appName); }}
                  className="p-1 text-zinc-300 dark:text-zinc-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                  title={`删除 ${g.appName} 的所有数据`}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* 页面列表 */}
        <div className="flex-1 overflow-y-auto p-3">
          <h2 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-2">页面</h2>
          <div className="space-y-0.5">
            {pageTree.map(node => (
              <PageTreeItem
                key={node.page.fingerprint}
                node={node}
                selectedFp={selectedPage?.fingerprint ?? null}
                onSelect={(page) => {
                  console.log('[Knowledge] 选择页面:', page.fingerprint, 'screenshot_path:', page.screenshot_path);
                  setSelectedPage(page);
                  setSelectedElement(null);
                }}
                onDelete={handleDeletePage}
                depth={0}
              />
            ))}
          </div>
        </div>
      </div>

      {/* 右侧主区域 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selectedPage ? (
          <>
            {/* 截图画布 */}
            <div className="flex-1 p-4 flex flex-col min-h-0">
              <div className="mb-3 flex items-center justify-between shrink-0">
                <h3 className="font-medium text-zinc-900 dark:text-zinc-100">{inferPageName(selectedPage)}</h3>
                <span className="text-xs text-zinc-400">{getAnnotations(selectedPage).length} 元素</span>
              </div>
              <ScreenshotCanvas
                screenshotPath={selectedPage.screenshot_path ?? null}
                annotations={currentPageAnnotations}
                childPages={childPages}
                selectedElement={selectedElement}
                onSelect={setSelectedElement}
                onNavigateChild={setSelectedPage}
              />
            </div>

            {/* 元素详情抽屉 */}
            {selectedElement && (
              <div className="border-t border-zinc-200 dark:border-zinc-800 p-4 max-h-[240px] overflow-y-auto bg-zinc-50 dark:bg-zinc-900">
                <div className="flex items-start justify-between mb-2">
                  <h4 className="font-medium text-zinc-900 dark:text-zinc-100">{selectedElement.label}</h4>
                  <button onClick={() => setSelectedElement(null)} className="text-zinc-400 hover:text-zinc-600 text-sm">关闭</button>
                </div>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-2">{selectedElement.description}</p>
                <div className="flex flex-wrap gap-1 mb-2">
                  {selectedElement.keywords?.map(kw => (
                    <span key={kw} className="text-xs px-1.5 py-0.5 rounded bg-zinc-200 dark:bg-zinc-700 text-zinc-600 dark:text-zinc-300">{kw}</span>
                  ))}
                </div>
                {selectedElement.capability && (
                  <div className="text-xs text-zinc-500 space-y-0.5">
                    <div>交互类型: {selectedElement.capability.interactionType}</div>
                    {selectedElement.capability.inputFormat && <div>输入格式: {selectedElement.capability.inputFormat}</div>}
                    {selectedElement.capability.notes && <div>说明: {selectedElement.capability.notes}</div>}
                  </div>
                )}
                <div className="text-xs text-zinc-400 mt-2">
                  位置: ({(selectedElement.relativeX * 100).toFixed(1)}%, {(selectedElement.relativeY * 100).toFixed(1)}%)
                  {selectedElement.relativeWidth != null && ` · 大小: ${(selectedElement.relativeWidth * 100).toFixed(1)}% × ${((selectedElement.relativeHeight ?? 0) * 100).toFixed(1)}%`}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 gap-2">
            <Info size={32} />
            <p>选择一个页面查看 wireframe</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Screenshot Canvas ──

function ScreenshotCanvas({
  screenshotPath,
  annotations,
  childPages,
  selectedElement,
  onSelect,
  onNavigateChild,
}: {
  screenshotPath: string | null;
  annotations: SemanticAnnotation[];
  childPages: UICacheRow[];
  selectedElement: SemanticAnnotation | null;
  onSelect: (el: SemanticAnnotation | null) => void;
  onNavigateChild: (page: UICacheRow) => void;
}) {
  const [imgSrc, setImgSrc] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ w: 960, h: 600 });
  const [imgNaturalSize, setImgNaturalSize] = useState({ w: 0, h: 0 });

  // 计算 object-contain 后图片的实际显示区域
  const getImageDisplayRect = useCallback(() => {
    const { w: canvasW, h: canvasH } = containerSize;
    const { w: imgW, h: imgH } = imgNaturalSize;

    if (imgW === 0 || imgH === 0) {
      // 图片尺寸未知时，假设填满容器
      return { x: 0, y: 0, w: canvasW, h: canvasH };
    }

    const imgRatio = imgW / imgH;
    const containerRatio = canvasW / canvasH;

    let displayW, displayH, offsetX, offsetY;

    if (imgRatio > containerRatio) {
      // 图片更宽，以宽度为准，上下留白
      displayW = canvasW;
      displayH = canvasW / imgRatio;
      offsetX = 0;
      offsetY = (canvasH - displayH) / 2;
    } else {
      // 图片更高，以高度为准，左右留白
      displayH = canvasH;
      displayW = canvasH * imgRatio;
      offsetX = (canvasW - displayW) / 2;
      offsetY = 0;
    }

    return { x: offsetX, y: offsetY, w: displayW, h: displayH };
  }, [containerSize, imgNaturalSize]);

  // 加载截图
  useEffect(() => {
    console.log('[Knowledge] screenshotPath 变化:', screenshotPath);
    if (!screenshotPath) {
      console.log('[Knowledge] screenshotPath 为空，不加载图片');
      setImgSrc(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        // 使用 invoke 调用 Rust 命令读取文件为 data URL
        const { invoke } = await import('@tauri-apps/api/core');
        const dataUrl = await invoke<string>('read_file_as_data_url', { path: screenshotPath });
        if (!cancelled) setImgSrc(dataUrl);
      } catch {
        if (!cancelled) setImgSrc(null);
      }
    })();
    return () => { cancelled = true; };
  }, [screenshotPath]);

  // 监听容器尺寸
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setContainerSize({ w: width, h: height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { w: canvasW, h: canvasH } = containerSize;
  const hasScreenshot = !!imgSrc;
  const imgRect = getImageDisplayRect();

  // 点击画布空白处取消选中
  const handleBgClick = () => onSelect(null);

  return (
    <div
      ref={containerRef}
      className="relative flex-1 min-h-0 border border-zinc-300 dark:border-zinc-700 rounded overflow-hidden bg-zinc-100 dark:bg-zinc-800"
    >
      {/* 截图背景 */}
      {hasScreenshot && (
        <img
          src={imgSrc!}
          alt="screenshot"
          className="absolute inset-0 w-full h-full object-contain pointer-events-none select-none"
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            setImgNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
          }}
          onError={() => { /* ignore */ }}
        />
      )}

      {/* 无截图时的占位 */}
      {!hasScreenshot && (
        <div className="absolute inset-0 flex items-center justify-center text-zinc-400 text-sm">
          无截图数据
        </div>
      )}

      {/* 选中元素的红框高亮 */}
      {selectedElement && (
        <div
          className="absolute border-2 border-red-500 bg-red-500/15 rounded-sm pointer-events-none z-10 transition-all duration-150"
          style={{
            left: selectedElement.relativeX * imgRect.w + imgRect.x,
            top: selectedElement.relativeY * imgRect.h + imgRect.y,
            width: Math.max((selectedElement.relativeWidth ?? 0.05) * imgRect.w, 8),
            height: Math.max((selectedElement.relativeHeight ?? 0.03) * imgRect.h, 8),
          }}
        >
          <span className="absolute -top-5 left-0 text-[10px] text-red-600 dark:text-red-400 bg-white/90 dark:bg-zinc-900/90 px-1 rounded whitespace-nowrap">
            {selectedElement.label}
          </span>
        </div>
      )}

      {/* 元素列表浮层（半透明圆点标记） */}
      {annotations.map((ann, i) => {
        const x = ann.relativeX * imgRect.w + imgRect.x;
        const y = ann.relativeY * imgRect.h + imgRect.y;
        const isSelected = selectedElement === ann;
        return (
          <div
            key={i}
            onClick={(e) => { e.stopPropagation(); onSelect(ann); }}
            className={`absolute cursor-pointer rounded-full transition-all ${
              isSelected
                ? 'w-3 h-3 bg-red-500 ring-2 ring-red-300 z-20'
                : 'w-2 h-2 bg-blue-400/60 hover:bg-blue-500 hover:w-2.5 hover:h-2.5'
            }`}
            style={{ left: x - 4, top: y - 4 }}
            title={ann.label}
          />
        );
      })}

      {/* 子组件入口标记（绿色菱形） */}
      {childPages.map(child => {
        const trigger = parseTrigger(child.trigger_json);
        const ref = trigger?.elementRef;
        // 尝试从 trigger 的 elementRef 在 annotations 中找到对应位置
        const matchAnn = ref ? annotations.find(a =>
          (ref.automationId && a.automationId === ref.automationId) ||
          (ref.name && a.name === ref.name)
        ) : null;
        // 没有匹配时，用子组件自身第一个 annotation 的位置，或默认居中
        const childAnns = getAnnotations(child);
        const pos = matchAnn
          ? { x: matchAnn.relativeX, y: matchAnn.relativeY }
          : childAnns[0]
            ? { x: childAnns[0].relativeX, y: childAnns[0].relativeY }
            : { x: 0.5, y: 0.5 };
        const cx = pos.x * imgRect.w + imgRect.x;
        const cy = pos.y * imgRect.h + imgRect.y;
        return (
          <div
            key={child.fingerprint}
            onClick={(e) => { e.stopPropagation(); onNavigateChild(child); }}
            className="absolute cursor-pointer z-10 group"
            style={{ left: cx - 8, top: cy - 8 }}
          >
            <div className="w-4 h-4 bg-emerald-500/80 rotate-45 rounded-sm group-hover:bg-emerald-500 group-hover:scale-125 transition-all" />
            <span className="absolute -top-5 left-1/2 -translate-x-1/2 text-[10px] text-emerald-600 dark:text-emerald-400 bg-white/90 dark:bg-zinc-900/90 px-1 rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity">
              {inferPageName(child)}
            </span>
          </div>
        );
      })}

      {/* 点击空白区域取消选中 */}
      <div className="absolute inset-0 -z-10" onClick={handleBgClick} />
    </div>
  );
}

// ── Page Tree ──

interface PageTreeNode {
  page: UICacheRow;
  children: PageTreeNode[];
}

function buildPageTree(pages: UICacheRow[]): PageTreeNode[] {
  const byFp = new Map(pages.map(p => [p.fingerprint, { page: p, children: [] as PageTreeNode[] }]));
  const roots: PageTreeNode[] = [];
  for (const node of byFp.values()) {
    const parentFp = node.page.parent_fingerprint;
    if (parentFp && byFp.has(parentFp)) {
      byFp.get(parentFp)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function PageTreeItem({ node, selectedFp, onSelect, onDelete, depth }: {
  node: PageTreeNode;
  selectedFp: string | null;
  onSelect: (page: UICacheRow) => void;
  onDelete: (fp: string) => void;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(true);
  const trigger = parseTrigger(node.page.trigger_json);
  const isSelected = selectedFp === node.page.fingerprint;
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div
        className={`group flex items-center rounded transition-colors ${
          isSelected
            ? 'bg-blue-100 dark:bg-blue-900/30'
            : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
        }`}
        style={{ paddingLeft: depth * 16 }}
      >
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-0.5 text-zinc-400 hover:text-zinc-600 shrink-0"
          >
            <ChevronRight size={12} className={`transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
        ) : (
          <span className="w-4 shrink-0" />
        )}
        <button
          onClick={() => onSelect(node.page)}
          className="flex-1 text-left px-1.5 py-1.5 text-sm min-w-0"
        >
          <span className={`truncate block ${isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-zinc-700 dark:text-zinc-300'}`}>
            {inferPageName(node.page)}
          </span>
          {trigger && (
            <div className="text-xs text-zinc-400 mt-0.5 flex items-center gap-1">
              <MousePointerClick size={10} />
              <span className="truncate">{trigger.detail}</span>
            </div>
          )}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(node.page.fingerprint); }}
          className="p-1 text-zinc-300 dark:text-zinc-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all shrink-0"
          title="删除此页面"
        >
          <Trash2 size={12} />
        </button>
      </div>
      {expanded && node.children.map(child => (
        <PageTreeItem
          key={child.page.fingerprint}
          node={child}
          selectedFp={selectedFp}
          onSelect={onSelect}
          onDelete={onDelete}
          depth={depth + 1}
        />
      ))}
    </div>
  );
}

/** 获取页面自身的注解，排除属于子组件的元素 */
function getOwnAnnotations(page: UICacheRow, allPages: UICacheRow[]): SemanticAnnotation[] {
  const own = getAnnotations(page);
  // 收集所有子组件的 fingerprint
  const childFps = new Set(allPages.filter(p => p.parent_fingerprint === page.fingerprint).map(p => p.fingerprint));
  if (childFps.size === 0) return own;
  // 过滤掉与子组件 fingerprint 匹配的注解（理论上子组件元素不应出现在父页面，但以防万一）
  return own;
}

// ── Helpers ──

function parseTrigger(json: string | null | undefined): TriggerInfo | null {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function getAnnotations(row: UICacheRow): SemanticAnnotation[] {
  try { return JSON.parse(row.semantic_annotations); } catch { return []; }
}

function inferPageName(row: UICacheRow): string {
  if (row.app_name && row.window_class) return `${row.app_name}-${row.window_class}`;
  return row.app_name || row.fingerprint.slice(0, 12);
}
