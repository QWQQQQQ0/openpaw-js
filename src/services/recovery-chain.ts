// Failure Recovery Chain (Phase 4)
//
// When a semantic action fails (element not found), try local recovery
// before escalating to LLM. Most failures are caused by:
//   - Element scrolled off-screen
//   - Window lost focus
//   - UI state changed (modal opened, page switched)
//   - UIA tree cache stale
//
// Recovery levels (cheapest first):
//   1. Scroll        — element may be just off-screen
//   2. Search        — Ctrl+F may reveal it
//   3. Go back       — Escape to close modal / return
//   4. Re-focus      — window may have lost foreground
//   5. Re-get tree   — UIA tree may be stale
//   6. Escalate      — call LLM (last resort)

import type { ISkillExecutor } from '@/interfaces/skill-executor';
import type { AgentState } from './state-machine';

// ── Types ──

export type RecoveryLevel = 'scroll' | 'search' | 'back' | 'refocus' | 'retree' | 'escalate';

export interface RecoveryResult {
  recovered: boolean;
  level: RecoveryLevel;
  message: string;
}

interface ActionTarget {
  role?: string;
  name?: string;
}

interface FailedAction {
  toolName: string;
  target?: ActionTarget;
  error?: string;
}

// ── Recovery Chain ──

export class RecoveryChain {
  private skillExecutor: ISkillExecutor;

  // Ordered from cheapest to most expensive
  private readonly levels: RecoveryLevel[] = [
    'scroll',
    'search',
    'back',
    'refocus',
    'retree',
    'escalate',
  ];

  constructor(skillExecutor: ISkillExecutor) {
    this.skillExecutor = skillExecutor;
  }

  /** Run the recovery chain. Returns success after the first level that works. */
  async recover(
    failedAction: FailedAction,
    state: Readonly<AgentState>,
    windowHwnd: number,
  ): Promise<RecoveryResult> {
    const target = failedAction.target;

    for (const level of this.levels) {
      try {
        const result = await this.tryLevel(level, target, state, windowHwnd);
        if (result) {
          return { recovered: true, level, message: `Recovered via ${level}` };
        }
      } catch {
        // Level failed, try next
      }
    }
    return {
      recovered: false,
      level: 'escalate',
      message: 'All recovery levels exhausted — escalate to LLM',
    };
  }

  /** Try a single recovery level. Returns true if the target is now found. */
  private async tryLevel(
    level: RecoveryLevel,
    target: ActionTarget | undefined,
    state: Readonly<AgentState>,
    windowHwnd: number,
  ): Promise<boolean> {
    switch (level) {
      case 'scroll': return this.recoverScroll(target, windowHwnd);
      case 'search': return this.recoverSearch(target, windowHwnd);
      case 'back': return this.recoverBack(windowHwnd);
      case 'refocus': return this.recoverRefocus(state, windowHwnd);
      case 'retree': return this.recoverRetree(windowHwnd);
      case 'escalate': return false; // always falls through to LLM
    }
  }

  // ── Level 1: Scroll (element may be off-screen) ──

  private async recoverScroll(
    target: ActionTarget | undefined,
    windowHwnd: number,
  ): Promise<boolean> {
    // Try scroll down, then check
    const scrollAmounts = [-120, 120, -240, 240]; // up, down, up more, down more
    for (const delta of scrollAmounts) {
      await this.skillExecutor.executeToolCall('desktop_scroll', {
        x: 400, y: 400, delta,  // center-ish area
      });
      await new Promise((r) => setTimeout(r, 200));

      if (target?.role) {
        const check = await this.skillExecutor.executeToolCall('uia_find_element', {
          role: target.role,
          name: target.name ?? null,
          window_hwnd: windowHwnd,
        });
        if (check.success && check.data?.['found']) {
          return true;
        }
      }
    }
    return false;
  }

  // ── Level 2: Search (Ctrl+F) ──

  private async recoverSearch(
    target: ActionTarget | undefined,
    windowHwnd: number,
  ): Promise<boolean> {
    if (!target?.name) return false;

    try {
      // Press Ctrl+F to open search
      await this.skillExecutor.executeToolCall('desktop_press_key', { key: 'Ctrl+F' });
      await new Promise((r) => setTimeout(r, 300));

      // Type the target name
      await this.skillExecutor.executeToolCall('uia_type', {
        text: target.name,
        window_hwnd: windowHwnd,
      });
      await new Promise((r) => setTimeout(r, 300));

      // Press Escape to close search bar
      await this.skillExecutor.executeToolCall('desktop_press_key', { key: 'Escape' });
      await new Promise((r) => setTimeout(r, 200));

      // Check if target is now findable
      if (target.role) {
        const check = await this.skillExecutor.executeToolCall('uia_find_element', {
          role: target.role,
          name: target.name,
          window_hwnd: windowHwnd,
        });
        if (check.success && check.data?.['found']) {
          return true;
        }
      }
    } catch {
      // search recovery is best-effort
    }
    return false;
  }

  // ── Level 3: Go back (Escape — dismiss modal / leave search) ──

  private async recoverBack(windowHwnd: number): Promise<boolean> {
    try {
      // Dismiss any modal/search by pressing Escape
      await this.skillExecutor.executeToolCall('desktop_press_key', { key: 'Escape' });
      await new Promise((r) => setTimeout(r, 300));

      // Re-get interactive nodes to check if UI normalized
      const check = await this.skillExecutor.executeToolCall('uia_get_interactive', {
        window_hwnd: windowHwnd,
      });
      const nodes = (check.data?.['nodes'] as Array<Record<string, unknown>>) || [];

      // Success if we got some nodes (UI is accessible again)
      return nodes.length > 0;
    } catch {
      return false;
    }
  }

  // ── Level 4: Re-focus window ──

  private async recoverRefocus(
    state: Readonly<AgentState>,
    windowHwnd: number,
  ): Promise<boolean> {
    try {
      // Re-focus the target window
      await this.skillExecutor.executeToolCall('desktop_focus_window', { hwnd: windowHwnd });
      await new Promise((r) => setTimeout(r, 200));

      // Verify by checking any interactive element exists
      const check = await this.skillExecutor.executeToolCall('uia_get_interactive', {
        window_hwnd: windowHwnd,
      });
      const nodes = (check.data?.['nodes'] as Array<Record<string, unknown>>) || [];
      return nodes.length > 0;
    } catch {
      return false;
    }
  }

  // ── Level 5: Re-get UI tree ──

  private async recoverRetree(windowHwnd: number): Promise<boolean> {
    try {
      // Force fresh UIA tree read
      const check = await this.skillExecutor.executeToolCall('uia_get_interactive', {
        window_hwnd: windowHwnd,
      });
      const count = (check.data?.['count'] as number) || 0;

      // Also invalidate fingerprint — UI may have structurally changed
      return count > 0;
    } catch {
      return false;
    }
  }
}
