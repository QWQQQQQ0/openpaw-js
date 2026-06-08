import { TaskTreeDB } from './task-tree-db';
import { ProcessLogDB } from './process-log-db';
import { AgentMessageDB } from './agent-message-db';
import { ContextBuilder } from './context-builder';
import { codeSandboxService } from '@/services/code-sandbox';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { dirname, resolve, join, relative } from 'node:path';
import type { AgentType, LogAction, TaskStatus, ModuleContract, SplitDecision } from './types';
import type { TaskTreeRow, AgentProcessLogRow } from '@/db/types';
import type { IModelService } from '@/interfaces/model-service';
import type { ProviderConfig } from '@/types/provider';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentRunResult {
  success: boolean;
  taskId: string;
  agentId: string;
  outputFiles: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal types for tool system
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

interface ParsedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ParsedResponse {
  text: string;
  toolCalls: ParsedToolCall[];
}

interface ToolResult {
  success: boolean;
  /** Text summary / output for the LLM. */
  output: string;
  /** Path of a file that was written / read (if applicable). */
  filePath?: string;
  /** List of all output file paths accumulated by this tool call. */
  outputFiles?: string[];
  /** Structured data for the tool result. */
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic-compatible format)
// ---------------------------------------------------------------------------

const BASE_TOOLS: Record<string, ToolDef> = {
  think: {
    name: 'think',
    description: 'Record your internal reasoning and analysis steps. Use this to show your work before taking actions.',
    input_schema: {
      type: 'object',
      properties: {
        thought: { type: 'string', description: 'Your reasoning or analysis content.' },
      },
      required: ['thought'],
    },
  },

  write_file: {
    name: 'write_file',
    description: 'Write content to a file in the project directory. Creates parent directories automatically.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path within the project (e.g. src/index.ts).' },
        content: { type: 'string', description: 'Full file content to write.' },
        language: { type: 'string', description: 'Optional language hint (javascript, python, typescript, etc.).' },
      },
      required: ['path', 'content'],
    },
  },

  read_file: {
    name: 'read_file',
    description: 'Read the content of an existing file in the project directory.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path within the project.' },
      },
      required: ['path'],
    },
  },

  execute_code: {
    name: 'execute_code',
    description: 'Execute code in a sandboxed environment. Supports javascript (Node.js), python, and sql.',
    input_schema: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['javascript', 'python', 'sql'],
          description: 'The language to execute.',
        },
        code: { type: 'string', description: 'Source code to execute.' },
      },
      required: ['language', 'code'],
    },
  },

  send_message: {
    name: 'send_message',
    description: 'Send a message to another agent (e.g. architect or developer) to negotiate requirements or report issues.',
    input_schema: {
      type: 'object',
      properties: {
        toAgentId: { type: 'string', description: 'Target agent identifier (e.g. "architect-xxxx" or "developer-xxxx").' },
        subject: { type: 'string', description: 'Short subject line for the message.' },
        content: { type: 'string', description: 'Detailed message content.' },
        messageType: {
          type: 'string',
          description: 'Optional type hint (e.g. "question", "clarification", "issue").',
        },
      },
      required: ['toAgentId', 'subject', 'content'],
    },
  },

  submit_decision: {
    name: 'submit_decision',
    description: '[Architect only] Submit a split decision for the current module. Use this to communicate whether the module should be split into sub-modules.',
    input_schema: {
      type: 'object',
      properties: {
        should_split: { type: 'boolean', description: 'Whether the module should be split.' },
        score: { type: 'number', description: 'Confidence score 0-10. Only split if score >= 7.' },
        pros: { type: 'array', items: { type: 'string' }, description: 'Reasons in favor of splitting.' },
        cons: { type: 'array', items: { type: 'string' }, description: 'Reasons against splitting.' },
        reason: { type: 'string', description: 'Overall rationale for the decision.' },
        sub_modules: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Sub-module name.' },
              description: { type: 'string', description: 'What this sub-module does.' },
              files_estimate: { type: 'number', description: 'Estimated number of source files.' },
            },
            required: ['name', 'description'],
          },
          description: 'Required only if should_split is true.',
        },
      },
      required: ['should_split', 'score', 'pros', 'cons', 'reason'],
    },
  },

  finalize: {
    name: 'finalize',
    description: 'Mark the task as complete. Call this when you have finished implementing, reviewing, or integrating.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Brief summary of what was accomplished.' },
        outputFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of all file paths created or modified.',
        },
      },
      required: ['summary'],
    },
  },

  approve_review: {
    name: 'approve_review',
    description: '[Reviewer only] Approve the code under review, indicating it meets the contract and quality standards.',
    input_schema: {
      type: 'object',
      properties: {
        notes: { type: 'string', description: 'Optional approval notes or suggestions.' },
      },
      required: [],
    },
  },
};

// Tool sets per agent type
const AGENT_TOOLS: Record<AgentType, string[]> = {
  orchestrator: ['think'],
  architect: ['think', 'submit_decision'],
  developer: ['think', 'write_file', 'read_file', 'execute_code', 'send_message', 'finalize'],
  reviewer: ['think', 'read_file', 'send_message', 'approve_review'],
  integrator: ['think', 'write_file', 'read_file', 'execute_code', 'finalize'],
};

// ---------------------------------------------------------------------------
// Default project output base
// ---------------------------------------------------------------------------

const PROJECTS_BASE_DIR = resolve(process.cwd(), 'generated');

// ---------------------------------------------------------------------------
// AgentRunner
// ---------------------------------------------------------------------------

export class AgentRunner {
  private taskDB = new TaskTreeDB();
  private logDB = new ProcessLogDB();
  private msgDB = new AgentMessageDB();
  private contextBuilder = new ContextBuilder();
  private modelService: IModelService | null = null;
  private provider: ProviderConfig | null = null;
  private apiKey: string | null = null;

  // -- Public API -----------------------------------------------------------

  /**
   * Configure ModelService for unified LLM access.
   * When set, llmCallFn parameter becomes optional.
   */
  setModelService(modelService: IModelService, provider: ProviderConfig, apiKey: string): void {
    this.modelService = modelService;
    this.provider = provider;
    this.apiKey = apiKey;
  }

  /**
   * Create an LLM caller from ModelService.
   * Uses callWithTools() for proper tool call parsing.
   */
  private createLlmCallFn(): (messages: unknown[], tools: unknown[]) => AsyncGenerator<string> {
    if (!this.modelService || !this.provider || !this.apiKey) {
      throw new Error('No LLM caller configured: provide llmCallFn or call setModelService() first');
    }

    const { modelService, provider, apiKey } = this;
    return async function* (messages: unknown[], tools: unknown[]) {
      const { ModelScenario } = await import('@/services/llm-gateway/gateway');
      const stream = modelService.chatStream({
        scenario: ModelScenario.codeGeneration,
        messages: messages as Parameters<typeof modelService.chatStream>[0]['messages'],
        provider,
        apiKey,
        tools: tools as Record<string, unknown>[] | undefined,
      });

      for await (const chunk of stream) {
        if (chunk.startsWith('__ERROR__:')) {
          throw new Error(chunk.substring(10));
        }
        // Pass through all chunks including __TOOLS__: for tool parsing
        yield chunk;
      }
    };
  }

  /**
   * Generate a unique agent ID.
   * Format: `{agentType}-{shortUuid}`
   */
  generateAgentId(agentType: AgentType): string {
    const shortId = crypto.randomUUID().slice(0, 8);
    return `${agentType}-${shortId}`;
  }

  /**
   * Run a single agent for a specific task.
   *
   * Lifecycle:
   *  1. Generate + register agent ID
   *  2. Build agent-specific context (system + user prompt)
   *  3. Enter LLM tool-use loop (up to `maxTurns`)
   *  4. Log every action to ProcessLogDB
   *  5. Update task status when done
   */
  async runAgent(params: {
    taskId: string;
    agentType: AgentType;
    projectName: string;
    llmCallFn?: (messages: unknown[], tools: unknown[]) => AsyncGenerator<string>;
    maxTurns?: number;
  }): Promise<AgentRunResult> {
    const maxTurns = params.maxTurns ?? 10;
    const agentId = this.generateAgentId(params.agentType);

    // Resolve LLM caller: prefer llmCallFn, fallback to modelService
    const llmCallFn = params.llmCallFn ?? this.createLlmCallFn();

    // 1. Register agent on the task
    await this.taskDB.assignAgent(params.taskId, agentId, params.agentType);
    await this.taskDB.updateStatus(params.taskId, this._statusForAgentType(params.agentType));

    // 2. Load recovery state
    const task = await this.taskDB.getById(params.taskId);
    if (!task) {
      return { success: false, taskId: params.taskId, agentId, outputFiles: [], error: `Task not found: ${params.taskId}` };
    }

    const existingFiles = await this._loadExistingFiles(task, params.projectName);
    const previousLogs = await this.logDB.getByTask(params.taskId);

    let contract: ModuleContract | null = null;
    if (task.contract_json) {
      try { contract = JSON.parse(task.contract_json) as ModuleContract; } catch { /* non-contract JSON */ }
    }

    // 3. Build context
    const { systemPrompt, userPrompt } = this.contextBuilder.buildContext({
      agentType: params.agentType,
      task,
      contract,
      existingFiles,
      availableTools: AGENT_TOOLS[params.agentType],
      projectName: params.projectName,
      previousLogs,
    });

    // 4. Prepare messages + tools for the LLM
    const messages: unknown[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
    const toolDefs = AGENT_TOOLS[params.agentType].map((name) => BASE_TOOLS[name]);

    // Track output files
    const outputFilesSet = new Set<string>(existingFiles.map((f) => f.path));

    // 5. Main tool-use loop
    for (let turn = 0; turn < maxTurns; turn++) {
      let responseText = '';
      let toolJson: string | undefined;

      try {
        const gen = llmCallFn(messages, toolDefs);
        for await (const chunk of gen) {
          if (chunk.startsWith('__TOOLS__:')) {
            toolJson = chunk.substring(10);
          } else if (chunk.startsWith('__ERROR__:')) {
            throw new Error(chunk.substring(10));
          } else if (chunk.startsWith('__REASONING__:')) {
            // Skip reasoning chunks
          } else {
            responseText += chunk;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.taskDB.updateStatus(params.taskId, 'failed', msg);
        return { success: false, taskId: params.taskId, agentId, outputFiles: [...outputFilesSet], error: msg };
      }

      // Parse tool calls from __TOOLS__: marker or response JSON
      const parsed = toolJson
        ? this._parseToolCallsFromJson(toolJson, responseText)
        : this._parseResponse(responseText);

      if (parsed.toolCalls.length === 0) {
        // No tool calls — agent is signalling it's done (text-only answer)
        break;
      }

      // Build assistant message with text + tool_use blocks
      const assistantContent: unknown[] = [];
      if (parsed.text) {
        assistantContent.push({ type: 'text', text: parsed.text });
      }
      for (const tc of parsed.toolCalls) {
        assistantContent.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
      }
      messages.push({ role: 'assistant', content: assistantContent });

      // Execute each tool
      const toolResultContents: unknown[] = [];
      let finalized = false;

      for (const tc of parsed.toolCalls) {
        const result = await this._executeTool(tc, params.projectName, params.taskId, agentId, turn);

        toolResultContents.push({
          type: 'tool_result',
          tool_use_id: tc.id,
          content: JSON.stringify(result.output),
        });

        // Track output files from tool results
        if (result.filePath) outputFilesSet.add(result.filePath);
        if (result.outputFiles) result.outputFiles.forEach((p) => outputFilesSet.add(p));

        // Handle special tools
        if (tc.name === 'finalize') {
          finalized = true;
          if (result.data?.outputFiles) {
            (result.data.outputFiles as string[]).forEach((p: string) => outputFilesSet.add(p));
          }
          await this.taskDB.updateOutputFiles(params.taskId, JSON.stringify([...outputFilesSet]));
          await this.taskDB.updateStatus(params.taskId, 'done');

          return {
            success: true,
            taskId: params.taskId,
            agentId,
            outputFiles: [...outputFilesSet],
          };
        }

        if (tc.name === 'submit_decision') {
          await this.taskDB.updateDecision(params.taskId, JSON.stringify(tc.input));
        }

        if (tc.name === 'approve_review') {
          await this.taskDB.updateStatus(params.taskId, 'done');
        }
      }

      // Append tool results as a single user message (Anthropic convention)
      if (toolResultContents.length > 0) {
        messages.push({ role: 'user', content: toolResultContents });
      }

      if (finalized) break;
    }

    // Natural exit: no more tool calls or maxTurns reached without finalize
    const outputFilesArr = [...outputFilesSet];
    await this.taskDB.updateOutputFiles(params.taskId, JSON.stringify(outputFilesArr));
    await this.taskDB.updateStatus(params.taskId, 'done');

    return { success: true, taskId: params.taskId, agentId, outputFiles: outputFilesArr };
  }

  // -- Private: File helpers -----------------------------------------------

  /**
   * Resolve a project-relative path to an absolute filesystem path.
   */
  private _projectFilePath(projectName: string, filePath: string): string {
    // Prevent directory traversal
    const safe = join('/', filePath);
    return resolve(PROJECTS_BASE_DIR, projectName, safe.slice(1));
  }

  /**
   * Load all files that the task has already produced (for recovery context).
   * Reads them from disk and returns path + content pairs.
   */
  private async _loadExistingFiles(
    task: TaskTreeRow,
    projectName: string,
  ): Promise<Array<{ path: string; content: string }>> {
    if (!task.output_files_json) return [];

    let paths: string[];
    try {
      paths = JSON.parse(task.output_files_json) as string[];
    } catch {
      return [];
    }

    const result: Array<{ path: string; content: string }> = [];
    for (const p of paths) {
      try {
        const fullPath = this._projectFilePath(projectName, p);
        const content = await readFile(fullPath, 'utf-8');
        result.push({ path: p, content });
      } catch {
        // File may have been deleted or never written; skip.
      }
    }
    return result;
  }

  // -- Private: Tool execution ---------------------------------------------

  private async _executeTool(
    tc: ParsedToolCall,
    projectName: string,
    taskId: string,
    agentId: string,
    turn: number,
  ): Promise<ToolResult> {
    const action = tc.name as LogAction;
    const startTime = Date.now();

    try {
      switch (tc.name) {
        case 'think': {
          const thought = String(tc.input.thought ?? '');
          await this.logDB.append(taskId, agentId, turn, 'analyze', {
            decisionRationale: thought,
          });
          return { success: true, output: `[thought recorded: ${thought.slice(0, 200)}]` };
        }

        case 'write_file': {
          const filePath = String(tc.input.path ?? '');
          const content = String(tc.input.content ?? '');
          const fullPath = this._projectFilePath(projectName, filePath);

          await mkdir(dirname(fullPath), { recursive: true });
          await writeFile(fullPath, content, 'utf-8');

          const durationMs = Date.now() - startTime;
          await this.logDB.append(taskId, agentId, turn, 'write_file', {
            filePath,
            outputSummary: `Wrote ${filePath} (${content.length} chars)`,
            durationMs,
          });

          return {
            success: true,
            output: `Successfully wrote ${filePath} (${content.length} characters).`,
            filePath,
          };
        }

        case 'read_file': {
          const filePath = String(tc.input.path ?? '');
          const fullPath = this._projectFilePath(projectName, filePath);
          const content = await readFile(fullPath, 'utf-8');

          await this.logDB.append(taskId, agentId, turn, 'read_file', {
            filePath,
            inputSummary: `Read ${filePath}`,
            durationMs: Date.now() - startTime,
          });

          return {
            success: true,
            output: content,
            filePath,
          };
        }

        case 'execute_code': {
          const language = String(tc.input.language ?? 'javascript');
          const code = String(tc.input.code ?? '');
          const result = await codeSandboxService.execute(
            language as 'javascript' | 'python' | 'sql',
            code,
          );

          await this.logDB.append(taskId, agentId, turn, 'shell_exec', {
            inputSummary: `Executed ${language} code (${code.length} chars)`,
            outputSummary: result.success ? result.output.slice(0, 500) : `ERROR: ${(result.error ?? '').slice(0, 500)}`,
            durationMs: result.durationMs,
          });

          return {
            success: result.success,
            output: result.success
              ? `Exit code 0. Output:\n${result.output}`
              : `Error:\n${result.error ?? 'unknown error'}`,
          };
        }

        case 'send_message': {
          const toAgentId = String(tc.input.toAgentId ?? '');
          const subject = String(tc.input.subject ?? '');
          const content = String(tc.input.content ?? '');
          const messageType = String(tc.input.messageType ?? 'negotiation');

          const msgId = await this.msgDB.send(agentId, toAgentId, taskId, messageType, subject, content);

          await this.logDB.append(taskId, agentId, turn, 'negotiate', {
            outputSummary: `Message to ${toAgentId}: ${subject}`,
          });

          return {
            success: true,
            output: `Message sent to ${toAgentId}. ID: ${msgId}`,
          };
        }

        case 'submit_decision': {
          const decision: SplitDecision = {
            should_split: Boolean(tc.input.should_split),
            score: Number(tc.input.score ?? 0),
            pros: Array.isArray(tc.input.pros) ? tc.input.pros as string[] : [],
            cons: Array.isArray(tc.input.cons) ? tc.input.cons as string[] : [],
            reason: String(tc.input.reason ?? ''),
            sub_modules: Array.isArray(tc.input.sub_modules)
              ? tc.input.sub_modules as SplitDecision['sub_modules']
              : undefined,
          };

          await this.logDB.append(taskId, agentId, turn, 'decide_split', {
            decisionRationale: `Score: ${decision.score}. ${decision.reason}`,
          });

          return {
            success: true,
            output: `Decision: ${decision.should_split ? 'SPLIT' : 'NO SPLIT'} (score: ${decision.score}/10). ${decision.reason}`,
            data: { decision } as unknown as Record<string, unknown>,
          };
        }

        case 'finalize': {
          const summary = String(tc.input.summary ?? '');
          const outputFiles = Array.isArray(tc.input.outputFiles)
            ? (tc.input.outputFiles as string[])
            : [];

          await this.logDB.append(taskId, agentId, turn, 'done', {
            outputSummary: summary,
          });

          return {
            success: true,
            output: `Task finalized: ${summary}`,
            outputFiles,
            data: { outputFiles, summary },
          };
        }

        case 'approve_review': {
          const notes = String(tc.input.notes ?? '');

          await this.logDB.append(taskId, agentId, turn, 'review', {
            outputSummary: notes ? `Approved: ${notes}` : 'Approved without notes.',
          });

          return {
            success: true,
            output: `Review approved.${notes ? ` Notes: ${notes}` : ''}`,
          };
        }

        default: {
          return { success: false, output: `Unknown tool: ${tc.name}` };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.logDB.append(taskId, agentId, turn, action, {
        errorInfo: msg,
      });
      return { success: false, output: `Error executing ${tc.name}: ${msg}` };
    }
  }

  // -- Private: LLM response handling --------------------------------------

  /**
   * Parse tool calls from __TOOLS__: marker (ModelService format).
   * Format: [{"id":"...","function":{"name":"...","arguments":"{...}"}}]
   */
  private _parseToolCallsFromJson(toolJson: string, text: string): ParsedResponse {
    try {
      const list = JSON.parse(toolJson) as Array<Record<string, unknown>>;
      const toolCalls: ParsedToolCall[] = list.map((tc) => {
        const func = tc['function'] as Record<string, unknown>;
        return {
          id: String(tc['id'] ?? ''),
          name: String(func['name'] ?? ''),
          input: this._parseJsonArg(func['arguments'] as string) ?? {},
        };
      });
      return { text, toolCalls };
    } catch {
      // Fallback: try parsing as response JSON
      return this._parseResponse(toolJson);
    }
  }

  /**
   * Consume an AsyncGenerator and accumulate all string chunks.
   */
  private async _accumulateGenerator(gen: AsyncGenerator<string>): Promise<string> {
    const parts: string[] = [];
    for await (const chunk of gen) {
      parts.push(chunk);
    }
    return parts.join('');
  }

  /**
   * Parse the LLM response text into text content and tool calls.
   *
   * Supports:
   *  - Anthropic format (JSON with `content` array containing `tool_use` blocks)
   *  - OpenAI format (JSON with `choices[0].message.tool_calls`)
   *  - Plain text (no tool calls)
   */
  private _parseResponse(raw: string): ParsedResponse {
    // Try JSON formats first
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Plain text — no tool calls
      return { text: raw, toolCalls: [] };
    }

    if (typeof parsed !== 'object' || parsed === null) {
      return { text: raw, toolCalls: [] };
    }

    const obj = parsed as Record<string, unknown>;

    // --- Anthropic format: { content: [ { type: "tool_use", ... } ] } ---
    if (Array.isArray(obj.content)) {
      const blocks = obj.content as Array<Record<string, unknown>>;
      const textParts: string[] = [];
      const toolCalls: ParsedToolCall[] = [];
      let toolIdCounter = 0;

      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(String(block.text ?? ''));
        } else if (block.type === 'tool_use' || block.type === 'tool_call') {
          toolCalls.push({
            id: String(block.id ?? `tool_${++toolIdCounter}`),
            name: String(block.name ?? ''),
            input: (block.input ?? block.arguments ?? {}) as Record<string, unknown>,
          });
        }
      }

      return { text: textParts.join(''), toolCalls };
    }

    // --- OpenAI format: { choices: [ { message: { tool_calls: [...] } } ] } ---
    if (Array.isArray(obj.choices)) {
      const choice = (obj.choices as Array<Record<string, unknown>>)[0];
      if (choice?.message) {
        const msg = choice.message as Record<string, unknown>;
        const text = String(msg.content ?? '');
        const rawCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined;

        if (Array.isArray(rawCalls)) {
          const toolCalls: ParsedToolCall[] = rawCalls.map((tc) => ({
            id: String(tc.id ?? ''),
            name: String((tc.function as Record<string, unknown> | undefined)?.name ?? tc.name ?? ''),
            input: this._parseJsonArg((tc.function as Record<string, unknown> | undefined)?.arguments as string | undefined) ??
                   (tc.input as Record<string, unknown> ?? {}),
          }));
          return { text, toolCalls };
        }

        return { text, toolCalls: [] };
      }
    }

    // --- Vertex AI / bare format: { tool_calls: [...] } ---
    if (Array.isArray(obj.tool_calls)) {
      const rawCalls = obj.tool_calls as Array<Record<string, unknown>>;
      const toolCalls: ParsedToolCall[] = rawCalls.map((tc) => ({
        id: String(tc.id ?? ''),
        name: String(tc.name ?? (tc.function as Record<string, unknown> | undefined)?.name ?? ''),
        input: (tc.input ?? this._parseJsonArg((tc.function as Record<string, unknown> | undefined)?.arguments as string | undefined) ?? {}) as Record<string, unknown>,
      }));
      return { text: String(obj.content ?? obj.text ?? ''), toolCalls };
    }

    // Fallback: raw JSON object but no tool calls found
    return { text: raw, toolCalls: [] };
  }

  /**
   * Safely parse a JSON string argument (OpenAI-style).
   */
  private _parseJsonArg(arg?: string): Record<string, unknown> | undefined {
    if (!arg) return undefined;
    try {
      const parsed = JSON.parse(arg);
      if (typeof parsed === 'object' && parsed !== null) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
    return undefined;
  }

  // -- Private: Helpers ----------------------------------------------------

  private _statusForAgentType(agentType: AgentType): TaskStatus {
    switch (agentType) {
      case 'architect': return 'analyzing';
      case 'developer': return 'coding';
      case 'reviewer': return 'reviewing';
      case 'integrator': return 'coding';
      default: return 'pending';
    }
  }
}
