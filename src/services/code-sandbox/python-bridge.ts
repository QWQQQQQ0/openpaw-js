/**
 * Python-engine bridge.
 *
 * This module provides the communication layer between the TypeScript
 * code-sandbox and the Python sidecar (python-engine/main.py).
 *
 * The actual Python execution is wired through the Tauri sidecar mechanism.
 * TODO: Wire to the actual sidecar bridge once the Rust IPC layer is updated.
 */

export interface PythonExecParams {
  code: string;
  timeoutSec?: number;
  params?: Record<string, unknown>;
}

export interface PythonExecResult {
  success: boolean;
  output: string;
  error?: string;
  result?: unknown;
  durationMs: number;
  truncated: boolean;
}

/**
 * Execute Python code via the python-engine sidecar.
 *
 * Currently a stub — will be wired to the actual Tauri sidecar bridge
 * when the Rust IPC layer exposes the `exec_python` tool.
 *
 * The python-engine/main.py already handles the `exec_python` tool.
 * This bridge function will invoke it once the Rust layer is updated.
 */
export async function bridgeExecPython(params: PythonExecParams): Promise<PythonExecResult> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _ = params;
  throw new Error(
    'Python execution is not yet wired to the sidecar bridge. ' +
    'The python-engine/main.py handles "exec_python" but the Rust IPC ' +
    'layer has not been updated to route calls to it.',
  );
}
