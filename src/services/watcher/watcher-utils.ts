// Watcher utilities — shared logic for task type detection, preparation goals,
// tool filtering, and provider loading. Used by WatcherInstance, ScreenChangeEventSource,
// action executors, and template compiler.

import type { WatcherConfig } from '@/types/watcher';

/** Keywords indicating the task is ongoing monitoring, not a one-shot action */
const ONGOING_KEYWORDS = [
  '监听', '监控', '实时', 'watch', 'monitor', 'listen',
  '轮询', 'poll', '持续', 'continuous', '新消息', '变化',
  '通知我', '提醒我', '自动回复',
];

/** Keywords indicating the task is a one-shot execution */
const ONESHOT_KEYWORDS = [
  '完成后', '一次性', '执行完', '做完', 'one-time', 'one-shot',
];

/**
 * Determine whether this watcher/task is an ongoing monitoring task
 * (should enter polling loop) vs a one-shot execution task.
 *
 * Decision logic:
 * 1. Keyword analysis on taskName and regionDescription
 * 2. If action.type is 'notify' or 'custom' => ongoing (passive reaction)
 * 3. If action.type is 'agent_execute' AND no ongoing keywords => one-shot
 */
export function isOngoingMonitoringTask(
  actionType: string,
  regionDescription?: string,
  taskName?: string,
): boolean {
  // Keyword analysis on taskName + regionDescription
  const texts = [taskName, regionDescription].filter(Boolean).map(s => s!.toLowerCase()).join(' ');
  if (texts) {
    const hasOngoing = ONGOING_KEYWORDS.some(kw => texts.includes(kw));
    const hasOneshot = ONESHOT_KEYWORDS.some(kw => texts.includes(kw));
    if (hasOngoing) return true;
    if (hasOneshot) return false;
  }

  // Primary signal: action type
  if (actionType === 'notify' || actionType === 'custom') return true;
  if (actionType === 'agent_execute') return false;

  // Default: treat as ongoing (safer — enters polling loop)
  return true;
}

/**
 * Build a preparation-focused goal for planAndExecute().
 * Only asks the LLM to open the app and navigate to the right page,
 * NOT to execute the monitoring goal itself.
 */
export function buildPreparationGoal(regionDescription: string, appName?: string): string {
  const appPart = appName ? `，应用: "${appName}"` : '';
  return `打开应用并导航到正确页面，准备进行: "${regionDescription}"${appPart}。只打开应用并到达目标页面，不要执行实际任务。到达目标页面后调用 desktop_done。`;
}

/**
 * Build tool filter from WatcherConfig's toolMode/customTools.
 * Returns undefined for 'all' mode (no filter), empty Set for 'none', or a Set of tool names for 'custom'.
 */
export function buildToolFilter(config: { toolMode?: string; customTools?: string[] }): Set<string> | undefined {
  if (config.toolMode === 'none') return new Set<string>();
  if (config.toolMode === 'custom' && config.customTools?.length) {
    return new Set(config.customTools);
  }
  return undefined; // 'all' or undefined = no filter
}

/**
 * Load default provider and API key from the model config store.
 * Consolidates the repeated 5-line pattern found in action executors and template compiler.
 */
export async function loadProviderAndKey(): Promise<{
  provider: import('@/types/provider').ProviderConfig;
  apiKey: string;
}> {
  const { useModelConfigStore } = await import('@/stores/model-config-store');
  const modelStore = useModelConfigStore.getState();
  if (modelStore.providers.length === 0) await modelStore.load();
  const provider = modelStore.defaultConfig();
  if (!provider) throw new Error('No default model provider configured');
  const apiKey = await modelStore.getApiKey(provider.id, '');
  if (!apiKey) throw new Error('No API key for provider');
  return { provider, apiKey };
}
