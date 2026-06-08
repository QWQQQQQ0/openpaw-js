/**
 * CodeGateway — code generation entry point.
 *
 * Called by the Admin Agent when existing tools cannot satisfy a user's
 * code-generation request.  It:
 *   1. Judges the complexity of the request ('simple' / 'complex')
 *   2. Routes to the appropriate handler:
 *      - simple  → inline single-agent generation
 *      - complex → multi-agent orchestrator (Phase 5, forward reference)
 */

import { Orchestrator } from './multi-agent';
import type { CodeLanguage } from './code-sandbox/sandbox-types';
import type { IModelService } from '@/interfaces/model-service';
import type { ProviderConfig } from '@/types/provider';
import { ModelScenario } from '@/services/llm-gateway/gateway';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LlmCallFn = (
  messages: unknown[],
  tools?: unknown[],
) => AsyncGenerator<string>;

export interface GatewayParams {
  userRequest: string;
  projectName: string;
  /** @deprecated Use modelService + provider + apiKey instead */
  llmCallFn?: LlmCallFn;
  modelService?: IModelService;
  provider?: ProviderConfig;
  apiKey?: string;
}

export interface GatewayResult {
  success: boolean;
  result?: unknown;
  skillRegistered?: string;
  error?: string;
}

interface ComplexityJudgment {
  complexity: 'simple' | 'complex';
  reason: string;
  estimatedFiles: number;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

function buildComplexityJudgePrompt(request: string): string {
  return [
    'You are a software project complexity analyzer. Given a user request, classify it into one of two categories:',
    '',
    'SIMPLE: A single-file change, a small utility function, a straightforward script, or a minor bug fix.',
    '        Typically involves 1 file and can be done by a single developer agent.',
    '',
    'COMPLEX: Multi-file changes, full feature implementation, new module/package creation,',
    '         integration of multiple components, database schema changes, or anything requiring',
    '         architectural decisions. Typically involves 2+ files and may benefit from multiple agents.',
    '',
    'Respond ONLY with a JSON object in this exact format (no markdown, no explanation):',
    '{',
    '  "complexity": "simple" | "complex",',
    '  "reason": "Brief 1-sentence justification",',
    '  "estimatedFiles": <number>',
    '}',
    '',
    'User request:',
    request,
  ].join('\n');
}

function buildCodeGenSinglePrompt(request: string, projectName: string): string {
  return [
    `You are a developer working on the project "${projectName}".`,
    'Generate the code needed to satisfy the following request.',
    '',
    request,
    '',
    'Output the code inside markdown code blocks. For each file, specify the file path as a comment:',
    '',
    '```typescript',
    '// src/path/to/file.ts',
    '// ... code',
    '```',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Gateway
// ---------------------------------------------------------------------------

export class CodeGateway {
  private orchestrator: Orchestrator | null = null;

  /**
   * Main entry point.
   * 1. Judge complexity.
   * 2. Route to simple or complex handler.
   * 3. Return result.
   */
  async handleRequest(params: GatewayParams): Promise<GatewayResult> {
    const { userRequest, projectName, llmCallFn, modelService, provider, apiKey } = params;

    // Resolve LLM caller: prefer modelService, fallback to llmCallFn
    const llmCaller = modelService && provider && apiKey
      ? this.createLlmCaller(modelService, provider, apiKey)
      : llmCallFn;

    if (!llmCaller) {
      return {
        success: false,
        error: 'CodeGateway error: Either llmCallFn or (modelService + provider + apiKey) must be provided',
      };
    }

    try {
      // Step 1: Judge complexity
      const judgment = await this.judgeComplexity(userRequest, llmCaller);

      // Step 2: Route
      if (judgment.complexity === 'simple') {
        return await this.handleSimple(userRequest, projectName, llmCaller);
      }

      return await this.handleComplex(userRequest, projectName, llmCaller);
    } catch (e) {
      return {
        success: false,
        error: `CodeGateway error: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  /**
   * Create an LLM caller from ModelService (unified path).
   * This preserves caching, length checks, and system prompt injection.
   */
  private createLlmCaller(
    modelService: IModelService,
    provider: ProviderConfig,
    apiKey: string,
  ): LlmCallFn {
    return async function* (messages: unknown[], tools?: unknown[]) {
      const stream = modelService.chatStream({
        scenario: ModelScenario.codeGeneration,
        messages: messages as Parameters<typeof modelService.chatStream>[0]['messages'],
        provider,
        apiKey,
        tools: tools as Record<string, unknown>[] | undefined,
      });

      for await (const chunk of stream) {
        // Skip internal markers, yield only content
        if (chunk.startsWith('__ERROR__:')) {
          throw new Error(chunk.substring(10));
        }
        if (chunk.startsWith('__REASONING__:')) continue;
        if (chunk.startsWith('__TOOLS__:')) continue;
        yield chunk;
      }
    };
  }

  // -----------------------------------------------------------------------
  // Complexity judge
  // -----------------------------------------------------------------------

  private async judgeComplexity(
    userRequest: string,
    llmCallFn: LlmCallFn,
  ): Promise<ComplexityJudgment> {
    const prompt = buildComplexityJudgePrompt(userRequest);
    const messages = [
      { role: 'user' as const, content: prompt },
    ];

    let fullResponse = '';
    const stream = llmCallFn(messages);
    for await (const chunk of stream) {
      fullResponse += chunk;
    }

    // Try to parse JSON from the response
    const jsonMatch = fullResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      // Fallback: treat as complex to be safe
      return {
        complexity: 'complex',
        reason: 'Failed to parse LLM judgment — defaulting to complex',
        estimatedFiles: 2,
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]) as ComplexityJudgment;
      return {
        complexity: parsed.complexity === 'simple' ? 'simple' : 'complex',
        reason: parsed.reason ?? 'No reason provided',
        estimatedFiles: typeof parsed.estimatedFiles === 'number' ? parsed.estimatedFiles : 1,
      };
    } catch {
      return {
        complexity: 'complex',
        reason: 'Failed to parse LLM judgment JSON — defaulting to complex',
        estimatedFiles: 2,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Simple path
  // -----------------------------------------------------------------------

  private async handleSimple(
    userRequest: string,
    projectName: string,
    llmCallFn: LlmCallFn,
  ): Promise<GatewayResult> {
    const prompt = buildCodeGenSinglePrompt(userRequest, projectName);
    const messages = [
      { role: 'system', content: 'You are a skilled developer. Generate production-quality code.' },
      { role: 'user', content: prompt },
    ];

    let fullResponse = '';
    const stream = llmCallFn(messages);
    for await (const chunk of stream) {
      fullResponse += chunk;
    }

    // Extract code blocks
    const codeBlocks = this.extractCodeBlocks(fullResponse);

    if (codeBlocks.length === 0) {
      // If no code blocks, return the raw response as text
      return {
        success: true,
        result: {
          type: 'text',
          content: fullResponse,
        },
      };
    }

    return {
      success: true,
      result: {
        type: 'code',
        blocks: codeBlocks.map((b) => ({
          language: b.language,
          code: b.code,
          filePath: this.inferFilePath(b.language, projectName),
        })),
        rawResponse: fullResponse,
      },
    };
  }

  // -----------------------------------------------------------------------
  // Complex path — delegates to multi-agent orchestrator (Phase 5)
  // -----------------------------------------------------------------------

  private async handleComplex(
    userRequest: string,
    projectName: string,
    llmCallFn: LlmCallFn,
  ): Promise<GatewayResult> {
    // Lazily create the orchestrator
    if (!this.orchestrator) {
      try {
        this.orchestrator = new Orchestrator();
      } catch {
        // Orchestrator not yet implemented — fall back to simple path
        console.warn(
          '[CodeGateway] Orchestrator not available, falling back to simple handler',
        );
        return this.handleSimple(userRequest, projectName, llmCallFn);
      }
    }

    const result = await this.orchestrator.runGenerationTask({
      userRequest,
      projectName,
      llmCallFn: llmCallFn as (messages: unknown[], tools?: unknown[]) => AsyncGenerator<string>,
    });

    return {
      success: result.success,
      result: result.result,
      error: result.error,
    };
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private extractCodeBlocks(text: string): Array<{ language: string; code: string }> {
    const blocks: Array<{ language: string; code: string }> = [];
    const regex = /```(\w*)\s*\n?([\s\S]*?)```/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      const language = match[1] || 'text';
      const code = match[2].trim();
      if (code.length > 0) {
        blocks.push({ language, code });
      }
    }
    return blocks;
  }

  private inferFilePath(language: string, projectName: string): string {
    const extMap: Record<string, string> = {
      javascript: '.js',
      typescript: '.ts',
      python: '.py',
      sql: '.sql',
      html: '.html',
      css: '.css',
      jsx: '.jsx',
      tsx: '.tsx',
      json: '.json',
      yaml: '.yml',
      markdown: '.md',
      bash: '.sh',
    };
    const ext = extMap[language] ?? `.${language}`;
    return `generated/${projectName}/output${ext}`;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

export const codeGateway = new CodeGateway();
