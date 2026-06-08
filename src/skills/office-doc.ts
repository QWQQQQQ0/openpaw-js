// Office document generation skill - Word, Excel, PPT

import type { Skill, SkillTool } from './skill';
import { SkillOk, SkillFail } from './skill';
import type { SkillResult, ToolDefinition } from '@/types/skill';

export class OfficeDocSkill implements Skill {
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
    this.id = config?.id ?? 'office_doc';
    this.name = config?.name ?? 'Office Document Generator';
    this.category = config?.category ?? 'Document';
    this.description = config?.description ?? 'Generate Word, Excel, and PowerPoint documents from structured content or Markdown.';
    this.tools = config?.tools?.map(t => ({ name: t.name, description: t.description, parameters: t.parameters, nameCn: t.nameCn, descriptionCn: t.descriptionCn })) ?? [];
    if (config?.nameCn) this.nameCn = config.nameCn;
    if (config?.descriptionCn) this.descriptionCn = config.descriptionCn;
    if (config?.categoryCn) this.categoryCn = config.categoryCn;
    if (config?.usage) this.usage = config.usage;
    if (config?.usageCn) this.usageCn = config.usageCn;
  }

  async execute(toolName: string, params: Record<string, unknown>): Promise<SkillResult> {
    try {
      switch (toolName) {
        case 'generate_word':
          return await this.generateWord(params);
        case 'generate_excel':
          return await this.generateExcel(params);
        case 'generate_ppt':
          return await this.generatePpt(params);
        default:
          return SkillFail(`Unknown tool: ${toolName}`);
      }
    } catch (e) {
      return SkillFail(`Tool execution failed: ${e}`);
    }
  }

  private async generateWord(params: Record<string, unknown>): Promise<SkillResult> {
    const title = params['title'] as string;
    const content = params['content'] as string;

    if (!title) return SkillFail('Title is required');
    if (!content) return SkillFail('Content is required');

    const { invoke } = await import('@tauri-apps/api/core');

    // Generate save path
    const filename = `${title}.docx`;
    const savePath = await this.getSavePath(filename);

    const result = await invoke<{
      saved: boolean;
      path?: string;
      data?: string;
      size: number;
    }>('word_generate', {
      title,
      content,
      subtitle: params['subtitle'] as string | undefined,
      author: params['author'] as string | undefined,
      savePath,
    });

    if (result.saved && result.path) {
      return SkillOk(`Word document generated: ${result.path}`, {
        path: result.path,
        size: result.size,
        format: 'docx',
      });
    }

    // If not saved (no path provided), offer download
    if (result.data) {
      await this.downloadFile(result.data, filename, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      return SkillOk(`Word document downloaded: ${filename}`, {
        filename,
        size: result.size,
        format: 'docx',
      });
    }

    return SkillOk('Word document generated', { size: result.size });
  }

  private async generateExcel(params: Record<string, unknown>): Promise<SkillResult> {
    const title = params['title'] as string;
    const sheets = params['sheets'] as Array<Record<string, unknown>>;

    if (!title) return SkillFail('Title is required');
    if (!sheets || sheets.length === 0) return SkillFail('At least one sheet is required');

    const { invoke } = await import('@tauri-apps/api/core');

    const filename = `${title}.xlsx`;
    const savePath = await this.getSavePath(filename);

    const result = await invoke<{
      saved: boolean;
      path?: string;
      data?: string;
      size: number;
    }>('excel_generate', {
      title,
      sheets,
      author: params['author'] as string | undefined,
      savePath,
    });

    if (result.saved && result.path) {
      return SkillOk(`Excel spreadsheet generated: ${result.path}`, {
        path: result.path,
        size: result.size,
        format: 'xlsx',
      });
    }

    if (result.data) {
      await this.downloadFile(result.data, filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      return SkillOk(`Excel spreadsheet downloaded: ${filename}`, {
        filename,
        size: result.size,
        format: 'xlsx',
      });
    }

    return SkillOk('Excel spreadsheet generated', { size: result.size });
  }

  private async generatePpt(params: Record<string, unknown>): Promise<SkillResult> {
    const title = params['title'] as string;

    if (!title) return SkillFail('Title is required');

    const slides = params['slides'] as Array<Record<string, unknown>> | undefined;
    const markdown = params['markdown'] as string | undefined;

    if (!slides && !markdown) return SkillFail('Either slides or markdown content is required');

    const { invoke } = await import('@tauri-apps/api/core');

    const filename = `${title}.pptx`;
    const savePath = await this.getSavePath(filename);

    const result = await invoke<{
      saved: boolean;
      path?: string;
      data?: string;
      size: number;
    }>('ppt_generate', {
      title,
      slides: slides ?? null,
      markdown: markdown ?? null,
      author: params['author'] as string | undefined,
      savePath,
    });

    if (result.saved && result.path) {
      return SkillOk(`PowerPoint presentation generated: ${result.path}`, {
        path: result.path,
        size: result.size,
        format: 'pptx',
      });
    }

    if (result.data) {
      await this.downloadFile(result.data, filename, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
      return SkillOk(`PowerPoint presentation downloaded: ${filename}`, {
        filename,
        size: result.size,
        format: 'pptx',
      });
    }

    return SkillOk('PowerPoint presentation generated', { size: result.size });
  }

  private async getSavePath(filename: string): Promise<string | undefined> {
    // In Tauri, we can use the dialog plugin to get a save path
    // For now, return undefined to use browser download
    // TODO: Implement Tauri dialog for native save
    return undefined;
  }

  private async downloadFile(base64Data: string, filename: string, mimeType: string): Promise<void> {
    // Convert base64 to blob and trigger download
    const byteCharacters = atob(base64Data);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: mimeType });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
