/**
 * 通用执行引擎
 *
 * 功能：
 * 1. 执行自动化模板
 * 2. 语义匹配定位元素
 * 3. 循环/条件流程控制
 * 4. 参数替换
 * 5. 执行日志
 */

import type { PlatformAdapter, ElementQuery } from '@/adapters/platform-adapter';
import { adapterRegistry } from '@/adapters/platform-adapter';
import type {
  AutomationTemplate,
  TemplateStep,
  TemplateParameter,
  TemplateExecutionContext,
  LoopContext,
  ExecutionLog,
  TemplateStatus,
} from '@/types/automation-template';
import type { UnifiedElement } from '@/types/unified-element';
import type { ActionTarget, TemplateExpression } from '@/types/unified-action';
import { desktopService } from '@/services/desktop-service';

/**
 * 执行选项
 */
export interface ExecutionOptions {
  dryRun?: boolean;                    // 试运行模式
  verbose?: boolean;                   // 详细日志
  pauseOnError?: boolean;              // 出错时暂停
  stepTimeout?: number;                // 单步超时 (ms)
  onStepStart?: (step: TemplateStep, index: number) => void;
  onStepEnd?: (step: TemplateStep, index: number, success: boolean) => void;
  onError?: (step: TemplateStep, error: Error) => void;
  onStatusChange?: (status: TemplateStatus) => void;
}

/**
 * 通用执行引擎
 */
class UnifiedExecutor {
  private adapters: Map<string, PlatformAdapter> = new Map();
  private currentContext: TemplateExecutionContext | null = null;
  private abortController: AbortController | null = null;

  constructor() {
    // 初始化时获取所有可用的适配器
    this.initializeAdapters();
  }

  private async initializeAdapters(): Promise<void> {
    const adapters = await adapterRegistry.getAvailableAdapters();
    for (const adapter of adapters) {
      this.adapters.set(adapter.platform, adapter);
    }
  }

  // ── 执行控制 ──

  /**
   * 执行模板
   */
  async execute(
    template: AutomationTemplate,
    params: Record<string, unknown> = {},
    options: ExecutionOptions = {},
  ): Promise<TemplateExecutionContext> {
    // 创建执行上下文
    const context: TemplateExecutionContext = {
      template,
      params,
      variables: {},
      currentStepIndex: 0,
      loopStack: [],
      status: 'running',
      startTime: Date.now(),
      logs: [],
    };

    this.currentContext = context;
    this.abortController = new AbortController();

    options.onStatusChange?.('running');

    try {
      // 初始化适配器
      await this.initializeAdapters();

      // 执行步骤
      await this.executeSteps(template.steps, context, options);

      // 完成
      context.status = 'completed';
      context.endTime = Date.now();
      options.onStatusChange?.('completed');

    } catch (error) {
      context.status = 'failed';
      context.endTime = Date.now();
      context.error = error as Error;
      options.onStatusChange?.('failed');

      if (options.onError) {
        options.onError(
          context.template.steps[context.currentStepIndex],
          error as Error,
        );
      }

      if (!options.pauseOnError) {
        throw error;
      }
    } finally {
      this.currentContext = null;
      this.abortController = null;
    }

    return context;
  }

  /**
   * 暂停执行
   */
  pause(): void {
    if (this.currentContext && this.currentContext.status === 'running') {
      this.currentContext.status = 'paused';
    }
  }

  /**
   * 恢复执行
   */
  resume(): void {
    if (this.currentContext && this.currentContext.status === 'paused') {
      this.currentContext.status = 'running';
    }
  }

  /**
   * 取消执行
   */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort();
    }
    if (this.currentContext) {
      this.currentContext.status = 'cancelled';
      this.currentContext.endTime = Date.now();
    }
  }

  // ── 步骤执行 ──

  private async executeSteps(
    steps: TemplateStep[],
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      // 检查取消
      if (this.abortController?.signal.aborted) {
        throw new Error('Execution cancelled');
      }

      // 检查暂停
      while (context.status === 'paused') {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      const step = steps[i];
      context.currentStepIndex = i;

      // 步骤开始回调
      options.onStepStart?.(step, i);

      // 执行步骤
      const startTime = Date.now();
      let success = true;
      let error: string | undefined;

      try {
        await this.executeStep(step, context, options);
      } catch (e) {
        success = false;
        error = (e as Error).message;

        if (options.pauseOnError) {
          context.status = 'paused';
          options.onStatusChange?.('paused');

          // 等待恢复
          while (context.status === 'paused') {
            await new Promise(resolve => setTimeout(resolve, 100));
          }

          if (context.status === 'cancelled') {
            throw new Error('Execution cancelled');
          }
        } else {
          throw e;
        }
      }

      // 记录日志
      const log: ExecutionLog = {
        timestamp: Date.now(),
        stepId: step.id,
        stepIndex: i,
        action: step.action,
        status: success ? 'success' : 'failure',
        message: step.description,
        error,
        duration: Date.now() - startTime,
      };
      context.logs.push(log);

      // 步骤结束回调
      options.onStepEnd?.(step, i, success);
    }
  }

  private async executeStep(
    step: TemplateStep,
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    // 解析参数
    const resolved = this.resolveParams(step, context);

    // 检查条件
    if (resolved.condition && !this.evaluateCondition(resolved.condition, context)) {
      return;
    }

    // 步骤前等待
    if (resolved.waitBefore) {
      await this.sleep(resolved.waitBefore);
    }

    // 执行动作
    switch (resolved.action) {
      case 'click':
      case 'double_click':
      case 'right_click':
        await this.executeClick(resolved, context, options);
        break;

      case 'type':
        await this.executeType(resolved, context, options);
        break;

      case 'key':
      case 'hotkey':
        await this.executeKey(resolved, context, options);
        break;

      case 'copy':
        await this.executeCopy(resolved, context, options);
        break;

      case 'paste':
        await this.executePaste(resolved, context, options);
        break;

      case 'focus':
        await this.executeFocus(resolved, context, options);
        break;

      case 'scroll':
        await this.executeScroll(resolved, context, options);
        break;

      case 'wait':
        await this.executeWait(resolved, context, options);
        break;

      case 'loop_start':
        this.startLoop(resolved, context);
        break;

      case 'loop_end':
        this.endLoop(resolved, context);
        break;

      case 'break':
        this.executeBreak(context);
        break;

      case 'continue':
        this.executeContinue(context);
        break;

      case 'code':
        await this.executeCode(resolved, context, options);
        break;

      case 'drag':
        await this.executeDrag(resolved, context, options);
        break;

      default:
        break;
    }

    // 步骤后等待
    if (resolved.waitAfter) {
      await this.sleep(resolved.waitAfter);
    }
  }

  // ── 参数解析 ──

  private resolveParams(step: TemplateStep, context: TemplateExecutionContext): TemplateStep {
    const resolved = JSON.parse(JSON.stringify(step)) as TemplateStep;

    // 解析 params 中的模板表达式
    if (resolved.params) {
      for (const [key, value] of Object.entries(resolved.params)) {
        if (typeof value === 'string') {
          (resolved.params as Record<string, unknown>)[key] = this.resolveExpression(value, context);
        }
      }
    }

    // 解析 target 中的模板表达式
    if (resolved.target?.semantic?.name) {
      resolved.target.semantic.name = this.resolveExpression(
        resolved.target.semantic.name as string,
        context,
      ) as string;
    }

    // 解析 target 中的坐标表达式
    if (resolved.target?.coordinate) {
      const coord = resolved.target.coordinate;
      if (typeof coord.x === 'string') {
        const resolved_x = this.resolveExpression(coord.x, context);
        coord.x = Number(resolved_x);
      }
      if (typeof coord.y === 'string') {
        const resolved_y = this.resolveExpression(coord.y, context);
        coord.y = Number(resolved_y);
      }
    }

    return resolved;
  }

  private resolveExpression(expr: TemplateExpression, context: TemplateExecutionContext): unknown {
    if (typeof expr !== 'string') return expr;

    // 处理模板表达式 {{xxx}}
    return expr.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
      const trimmedPath = path.trim();
      const value = this.evaluateExpression(trimmedPath, context);
      return value !== undefined ? String(value) : match;
    });
  }

  /**
   * 求值表达式 — 支持变量引用和简单算术
   * 如 "index" → 变量值, "150 + index * 60" → 计算结果
   */
  private evaluateExpression(expr: string, context: TemplateExecutionContext): unknown {
    // 纯变量名或路径（无运算符）
    if (/^[\w.[\]]+$/.test(expr)) {
      return this.evaluatePath(expr, context);
    }

    // 替换变量名 → 数值，然后做算术求值
    const substituted = expr.replace(/\b[\w.[\]]+\b/g, (token) => {
      // 跳过纯数字
      if (/^\d+(\.\d+)?$/.test(token)) return token;
      const val = this.evaluatePath(token, context);
      if (typeof val === 'number') return String(val);
      if (typeof val === 'string' && !isNaN(Number(val))) return val;
      return token; // 无法解析的保留原样
    });

    // 安全检查：只允许数字、运算符、括号、空格
    if (!/^[\d\s+\-*/().]+$/.test(substituted)) {
      return undefined;
    }

    try {
      const result = Function(`"use strict"; return (${substituted})`)();
      return typeof result === 'number' ? result : undefined;
    } catch {
      return undefined;
    }
  }

  private evaluatePath(path: string, context: TemplateExecutionContext): unknown {
    // 处理简单的变量引用
    if (path in context.variables) {
      return context.variables[path];
    }

    // 处理参数引用
    if (path in context.params) {
      return context.params[path];
    }

    // 处理点号路径（如 source.rows）
    const parts = path.split('.');
    let current: unknown = { ...context.variables, ...context.params };

    for (const part of parts) {
      // 处理数组索引
      const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
      if (arrayMatch) {
        const [, key, index] = arrayMatch;
        current = (current as Record<string, unknown>)?.[key];
        if (Array.isArray(current)) {
          current = current[parseInt(index)];
        } else {
          return undefined;
        }
      } else {
        if (current && typeof current === 'object') {
          current = (current as Record<string, unknown>)[part];
        } else {
          return undefined;
        }
      }
    }

    return current;
  }

  private evaluateCondition(condition: string, context: TemplateExecutionContext): boolean {
    // 简单的条件评估
    const value = this.resolveExpression(condition, context);

    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.length > 0;
    if (typeof value === 'number') return value !== 0;
    return value != null;
  }

  // ── 动作执行 ──

  private async executeClick(
    step: TemplateStep,
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    const target = step.target;

    if (options.dryRun) {
      return;
    }

    // 1. 语义定位（优先）
    if (target?.semantic) {
      const element = await this.findElementBySemantic(target.semantic, context);
      if (element) {
        await this.clickElement(element);
        return;
      }
    }

    // 2. 路径定位
    if (target?.path) {
      const element = await this.findElementByPath(target.path);
      if (element) {
        await this.clickElement(element);
        return;
      }
    }

    // 3. 坐标定位（兜底）
    if (target?.coordinate) {
      const x = Number(this.resolveExpression(String(target.coordinate.x), context));
      const y = Number(this.resolveExpression(String(target.coordinate.y), context));
      await this.clickCoordinate(x, y);
      return;
    }

    // 4. 变量引用
    if (target?.variable) {
      const element = context.variables[target.variable] as UnifiedElement;
      if (element) {
        await this.clickElement(element);
        return;
      }
    }

    throw new Error('No valid target for click');
  }

  private async executeType(
    step: TemplateStep,
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    const text = String(step.params?.text || '');
    const target = step.target;

    if (options.dryRun) {
      return;
    }

    if (target?.semantic) {
      const element = await this.findElementBySemantic(target.semantic, context);
      if (element) {
        const adapter = await this.getAdapterForElement(element);
        if (adapter) {
          await adapter.type(element, text);
          return;
        }
      }
    }

    // 使用桌面服务直接输入
    await desktopService.typeText(text);
  }

  private async executeKey(
    step: TemplateStep,
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    const key = String(step.params?.key || '');

    if (options.dryRun) {
      return;
    }

    await desktopService.pressKey(key);
  }

  private async executeCopy(
    step: TemplateStep,
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    if (options.dryRun) {
      return;
    }

    await desktopService.pressKey('Ctrl+C');

    // 等待剪贴板更新，然后读取内容存入变量
    await this.sleep(200);
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        context.variables['clipboard'] = text;
      }
    } catch {
      // 剪贴板读取可能被拒绝，忽略
    }
  }

  private async executePaste(
    step: TemplateStep,
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    if (options.dryRun) {
      return;
    }

    await desktopService.pressKey('Ctrl+V');
  }

  private async executeFocus(
    step: TemplateStep,
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    const target = step.target;

    if (options.dryRun) {
      return;
    }

    if (target?.semantic) {
      const element = await this.findElementBySemantic(target.semantic, context);
      if (element) {
        // 聚焦窗口
        const title = element.identity.name;
        const windows = await desktopService.listWindows();
        const window = windows.find(w => w.title.includes(title));
        if (window) {
          await desktopService.focusWindow(window.hwnd);
        }
      }
    }
  }

  private async executeScroll(
    step: TemplateStep,
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    const direction = String(step.params?.direction || 'down');
    const amount = Number(step.params?.amount || 100);
    const target = step.target;

    if (options.dryRun) {
      return;
    }

    if (target?.coordinate) {
      const x = Number(this.resolveExpression(String(target.coordinate.x), context));
      const y = Number(this.resolveExpression(String(target.coordinate.y), context));
      const delta = direction === 'down' ? -amount : amount;
      await desktopService.scroll(x, y, delta);
    }
  }

  private async executeDrag(
    step: TemplateStep,
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    const params = step.params || {};

    if (options.dryRun) {
      return;
    }

    const start_x = Number(this.resolveExpression(String(params.start_x ?? 0), context));
    const start_y = Number(this.resolveExpression(String(params.start_y ?? 0), context));
    const end_x = Number(this.resolveExpression(String(params.end_x ?? 0), context));
    const end_y = Number(this.resolveExpression(String(params.end_y ?? 0), context));
    const duration_ms = params.duration_ms ? Number(params.duration_ms) : undefined;
    const button = params.button ? String(params.button) : undefined;

    await desktopService.drag(start_x, start_y, end_x, end_y, duration_ms, button);
  }

  private async executeWait(
    step: TemplateStep,
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    const duration = Number(step.params?.duration || 1000);

    if (options.dryRun) {
      return;
    }

    await this.sleep(duration);
  }

  private async executeCode(
    step: TemplateStep,
    context: TemplateExecutionContext,
    options: ExecutionOptions,
  ): Promise<void> {
    const code = String(step.params?.code || '');
    if (!code) return;

    if (options.dryRun) {
      return;
    }

    try {
      // 沙箱环境：vars（读写上下文变量）、params（步骤参数）、ok/fail（返回结果）
      const sandboxFn = new Function('vars', 'params', 'ok', 'fail', code);
      const result = sandboxFn(
        context.variables,
        step.params || {},
        (msg: string, data?: Record<string, unknown>) => ({ success: true, message: msg, ...data }),
        (msg: string) => ({ success: false, message: msg }),
      );

      // 如果代码返回了对象，合并到上下文变量
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        Object.assign(context.variables, result);
      }
    } catch (e) {
      throw new Error(`Code execution error: ${(e as Error).message}`);
    }
  }

  // ── 流程控制 ──

  private startLoop(step: TemplateStep, context: TemplateExecutionContext): void {
    const over = String(step.params?.over || '');
    const variable = String(step.params?.variable || 'item');

    // 解析循环数据源
    let items: unknown[] = [];

    if (over.startsWith('{{') && over.endsWith('}}')) {
      // 参数引用
      const path = over.slice(2, -2);
      const value = this.evaluatePath(path, context);
      if (Array.isArray(value)) {
        items = value;
      }
    } else if (Array.isArray(context.params[over])) {
      // 参数数组
      items = context.params[over] as unknown[];
    } else {
      // 数字循环次数（坐标参数化场景：over: "5" → 循环 5 次）
      const count = parseInt(over, 10);
      if (!isNaN(count) && count > 0) {
        items = Array.from({ length: count }, (_, i) => i);
      }
    }

    context.loopStack.push({
      items,
      currentIndex: 0,
      variable,
      bodyStartIndex: context.currentStepIndex + 1,
    });

    // 设置初始变量
    if (items.length > 0) {
      context.variables[variable] = items[0];
      // 始终暴露 index 变量，方便坐标公式引用
      context.variables['index'] = 0;
    }
  }

  private endLoop(step: TemplateStep, context: TemplateExecutionContext): void {
    const loop = context.loopStack[context.loopStack.length - 1];
    if (!loop) return;

    loop.currentIndex++;

    if (loop.currentIndex < loop.items.length) {
      // 更新变量
      context.variables[loop.variable] = loop.items[loop.currentIndex];
      // 同步更新 index 变量
      context.variables['index'] = loop.currentIndex;

      // 跳回循环体开始
      context.currentStepIndex = loop.bodyStartIndex - 1; // -1 因为 for 循环会 +1
    } else {
      // 循环结束
      context.loopStack.pop();
    }
  }

  private executeBreak(context: TemplateExecutionContext): void {
    const loop = context.loopStack[context.loopStack.length - 1];
    if (!loop) return;

    // 跳到循环结束
    // 需要找到对应的 loop_end
    // 简化处理：直接结束当前循环
    context.loopStack.pop();
  }

  private executeContinue(context: TemplateExecutionContext): void {
    const loop = context.loopStack[context.loopStack.length - 1];
    if (!loop) return;

    // 跳到循环体开始
    context.currentStepIndex = loop.bodyStartIndex - 1; // -1 因为 for 循环会 +1
  }

  // ── 元素查找 ──

  private async findElementBySemantic(
    semantic: { role: string; name: unknown },
    context: TemplateExecutionContext,
  ): Promise<UnifiedElement | null> {
    const role = semantic.role;
    const name = String(this.resolveExpression(String(semantic.name), context));

    // 遍历所有适配器查找
    for (const adapter of this.adapters.values()) {
      try {
        const element = await adapter.findElement({ role, name });
        if (element) return element;
      } catch {
        // 继续尝试其他适配器
      }
    }

    return null;
  }

  private async findElementByPath(path: string): Promise<UnifiedElement | null> {
    for (const adapter of this.adapters.values()) {
      try {
        const element = await adapter.findElement({ path });
        if (element) return element;
      } catch {
        // 继续尝试其他适配器
      }
    }
    return null;
  }

  private async clickElement(element: UnifiedElement): Promise<void> {
    const adapter = await this.getAdapterForElement(element);
    if (adapter) {
      await adapter.click(element);
    } else {
      // 使用坐标点击
      if (element.location.bounds) {
        const { x, y, width, height } = element.location.bounds;
        await desktopService.click(x + width / 2, y + height / 2);
      }
    }
  }

  private async clickCoordinate(x: number, y: number): Promise<void> {
    await desktopService.click(x, y);
  }

  private async getAdapterForElement(element: UnifiedElement): Promise<PlatformAdapter | null> {
    const platform = element.raw?.platform;
    if (platform && this.adapters.has(platform)) {
      return this.adapters.get(platform)!;
    }

    // 返回第一个可用的适配器
    for (const adapter of this.adapters.values()) {
      return adapter;
    }

    return null;
  }

  // ── 辅助方法 ──

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 获取当前执行上下文
   */
  getCurrentContext(): TemplateExecutionContext | null {
    return this.currentContext;
  }

  /**
   * 获取执行日志
   */
  getLogs(): ExecutionLog[] {
    return this.currentContext?.logs || [];
  }
}

// 导出单例
export const unifiedExecutor = new UnifiedExecutor();
