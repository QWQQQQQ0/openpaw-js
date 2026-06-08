/**
 * Python code sandbox — stub that bridges to the python-engine sidecar.
 *
 * The actual Python execution is handled by `python-engine/main.py` which
 * exposes the `exec_python` tool via JSON-line stdin/stdout.
 *
 * This TypeScript side calls `bridgeExecPython()` — a shared module that
 * will be wired to the Tauri sidecar IPC once the Rust layer is updated.
 * For now it throws a descriptive error.
 */

import type { SandboxConfig, SandboxResult } from './sandbox-types';
import { bridgeExecPython } from './python-bridge';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute Python code via the python-engine sidecar.
 *
 * @param code    - The Python source to execute.
 * @param context - Variables to inject into the Python global scope.
 * @param config  - Sandbox configuration overrides.
 */
export async function executePython(
  code: string,
  context?: Record<string, unknown>,
  config?: Partial<SandboxConfig>,
): Promise<SandboxResult> {
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startTime = performance.now();

  try {
    const result = await bridgeExecPython({
      code,
      timeoutSec: Math.ceil(timeoutMs / 1000),
      params: context,
    });

    return {
      success: result.success,
      output: result.output,
      error: result.error,
      result: result.result,
      durationMs: result.durationMs,
      truncated: result.truncated,
    };
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - startTime);
    return {
      success: false,
      output: '',
      error: err instanceof Error ? err.message : String(err),
      durationMs,
      truncated: false,
    };
  }
}
