import { getDB } from '@/db';
import type { AgentMessageRow } from '@/db/types';

export class AgentMessageDB {
  /**
   * Send a message from one agent to another.
   * Returns the generated UUID.
   */
  async send(
    fromAgentId: string,
    toAgentId: string,
    taskId: string,
    messageType: string,
    subject: string,
    content: string,
    replyToId?: string,
  ): Promise<string> {
    const db = await getDB();
    const id = crypto.randomUUID();
    await db.execute(
      `INSERT INTO agent_messages (id, from_agent_id, to_agent_id, task_id, message_type, subject, content, reply_to_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, fromAgentId, toAgentId, taskId, messageType, subject, content, replyToId ?? null],
    );
    return id;
  }

  /**
   * Get all messages for a task, ordered by creation time.
   */
  async getByTask(taskId: string): Promise<AgentMessageRow[]> {
    const db = await getDB();
    return db.query<AgentMessageRow>(
      'SELECT * FROM agent_messages WHERE task_id = ? ORDER BY created_at ASC',
      [taskId],
    );
  }

  /**
   * Get all unresolved messages for a task (resolved = 0).
   */
  async getUnresolved(taskId: string): Promise<AgentMessageRow[]> {
    const db = await getDB();
    return db.query<AgentMessageRow>(
      'SELECT * FROM agent_messages WHERE task_id = ? AND resolved = 0 ORDER BY created_at ASC',
      [taskId],
    );
  }

  /**
   * Resolve a message by setting the resolution text and marking it as resolved.
   */
  async resolve(id: string, resolution: string): Promise<void> {
    const db = await getDB();
    await db.execute(
      "UPDATE agent_messages SET resolved = 1, resolution = ? WHERE id = ?",
      [resolution, id],
    );
  }

  /**
   * Get the full conversation thread starting from a root message (reply_to_id chain).
   * If the given replyToId is null, returns the root message chain starting from that message.
   */
  async getConversation(replyToId: string): Promise<AgentMessageRow[]> {
    const db = await getDB();
    // This returns the message with the given ID plus all replies to it, recursively
    // SQLite recursive CTE for the thread
    return db.query<AgentMessageRow>(
      `WITH RECURSIVE thread AS (
         SELECT * FROM agent_messages WHERE id = ?
         UNION ALL
         SELECT m.* FROM agent_messages m
         INNER JOIN thread t ON m.reply_to_id = t.id
       )
       SELECT * FROM thread ORDER BY created_at ASC`,
      [replyToId],
    );
  }
}
