import type {
  UICacheRow,
  StepCacheRow,
  StepCacheEntry,
  SubGoalCacheRow,
  SubGoalCacheEntry,
  LLMCallCacheRow,
  GoalDecomposition,
  InteractiveNode,
  SemanticAction,
  SemanticAnnotation,
  SkillTemplateRow,
} from '@/types/cache';
import type { TriggerInfo } from '@/types/page-component';
import type { WatcherConfig } from '@/types/watcher';
import type { AppLogEntry, AppEventSource, AppEventLevel } from '@/types/events';

export interface CacheHitResult {
  level: 'l3' | 'l2' | 'l1' | 'miss';
  detail: string;
  entry?: Record<string, unknown>;
}

export interface ICacheService {
  // 工具函数
  normalizeGoal(goal: string): string;
  resolveFingerprint(windowFP: string, pageFPs: Record<string, string>, preferredPage?: string): { fingerprint: string; isExactPage: boolean };

  // L1: UI fingerprint cache
  storeUICache(fingerprint: string, windowFP: string, pageFP: string | null, appName: string, windowClass: string, nodes: InteractiveNode[], semanticAnnotations?: SemanticAnnotation[], parentFingerprint?: string | null, trigger?: TriggerInfo | null, screenshotPath?: string | null): Promise<void>;
  getUICache(fingerprint: string): Promise<{ nodes: InteractiveNode[]; annotations: SemanticAnnotation[]; row: UICacheRow } | null>;
  updateSemanticAnnotations(fingerprint: string, annotations: SemanticAnnotation[]): Promise<void>;

  // 页面组件知识库
  getChildrenOf(parentFingerprint: string): Promise<UICacheRow[]>;
  updatePageComponent(fingerprint: string, parentFp: string | null, trigger: TriggerInfo | null): Promise<void>;
  getAppPageGraph(appName: string): Promise<UICacheRow[]>;

  // L2a: Sub-goal cache
  storeSubGoalCache(entry: SubGoalCacheEntry): Promise<void>;
  getSubGoalCache(subgoalKey: string, appName?: string): Promise<SubGoalCacheEntry | null>;
  deleteSubGoalCacheByKey(subgoalKey: string, appName?: string): Promise<void>;

  // Goal decomposition cache (goal → subgoals[])
  getGoalDecomposition(normalizedGoal: string): Promise<GoalDecomposition | null>;
  storeGoalDecomposition(normalizedGoal: string, decomposition: GoalDecomposition): Promise<void>;
  getAllGoalDecompositionRows(): Promise<Array<{ normalized_goal: string; subgoals_json: string; hit_count: number; created_at: number }>>;
  deleteGoalDecomposition(normalizedGoal: string): Promise<void>;
  clearGoalDecompositionCache(): Promise<void>;

  // L2b: Step cache
  storeStepCache(entry: StepCacheEntry): Promise<void>;
  getStepCache(goalFragment: string, windowFP?: string, appName?: string): Promise<StepCacheEntry | null>;

  // LLM call cache
  getLLMCallCache(requestHash: string): Promise<LLMCallCacheRow | null>;
  storeLLMCallCache(requestHash: string, responseText: string, model: string, providerType: string, messageCount: number, toolCount: number, requestText?: string): Promise<void>;

  // L3: Skill templates
  storeSkillTemplate(name: string, description: string, params: string[], template: SemanticAction[], preconditions: string[]): Promise<void>;
  getSkillTemplateRows(): Promise<SkillTemplateRow[]>;

  // Bulk queries (cache viewer)
  getAllUICacheRows(): Promise<UICacheRow[]>;
  getAllSkillTemplateRows(): Promise<SkillTemplateRow[]>;
  getAllSubGoalCacheRows(): Promise<SubGoalCacheRow[]>;
  getAllStepCacheRows(): Promise<StepCacheRow[]>;
  getAllLLMCallCacheRows(): Promise<LLMCallCacheRow[]>;

  // Delete single entries
  deleteUICache(fingerprint: string): Promise<void>;
  deleteSkillTemplate(id: number): Promise<void>;
  deleteSubGoalCache(id: number): Promise<void>;
  deleteStepCache(id: number): Promise<void>;
  deleteLLMCallCache(id: number): Promise<void>;

  // Clear all
  clearAllCache(): Promise<void>;
  clearSubGoalCache(): Promise<void>;
  clearStepCache(): Promise<void>;

  // Cache hit test
  testCacheHit(goal: string, windowFP: string, pageFP?: string): Promise<CacheHitResult[]>;

  // Watcher config CRUD
  storeWatcherConfig(config: WatcherConfig): Promise<void>;
  getWatcherConfig(id: string): Promise<WatcherConfig | null>;
  getAllWatcherConfigs(): Promise<WatcherConfig[]>;
  deleteWatcherConfig(id: string): Promise<void>;

  // App log CRUD
  storeAppLog(entry: Omit<AppLogEntry, 'id'>): Promise<void>;
  queryAppLogs(filter?: { source?: AppEventSource; sourceId?: string; level?: AppEventLevel; since?: number; limit?: number }): Promise<AppLogEntry[]>;
  cleanupOldLogs(keepDays?: number): Promise<void>;
}
