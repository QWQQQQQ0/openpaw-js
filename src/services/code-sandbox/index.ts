/**
 * CodeSandboxService — unified facade for all code sandboxes.
 *
 * Routes execution requests to the appropriate sandbox based on language:
 *   - `javascript` → `executeJavaScript()`  (new Function + Proxy)
 *   - `python`     → `executePython()`       (python-engine sidecar stub)
 *   - `sql`        → `executeSQL()`          (getDB adapter)
 *   - `html`       → `executeHTML()`         (not yet implemented)
 *
 * Usage:
 * ```ts
 * const sandbox = new CodeSandboxService();
 * const jsResult   = await sandbox.execute('javascript', '1 + 1');
 * const sqlResult  = await sandbox.execute('sql', 'SELECT * FROM skills LIMIT 5');
 * const pyResult   = await sandbox.execute('python', 'print("hello")');
 * ```
 */

import type { CodeLanguage, SandboxConfig, SandboxResult } from './sandbox-types';
import { executeJavaScript } from './sandbox-js';
import { executeSQL } from './sandbox-sql';
import { executePython } from './sandbox-python';

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SandboxConfig = {
  timeoutMs: 30_000,
  allowNetwork: false,
  allowDDL: false,
  maxRows: 1000,
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class CodeSandboxService {
  /**
   * Execute code in a sandboxed environment.
   *
   * @param language - Target language (`javascript`, `python`, `sql`, or `html`).
   * @param code     - Source code to execute.
   * @param context  - Variables to inject into the sandbox scope.
   * @param config   - Partial config overrides (merged with defaults).
   */
  async execute(
    language: CodeLanguage,
    code: string,
    context?: Record<string, unknown>,
    config?: Partial<SandboxConfig>,
  ): Promise<SandboxResult> {
    const merged: SandboxConfig = { ...DEFAULT_CONFIG, ...config };

    switch (language) {
      case 'javascript':
        return executeJavaScript(code, context, merged);
      case 'python':
        return executePython(code, context, merged);
      case 'sql':
        return executeSQL(code, merged);
      case 'html':
        return this._executeHTML(code, merged);
      default:
        return {
          success: false,
          output: '',
          error: `Unsupported language: ${language as string}`,
          durationMs: 0,
          truncated: false,
        };
    }
  }

  /**
   * HTML sandbox placeholder.
   *
   * TODO: Implement HTML sandbox (iframe with srcdoc, sandbox attribute).
   */
  private async _executeHTML(
    _code: string,
    _config: SandboxConfig,
  ): Promise<SandboxResult> {
    return {
      success: false,
      output: '',
      error: 'HTML sandbox is not yet implemented',
      durationMs: 0,
      truncated: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Singleton export
// ---------------------------------------------------------------------------

export const codeSandboxService = new CodeSandboxService();

export type { CodeLanguage, SandboxConfig, SandboxResult } from './sandbox-types';
