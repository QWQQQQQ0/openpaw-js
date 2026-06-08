import { getDB } from '@/db';
import type { AgentProcessLogRow } from '@/db/types';
import type { LogAction } from './types';

export interface AppendLogOptions {
  filePath?: string;
  inputSummary?: string;
  outputSummary?: string;
  fullInputPath?: string;
  fullOutputPath?: string;
  decisionRationale?: string;
  errorInfo?: string;
  durationMs?: number;
}

export class ProcessLogDB {
  /**
   * Append a new process log entry.
   */
  async append(
    taskId: string,
    agentId: string,
    stepOrder: number,
    action: LogAction,
    opts?: AppendLogOptions,
  ): Promise<void> {
    const db = await getDB();
    await db.execute(
      `INSERT INTO agent_process_log (task_id, agent_id, step_order, action, file_path, input_summary, output_summary, full_input_path, full_output_path, decision_rationale, error_info, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        taskId,
        agentId,
        stepOrder,
        action,
        opts?.filePath ?? null,
        opts?.inputSummary ?? null,
        opts?.outputSummary ?? null,
        opts?.fullInputPath ?? null,
        opts?.fullOutputPath ?? null,
        opts?.decisionRationale ?? null,
        opts?.errorInfo ?? null,
        opts?.durationMs ?? null,
      ],
    );
  }

  /**
   * Get all log entries for a task, ordered by step_order ascending.
   */
  async getByTask(taskId: string): Promise<AgentProcessLogRow[]> {
    const db = await getDB();
    return db.query<AgentProcessLogRow>(
      'SELECT * FROM agent_process_log WHERE task_id = ? ORDER BY step_order ASC',
      [taskId],
    );
  }

  /**
   * Get the last log entry for a task (highest step_order).
   */
  async getLastStep(taskId: string): Promise<AgentProcessLogRow | null> {
    const db = await getDB();
    return db.get<AgentProcessLogRow>(
      'SELECT * FROM agent_process_log WHERE task_id = ? ORDER BY step_order DESC LIMIT 1',
      [taskId],
    );
  }

  /**
   * Get the next step order for a task (MAX(step_order) + 1, or 1 if none exist).
   */
  async getNextStepOrder(taskId: string): Promise<number> {
    const db = await getDB();
    const row = await db.get<{ max_order: number }>(
      'SELECT COALESCE(MAX(step_order), 0) + 1 AS max_order FROM agent_process_log WHERE task_id = ?',
      [taskId],
    );
    return row?.max_order ?? 1;
  }
}
