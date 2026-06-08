// Built-in skill providing Developer Agent code generation tools.
// Pattern follows AppBuilderSkill and OfficeDocSkill.

import type { Skill, SkillTool } from './skill';
import { SkillOk, SkillFail } from './skill';
import type { SkillResult } from '@/types/skill';
import { codeSandboxService } from '@/services/code-sandbox';
import { CodeRegistryDB } from '@/services/code-registry';
import type { LLMMessage } from '@/types/message';
import type { IModelService } from '@/interfaces/model-service';
import type { ProviderConfig } from '@/types/provider';
import { ModelScenario } from '@/services/llm-gateway/gateway';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** In-memory fallback for file operations when Tauri backend is not wired. */
const fileCache = new Map<string, string>();

/** Try to write a file via Tauri plugin-fs, falling back to memory cache. */
async function tryWriteFile(filePath: string, content: string): Promise<{ ok: boolean; path: string; method: string }> {
  fileCache.set(filePath, content);

  // Attempt 1: @tauri-apps/plugin-fs (optional dependency, not guaranteed to be installed)
  try {
    // @ts-expect-error — plugin-fs is optional; failure is caught at runtime
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    await writeTextFile(filePath, content);
    return { ok: true, path: filePath, method: 'plugin-fs' };
  } catch {
    // fall through
  }

  // Attempt 2: @tauri-apps/api/core invoke (Rust command may not exist)
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('write_file', { path: filePath, content });
    return { ok: true, path: filePath, method: 'invoke' };
  } catch {
    // fall through — file is still in memory cache
  }

  return { ok: true, path: filePath, method: 'memory-cache' };
}

/** Try to read a file via Tauri plugin-fs, falling back to memory cache. */
async function tryReadFile(filePath: string): Promise<{ ok: boolean; content: string; method: string }> {
  // Check memory cache first
  const cached = fileCache.get(filePath);
  if (cached !== undefined) {
    return { ok: true, content: cached, method: 'memory-cache' };
  }

  // Attempt 1: @tauri-apps/plugin-fs
  try {
    // @ts-expect-error — plugin-fs is optional; failure is caught at runtime
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const content = await readTextFile(filePath);
    fileCache.set(filePath, content);
    return { ok: true, content, method: 'plugin-fs' };
  } catch {
    // fall through
  }

  // Attempt 2: @tauri-apps/api/core invoke
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const content = await invoke<string>('read_file', { path: filePath });
    fileCache.set(filePath, content);
    return { ok: true, content, method: 'invoke' };
  } catch {
    // fall through
  }

  return { ok: false, content: '', method: 'none' };
}

/** Extract code blocks from markdown content (```lang ... ```). */
function extractCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const regex = /```(?:\w+)?\s*\n?([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const code = match[1].trim();
    if (code.length > 0) blocks.push(code);
  }
  return blocks;
}

/** Build a code-generation prompt. */
function buildCodeGenPrompt(task: string, language: string, context?: string, constraints?: string): string {
  const parts: string[] = [
    `You are a code generation assistant. Generate ${language} code for the following task:`,
    '',
    task,
  ];
  if (context) {
    parts.push('', '## Context', '', context);
  }
  if (constraints) {
    parts.push('', '## Constraints', '', constraints);
  }
  parts.push('', '## Output Format', '', 'Output ONLY the code inside a single markdown code block:');
  parts.push('', `\`\`\`${language}`, '// your code here', '```');
  parts.push('', 'Do NOT include any explanation outside the code block.');
  return parts.join('\n');
}

/** Build a code-iteration (fix) prompt. */
function buildCodeIterPrompt(task: string, code: string, language: string, error: string): string {
  return [
    `You are fixing ${language} code. The original task:`,
    '',
    task,
    '',
    'Current code:',
    '',
    `\`\`\`${language}`,
    code,
    '```',
    '',
    'The code produced the following error when executed:',
    '',
    error,
    '',
    'Fix the code so it runs without errors. Output ONLY the fixed code inside a markdown code block.',
    `\`\`\`${language}`,
    '// fixed code here',
    '```',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Skill
// ---------------------------------------------------------------------------

const codeRegistry = new CodeRegistryDB();

export class CodeToolsSkill implements Skill {
  id = 'code_tools';
  name = 'Code Tools';
  nameCn = '代码工具';
  category = 'Code Generation';
  categoryCn = '代码生成';
  description = 'Code generation, file I/O, and sandbox execution tools for Developer Agents';
  descriptionCn = '开发者代理的代码生成、文件 I/O 和沙箱执行工具';

  tools: SkillTool[] = [
    {
      name: 'write_file',
      description: 'Write code content to a file in the project directory',
      nameCn: '写入文件',
      descriptionCn: '将代码内容写入项目目录中的文件',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: 'Relative file path within the project (e.g. src/utils/helper.ts)',
          },
          content: { type: 'string', description: 'File content to write' },
        },
        required: ['file_path', 'content'],
      },
    },
    {
      name: 'read_file',
      description: 'Read file content from the project directory',
      nameCn: '读取文件',
      descriptionCn: '从项目目录读取文件内容',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'Relative file path within the project' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'generate_code',
      description: 'Generate code using the LLM for a given task description. Returns extracted code blocks.',
      nameCn: '生成代码',
      descriptionCn: '根据任务描述使用 LLM 生成代码，返回提取到的代码块',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Description of the code to generate' },
          language: { type: 'string', description: 'Target programming language (javascript, python, typescript, etc.)' },
          context: { type: 'string', description: 'Additional context or existing code to build upon' },
          constraints: { type: 'string', description: 'Constraints or requirements the code must satisfy' },
        },
        required: ['task', 'language'],
      },
    },
    {
      name: 'execute_code',
      description: 'Execute code in a sandboxed environment and return the result',
      nameCn: '执行代码',
      descriptionCn: '在沙箱环境中执行代码并返回结果',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Source code to execute' },
          language: {
            type: 'string',
            description: 'Language (javascript, python, sql, html)',
            enum: ['javascript', 'python', 'sql', 'html'],
          },
          timeout_ms: { type: 'number', description: 'Execution timeout in milliseconds (default 30000)' },
        },
        required: ['code', 'language'],
      },
    },
    {
      name: 'iterate_code',
      description: 'Execute code in a loop, fixing errors via LLM up to 3 iterations. Returns final result and fixed code.',
      nameCn: '迭代代码',
      descriptionCn: '循环执行代码，通过 LLM 修复错误（最多 3 次迭代），返回最终结果和修复后的代码',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Original task description' },
          code: { type: 'string', description: 'Initial code to execute and iterate on' },
          language: {
            type: 'string',
            description: 'Language (javascript, python, sql, html)',
            enum: ['javascript', 'python', 'sql', 'html'],
          },
          max_iterations: { type: 'number', description: 'Maximum fix iterations (default 3)' },
        },
        required: ['task', 'code', 'language'],
      },
    },
    {
      name: 'save_code',
      description: 'Save generated code to the code registry for future reuse',
      nameCn: '保存代码',
      descriptionCn: '将生成的代码保存到代码注册表以供将来重用',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name for the saved code' },
          code: { type: 'string', description: 'Source code to save' },
          language: {
            type: 'string',
            description: 'Language (javascript, python, sql, html)',
            enum: ['javascript', 'python', 'sql', 'html'],
          },
          description: { type: 'string', description: 'Optional description of the code' },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional tags for searching',
          },
        },
        required: ['name', 'code', 'language'],
      },
    },
    {
      name: 'list_code',
      description: 'Search and list saved code entries from the code registry',
      nameCn: '列出代码',
      descriptionCn: '从代码注册表搜索并列出已保存的代码条目',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional search term for name or description' },
          language: { type: 'string', description: 'Optional language filter' },
          tag: { type: 'string', description: 'Optional tag filter' },
        },
      },
    },
  ];

  private llmCaller: ((messages: LLMMessage[]) => AsyncGenerator<string>) | null = null;
  private modelService: IModelService | null = null;
  private provider: ProviderConfig | null = null;
  private apiKey: string | null = null;

  /**
   * Set the LLM calling function used by generate_code and iterate_code.
   * Called by AgentRunner before agents are dispatched.
   * @deprecated Use setModelService() instead for unified LLM access.
   */
  setLlmCaller(fn: (messages: LLMMessage[]) => AsyncGenerator<string>): void {
    this.llmCaller = fn;
  }

  /**
   * Set ModelService for unified LLM access.
   * When set, llmCaller becomes optional.
   */
  setModelService(modelService: IModelService, provider: ProviderConfig, apiKey: string): void {
    this.modelService = modelService;
    this.provider = provider;
    this.apiKey = apiKey;
  }

  /**
   * Get the LLM caller: prefer modelService, fallback to llmCaller.
   */
  private getLlmCaller(): (messages: LLMMessage[]) => AsyncGenerator<string> {
    if (this.llmCaller) return this.llmCaller;

    if (this.modelService && this.provider && this.apiKey) {
      const { modelService, provider, apiKey } = this;
      return async function* (messages: LLMMessage[]) {
        const stream = modelService.chatStream({
          scenario: ModelScenario.codeGeneration,
          messages,
          provider,
          apiKey,
        });

        for await (const chunk of stream) {
          if (chunk.startsWith('__ERROR__:')) {
            throw new Error(chunk.substring(10));
          }
          if (chunk.startsWith('__REASONING__:')) continue;
          if (chunk.startsWith('__TOOLS__:')) continue;
          yield chunk;
        }
      };
    }

    throw new Error('LLM caller is not configured. Call setModelService() or setLlmCaller() first.');
  }

  // -----------------------------------------------------------------------
  // Execute dispatch
  // -----------------------------------------------------------------------

  async execute(toolName: string, params: Record<string, unknown>): Promise<SkillResult> {
    try {
      switch (toolName) {
        case 'write_file':
          return await this.handleWriteFile(params);
        case 'read_file':
          return await this.handleReadFile(params);
        case 'generate_code':
          return await this.handleGenerateCode(params);
        case 'execute_code':
          return await this.handleExecuteCode(params);
        case 'iterate_code':
          return await this.handleIterateCode(params);
        case 'save_code':
          return await this.handleSaveCode(params);
        case 'list_code':
          return await this.handleListCode(params);
        default:
          return SkillFail(`Unknown tool: ${toolName}`);
      }
    } catch (e) {
      return SkillFail(`Tool "${toolName}" failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // -----------------------------------------------------------------------
  // write_file
  // -----------------------------------------------------------------------

  private async handleWriteFile(params: Record<string, unknown>): Promise<SkillResult> {
    const filePath = params['file_path'] as string;
    const content = params['content'] as string;

    if (!filePath) return SkillFail('file_path is required');
    if (content === undefined) return SkillFail('content is required');

    const result = await tryWriteFile(filePath, content);

    if (result.method === 'memory-cache') {
      return SkillOk(`File written to memory cache: ${filePath}`, {
        file_path: filePath,
        method: result.method,
        note: 'Tauri file-system plugin is not available. Content is cached in memory only.',
      });
    }

    return SkillOk(`File written successfully: ${filePath} (via ${result.method})`, {
      file_path: filePath,
      method: result.method,
    });
  }

  // -----------------------------------------------------------------------
  // read_file
  // -----------------------------------------------------------------------

  private async handleReadFile(params: Record<string, unknown>): Promise<SkillResult> {
    const filePath = params['file_path'] as string;
    if (!filePath) return SkillFail('file_path is required');

    const result = await tryReadFile(filePath);
    if (!result.ok) {
      return SkillFail(`File not found: ${filePath}`, { file_path: filePath });
    }

    return SkillOk(`File read: ${filePath} (via ${result.method})`, {
      file_path: filePath,
      content: result.content,
      method: result.method,
    });
  }

  // -----------------------------------------------------------------------
  // generate_code
  // -----------------------------------------------------------------------

  private async handleGenerateCode(params: Record<string, unknown>): Promise<SkillResult> {
    const task = params['task'] as string;
    const language = params['language'] as string;
    const context = params['context'] as string | undefined;
    const constraints = params['constraints'] as string | undefined;

    if (!task) return SkillFail('task is required');
    if (!language) return SkillFail('language is required');

    let llmCaller: (messages: LLMMessage[]) => AsyncGenerator<string>;
    try {
      llmCaller = this.getLlmCaller();
    } catch (e) {
      return SkillFail(e instanceof Error ? e.message : String(e));
    }

    const prompt = buildCodeGenPrompt(task, language, context, constraints);
    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a code generation assistant. Output only code blocks.' },
      { role: 'user', content: prompt },
    ];

    let fullResponse = '';
    const stream = llmCaller(messages);
    for await (const chunk of stream) {
      fullResponse += chunk;
    }

    const codeBlocks = extractCodeBlocks(fullResponse);
    if (codeBlocks.length === 0) {
      return SkillFail('No code blocks found in LLM response', { response: fullResponse });
    }

    return SkillOk(`Generated ${codeBlocks.length} code block(s)`, {
      code: codeBlocks.join('\n\n'),
      allBlocks: codeBlocks,
      language,
      task,
    });
  }

  // -----------------------------------------------------------------------
  // execute_code
  // -----------------------------------------------------------------------

  private async handleExecuteCode(params: Record<string, unknown>): Promise<SkillResult> {
    const code = params['code'] as string;
    const language = params['language'] as string;
    const timeoutMs = (params['timeout_ms'] as number) ?? 30000;

    if (!code) return SkillFail('code is required');
    if (!language) return SkillFail('language is required');

    const result = await codeSandboxService.execute(
      language as Parameters<typeof codeSandboxService.execute>[0],
      code,
      undefined,
      { timeoutMs },
    );

    return SkillOk(
      result.success ? 'Code executed successfully' : 'Code execution failed',
      {
        success: result.success,
        output: result.output,
        error: result.error,
        result: result.result,
        durationMs: result.durationMs,
        truncated: result.truncated,
      },
    );
  }

  // -----------------------------------------------------------------------
  // iterate_code
  // -----------------------------------------------------------------------

  private async handleIterateCode(params: Record<string, unknown>): Promise<SkillResult> {
    const task = params['task'] as string;
    const language = params['language'] as string;
    const maxIterations = Math.min(params['max_iterations'] as number ?? 3, 3);
    let code = params['code'] as string;

    if (!task) return SkillFail('task is required');
    if (!language) return SkillFail('language is required');
    if (!code) return SkillFail('code is required');

    let llmCaller: (messages: LLMMessage[]) => AsyncGenerator<string>;
    try {
      llmCaller = this.getLlmCaller();
    } catch (e) {
      return SkillFail(e instanceof Error ? e.message : String(e));
    }

    for (let i = 0; i < maxIterations; i++) {
      // Execute current code
      const result = await codeSandboxService.execute(
        language as Parameters<typeof codeSandboxService.execute>[0],
        code,
      );

      if (result.success) {
        return SkillOk(`Code executed successfully on iteration ${i + 1}`, {
          code,
          iteration: i + 1,
          output: result.output,
          result: result.result,
          durationMs: result.durationMs,
        });
      }

      // If this was the last iteration, return the error
      if (i >= maxIterations - 1) {
        return SkillFail(`Code failed after ${maxIterations} iterations`, {
          code,
          iteration: i + 1,
          error: result.error ?? 'Unknown error',
          output: result.output,
        });
      }

      // Try to fix via LLM
      const fixPrompt = buildCodeIterPrompt(task, code, language, result.error ?? 'Unknown error');
      const messages: LLMMessage[] = [
        { role: 'system', content: 'You are a code debugging assistant. Fix the code.' },
        { role: 'user', content: fixPrompt },
      ];

      let fixResponse = '';
      const stream = llmCaller(messages);
      for await (const chunk of stream) {
        fixResponse += chunk;
      }

      const fixedBlocks = extractCodeBlocks(fixResponse);
      if (fixedBlocks.length > 0) {
        code = fixedBlocks[0];
      }
      // If no code blocks, keep the original code and loop again
    }

    // Shouldn't reach here, but just in case
    return SkillFail('Code iteration did not produce a successful result');
  }

  // -----------------------------------------------------------------------
  // save_code
  // -----------------------------------------------------------------------

  private async handleSaveCode(params: Record<string, unknown>): Promise<SkillResult> {
    const name = params['name'] as string;
    const code = params['code'] as string;
    const language = params['language'] as string;
    const description = (params['description'] as string) ?? '';
    const tags = (params['tags'] as string[]) ?? [];

    if (!name) return SkillFail('name is required');
    if (!code) return SkillFail('code is required');
    if (!language) return SkillFail('language is required');

    try {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await codeRegistry.save({
        id,
        name,
        description,
        language: language as CodeEntryLanguage,
        code,
        params: [],
        tags,
        createdAt: now,
        updatedAt: now,
        hitCount: 0,
      });

      return SkillOk(`Code "${name}" saved successfully`, { id, name, language });
    } catch (e) {
      return SkillFail(`Failed to save code: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // -----------------------------------------------------------------------
  // list_code
  // -----------------------------------------------------------------------

  private async handleListCode(params: Record<string, unknown>): Promise<SkillResult> {
    const search = params['search'] as string | undefined;
    const language = params['language'] as string | undefined;
    const tag = params['tag'] as string | undefined;

    try {
      const entries = await codeRegistry.list({ search, language, tag });
      return SkillOk(`Found ${entries.length} code entr${entries.length === 1 ? 'y' : 'ies'}`, {
        entries: entries.map((e) => ({
          id: e.id,
          name: e.name,
          description: e.description,
          language: e.language,
          tags: e.tags,
          createdAt: e.createdAt,
          hitCount: e.hitCount,
        })),
        count: entries.length,
      });
    } catch (e) {
      return SkillFail(`Failed to list code: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

// Re-export for convenience
type CodeEntryLanguage = 'javascript' | 'python' | 'sql' | 'html';
