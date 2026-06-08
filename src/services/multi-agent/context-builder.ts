import type { AgentType, ModuleContract } from './types';
import type { TaskTreeRow, AgentProcessLogRow } from '@/db/types';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function formatExistingFiles(
  files: Array<{ path: string; content: string }>,
): string {
  if (files.length === 0) return '(no existing files)';
  return files
    .map((f) => {
      const preview =
        f.content.length > 500
          ? f.content.slice(0, 500) + '\n... (truncated)'
          : f.content;
      return `--- ${f.path} ---\n${preview}`;
    })
    .join('\n\n');
}

function formatContract(contract: ModuleContract | null): string {
  if (!contract) return '(no contract assigned yet)';
  return JSON.stringify(contract, null, 2);
}

function formatLogs(logs?: AgentProcessLogRow[]): string {
  if (!logs || logs.length === 0) return '(no previous logs)';
  return logs
    .map(
      (l) =>
        `[step ${l.step_order}] ${l.action}${l.file_path ? ` on ${l.file_path}` : ''}${l.output_summary ? `: ${l.output_summary}` : ''}${l.error_info ? ` ERROR: ${l.error_info}` : ''}`,
    )
    .join('\n');
}

function formatTools(tools: string[]): string {
  return tools.map((t) => `  - \`${t}\``).join('\n');
}

// ---------------------------------------------------------------------------
// ContextBuilder
// ---------------------------------------------------------------------------

export class ContextBuilder {
  /**
   * Build the system + user prompt context for a specific agent type.
   */
  buildContext(params: {
    agentType: AgentType;
    task: TaskTreeRow;
    contract: ModuleContract | null;
    existingFiles: Array<{ path: string; content: string }>;
    availableTools: string[];
    projectName: string;
    previousLogs?: AgentProcessLogRow[];
  }): { systemPrompt: string; userPrompt: string } {
    switch (params.agentType) {
      case 'architect':
        return this._buildArchitectContext(params);
      case 'developer':
        return this._buildDeveloperContext(params);
      case 'reviewer':
        return this._buildReviewerContext(params);
      case 'integrator':
        return this._buildIntegratorContext(params);
      case 'orchestrator':
        // Orchestrator is not called as an agent; fall through.
        return {
          systemPrompt: 'You are the orchestrator agent.',
          userPrompt: params.task.module_name,
        };
      default:
        throw new Error(`Unknown agent type: ${params.agentType as string}`);
    }
  }

  // -----------------------------------------------------------------------
  // Architect
  // -----------------------------------------------------------------------

  private _buildArchitectContext(params: {
    task: TaskTreeRow;
    contract: ModuleContract | null;
    existingFiles: Array<{ path: string; content: string }>;
    availableTools: string[];
    projectName: string;
    previousLogs?: AgentProcessLogRow[];
  }): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = [
      '# Role',
      '',
      'You are a **software architect agent** in a multi-agent code generation system.',
      'Your job is to analyze a module requirement and decide whether it should be',
      'split into smaller sub-modules, or implemented directly.',
      '',
      '## Anti-hallucination rules (CRITICAL)',
      '',
      '1. **Depth limit** — If the current depth is >= 3, you MUST NOT split.',
      '   The system maximum is 4 levels deep including the root.',
      '2. **Score threshold** — Only recommend splitting if you have a clear',
      '   reason that the module genuinely contains multiple independently',
      '   implementable sub-modules. Score your confidence from 0-10.',
      '   Only if score >= 7 should you split.',
      '3. **"不拆分是正常的"** — It is completely normal and expected to NOT split.',
      '   Many modules are simple enough to implement as-is. Do NOT feel',
      '   pressure to invent sub-modules. Prefer a flat, simple structure.',
      '4. **Each sub-module must be independently implementable** — a sub-module',
      '   should have a clear single responsibility, well-defined interface,',
      '   and minimal coupling to siblings.',
      '5. **Estimate file count** — For each proposed sub-module, give a',
      '   realistic estimate of how many files it will need (< 5 for small,',
      '   5-15 for medium, 15-30 for large modules).',
      '',
      '## Available tools',
      '',
      formatTools(params.availableTools),
      '',
      '## Output format',
      '',
      'Use the `submit_decision` tool to communicate your split decision.',
      'Include your reasoning, pros/cons, and the score.',
    ].join('\n');

    const userPrompt = [
      `# Module to analyze`,
      ``,
      `**Project:** ${params.projectName}`,
      `**Module:** ${params.task.module_name}`,
      `**Module path:** ${params.task.module_path}`,
      `**Current depth:** ${params.task.depth}`,
      `**Current status:** ${params.task.status}`,
      ``,
      `## Parent contract`,
      ``,
      formatContract(params.contract),
      ``,
      `## Previous logs`,
      ``,
      formatLogs(params.previousLogs),
      ``,
      `## Instructions`,
      ``,
      `Analyze the module above. Decide if it should be split into sub-modules`,
      `or implemented directly. Remember: it is normal NOT to split.`,
    ].join('\n');

    return { systemPrompt, userPrompt };
  }

  // -----------------------------------------------------------------------
  // Developer
  // -----------------------------------------------------------------------

  private _buildDeveloperContext(params: {
    task: TaskTreeRow;
    contract: ModuleContract | null;
    existingFiles: Array<{ path: string; content: string }>;
    availableTools: string[];
    projectName: string;
    previousLogs?: AgentProcessLogRow[];
  }): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = [
      '# Role',
      '',
      'You are a **developer agent** in a multi-agent code generation system.',
      'Your job is to implement a software module based on a contract.',
      '',
      '## Guidelines',
      '',
      '1. **Follow the contract exactly** — the types, function signatures, and',
      '   imports specified in the contract must be implemented as documented.',
      '2. **Existing files** — If files already exist (recovery mode), load and',
      '   review them before making changes.',
      '3. **Write production-quality code** — proper error handling, input',
      '   validation, and documentation.',
      '4. **Test your code** — use the `execute_code` tool to run quick sanity',
      '   checks after writing files.',
      '5. **Output files** — when you are done, call the `finalize` tool with a',
      '   summary and the list of file paths you created or modified.',
      '',
      '## Available tools',
      '',
      formatTools(params.availableTools),
    ].join('\n');

    const userPrompt = [
      `# Development task`,
      ``,
      `**Project:** ${params.projectName}`,
      `**Module:** ${params.task.module_name}`,
      `**Module path:** ${params.task.module_path}`,
      ``,
      `## Contract`,
      ``,
      formatContract(params.contract),
      ``,
      `## Existing files`,
      ``,
      formatExistingFiles(params.existingFiles),
      ``,
      params.previousLogs && params.previousLogs.length > 0
        ? `## Previous work (recovery)\n\n${formatLogs(params.previousLogs)}\n`
        : '## Fresh task\n\nNo previous work exists for this module. Start from scratch.\n',
      ``,
      `## Instructions`,
      ``,
      `Implement the module according to the contract above.`,
      `Use \`write_file\` to create files, \`execute_code\` to test,`,
      `and \`finalize\` when done.`,
    ].join('\n');

    return { systemPrompt, userPrompt };
  }

  // -----------------------------------------------------------------------
  // Reviewer
  // -----------------------------------------------------------------------

  private _buildReviewerContext(params: {
    task: TaskTreeRow;
    contract: ModuleContract | null;
    existingFiles: Array<{ path: string; content: string }>;
    availableTools: string[];
    projectName: string;
    previousLogs?: AgentProcessLogRow[];
  }): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = [
      '# Role',
      '',
      'You are a **reviewer agent** in a multi-agent code generation system.',
      'Your job is to review generated code against the module contract and',
      'ensure correctness, completeness, and quality.',
      '',
      '## Review criteria',
      '',
      '1. **Contract compliance** — all exported functions and types from the',
      '   contract must exist in the code. Signatures must match.',
      '2. **Correctness** — the code should compile/run without errors.',
      '3. **Completeness** — all edge cases and error paths should be handled.',
      '4. **Code quality** — naming, structure, documentation, and separation',
      '   of concerns.',
      '5. **Security** — no injection vulnerabilities, no hardcoded secrets.',
      '',
      '## How to report',
      '',
      '- If the code passes review, call the `approve_review` tool.',
      '- If the code has issues, call the `send_message` tool to notify the',
      '  developer agent with specific, actionable feedback.',
    ].join('\n');

    const userPrompt = [
      `# Review task`,
      ``,
      `**Project:** ${params.projectName}`,
      `**Module:** ${params.task.module_name}`,
      `**Module path:** ${params.task.module_path}`,
      ``,
      `## Expected contract`,
      ``,
      formatContract(params.contract),
      ``,
      `## Code to review`,
      ``,
      formatExistingFiles(params.existingFiles),
      ``,
      `## Previous review attempts`,
      ``,
      formatLogs(params.previousLogs),
    ].join('\n');

    return { systemPrompt, userPrompt };
  }

  // -----------------------------------------------------------------------
  // Integrator
  // -----------------------------------------------------------------------

  private _buildIntegratorContext(params: {
    task: TaskTreeRow;
    contract: ModuleContract | null;
    existingFiles: Array<{ path: string; content: string }>;
    availableTools: string[];
    projectName: string;
    previousLogs?: AgentProcessLogRow[];
  }): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = [
      '# Role',
      '',
      'You are an **integrator agent** in a multi-agent code generation system.',
      'Your job is to assemble all independently-developed modules into a',
      'cohesive system. You handle cross-module imports, barrel files,',
      'configuration, and final wiring.',
      '',
      '## Responsibilities',
      '',
      '1. **Barrel files** — create `index.ts` files that re-export public',
      '   APIs from each module.',
      '2. **Import validation** — verify all cross-module imports resolve',
      '   correctly and fix any broken import paths.',
      '3. **Root wiring** — create the main entry point that ties all modules',
      '   together.',
      '4. **Configuration** — ensure shared config and types are consistent',
      '   across modules.',
      '5. **Final verification** — run a quick sanity check to ensure the',
      '   system can be loaded without errors.',
      '',
      '## Available tools',
      '',
      formatTools(params.availableTools),
    ].join('\n');

    const userPrompt = [
      `# Integration task`,
      ``,
      `**Project:** ${params.projectName}`,
      `**Root module:** ${params.task.module_name}`,
      ``,
      `## All generated files`,
      ``,
      formatExistingFiles(params.existingFiles),
      ``,
      `## Instructions`,
      ``,
      `Review all files, create barrel exports, fix cross-module imports,`,
      `and produce a final integrated system. Call \`finalize\` when done.`,
    ].join('\n');

    return { systemPrompt, userPrompt };
  }
}
