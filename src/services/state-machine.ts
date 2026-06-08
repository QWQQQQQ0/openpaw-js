// Agent State Machine (Phase 4)
//
// Tracks execution state and makes local decisions so that the LLM
// is only called for genuine planning, not routine recovery or mode detection.

import type { WindowInfo } from './desktop-service';

// ── Types ──

export type AgentMode = 'normal' | 'search' | 'modal' | 'loading' | 'unknown';
export type Decision = 'use_skill' | 'use_cache' | 'get_nodes' | 'call_llm' | 'recover' | 'done';

export interface AgentState {
  // World state
  focusedWindow: WindowInfo | null;
  activePage: string | null;
  mode: AgentMode;
  pageFP: string | null;
  windowFP: string | null;

  // Task state
  goal: string;
  stage: 'init' | 'planning' | 'executing' | 'verifying' | 'done';
  completedSteps: string[];
  remainingSteps: string[];

  // Cache state
  cacheSource: 'l3' | 'l2' | 'l1' | 'llm' | 'none';
  cacheHitL1: boolean;
  cacheHitL2: boolean;

  // Health state
  consecutiveFailures: number;
  totalActions: number;
  lastError: string | null;
}

export const EMPTY_STATE: AgentState = {
  focusedWindow: null,
  activePage: null,
  mode: 'normal',
  pageFP: null,
  windowFP: null,
  goal: '',
  stage: 'init',
  completedSteps: [],
  remainingSteps: [],
  cacheSource: 'none',
  cacheHitL1: false,
  cacheHitL2: false,
  consecutiveFailures: 0,
  totalActions: 0,
  lastError: null,
};

// ── Thresholds ──

const MAX_CONSECUTIVE_FAILURES = 3; // escalate to LLM after this many local failures

// ── StateMachine ──

export class StateMachine {
  private state: AgentState;

  constructor(goal: string, focusedWindow?: WindowInfo | null) {
    this.state = { ...EMPTY_STATE, goal, focusedWindow: focusedWindow ?? null };
  }

  getState(): Readonly<AgentState> {
    return this.state;
  }

  // ── Decision ──

  /** Decide what the agent should do next. Called before each action. */
  decide(): Decision {
    const s = this.state;

    // Too many failures → escalate
    if (s.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      return 'call_llm';
    }

    // Task complete
    if (s.stage === 'done') {
      return 'done';
    }

    // We have remaining planned steps → execute next
    if (s.remainingSteps.length > 0 && s.stage === 'executing') {
      // Current step is actionable, continue executing
      if (s.consecutiveFailures > 0) {
        return 'recover'; // previous step failed, try recovery
      }
      return 'use_cache'; // continue replaying cached steps
    }

    // Need a plan
    if (s.stage === 'init' || s.stage === 'planning') {
      if (s.cacheHitL2) return 'use_cache';
      if (s.cacheHitL1) return 'call_llm'; // have UI nodes, need plan
      return 'get_nodes'; // need UI nodes first
    }

    return 'call_llm';
  }

  // ── Transition ──

  /** Called after an action is executed. Updates state and detects anomalies. */
  transition(
    actionName: string,
    success: boolean,
    result: Record<string, unknown> | null,
  ): void {
    this.state.totalActions++;

    if (success) {
      this.state.consecutiveFailures = 0;
      this.state.completedSteps.push(actionName);
      this._detectModeChange(result);
      this._updateStage(actionName, result);
    } else {
      this.state.consecutiveFailures++;
      this.state.lastError = (result?.['error'] as string)
        || (result?.['message'] as string)
        || `Action ${actionName} failed`;
    }

    // If remainingSteps exist, remove the completed one
    if (success && this.state.remainingSteps.length > 0) {
      const next = this.state.remainingSteps[0];
      if (next === actionName || this._isEquivalentAction(next, actionName)) {
        this.state.remainingSteps.shift();
      }
    }
  }

  // ── Setters ──

  setStage(stage: AgentState['stage']): void {
    this.state.stage = stage;
  }

  setCacheSource(source: AgentState['cacheSource']): void {
    this.state.cacheSource = source;
    this.state.cacheHitL1 = source === 'l1' || source === 'l2' || source === 'l3';
    this.state.cacheHitL2 = source === 'l2' || source === 'l3';
    if (source === 'l2' || source === 'l3') {
      this.state.stage = 'executing';
    }
  }

  setRemainingSteps(steps: string[]): void {
    this.state.remainingSteps = [...steps];
  }

  setWindow(fp: string | null, window: WindowInfo | null): void {
    this.state.windowFP = fp;
    this.state.focusedWindow = window;
  }

  setPage(fp: string | null): void {
    this.state.pageFP = fp;
    this.state.activePage = fp;
  }

  markRecoveryAttempt(): void {
    // Don't count recovery attempts as failures — they're expected
    if (this.state.consecutiveFailures > 0) {
      // Only count if we've exhausted recovery options
    }
  }

  resetFailures(): void {
    this.state.consecutiveFailures = 0;
    this.state.lastError = null;
  }

  // ── Internal ──

  /** Detect mode changes from action results (e.g., modal opened, search activated). */
  private _detectModeChange(result: Record<string, unknown> | null): void {
    if (!result) return;

    const nodes = result['nodes'] as Array<Record<string, unknown>> | undefined;
    const windowTitle = result['window_title'] as string | undefined;

    // Dialog/Modal detection: many Button nodes with short names like "OK", "Cancel"
    if (nodes) {
      const dialogButtons = nodes.filter(
        (n) => n['role'] === 'Button' &&
          ['OK', '确定', 'Cancel', '取消', 'Yes', 'No', '是', '否', '关闭', 'Close'].includes(String(n['name'] || '')),
      );
      if (dialogButtons.length >= 1) {
        const prevMode = this.state.mode;
        this.state.mode = 'modal';
        if (prevMode !== 'modal') {
          // mode changed to modal
        }
        return;
      }
    }

    // Search mode detection
    if (windowTitle?.includes('搜索') || windowTitle?.includes('Search')) {
      this.state.mode = 'search';
      return;
    }

    this.state.mode = 'normal';
  }

  private _updateStage(actionName: string, _result: Record<string, unknown> | null): void {
    if (actionName === 'desktop_done') {
      this.state.stage = 'done';
      return;
    }

    if (this.state.stage !== 'init') return;

    // During init, uia_ calls are preparation → planning stage
    if (actionName === 'uia_get_interactive' || actionName === 'uia_fingerprint') {
      this.state.stage = 'planning';
    } else {
      this.state.stage = 'executing';
    }
  }

  private _isEquivalentAction(planned: string, executed: string): boolean {
    // Map semantic actions to tool names
    const equivalents: Record<string, string[]> = {
      'click': ['uia_click', 'desktop_click'],
      'type': ['uia_type', 'desktop_type'],
      'wait': ['desktop_wait'],
      'open_app': ['desktop_open_app'],
      'focus_window': ['desktop_focus_window'],
      'press_key': ['desktop_press_key'],
    };
    const mapped = equivalents[executed];
    return mapped ? mapped.includes(planned) || planned === executed : planned === executed;
  }
}
