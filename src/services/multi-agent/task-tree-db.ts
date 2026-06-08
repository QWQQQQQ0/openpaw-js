import { getDB } from '@/db';
import type { TaskTreeRow } from '@/db/types';
import type { AgentType, TaskStatus } from './types';

export class TaskTreeDB {
  /**
   * Create a root task node for a project.
   * Returns the generated UUID.
   */
  async createRoot(projectName: string, agentId: string): Promise<string> {
    const db = await getDB();
    const id = crypto.randomUUID();
    await db.execute(
      `INSERT INTO task_tree (id, project_name, module_name, module_path, agent_id, agent_type, status, depth, sort_order)
       VALUES (?, ?, ?, ?, ?, 'orchestrator', 'analyzing', 0, 0)`,
      [id, projectName, projectName, projectName, agentId],
    );
    return id;
  }

  /**
   * Create a child task node under a parent.
   * Returns the generated UUID.
   */
  async createChild(
    parentId: string,
    moduleName: string,
    modulePath: string,
    agentType: AgentType,
    depth: number,
    contractJson?: string,
  ): Promise<string> {
    const db = await getDB();

    // Determine the next sort_order among siblings
    const maxOrder = await db.get<{ max_sort: number }>(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS max_sort FROM task_tree WHERE parent_module_id = ?',
      [parentId],
    );
    const sortOrder = maxOrder?.max_sort ?? 0;

    const id = crypto.randomUUID();
    await db.execute(
      `INSERT INTO task_tree (id, project_name, module_name, module_path, parent_module_id, agent_type, depth, sort_order, contract_json, status)
       SELECT ?, project_name, ?, ?, ?, ?, ?, ?, ?, 'pending' FROM task_tree WHERE id = ?`,
      [id, moduleName, modulePath, parentId, agentType, depth, sortOrder, contractJson ?? null, parentId],
    );
    return id;
  }

  /**
   * Get a task node by its ID.
   */
  async getById(id: string): Promise<TaskTreeRow | null> {
    const db = await getDB();
    return db.get<TaskTreeRow>('SELECT * FROM task_tree WHERE id = ?', [id]);
  }

  /**
   * Get all children of a task node, ordered by sort_order.
   */
  async getChildren(parentId: string): Promise<TaskTreeRow[]> {
    const db = await getDB();
    return db.query<TaskTreeRow>(
      'SELECT * FROM task_tree WHERE parent_module_id = ? ORDER BY sort_order ASC',
      [parentId],
    );
  }

  /**
   * Get all task nodes for a project.
   */
  async getByProject(projectName: string): Promise<TaskTreeRow[]> {
    const db = await getDB();
    return db.query<TaskTreeRow>(
      'SELECT * FROM task_tree WHERE project_name = ? ORDER BY depth ASC, sort_order ASC',
      [projectName],
    );
  }

  /**
   * Get all unfinished task nodes for a project (status NOT IN ('done', 'failed')).
   */
  async getUnfinished(projectName: string): Promise<TaskTreeRow[]> {
    const db = await getDB();
    return db.query<TaskTreeRow>(
      "SELECT * FROM task_tree WHERE project_name = ? AND status NOT IN ('done', 'failed') ORDER BY depth ASC, sort_order ASC",
      [projectName],
    );
  }

  /**
   * Update the status of a task node.
   */
  async updateStatus(id: string, status: TaskStatus, errorInfo?: string): Promise<void> {
    const db = await getDB();
    if (errorInfo !== undefined) {
      await db.execute(
        "UPDATE task_tree SET status = ?, error_info = ?, updated_at = datetime('now') WHERE id = ?",
        [status, errorInfo, id],
      );
    } else {
      await db.execute(
        "UPDATE task_tree SET status = ?, updated_at = datetime('now') WHERE id = ?",
        [status, id],
      );
    }
  }

  /**
   * Update the agent ID assigned to a task.
   */
  async updateAgent(id: string, agentId: string): Promise<void> {
    const db = await getDB();
    await db.execute(
      "UPDATE task_tree SET agent_id = ?, updated_at = datetime('now') WHERE id = ?",
      [agentId, id],
    );
  }

  /**
   * Update the contract JSON of a task node.
   */
  async updateContract(id: string, contractJson: string): Promise<void> {
    const db = await getDB();
    await db.execute(
      "UPDATE task_tree SET contract_json = ?, updated_at = datetime('now') WHERE id = ?",
      [contractJson, id],
    );
  }

  /**
   * Update the split decision JSON of a task node.
   */
  async updateDecision(id: string, decisionJson: string): Promise<void> {
    const db = await getDB();
    await db.execute(
      "UPDATE task_tree SET decision_json = ?, updated_at = datetime('now') WHERE id = ?",
      [decisionJson, id],
    );
  }

  /**
   * Update the output files JSON of a task node.
   */
  async updateOutputFiles(id: string, filesJson: string): Promise<void> {
    const db = await getDB();
    await db.execute(
      "UPDATE task_tree SET output_files_json = ?, updated_at = datetime('now') WHERE id = ?",
      [filesJson, id],
    );
  }

  /**
   * Assign a specific agent to a task and update its type.
   */
  async assignAgent(id: string, agentId: string, agentType: AgentType): Promise<void> {
    const db = await getDB();
    await db.execute(
      "UPDATE task_tree SET agent_id = ?, agent_type = ?, updated_at = datetime('now') WHERE id = ?",
      [agentId, agentType, id],
    );
  }
}
