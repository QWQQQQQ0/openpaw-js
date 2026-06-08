import { getDB } from '@/db';
import type { CodeRegistryRow } from '@/db/types';
import type { CodeEntry, CodeQueryFilter } from './code-registry-types';

function rowToEntry(row: CodeRegistryRow): CodeEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    language: row.language as CodeEntry['language'],
    code: row.code,
    params: JSON.parse(row.params_json || '[]'),
    tags: JSON.parse(row.tags_json || '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hitCount: row.hit_count,
  };
}

export class CodeRegistryDB {
  async save(entry: CodeEntry): Promise<void> {
    const db = await getDB();
    await db.execute(
      `INSERT OR REPLACE INTO code_registry
       (id, name, description, language, code, params_json, tags_json, created_at, updated_at, hit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.name,
        entry.description,
        entry.language,
        entry.code,
        JSON.stringify(entry.params),
        JSON.stringify(entry.tags),
        entry.createdAt,
        entry.updatedAt,
        entry.hitCount,
      ],
    );
  }

  async get(id: string): Promise<CodeEntry | null> {
    const db = await getDB();
    const row = await db.get<CodeRegistryRow>(
      'SELECT * FROM code_registry WHERE id = ?',
      [id],
    );
    if (!row) return null;
    return rowToEntry(row);
  }

  async list(filter?: CodeQueryFilter): Promise<CodeEntry[]> {
    const db = await getDB();
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter?.language) {
      conditions.push('language = ?');
      params.push(filter.language);
    }
    if (filter?.tag) {
      conditions.push("tags_json LIKE ?");
      params.push(`%"${filter.tag}"%`);
    }
    if (filter?.search) {
      conditions.push('(name LIKE ? OR description LIKE ?)');
      const pattern = `%${filter.search}%`;
      params.push(pattern, pattern);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await db.query<CodeRegistryRow>(
      `SELECT * FROM code_registry ${where} ORDER BY updated_at DESC`,
      params,
    );
    return rows.map(rowToEntry);
  }

  async update(id: string, updates: Partial<CodeEntry>): Promise<void> {
    const db = await getDB();
    const sets: string[] = [];
    const params: unknown[] = [];

    if (updates.name !== undefined) {
      sets.push('name = ?');
      params.push(updates.name);
    }
    if (updates.description !== undefined) {
      sets.push('description = ?');
      params.push(updates.description);
    }
    if (updates.language !== undefined) {
      sets.push('language = ?');
      params.push(updates.language);
    }
    if (updates.code !== undefined) {
      sets.push('code = ?');
      params.push(updates.code);
    }
    if (updates.params !== undefined) {
      sets.push('params_json = ?');
      params.push(JSON.stringify(updates.params));
    }
    if (updates.tags !== undefined) {
      sets.push('tags_json = ?');
      params.push(JSON.stringify(updates.tags));
    }
    if (updates.hitCount !== undefined) {
      sets.push('hit_count = ?');
      params.push(updates.hitCount);
    }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    params.push(id);

    await db.execute(
      `UPDATE code_registry SET ${sets.join(', ')} WHERE id = ?`,
      params,
    );
  }

  async delete(id: string): Promise<void> {
    const db = await getDB();
    await db.execute('DELETE FROM code_registry WHERE id = ?', [id]);
  }

  async incrementHitCount(id: string): Promise<void> {
    const db = await getDB();
    await db.execute(
      "UPDATE code_registry SET hit_count = hit_count + 1, updated_at = datetime('now') WHERE id = ?",
      [id],
    );
  }
}
