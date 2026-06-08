// AgentTaskService — thin orchestration layer for natural language task execution.
// User says something → classifyIntent → dispatch to once/timer/screen_change.
// All execution logic is delegated: DesktopAutomationAgent for once, TaskScheduler for scheduled.

import type { ParsedGoal, ParsedTask } from '@/types/goal';
import type { TaskConfig } from '@/types/scheduler';
import type { ProviderConfig } from '@/types/provider';
import type { IModelService } from '@/interfaces/model-service';
import type { ISkillExecutor } from '@/interfaces/skill-executor';
import type { ICacheService } from '@/interfaces/cache-service';
import type { AgentTurn, AgentStepCallback } from '@/services/desktop-automation-agent';
import { classifyIntent } from '@/services/intent-classifier';
import { buildTaskConfig } from '@/services/task-builder';
import { appEventBus } from '@/services/event-bus';
import { watcherManager } from '@/services/watcher';

export interface TaskResult {
  taskId?: string;
  status: 'done' | 'scheduled' | 'error';
  turns?: AgentTurn[] | null;
  error?: string;
}

export interface AgentResponse {
  message: string;
  tasks: TaskResult[];
}

export class AgentTaskService {
  private modelService: IModelService;
  private skillExecutor: ISkillExecutor;
  private cacheService: ICacheService;

  constructor(
    modelService: IModelService,
    skillExecutor: ISkillExecutor,
    cacheService: ICacheService,
  ) {
    this.modelService = modelService;
    this.skillExecutor = skillExecutor;
    this.cacheService = cacheService;
  }

  /**
   * Main entry: user says something, agent handles everything.
   * Classifies intent → dispatches once/timer/screen_change tasks.
   * @param toolFilter Optional set of tool names to pass to the agent (from ToolMode).
   */
  async handleUserGoal(
    userInput: string,
    provider: ProviderConfig,
    apiKey: string,
    toolFilter?: Set<string>,
    signal?: AbortSignal,
  ): Promise<AgentResponse> {
    // 1. Classify intent (auto-cached via llm_call_cache)
    const parsed = await classifyIntent(userInput, this.modelService, provider, apiKey);

    const results: TaskResult[] = [];

    for (const task of parsed.tasks) {
      try {
        if (task.type === 'once') {
          const result = await this.executeOnce(task, userInput, provider, apiKey, toolFilter, signal);
          results.push(result);
        } else {
          const result = await this.createScheduledTask(task, toolFilter);
          results.push(result);
        }
      } catch (e) {
        results.push({
          status: 'error',
          error: String(e),
        });
        appEventBus.emit({
          source: 'app',
          type: 'task_error',
          level: 'error',
          message: `Task "${task.name}" failed: ${String(e)}`,
          timestamp: Date.now(),
        });
      }
    }

    return { message: parsed.response, tasks: results };
  }

  /**
   * Execute a one-shot task via DesktopAutomationAgent.
   * Internally runs full L3→L2→Plan→PerTurn pipeline with all caching.
   */
  private async executeOnce(
    task: ParsedTask,
    fullUserGoal: string,
    provider: ProviderConfig,
    apiKey: string,
    toolFilter?: Set<string>,
    signal?: AbortSignal,
  ): Promise<TaskResult> {
    const { DesktopAutomationAgent } = await import('@/services/desktop-automation-agent');

    const agent = new DesktopAutomationAgent(this.skillExecutor, this.cacheService);

    appEventBus.emit({
      source: 'app',
      type: 'task_execute_start',
      level: 'info',
      message: `Executing: ${task.goal}`,
      timestamp: Date.now(),
    });

    // Capture initial desktop state
    try {
      const { desktopService } = await import('@/services/desktop-service');
      const screenshot = await desktopService.screenshot();
      appEventBus.emit({
        source: 'agent',
        type: 'screenshot',
        level: 'debug',
        message: 'Initial desktop state',
        sourceId: task.name,
        timestamp: Date.now(),
        data: { screenshot },
      });
    } catch { /* non-critical */ }

    const SCREENSHOT_TOOLS = new Set([
      'desktop_click', 'desktop_double_click', 'desktop_right_click',
      'desktop_type_text', 'desktop_open_app', 'desktop_press_key',
    ]);

    const turns = await agent.executeCommand({
      goal: fullUserGoal,               // 用户原始完整输入 → system prompt
      taskInstruction: task.goal,        // 当前子任务 → user message
      provider,
      apiKey,
      maxTurns: 20,
      toolFilter,
      signal,
      onStep: async (event) => {
        const data = event.data as { name?: string; arguments?: Record<string, unknown>; success?: boolean; message?: string; reasoning?: string; responseText?: string; tool_calls?: Array<{ name: string; arguments: Record<string, unknown> }> } | undefined;
        const toolName = data?.name ?? '';
        const toolArgs = data?.arguments ? JSON.stringify(data.arguments).substring(0, 80) : '';

        appEventBus.emit({
          source: 'agent',
          type: event.type,
          level: event.type === 'after_tool' && data?.success === false ? 'warn' : 'info',
          message: event.type === 'before_tool'
            ? `▶ ${toolName}(${toolArgs})`
            : event.type === 'after_tool'
            ? `${data?.success ? '✓' : '✗'} ${toolName}: ${data?.message ?? ''}`
            : event.type === 'after_llm'
            ? `🧠 LLM decided: ${data?.tool_calls?.map(tc => tc.name).join(', ') || 'text only'}`
            : `[${event.type}] turn=${event.turnIndex}`,
          sourceId: task.name,
          timestamp: Date.now(),
          // 附加推理过程，前端可按需展示
          data: event.type === 'after_llm' ? { reasoning: data?.reasoning, responseText: data?.responseText, toolCalls: data?.tool_calls } : undefined,
        });

        // Capture screenshot after visual tool calls for debugging
        if (event.type === 'after_tool' && toolName && SCREENSHOT_TOOLS.has(toolName)) {
          try {
            const { desktopService } = await import('@/services/desktop-service');
            const t0 = Date.now();
            const screenshot = await desktopService.screenshot();
            console.debug(`[task-service] onStep screenshot after ${toolName}: ${screenshot?.length ?? 0} chars, ${Date.now() - t0}ms`);
            appEventBus.emit({
              source: 'agent',
              type: 'screenshot',
              level: 'debug',
              message: `Screenshot after ${toolName}`,
              sourceId: task.name,
              timestamp: Date.now(),
              data: { screenshot, afterTool: toolName },
            });
          } catch { /* screenshot failed, non-critical */ }
        }

        return null;
      },
    });

    appEventBus.emit({
      source: 'app',
      type: 'task_execute_done',
      level: 'info',
      message: `Completed: ${task.name}`,
      timestamp: Date.now(),
    });

    return { status: 'done', turns };
  }

  /**
   * Create a scheduled task (timer or screen_change) and add to TaskScheduler.
   * The task will run on its own schedule via the existing scheduler infrastructure.
   */
  private async createScheduledTask(task: ParsedTask, toolFilter?: Set<string>): Promise<TaskResult> {
    const taskConfig = buildTaskConfig(task);

    appEventBus.emit({
      source: 'app',
      type: 'task_scheduled',
      level: 'info',
      message: `Scheduled: ${task.name} (${task.type})`,
      timestamp: Date.now(),
      data: { taskId: taskConfig.id, type: task.type },
    });

    // 将 toolFilter 转为 toolMode/customTools 存入 WatcherConfig
    const toolMode = this.resolveToolMode(toolFilter);
    const customTools = toolFilter && toolFilter.size > 0 ? Array.from(toolFilter) : undefined;

    const watcherConfig = taskConfigToWatcherConfig(taskConfig, toolMode, customTools);

    await watcherManager.create(watcherConfig);

    return { taskId: taskConfig.id, status: 'scheduled' };
  }

  /** Get default provider and API key from model config store */
  private async getProviderAndKey(): Promise<[ProviderConfig, string]> {
    const { useModelConfigStore } = await import('@/stores/model-config-store');
    const modelStore = useModelConfigStore.getState();
    if (modelStore.providers.length === 0) await modelStore.load();
    const provider = modelStore.defaultConfig();
    if (!provider) throw new Error('No default model provider configured');
    const apiKey = await modelStore.getApiKey(provider.id, '');
    if (!apiKey) throw new Error('No API key for provider');
    return [provider, apiKey];
  }

  private resolveToolMode(toolFilter?: Set<string>): string | undefined {
    if (!toolFilter) return 'all';
    if (toolFilter.size === 0) return 'none';
    return 'custom';
  }

  /**
   * 准备阶段：打开应用、定位窗口。
   * 在 watcher 创建前调用，确保目标窗口已就绪。
   */
  private async prepareWindow(config: import('@/types/watcher').WatcherConfig): Promise<void> {
    const mt = config.monitorTarget;
    if (!mt || mt.type !== 'window') return;

    const appName = mt.appName || mt.windowTitle;
    if (!appName) return;

    appEventBus.emit({
      source: 'app',
      type: 'task_prepare',
      level: 'info',
      message: `准备窗口: ${appName}`,
      timestamp: Date.now(),
    });

    try {
      // 1. 尝试按标题查找已有窗口
      if (mt.windowTitle) {
        const { desktopService } = await import('@/services/desktop-service');
        const windows = await desktopService.listWindows();
        const found = windows.find(w =>
          w.title.includes(mt.windowTitle!) || mt.windowTitle!.includes(w.title)
        );
        if (found) {
          mt.windowHwnd = found.hwnd;
          return;
        }
      }

      // 2. 打开应用
      const { getBuiltinExecutor } = await import('@/skills/builtin-executor');
      const executor = getBuiltinExecutor();
      const result = await executor.executeToolCall('desktop_open_app', { name: appName });
      const data = result?.data as Record<string, unknown> | undefined;
      const hwnd = Number(data?.['hwnd'] ?? 0);

      if (hwnd > 0) {
        mt.windowHwnd = hwnd;
      }
    } catch { /* ignore */ }
  }
}

/**
 * Convert TaskConfig to WatcherConfig format for watcherManager.create().
 * watcherManager expects WatcherConfig, not TaskConfig directly.
 */
import type { WatcherConfig as WatcherConfigType } from '@/types/watcher';

function taskConfigToWatcherConfig(tc: TaskConfig, toolMode?: string, customTools?: string[]): WatcherConfigType {
  const now = Date.now();
  const trigger = tc.trigger;

  if (trigger.type === 'timer') {
    return {
      id: tc.id,
      name: tc.name,
      enabled: tc.enabled,
      monitorTarget: { type: 'fullscreen' as const },
      region: { x: 0, y: 0, width: 1, height: 1 },
      pollIntervalMs: trigger.intervalMs,
      diffStrategy: 'fast_visual' as const,
      debounceMs: 0,
      cooldownMs: trigger.cooldownMs,
      minConfidence: 0.9,
      action: {
        type: tc.action.type,
        ...(tc.action.type === 'agent_execute' ? { goalTemplate: tc.action.goalTemplate } : {}),
        ...(tc.action.type === 'notify' ? { notifyTemplate: tc.action.notifyTemplate } : {}),
      },
      toolMode,
      customTools,
      createdAt: now,
      updatedAt: now,
    };
  }

  // screen_change
  const sc = trigger;
  return {
    id: tc.id,
    name: tc.name,
    enabled: tc.enabled,
    monitorTarget: sc.monitorTarget,
    region: sc.region,
    pollIntervalMs: sc.pollIntervalMs,
    diffStrategy: sc.diffStrategy,
    debounceMs: sc.debounceMs,
    cooldownMs: sc.cooldownMs,
    minConfidence: sc.minConfidence,
    action: {
      type: tc.action.type,
      ...(tc.action.type === 'agent_execute' ? { goalTemplate: tc.action.goalTemplate } : {}),
    },
    regionMode: sc.regionMode,
    regionDescription: sc.regionDescription,
    ...(sc.preparationGoal ? { preparationGoal: sc.preparationGoal } : {}),
    ...(sc.actionGoal ? { actionGoal: sc.actionGoal } : {}),
    toolMode,
    customTools,
    createdAt: now,
    updatedAt: now,
  };
}
