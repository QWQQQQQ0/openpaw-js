import type { ICacheService } from '@/interfaces/cache-service';
import type { SemanticAnnotation, UICacheRow } from '@/types/cache';
import type { PageComponent, TriggerInfo } from '@/types/page-component';

export class PageKnowledgeService {
  constructor(private cache: ICacheService) {}

  /** 从 SemanticAnnotation[] 提取语义能力摘要 */
  summarizeCapabilities(annotations: SemanticAnnotation[]): string[] {
    const seen = new Set<string>();
    const caps: string[] = [];
    for (const a of annotations) {
      // 跳过纯展示的内容区域（没有 capability 的）
      if (a.type === 'content' && !a.capability) continue;
      const desc = a.description || a.label;
      if (!desc || seen.has(desc)) continue;
      seen.add(desc);
      const cap = a.capability
        ? `${a.label}: ${a.capability.notes || a.capability.interactionType}`
        : `${a.label}: ${desc}`;
      caps.push(cap);
    }
    return caps;
  }

  /** 被动记录：agent 发现新页面时调用，如果已有则更新 annotations */
  async recordPageIfNew(
    fingerprint: string,
    appName: string,
    annotations: SemanticAnnotation[],
    parentFingerprint?: string | null,
    trigger?: TriggerInfo | null,
  ): Promise<void> {
    const existing = await this.cache.getUICache(fingerprint);
    if (!existing) return; // ui_cache 中没有，不额外创建
    // 如果传了 parent 信息且现有记录没有，更新之
    if (parentFingerprint && !existing.row.parent_fingerprint) {
      await this.cache.updatePageComponent(fingerprint, parentFingerprint, trigger ?? null);
    }
  }

  /** 为 LLM 生成当前页面的能力描述文本（含子组件信息） */
  async buildCapabilityPrompt(fingerprint: string): Promise<string | null> {
    const cached = await this.cache.getUICache(fingerprint);
    if (!cached || cached.annotations.length === 0) return null;

    const caps = this.summarizeCapabilities(cached.annotations);
    if (caps.length === 0) return null;

    const lines = caps.map(c => `  - ${c}`);

    // 查询子组件，补充"点击后展开"的详细信息
    const children = await this.cache.getChildrenOf(fingerprint);
    if (children.length > 0) {
      lines.push('');
      lines.push('可展开的子组件：');
      for (const child of children) {
        const trigger: TriggerInfo | null = child.trigger_json ? JSON.parse(child.trigger_json) : null;
        const childAnnotations: SemanticAnnotation[] = child.semantic_annotations ? JSON.parse(child.semantic_annotations) : [];
        const childCaps = this.summarizeCapabilities(childAnnotations);
        const triggerDesc = trigger?.detail || '未知触发方式';
        const childItems = childCaps.length > 0
          ? childCaps.map(c => `    - ${c}`).join('\n')
          : '    (尚未学习具体内容)';
        lines.push(`  ${triggerDesc}：`);
        lines.push(childItems);
      }
    }

    return `当前页面能力：\n${lines.join('\n')}`;
  }

  /** 查询应用的完整页面图，返回结构化 PageComponent[] */
  async getAppPageGraph(appName: string): Promise<PageComponent[]> {
    const rows = await this.cache.getAppPageGraph(appName);
    return rows.map(row => this.rowToComponent(row));
  }

  /** 获取某个组件的子组件 */
  async getChildren(parentFingerprint: string): Promise<PageComponent[]> {
    const rows = await this.cache.getChildrenOf(parentFingerprint);
    return rows.map(row => this.rowToComponent(row));
  }

  /** 单行转 PageComponent */
  private rowToComponent(row: UICacheRow): PageComponent {
    let annotations: SemanticAnnotation[] = [];
    try {
      annotations = JSON.parse(row.semantic_annotations);
    } catch { /* empty */ }

    let trigger: TriggerInfo | null = null;
    if (row.trigger_json) {
      try {
        trigger = JSON.parse(row.trigger_json);
      } catch { /* empty */ }
    }

    return {
      fingerprint: row.fingerprint,
      appId: row.app_name,
      name: this.inferPageName(row),
      parentFingerprint: row.parent_fingerprint ?? null,
      trigger,
      capabilities: this.summarizeCapabilities(annotations),
    };
  }

  /** 从 window_class 或 annotations 推断页面名称 */
  private inferPageName(row: UICacheRow): string {
    if (row.app_name && row.window_class) {
      return `${row.app_name}-${row.window_class}`;
    }
    return row.app_name || row.fingerprint.slice(0, 12);
  }
}
