// 来源: lib/skills/app_builder_skill.dart

import { getDB } from '@/db';
import type { Skill, SkillTool } from './skill';
import { SkillOk, SkillFail } from './skill';
import type { SkillResult, ToolDefinition } from '@/types/skill';

export class AppBuilderSkill implements Skill {
  id: string;
  name: string;
  category: string;
  description: string;
  tools: SkillTool[];
  nameCn?: string;
  descriptionCn?: string;
  categoryCn?: string;
  usage?: string;
  usageCn?: string;

  constructor(config?: { id?: string; name?: string; category?: string; description?: string; tools?: ToolDefinition[]; nameCn?: string; descriptionCn?: string; categoryCn?: string; usage?: string; usageCn?: string }) {
    this.id = config?.id ?? 'app_builder';
    this.name = config?.name ?? 'App Builder';
    this.category = config?.category ?? 'Application';
    this.description = config?.description ?? 'Save, list, update, and delete generated applications.';
    this.tools = config?.tools?.map(t => ({ name: t.name, description: t.description, parameters: t.parameters, nameCn: t.nameCn, descriptionCn: t.descriptionCn })) ?? [];
    if (config?.nameCn) this.nameCn = config.nameCn;
    if (config?.descriptionCn) this.descriptionCn = config.descriptionCn;
    if (config?.categoryCn) this.categoryCn = config.categoryCn;
    if (config?.usage) this.usage = config.usage;
    if (config?.usageCn) this.usageCn = config.usageCn;
  }

  async execute(toolName: string, params: Record<string, unknown>): Promise<SkillResult> {
    switch (toolName) {
      case 'save_app': return this.saveApp(params);
      case 'list_apps': return this.listApps();
      case 'get_app': return this.getApp(params);
      case 'update_app': return this.updateApp(params);
      case 'delete_app': return this.deleteApp(params);
      default: return SkillFail(`Unknown tool: ${toolName}`);
    }
  }

  private async saveApp(params: Record<string, unknown>): Promise<SkillResult> {
    const name = params['name'] as string;
    const description = (params['description'] as string) ?? '';
    const code = params['code'] as string;

    if (!name) return SkillFail('App name is required');
    if (!code) return SkillFail('App code is required');

    try {
      const db = await getDB();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.execute(
        'INSERT INTO savedApps (id, name, code, created_at) VALUES (?, ?, ?, ?)',
        [id, name, code, now],
      );
      return SkillOk(`App "${name}" saved successfully`, { id, name, description, code, created_at: now });
    } catch (e) {
      return SkillFail(`Failed to save app: ${e}`);
    }
  }

  private async listApps(): Promise<SkillResult> {
    try {
      const db = await getDB();
      const rows = await db.query<{ id: string; name: string; code: string; created_at: string }>(
        'SELECT id, name, created_at FROM savedApps ORDER BY created_at DESC',
      );
      return SkillOk(`Found ${rows.length} saved app${rows.length !== 1 ? 's' : ''}`, {
        apps: rows.map((r) => ({ id: r.id, name: r.name, created_at: r.created_at })),
        count: rows.length,
      });
    } catch (e) {
      return SkillFail(`Failed to list apps: ${e}`);
    }
  }

  private async getApp(params: Record<string, unknown>): Promise<SkillResult> {
    const id = params['id'] as string;
    if (!id) return SkillFail('App ID is required');

    try {
      const db = await getDB();
      const rows = await db.query<{ id: string; name: string; code: string; created_at: string }>(
        'SELECT id, name, code, created_at FROM savedApps WHERE id = ?',
        [id],
      );
      if (rows.length === 0) return SkillFail(`App not found: ${id}`);
      const app = rows[0];
      return SkillOk(`App found: ${app.name}`, { id: app.id, name: app.name, code: app.code, created_at: app.created_at });
    } catch (e) {
      return SkillFail(`Failed to get app: ${e}`);
    }
  }

  private async updateApp(params: Record<string, unknown>): Promise<SkillResult> {
    const id = params['id'] as string;
    if (!id) return SkillFail('App ID is required');

    try {
      const db = await getDB();
      const existing = await db.query<{ id: string; name: string; code: string }>(
        'SELECT id, name, code FROM savedApps WHERE id = ?',
        [id],
      );
      if (existing.length === 0) return SkillFail(`App not found: ${id}`);

      const name = (params['name'] as string) ?? existing[0].name;
      const code = (params['code'] as string) ?? existing[0].code;
      await db.execute(
        'UPDATE savedApps SET name = ?, code = ? WHERE id = ?',
        [name, code, id],
      );
      return SkillOk(`App "${name}" updated successfully`);
    } catch (e) {
      return SkillFail(`Failed to update app: ${e}`);
    }
  }

  private async deleteApp(params: Record<string, unknown>): Promise<SkillResult> {
    const id = params['id'] as string;
    if (!id) return SkillFail('App ID is required');

    try {
      const db = await getDB();
      await db.execute('DELETE FROM savedApps WHERE id = ?', [id]);
      return SkillOk('App deleted');
    } catch (e) {
      return SkillFail(`Failed to delete app: ${e}`);
    }
  }
}
