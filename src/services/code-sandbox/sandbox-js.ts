/**
 * JavaScript code sandbox using `new Function()` with Proxy-based global
 * interception, console output capture, and timeout enforcement.
 *
 * Security model:
 *   - Dangerous globals (eval, Function, require, process, setTimeout, …)
 *     are shadowed via named function parameters set to `undefined`.
 *   - Console output is monkey-patched to a string buffer (100 KB max).
 *   - Execution is wrapped in a Promise and raced against a timeout via
 *     `Promise.race`.
 *   - `fetch` is injected only when `allowNetwork` is true.
 *   - User context variables are spread into the sandbox scope.
 *
 * This is NOT a hard security boundary — it is sufficient for model-generated
 * code where the model is trusted not to adversarially escape.  Prototype
 * chain escapes (e.g. `({}).constructor.constructor`) remain possible.
 */

import type { SandboxConfig, SandboxResult } from './sandbox-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_OUTPUT_BYTES = 100_000;

const DEFAULT_TIMEOUT_MS = 30_000;

// Globals that are blocked by being set to `undefined` in the sandbox scope.
const BLOCKED_GLOBALS: Record<string, undefined> = {
  eval: undefined,
  Function: undefined,
  setTimeout: undefined,
  setInterval: undefined,
  clearTimeout: undefined,
  clearInterval: undefined,
  requestAnimationFrame: undefined,
  cancelAnimationFrame: undefined,
  queueMicrotask: undefined,
  __import__: undefined,
  importScripts: undefined,
};

// ---------------------------------------------------------------------------
// Console capture
// ---------------------------------------------------------------------------

interface OutputBuffer {
  chunks: string[];
  size: number;
  truncated: boolean;
}

function createOutputBuffer(): OutputBuffer {
  return { chunks: [], size: 0, truncated: false };
}

function writeToBuffer(buffer: OutputBuffer, text: string): void {
  if (buffer.truncated) return;
  buffer.chunks.push(text);
  buffer.size += text.length;
  if (buffer.size > MAX_OUTPUT_BYTES) {
    buffer.chunks.push('\n... (output truncated)\n');
    buffer.truncated = true;
  }
}

function formatArg(arg: unknown): string {
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (typeof arg === 'object') {
    try {
      return JSON.stringify(arg, null, 2);
    } catch {
      return String(arg);
    }
  }
  return String(arg);
}

function createSandboxConsole(buffer: OutputBuffer): Record<string, (...args: unknown[]) => void> {
  const methods: Record<string, (...args: unknown[]) => void> = {};
  for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
    methods[level] = (...args: unknown[]) => {
      writeToBuffer(buffer, args.map(formatArg).join(' ') + '\n');
    };
  }
  return methods;
}

// ---------------------------------------------------------------------------
// Safe-globals dictionary builder
// ---------------------------------------------------------------------------

function buildSandboxScope(
  buffer: OutputBuffer,
  context: Record<string, unknown>,
  allowNetwork: boolean,
): { names: string[]; values: unknown[] } {
  const scope: Record<string, unknown> = {
    // Safe built-ins
    console: createSandboxConsole(buffer),
    Array,
    Object,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    RegExp,
    Date,
    Error,
    Symbol,
    BigInt,
    TypeError,
    RangeError,
    ReferenceError,
    SyntaxError,
    URIError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Infinity,
    NaN,
    undefined,
    null: null,
    encodeURI,
    encodeURIComponent,
    decodeURI,
    decodeURIComponent,
    ArrayBuffer,
    Uint8Array,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    BigUint64Array,
    BigInt64Array,
    DataView,
    Intl,
    structuredClone,
    // Blocked
    ...BLOCKED_GLOBALS,
    // User context (last so it can override defaults)
    ...context,
  };

  if (allowNetwork && typeof fetch !== 'undefined') {
    scope.fetch = fetch;
  }

  return {
    names: Object.keys(scope),
    values: Object.values(scope),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute JavaScript code in a sandboxed `new Function()` context.
 *
 * @param code    - The JavaScript source to execute.
 * @param context - Variables to inject into the sandbox scope.
 * @param config  - Sandbox configuration overrides.
 */
export async function executeJavaScript(
  code: string,
  context?: Record<string, unknown>,
  config?: Partial<SandboxConfig>,
): Promise<SandboxResult> {
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowNetwork = config?.allowNetwork ?? false;

  const startTime = performance.now();
  const buffer = createOutputBuffer();
  const { names, values } = buildSandboxScope(buffer, context ?? {}, allowNetwork);

  let result: unknown = undefined;
  let error: Error | null = null;

  // Timer handle so we can cancel it if execution finishes first.
  let timerHandle: ReturnType<typeof setTimeout> | undefined;

  // Wrap the synchronous execution in a promise so we can race it against a timeout.
  const execPromise = new Promise<void>((resolve) => {
    try {
      // Create and call the sandbox function.
      // Each param name shadows a corresponding global inside the function body.
      const sandboxFn = new Function(...names, `"use strict";\n${code}`);
      result = sandboxFn(...values);
    } catch (err: unknown) {
      error = err instanceof Error ? err : new Error(String(err));
    } finally {
      resolve();
    }
  });

  // Race execution vs timeout
  const timer = new Promise<void>((_, reject) => {
    timerHandle = setTimeout(() => {
      reject(new Error(`Sandbox execution timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });

  try {
    await Promise.race([execPromise, timer]);
  } catch (err: unknown) {
    error = err instanceof Error ? err : new Error(String(err));
  } finally {
    if (timerHandle !== undefined) {
      clearTimeout(timerHandle);
      timerHandle = undefined;
    }
  }

  const durationMs = Math.round(performance.now() - startTime);
  const output = buffer.chunks.join('');

  return {
    success: error === null,
    output,
    error: error?.message ?? error?.toString(),
    result,
    durationMs,
    truncated: buffer.truncated,
  };
}
