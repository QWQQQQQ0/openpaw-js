// Screen change event source — encapsulates all screen-specific detection logic.
// Extracted from WatcherInstance to decouple from the scheduling layer.

import type { ScreenChangeTriggerConfig } from '@/types/scheduler';
import type { DiffResult, ScreenRegion, WatchProfile } from '@/types/watcher';
import { captureRegion, resolveCaptureRegion } from '@/services/watcher/region-capture';
import { getDetector } from '@/services/watcher/diff-detector';
import { discoverRegions } from '@/services/watcher/region-discovery';
import { getStepCache, storeStepCache } from '@/services/cache-service';
import { RegionQualityTracker } from '@/services/watcher/region-quality';
import { buildPreparationGoal } from '@/services/watcher/watcher-utils';

export interface ScreenChangeEvent {
  confidence: number;
  diffDetail?: string;
  diffBbox?: { x: number; y: number; width: number; height: number };
  baseline: string;
  current: string;
  diff: DiffResult;
}

export class ScreenChangeEventSource {
  private config: ScreenChangeTriggerConfig;
  private taskName: string;
  private actionType: string;
  private detector: ReturnType<typeof getDetector>;
  private qualityTracker: RegionQualityTracker | null = null;
  private watchProfile: WatchProfile | null = null;
  private watchBboxes: Map<string, ScreenRegion> = new Map();
  private currentCandidateIndex = 0;
  private _resolvedRegion: ScreenRegion | null = null;
  private baseline = '';
  private toolFilter?: Set<string>;
  private _disposed = false;
  private _onRegionResolved: ((region: ScreenRegion, monitorTarget?: import('@/types/watcher').MonitorTarget) => void) | null = null;

  /** 运行时状态（由 Task 创建并共享，集中管理 hwnd 等动态值） */
  readonly runtime: import('./watcher-runtime-state').WatcherRuntimeState;

  /** 获取窗口模式下的 hwnd（非窗口模式返回 0） */
  private getTargetHwnd(): number {
    return this.runtime.hwnd;
  }

  private emitFn: ((type: string, level: string, message: string, data?: Record<string, unknown>) => void) | null = null;

  constructor(taskName: string, config: ScreenChangeTriggerConfig, runtime: import('./watcher-runtime-state').WatcherRuntimeState, actionType?: string, toolFilter?: Set<string>) {
    this.taskName = taskName;
    this.config = config;
    this.runtime = runtime;
    this.actionType = actionType ?? 'custom';
    this.detector = getDetector(config.diffStrategy);
    this.toolFilter = toolFilter;
  }

  setEmitter(emit: (type: string, level: string, message: string, data?: Record<string, unknown>) => void): void {
    this.emitFn = emit;
  }

  /** 设置 region 解析完成后的回调（用于持久化） */
  setOnRegionResolved(cb: (region: ScreenRegion, monitorTarget?: import('@/types/watcher').MonitorTarget) => void): void {
    this._onRegionResolved = cb;
  }

  /** 手动触发区域重新定位（清除缓存坐标，重新走自动解析流程） */
  async reResolveRegion(): Promise<ScreenRegion> {
    this.emit('re_resolve_start', 'info', '正在重新定位监控区域...');

    // 确保 hwnd 有效（集中管理，自动补全 appName + hwnd）
    await this.runtime.ensureHwnd();
    // 同步 runtime hwnd 到 config
    if (this.runtime.hwnd > 0) {
      this.config.monitorTarget.windowHwnd = this.runtime.hwnd;
    }

    let effectiveFullRegion = await resolveCaptureRegion(this.config.monitorTarget, { x: 0, y: 0, width: 0, height: 0 });

    // 窗口未找到（hwnd 无效或窗口已关闭）→ 尝试打开应用
    if (effectiveFullRegion.width === 0 || effectiveFullRegion.height === 0) {
      const hwnd = await this.tryPrepareApp();
      if (hwnd > 0) this.runtime.setHwnd(hwnd);
      effectiveFullRegion = await resolveCaptureRegion(this.config.monitorTarget, { x: 0, y: 0, width: 0, height: 0 });
      if (effectiveFullRegion.width === 0 || effectiveFullRegion.height === 0) {
        this.emit('re_resolve_fail', 'error', '无法找到目标窗口，请确保应用已打开');
        throw new Error('无法找到目标窗口');
      }
    }

    const newRegion = await this.resolveAutoRegion(effectiveFullRegion, true); // 跳过缓存，强制 LLM 重新解析

    const newRelativeRegion = {
      x: newRegion.x - effectiveFullRegion.x,
      y: newRegion.y - effectiveFullRegion.y,
      width: newRegion.width,
      height: newRegion.height,
    };
    this.config.region = newRelativeRegion;
    this._resolvedRegion = newRegion;

    this.baseline = await captureRegion(newRegion, this.getTargetHwnd(), this.config.region);

    // 持久化 region + monitorTarget（appName 可能已被 backfillWindowInfo 补全）
    this._onRegionResolved?.(this.config.region, this.config.monitorTarget);

    this.emit('re_resolve_done', 'info', `重新定位完成: ${newRegion.width}x${newRegion.height}`, {
      region: this.config.region,
    });
    return newRegion;
  }

  private emit(type: string, level: string, message: string, data?: Record<string, unknown>): void {
    this.emitFn?.(type, level, message, data);
  }

  /** Resolve the capture region (manual or auto). Call once during start(). */
  async resolveRegion(): Promise<ScreenRegion> {
    let region: ScreenRegion;

    if (this.config.regionMode === 'auto' && this.config.regionDescription) {
      // 确保 hwnd 有效（集中管理，自动补全 appName + hwnd）
      await this.runtime.ensureHwnd();
      // 同步 runtime hwnd 到 config（ensureHwnd 可能解析了新 hwnd）
      if (this.runtime.hwnd > 0) {
        this.config.monitorTarget.windowHwnd = this.runtime.hwnd;
      }

      // 检查是否已有有效的缓存 region（上次解析结果已持久化到 config）
      // 必须有有效的 windowHwnd，否则相对坐标无法转绝对坐标
      const savedRegion = this.config.region;
      const hasValidHwnd = this.runtime.hwnd > 0;
      if (savedRegion && savedRegion.width > 0 && savedRegion.height > 0 && hasValidHwnd) {
        region = await resolveCaptureRegion(this.config.monitorTarget, savedRegion);
        if (region.width > 0 && region.height > 0) {
          // 校验：截图检查是否全黑
          try {
            const testCapture = await captureRegion(region, this.getTargetHwnd(), savedRegion);
            if (!this.isImageBlack(testCapture)) {
              this._resolvedRegion = region;
              this.baseline = await captureRegion(region, this.getTargetHwnd(), savedRegion);
              this.qualityTracker = new RegionQualityTracker({
                useOcr: this.config.diffStrategy !== 'fast_visual',
              });
              return region;
            }
          } catch { /* ignore */ }
        }
      }

      let fullRegion = await resolveCaptureRegion(this.config.monitorTarget, { x: 0, y: 0, width: 0, height: 0 });

      // If window not found (0x0), try to prepare (open) the app first
      if (fullRegion.width === 0 || fullRegion.height === 0) {
        const hwnd = await this.tryPrepareApp();
        if (hwnd > 0) {
          this.runtime.setHwnd(hwnd);
          fullRegion = await resolveCaptureRegion(this.config.monitorTarget, { x: 0, y: 0, width: 0, height: 0 });
        }
      }

      region = await this.resolveAutoRegion(fullRegion);
      this.qualityTracker = new RegionQualityTracker({
        useOcr: this.config.diffStrategy !== 'fast_visual',
      });
      // 持久化解析后的 region + monitorTarget
      this._onRegionResolved?.(this.config.region, this.config.monitorTarget);
    } else {
      region = await resolveCaptureRegion(this.config.monitorTarget, this.config.region);
    }

    this._resolvedRegion = region;
    console.log(`[screen-change-source] "${this.taskName}" [resolveRegion-baseline] 即将截图: absRegion=(${region.x},${region.y},${region.width}x${region.height}), hwnd=${this.getTargetHwnd()}, windowRegion=${JSON.stringify(this.config.region)}`);
    this.baseline = await captureRegion(region, this.getTargetHwnd(), this.config.region);
    return region;
  }

  /** Perform one capture+diff cycle. Returns event if a significant change detected, null otherwise. */
  async check(): Promise<ScreenChangeEvent | null> {
    if (this._disposed) return null;
    if (!this._resolvedRegion) throw new Error('ScreenChangeEventSource not initialized — call resolveRegion() first');

    // 同步 runtime hwnd 到 config（runtime 可能在 resolveRegion/ensureHwnd 中更新了 hwnd）
    if (this.runtime.hwnd > 0 && this.config.monitorTarget.windowHwnd !== this.runtime.hwnd) {
      this.config.monitorTarget.windowHwnd = this.runtime.hwnd;
    }

    const captureConfig = await resolveCaptureRegion(this.config.monitorTarget, this.config.region);

    // 窗口已失效（hwnd 无效）→ 重新定位
    if (captureConfig.width === 0 || captureConfig.height === 0) {
      this.emit('region_invalid', 'warn', '窗口已失效，重新定位');
      const hwnd = await this.tryPrepareApp();
      if (hwnd > 0) this.runtime.setHwnd(hwnd);
      const fullRegion = await resolveCaptureRegion(this.config.monitorTarget, { x: 0, y: 0, width: 0, height: 0 });
      const newRegion = await this.resolveAutoRegion(fullRegion);
      this.config.region = { x: newRegion.x - fullRegion.x, y: newRegion.y - fullRegion.y, width: newRegion.width, height: newRegion.height };
      this.baseline = await captureRegion(newRegion, this.getTargetHwnd(), this.config.region);
      return null;
    }

    const current = await captureRegion(captureConfig, this.getTargetHwnd(), this.config.region);

    // 截图全黑 → 坐标可能过期（窗口移动/缩放），触发区域重新定位
    if (this.isImageBlack(current)) {
      console.warn(`[screen-change-source] "${this.taskName}" check: 截图全黑，触发区域重新定位`);
      this.emit('region_invalid', 'warn', '截图全黑，重新定位区域');
      const fullRegion = await resolveCaptureRegion(this.config.monitorTarget, { x: 0, y: 0, width: 0, height: 0 });
      const newRegion = await this.resolveAutoRegion(fullRegion);
      this.config.region = { x: newRegion.x - fullRegion.x, y: newRegion.y - fullRegion.y, width: newRegion.width, height: newRegion.height };
      this.baseline = await captureRegion(newRegion, this.getTargetHwnd(), this.config.region);
      return null;
    }

    const diff = await this.detector.detect(this.baseline, current);

    this.emit('tick', 'info', `changed=${diff.changed}`, {
      baseline: this.baseline,
      current,
      changed: diff.changed,
      diffBbox: diff.diffBbox,
    });

    // Quality tracking (auto mode)
    if (this.qualityTracker) {
      this.qualityTracker.recordTick({
        changed: diff.changed,
        confidence: diff.confidence,
        ocrSuccess: this.inferOcrSuccess(diff),
        visualChangeRatio: diff.rawVisualDiff?.visual_change_ratio ?? 0,
        jitter: diff.changed && (diff.rawVisualDiff?.visual_change_ratio ?? 0) < 0.005 && diff.confidence < (this.config.minConfidence ?? 0.9),
        hasDiffBbox: !!diff.diffBbox,
      });

      if (this.qualityTracker.shouldEvaluate()) {
        const evalResult = this.qualityTracker.evaluate();
        this.emit('quality_evaluated', evalResult.metrics.qualityScore < 0.30 ? 'warn' : 'info',
          `Quality: ${(evalResult.metrics.qualityScore * 100).toFixed(0)}%`, { metrics: evalResult.metrics });

        if (evalResult.shouldReresolve) {
          await this.handleQualityFailure(evalResult.critical);
          this.baseline = current;
          return null;
        }
      }
    }

    if (!diff.changed) {
      this.emit('diff_unchanged', 'info', '无变化', { baseline: this.baseline, current });
      this.baseline = current;
      return null;
    }

    const minConf = this.config.minConfidence ?? 0.9;
    if (diff.confidence < minConf) {
      this.emit('low_confidence', 'info',
        `低置信度变化 (${(diff.confidence * 100).toFixed(0)}% < ${(minConf * 100).toFixed(0)}%)`,
        { confidence: diff.confidence, minConfidence: minConf, diffDetail: diff.diffDetail },
      );
      this.baseline = current;
      return null;
    }

    this.emit('diff_detected', 'info', diff.diffDetail ?? '检测到变化', {
      confidence: diff.confidence, diffDetail: diff.diffDetail, diffBbox: diff.diffBbox,
      baseline: this.baseline, current,
    });

    // Update baseline after detection
    this.baseline = current;

    return { confidence: diff.confidence, diffDetail: diff.diffDetail, diffBbox: diff.diffBbox, baseline: this.baseline, current, diff };
  }

  updateConfig(config: ScreenChangeTriggerConfig): void {
    this.config = config;
    this.detector = getDetector(config.diffStrategy);
  }

  dispose(): void {
    this._disposed = true;
    this.runtime.dispose();
    this.qualityTracker?.reset();
    this.qualityTracker = null;
  }

  /** 是否已释放 */
  get disposed(): boolean { return this._disposed; }

  // ── Auto region resolution pipeline (extracted from WatcherInstance) ──

  /**
   * 通过 appName 从 L1 ui_cache 获取已有的语义信息，格式化为 LLM 可读文本。
   * 不依赖 hwnd，直接用稳定的 appName 查询。
   */
  private async getCachedSemanticContext(appName: string): Promise<string> {
    if (!appName || appName === 'unknown') return '';
    try {
      const { getCacheService } = await import('@/services/cache-service-singleton');
      const rows = await getCacheService().getAppPageGraph(appName);
      if (!rows || rows.length === 0) {
        return '';
      }

      const allNodes: import('@/types/cache').InteractiveNode[] = [];
      const allAnnotations: import('@/types/cache').SemanticAnnotation[] = [];
      const seenNodeKeys = new Set<string>();
      const seenAnnotationKeys = new Set<string>();

      for (const row of rows) {
        try {
          const nodes = JSON.parse(row.interactive_nodes) as import('@/types/cache').InteractiveNode[];
          for (const n of nodes) {
            const key = `${n.role}|${n.name}`;
            if (!seenNodeKeys.has(key)) { seenNodeKeys.add(key); allNodes.push(n); }
          }
        } catch { /* skip */ }
        try {
          const annotations = JSON.parse(row.semantic_annotations) as import('@/types/cache').SemanticAnnotation[];
          for (const a of annotations) {
            const key = `${a.label}|${a.role}`;
            if (!seenAnnotationKeys.has(key)) { seenAnnotationKeys.add(key); allAnnotations.push(a); }
          }
        } catch { /* skip */ }
      }

      if (allNodes.length === 0 && allAnnotations.length === 0) return '';

      const parts: string[] = [];
      if (allNodes.length > 0) {
        parts.push('## 已知 UI 元素（UIA 节点）');
        for (const n of allNodes.slice(0, 50)) {
          const bounds = n.bounds ? `bounds={x:${n.bounds.left},y:${n.bounds.top},w:${n.bounds.width},h:${n.bounds.height}}` : 'bounds=null';
          parts.push(`- role="${n.role}", name="${n.name}", ${bounds}`);
        }
        if (allNodes.length > 50) parts.push(`- ...（还有 ${allNodes.length - 50} 个元素）`);
      }
      if (allAnnotations.length > 0) {
        parts.push('## 已知语义区域（视觉标注）');
        for (const a of allAnnotations.slice(0, 50)) {
          const coords = a.relativeWidth != null && a.relativeHeight != null
            ? `相对坐标=(${(a.relativeX * 100).toFixed(1)}%,${(a.relativeY * 100).toFixed(1)}%,${(a.relativeWidth * 100).toFixed(1)}%,${(a.relativeHeight * 100).toFixed(1)}%)`
            : `相对位置=(${(a.relativeX * 100).toFixed(1)}%,${(a.relativeY * 100).toFixed(1)}%)`;
          parts.push(`- label="${a.label}", description="${a.description}", keywords=[${a.keywords.join(',')}], type="${a.type ?? 'unknown'}", ${coords}`);
        }
        if (allAnnotations.length > 50) parts.push(`- ...（还有 ${allAnnotations.length - 50} 个区域）`);
      }

      const result = parts.join('\n');
      return result;
    } catch {
      return '';
    }
  }

  private async resolveAutoRegion(fullRegion: ScreenRegion, skipCache = false): Promise<ScreenRegion> {
    // appName 优先用 windowTitle（L1 缓存以此为 key，desktop_open_app 也用显示名），
    // fallback 到 appName（exe 名，如 "WeChat.exe"），最后用首词
    const appName = this.config.monitorTarget?.appName
      ?? this.config.monitorTarget?.windowTitle
      ?? 'unknown';
    let windowHwnd = this.config.monitorTarget?.windowHwnd ?? 0;
    let currentFullRegion = fullRegion;
    // 提前获取 L1 语义上下文（通过 appName 查询，不依赖 hwnd）
    let cachedSemanticContext = await this.getCachedSemanticContext(appName);

    // ② step_cache（重新定位时跳过，强制走 LLM 重新解析）
    const cached = skipCache ? null : await getStepCache(`watch:${this.config.regionDescription}`, undefined, appName).catch(() => null);
    if (cached?.bounds) {
      const b = cached.bounds;
      let localX: number, localY: number, localW: number, localH: number;

      if (cached.role === 'region_ratio') {
        // 新格式：bounds 存的是 0~1 归一化比例，按当前窗口尺寸还原像素
        localX = Math.round(b.left * fullRegion.width);
        localY = Math.round(b.top * fullRegion.height);
        localW = Math.round((b.right - b.left) * fullRegion.width);
        localH = Math.round((b.bottom - b.top) * fullRegion.height);
      } else {
        // 旧格式：bounds 存的是像素坐标（窗口可能已缩放，会有偏差）
        localX = b.left; localY = b.top;
        localW = b.right - b.left; localH = b.bottom - b.top;
      }

      if (localW > 0 && localH > 0) {
        const cachedRegion = { x: fullRegion.x + localX, y: fullRegion.y + localY, width: localW, height: localH };
        // 校验缓存：截图检查是否全黑（坐标可能已过期）
        try {
          const testCapture = await captureRegion(cachedRegion, this.getTargetHwnd(), this.config.region);
          if (this.isImageBlack(testCapture)) {
            // 全黑，跳过缓存
          } else {
            this.config.region = { x: localX, y: localY, width: localW, height: localH };
            this.watchProfile = null;
            return cachedRegion;
          }
        } catch (e) {
          console.warn(`[screen-change-source] "${this.taskName}" ② step_cache 校验截图失败:`, e);
        }
      }
    }

    // UIA + Vision
    const { ensureInteractiveNodes } = await import('@/services/agent/agent-cache');
    const { getCacheService } = await import('@/services/cache-service-singleton');
    const { getModelService } = await import('@/services/model-service-singleton');
    const { useModelConfigStore } = await import('@/stores/model-config-store');
    const { getBuiltinExecutor } = await import('@/skills/builtin-executor');

    let provider: import('@/types/provider').ProviderConfig | undefined;
    let apiKey: string | undefined;
    try {
      const modelStore = useModelConfigStore.getState();
      if (modelStore.providers.length === 0) await modelStore.load();
      provider = modelStore.defaultConfig() ?? undefined;
      if (provider) apiKey = await modelStore.getApiKey(provider.id, '') ?? undefined;
    } catch { /* ok */ }

    const deps = {
      skillExecutor: getBuiltinExecutor() as unknown as import('@/interfaces/skill-executor').ISkillExecutor,
      modelService: getModelService(),
      cacheService: getCacheService(),
    };

    // 跳过首次 ensureInteractiveNodes，等 tryPrepareApp 确保窗口就绪后再调用
    // 避免窗口未聚焦时截到屏幕左上角脏数据污染 L1 缓存
    let nodeResult: Awaited<ReturnType<typeof ensureInteractiveNodes>> = null;
    let nodes: import('@/types/cache').InteractiveNode[] = [];
    let annotations: import('@/types/cache').SemanticAnnotation[] = [];

    // ②.5 ongoing task, 尝试 app preparation
    const prepHwnd = await this.tryPrepareApp();
    if (prepHwnd > 0) {
      this.runtime.setHwnd(prepHwnd);
      this.config.monitorTarget.windowHwnd = prepHwnd;
      windowHwnd = prepHwnd;

      currentFullRegion = await resolveCaptureRegion(this.config.monitorTarget, { x: 0, y: 0, width: 0, height: 0 });

      // 窗口就绪后再获取 L1 数据
      nodeResult = await ensureInteractiveNodes(deps, windowHwnd, provider, apiKey);
      nodes = nodeResult?.nodes ?? [];
      annotations = nodeResult?.annotations ?? [];

      // ensureInteractiveNodes 的 vision fallback 可能写入了新的 ui_cache 数据，
      // 之前 getCachedSemanticContext 查时还没有，现在重新查一次
      if (!cachedSemanticContext && annotations.length > 0) {
        cachedSemanticContext = await this.getCachedSemanticContext(appName);
      }
    }

    // ① UIA local match（skipCache 时跳过，强制走 LLM）
    if (!skipCache && nodes.length > 0) {
      const localMatch = this.resolveRegionFromUIA(nodes as unknown as unknown[], this.config.regionDescription!);
      if (localMatch) {
        // resolveRegionFromUIA 返回 UIA 屏幕绝对坐标，转为窗口相对坐标存缓存
        const relX = localMatch.x - fullRegion.x, relY = localMatch.y - fullRegion.y;
        this.config.region = { x: relX, y: relY, width: localMatch.width, height: localMatch.height };
        this.watchProfile = null;
        try {
          await storeStepCache({
            goalFragment: `watch:${this.config.regionDescription}`, role: 'region_ratio',
            name: this.config.regionDescription!,
            bounds: {
              left: relX / fullRegion.width, top: relY / fullRegion.height,
              right: (relX + localMatch.width) / fullRegion.width, bottom: (relY + localMatch.height) / fullRegion.height,
            },
            appName,
          });
        } catch { /* non-fatal */ }
        return { x: localMatch.x, y: localMatch.y, width: localMatch.width, height: localMatch.height };
      }
    }

    // ①.5 vision annotations（skipCache 时跳过，强制走 LLM）
    if (!skipCache && annotations.length > 0) {
      const desc = this.config.regionDescription!.toLowerCase();
      const descWords = desc.split(/[\s,，、:：\-_]+/).filter(w => w.length > 0);
      const match = annotations.find(a => {
        const labelLower = a.label.toLowerCase();
        if (descWords.some(w => labelLower.includes(w))) return true;
        return a.keywords.some(kw => descWords.some(w => kw.toLowerCase().includes(w)));
      });
      if (match && match.relativeWidth && match.relativeHeight) {
        const resolved: ScreenRegion = {
          x: fullRegion.x + Math.round(match.relativeX * fullRegion.width),
          y: fullRegion.y + Math.round(match.relativeY * fullRegion.height),
          width: Math.round(match.relativeWidth * fullRegion.width),
          height: Math.round(match.relativeHeight * fullRegion.height),
        };
        this.config.region = { x: resolved.x - fullRegion.x, y: resolved.y - fullRegion.y, width: resolved.width, height: resolved.height };
        this.watchProfile = null;
        return resolved;
      }
    }

    const fullWinRegion: ScreenRegion = { x: 0, y: 0, width: 0, height: 0 };
    console.log(`[screen-change-source] "${this.taskName}" [resolveAuto-截图] 全窗口截图: absRegion=(${currentFullRegion.x},${currentFullRegion.y},${currentFullRegion.width}x${currentFullRegion.height}), hwnd=${this.getTargetHwnd()}, windowRegion=(0,0,0x0)`);
    let fullScreenshot = await captureRegion(currentFullRegion, this.getTargetHwnd(), fullWinRegion);
    console.log(`[screen-change-source] "${this.taskName}" [resolveAuto-截图] 全窗口截图完成: 大小=${fullScreenshot.length} bytes`);

    // preparation 和 ensureInteractiveNodes 已在前面完成
    // UIA/vision 匹配也已在前面尝试过，直接进入 discoverRegions

    // ③ discoverRegions (LLM + UIA/L1缓存)
    const uiaTree = nodes.length > 0 ? { nodes } : null;
    const hasSemanticContext = !!cachedSemanticContext;
    if (uiaTree || hasSemanticContext) {
      try {
        const { watchProfile, bboxes, cacheHit } = await discoverRegions({
          screenshot: fullScreenshot, uiaTree, appName, taskDescription: this.config.regionDescription!, cachedSemanticContext, skipCache,
        });
        this.watchProfile = watchProfile;
        this.watchBboxes = bboxes;
        this.currentCandidateIndex = 0;
        const primaryTarget = watchProfile.watch_targets[0];
        if (primaryTarget && bboxes.has(primaryTarget.semantic)) {
          const bbox = bboxes.get(primaryTarget.semantic)!;
          this.config.region = { x: bbox.x, y: bbox.y, width: bbox.width, height: bbox.height };
          try {
            await storeStepCache({
              goalFragment: `watch:${this.config.regionDescription}`, role: 'region_ratio',
              name: this.config.regionDescription!,
              bounds: {
                left: bbox.x / currentFullRegion.width, top: bbox.y / currentFullRegion.height,
                right: (bbox.x + bbox.width) / currentFullRegion.width, bottom: (bbox.y + bbox.height) / currentFullRegion.height,
              },
              appName,
            });
          } catch { /* non-fatal */ }
          return { x: currentFullRegion.x + bbox.x, y: currentFullRegion.y + bbox.y, width: bbox.width, height: bbox.height };
        }
      } catch { /* ignore */ }
    }

    // ③.5 OCR + LLM semantic selection (no UIA needed, precise coordinates)
    console.log(`[screen-change-source] "${this.taskName}" ③.5 尝试 OCR+LLM 语义定位`);
    try {
      const { discoverRegionFromOCR } = await import('@/services/watcher/region-from-ocr');
      const ocrRegion = await discoverRegionFromOCR({
        screenshot: fullScreenshot,
        regionDescription: this.config.regionDescription!,
        appName,
      });
      if (ocrRegion) {
        // OCR ran on window screenshot → coords are window-relative (not screen-absolute)
        this.config.region = { x: ocrRegion.x, y: ocrRegion.y, width: ocrRegion.width, height: ocrRegion.height };
        this.watchProfile = null;
        try {
          await storeStepCache({
            goalFragment: `watch:${this.config.regionDescription}`, role: 'region_ratio',
            name: this.config.regionDescription!,
            bounds: {
              left: ocrRegion.x / currentFullRegion.width, top: ocrRegion.y / currentFullRegion.height,
              right: (ocrRegion.x + ocrRegion.width) / currentFullRegion.width, bottom: (ocrRegion.y + ocrRegion.height) / currentFullRegion.height,
            },
            appName,
          });
        } catch { /* non-fatal */ }
        const screenRegion = { x: currentFullRegion.x + ocrRegion.x, y: currentFullRegion.y + ocrRegion.y, width: ocrRegion.width, height: ocrRegion.height };
        console.log(`[screen-change-source] "${this.taskName}" ③.5 OCR+LLM 命中: rel=(${ocrRegion.x},${ocrRegion.y}) screen=(${screenRegion.x},${screenRegion.y}) w=${screenRegion.width}, h=${screenRegion.height}`);
        return screenRegion;
      }
      console.log(`[screen-change-source] "${this.taskName}" ③.5 OCR+LLM 未命中`);
    } catch (e) {
      console.warn(`[screen-change-source] "${this.taskName}" ③.5 OCR+LLM 异常:`, e);
    }

    // ④ Fallback LLM bbox（截图 + L1 语义信息）
    console.log(`[screen-change-source] "${this.taskName}" ④ 使用 fallback LLM bbox 检测`);
    return this.resolveAutoRegionFallback(currentFullRegion, fullScreenshot, cachedSemanticContext);
  }

  private resolveRegionFromUIA(nodes: unknown[], description: string): ScreenRegion | null {
    const keywords = description.toLowerCase().split(/[\s,，、:：\-_]+/).filter(k => k.length > 0);
    const search = (nodeList: unknown[]): ScreenRegion | null => {
      for (const node of nodeList) {
        const n = node as Record<string, unknown>;
        const role = String(n.role ?? n.controlType ?? n.ControlType ?? '').toLowerCase();
        const name = String(n.name ?? n.Name ?? '').toLowerCase();
        if (keywords.some(kw => role.includes(kw) || name.includes(kw)) && n.bounds) {
          const b = n.bounds as Record<string, number>;
          const x = b.x ?? b.left ?? 0, y = b.y ?? b.top ?? 0;
          const w = b.width ?? ((b.right ?? 0) - (b.left ?? 0));
          const h = b.height ?? ((b.bottom ?? 0) - (b.top ?? 0));
          if (w > 0 && h > 0) return { x, y, width: w, height: h };
        }
        const children = (n.children ?? n.Children ?? []) as unknown[];
        if (children.length > 0) { const found = search(children); if (found) return found; }
      }
      return null;
    };
    return search(nodes);
  }

  private async resolveAutoRegionFallback(fullRegion: ScreenRegion, fullScreenshot: string, cachedSemanticContext?: string): Promise<ScreenRegion> {
    const { ModelScenario } = await import('@/services/llm-gateway/gateway');
    const { getModelService } = await import('@/services/model-service-singleton');
    const { useModelConfigStore } = await import('@/stores/model-config-store');
    const { compressImage } = await import('@/utils/image');
    const { invoke } = await import('@tauri-apps/api/core');

    const modelStore = useModelConfigStore.getState();
    if (modelStore.providers.length === 0) await modelStore.load();
    const provider = modelStore.defaultConfig();
    if (!provider) throw new Error('No default model provider for auto region');
    const apiKey = await modelStore.getApiKey(provider.id, '');
    if (!apiKey) throw new Error('No API key for auto region');

    // When app window is available, capture just the window instead of full screen
    const windowHwnd = this.config.monitorTarget?.windowHwnd ?? 0;
    let screenshotForLlm = fullScreenshot;
    let windowBounds: { x: number; y: number; width: number; height: number } | null = null;
    if (windowHwnd) {
      try {
        windowBounds = await invoke<{ x: number; y: number; width: number; height: number }>('get_window_bounds', { hwnd: windowHwnd });
        if (windowBounds.width > 0 && windowBounds.height > 0) {
          screenshotForLlm = await invoke<string>('capture_region', {
            x: windowBounds.x, y: windowBounds.y, width: windowBounds.width, height: windowBounds.height,
          });
          console.log(`[screen-change-source] "${this.taskName}" ④ fallback 使用应用窗口截图 (${windowBounds.width}x${windowBounds.height}) 而非全屏 (${fullRegion.width}x${fullRegion.height})`);
        } else {
          windowBounds = null;
        }
      } catch (e) {
        console.warn(`[screen-change-source] "${this.taskName}" ④ 应用窗口截图失败, 回退到全屏:`, e);
        windowBounds = null;
      }
    } else {
      console.log(`[screen-change-source] "${this.taskName}" ④ 无 windowHwnd, 使用全屏截图`);
    }

    const compressed = await compressImage(screenshotForLlm);
    console.log(`[screen-change-source] "${this.taskName}" ④ fallback LLM 请求: 截图尺寸=${compressed.originalWidth}x${compressed.originalHeight}, compressed=${compressed.dataUrl.length} chars`);

    const messages = [{
      role: 'user' as const,
      content: [
        { type: 'image_url' as const, image_url: { url: compressed.dataUrl } },
        { type: 'text' as const, text: `This is a screenshot (original: ${compressed.originalWidth}x${compressed.originalHeight}).\nI need to monitor: "${this.config.regionDescription}"\n${cachedSemanticContext ? `\n已知 UI 元素（来自之前的 UIA 分析）：\n${cachedSemanticContext}\n\n请优先参考以上元素信息定位目标区域，截图仅作辅助验证。如果以上元素中有与监控目标匹配的区域，直接使用其坐标信息。\n` : ''}返回包含新内容能够显示区域的最小范围，不要让可能影响检测内容稳定性其他内容显示在图片范围中. . Respond ONLY with JSON:\n{"x": <left>, "y": <top>, "width": <width>, "height": <height>}\nAll values in pixels relative to the original dimensions. Return full image bounds if unsure.` },
      ],
    }];

    const modelService = getModelService();
    let responseText = '';
    const stream = modelService.chatStream({ scenario: ModelScenario.watcher, messages, provider, apiKey });
    for await (const chunk of stream) {
      if (chunk.startsWith('__ERROR__:')) throw new Error(chunk);
      if (chunk.startsWith('__REASONING__:')) continue;
      responseText += chunk;
    }
    console.log(`[screen-change-source] "${this.taskName}" ④ fallback LLM 响应: ${responseText.substring(0, 200)}`);

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[screen-change-source] "${this.taskName}" ④ fallback LLM 未返回 JSON, 使用全窗口作为 fallback`);
      return fullRegion;
    }
    let parsed: Record<string, number>;
    try {
      parsed = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn(`[screen-change-source] "${this.taskName}" ④ fallback LLM 返回的 JSON 无效: "${jsonMatch[0].substring(0, 100)}", 使用全窗口作为 fallback`);
      return fullRegion;
    }

    let resolved: ScreenRegion;
    if (windowBounds) {
      // Coordinates from LLM are relative to the window screenshot
      resolved = {
        x: windowBounds.x + Math.round(parsed.x),
        y: windowBounds.y + Math.round(parsed.y),
        width: Math.round(parsed.width),
        height: Math.round(parsed.height),
      };
      console.log(`[screen-change-source] "${this.taskName}" ④ 窗口坐标转换: LLM返回(${parsed.x},${parsed.y},${parsed.width},${parsed.height}) + 窗口偏移(${windowBounds.x},${windowBounds.y}) → 屏幕(${resolved.x},${resolved.y},${resolved.width},${resolved.height})`);
    } else {
      const scaleX = fullRegion.width / compressed.originalWidth;
      const scaleY = fullRegion.height / compressed.originalHeight;
      resolved = {
        x: fullRegion.x + Math.round(parsed.x * scaleX), y: fullRegion.y + Math.round(parsed.y * scaleY),
        width: Math.round(parsed.width * scaleX), height: Math.round(parsed.height * scaleY),
      };
      console.log(`[screen-change-source] "${this.taskName}" ④ 全屏坐标转换: LLM返回(${parsed.x},${parsed.y}) scale=(${scaleX.toFixed(2)},${scaleY.toFixed(2)}) → 屏幕(${resolved.x},${resolved.y},${resolved.width},${resolved.height})`);
    }
    this.config.region = { x: resolved.x - fullRegion.x, y: resolved.y - fullRegion.y, width: resolved.width, height: resolved.height };
    const appName = this.config.monitorTarget?.windowTitle?.split(/[\s\-_]/)[0] ?? 'unknown';
    try {
      const r = this.config.region;
      await storeStepCache({
        goalFragment: `watch:${this.config.regionDescription}`, role: 'region_ratio',
        name: this.config.regionDescription!,
        bounds: {
          left: r.x / fullRegion.width, top: r.y / fullRegion.height,
          right: (r.x + r.width) / fullRegion.width, bottom: (r.y + r.height) / fullRegion.height,
        },
        appName,
      });
    } catch { /* non-fatal */ }

    return resolved;
  }

  private async tryPrepareApp(): Promise<number> {
    const goal = this.config.regionDescription;
    if (!goal) return 0;
    const target = this.config.monitorTarget;
    const windowTitle = target?.type === 'window' ? target.windowTitle : undefined;
    // 优先用 windowTitle 作为应用名（L1 缓存 key、desktop_open_app 参数都是显示名）
    // appName（exe 名如 "WeChat.exe"）仅作 fallback
    const appName = windowTitle ?? (target?.type === 'window' ? target.appName : undefined);

    let skillExecutor: import('@/interfaces/skill-executor').ISkillExecutor | undefined;
    const getExecutor = async () => {
      if (!skillExecutor) {
        const { getBuiltinExecutor } = await import('@/skills/builtin-executor');
        skillExecutor = getBuiltinExecutor() as unknown as import('@/interfaces/skill-executor').ISkillExecutor;
      }
      return skillExecutor;
    };

    // 1. 用 windowTitle 找已有窗口（页面已到位，如"文件管理群"窗口标题）
    if (windowTitle) {
      try {
        const executor = await getExecutor();
        const listResult = await executor.executeToolCall('desktop_list_windows', {});
        const windows = (listResult?.data as Record<string, unknown>)?.['windows'] as Array<Record<string, unknown>> | undefined;
        if (windows) {
          const match = windows.find((w) => {
            const title = String(w['title'] ?? '');
            return title.includes(windowTitle) || windowTitle.includes(title);
          });
          if (match && typeof match['hwnd'] === 'number' && match['hwnd'] > 0) {
            const hwnd = match['hwnd'] as number;
            await executor.executeToolCall('desktop_focus_window', { hwnd });
            return hwnd;
          }
        }
      } catch { /* ignore */ }
    }

    // 2. 用 appName 打开/聚焦应用（如"微信"）
    if (appName) {
      try {
        const executor = await getExecutor();
        const result = await executor.executeToolCall('desktop_open_app', { name: appName });
        const data = result?.data as Record<string, unknown> | undefined;
        const hwnd = Number(data?.['hwnd'] ?? 0);
        if (hwnd > 0) {
          // 应用已打开但可能不在目标页面，需要 LLM 导航
          // 先返回 hwnd 让 resolveCaptureRegion 能获取窗口位置
          // LLM 导航在后续的 resolveAutoRegion 中处理
          return hwnd;
        }
      } catch { /* ignore */ }
    }

    // 3. Fallback: LLM Agent 兜底（处理复杂导航场景）
    const prepGoal = this.config.preparationGoal || buildPreparationGoal(goal, appName);
    console.log(`[screen-change-source] "${this.taskName}" ▶ tryPrepareApp(LLM): "${prepGoal}"`);
    try {
      const { DesktopAutomationAgent } = await import('@/services/desktop-automation-agent');
      const { getCacheService } = await import('@/services/cache-service-singleton');
      const provider = await this.getAgentProvider();
      if (!provider) { return 0; }

      const executor = await getExecutor();
      const agent = new DesktopAutomationAgent(
        executor,
        getCacheService(),
      );
      const result = await agent.executeCommand({
        goal: prepGoal,
        provider: provider.config,
        apiKey: provider.apiKey,
        toolFilter: this.toolFilter,
      });
      if (result && result.length > 0) {
        let hwnd = 0;
        for (const turn of result) {
          for (let i = 0; i < turn.toolCalls.length; i++) {
            const tc = turn.toolCalls[i];
            if (tc.name === 'desktop_open_app') {
              const r = turn.results[i] as unknown as Record<string, unknown>;
              const rData = r?.['data'] as Record<string, unknown> | undefined;
              const resultHwnd = rData?.['hwnd'] ?? r?.['hwnd'];
              if (typeof resultHwnd === 'number' && resultHwnd > 0) {
                hwnd = resultHwnd;
              }
            } else if (tc.name === 'desktop_focus_window') {
              const argHwnd = Number(tc.arguments?.hwnd ?? 0);
              if (argHwnd > 0) hwnd = argHwnd;
            }
          }
        }
        console.log(`[screen-change-source] "${this.taskName}" ✓ tryPrepareApp(LLM) 成功, turns=${result.length}, hwnd=${hwnd}`);
        return hwnd;
      }
      console.log(`[screen-change-source] "${this.taskName}" ✗ tryPrepareApp(LLM) 返回 null`);
      return 0;
    } catch (e) {
      console.warn(`[screen-change-source] "${this.taskName}" ✗ tryPrepareApp(LLM) 异常:`, e);
      return 0;
    }
  }

  private async getAgentProvider(): Promise<{ config: import('@/types/provider').ProviderConfig; apiKey: string } | null> {
    const { useModelConfigStore } = await import('@/stores/model-config-store');
    const modelStore = useModelConfigStore.getState();
    if (modelStore.providers.length === 0) await modelStore.load();
    const provider = modelStore.defaultConfig();
    if (!provider) return null;
    const apiKey = await modelStore.getApiKey(provider.id, '');
    if (!apiKey) return null;
    return { config: provider, apiKey };
  }

  private inferOcrSuccess(diff: DiffResult): boolean {
    if (this.config.diffStrategy === 'fast_visual') return true;
    if (diff.confidence < 0.6 && !diff.diffDetail) return false;
    return true;
  }

  private async handleQualityFailure(critical: boolean): Promise<void> {
    if (this.watchProfile && this.currentCandidateIndex < this.watchProfile.watch_targets.length - 1) {
      this.currentCandidateIndex++;
      const target = this.watchProfile.watch_targets[this.currentCandidateIndex];
      const bbox = this.watchBboxes.get(target.semantic);
      if (bbox) {
        this.config.region = { ...bbox };
        this.qualityTracker?.reset();
        const captureConfig = await resolveCaptureRegion(this.config.monitorTarget, this.config.region);
        this.baseline = await captureRegion(captureConfig, this.getTargetHwnd(), this.config.region);
        this.emit('region_reresolved', 'info', `Switched to candidate: "${target.semantic}"`, { candidateIndex: this.currentCandidateIndex });
        return;
      }
    }
    if (critical || !this.watchProfile) {
      this.watchProfile = null;
      this.watchBboxes = new Map();
      this.currentCandidateIndex = 0;
      this.qualityTracker?.reset();
      const fullRegion = await resolveCaptureRegion(this.config.monitorTarget, { x: 0, y: 0, width: 0, height: 0 });
      const newRegion = await this.resolveAutoRegion(fullRegion);
      this.config.region = { x: newRegion.x - fullRegion.x, y: newRegion.y - fullRegion.y, width: newRegion.width, height: newRegion.height };
      this.baseline = await captureRegion(newRegion, this.getTargetHwnd(), this.config.region);
      this.emit('region_reresolved', 'info', 'Re-ran full region discovery', {});
    }
  }

  /**
   * 检查 BMP data URL 是否全黑（像素全 0）
   * 用于校验缓存坐标是否仍然有效
   */
  private isImageBlack(dataUrl: string): boolean {
    try {
      // data:image/bmp;base64,... → 解码 base64
      const base64 = dataUrl.split(',')[1];
      if (!base64) return true;
      const binary = atob(base64);
      // BMP header: 14 (file) + 40 (DIB) = 54 bytes, then pixel data
      // 采样几个像素点（每像素 3 bytes BGR）
      const headerSize = 54;
      const pixelStart = headerSize;
      const totalPixels = Math.floor((binary.length - pixelStart) / 3);
      if (totalPixels <= 0) return true;
      // 采样 5 个均匀分布的像素
      const sampleCount = Math.min(5, totalPixels);
      for (let i = 0; i < sampleCount; i++) {
        const offset = pixelStart + Math.floor((i * totalPixels) / sampleCount) * 3;
        if (offset + 2 < binary.length) {
          const b = binary.charCodeAt(offset);
          const g = binary.charCodeAt(offset + 1);
          const r = binary.charCodeAt(offset + 2);
          if (b !== 0 || g !== 0 || r !== 0) return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
