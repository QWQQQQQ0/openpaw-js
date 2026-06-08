export type CodeLanguage = 'javascript' | 'python' | 'sql' | 'html';

export interface SandboxConfig {
  timeoutMs: number;
  allowNetwork?: boolean;
  allowDDL?: boolean;
  maxRows?: number;
}

export interface SandboxResult {
  success: boolean;
  output: string;
  error?: string;
  result?: unknown;
  durationMs: number;
  truncated: boolean;
}
