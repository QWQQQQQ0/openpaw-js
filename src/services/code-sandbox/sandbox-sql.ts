/**
 * SQL sandbox wrapping `getDB()` from `@/db`.
 *
 * Security model:
 *   - DDL statements (CREATE, DROP, ALTER, TRUNCATE, VACUUM, REINDEX, ATTACH)
 *     are blocked by default.  Set `allowDDL: true` in the config to permit them.
 *   - SELECT / PRAGMA / EXPLAIN statements use `db.query()` (returns rows).
 *   - All other statements use `db.execute()` (returns void).
 *   - Query results are limited to `maxRows` (default 1000).
 *
 * All queries execute against the application's own SQLite database through
 * the platform-aware adapter (Tauri or WASM sql.js).
 */

import { getDB } from '@/db';
import type { SandboxConfig, SandboxResult } from './sandbox-types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_ROWS = 1000;

const DDL_PATTERNS = [
  /^\s*create\s/i,
  /^\s*drop\s/i,
  /^\s*alter\s/i,
  /^\s*truncate\s/i,
  /^\s*vacuum\s/i,
  /^\s*reindex\s/i,
  /^\s*attach\s/i,
];

// Statement types whose results are read as rows.
const READ_PATTERNS = [
  /^\s*select\s/i,
  /^\s*pragma\s/i,
  /^\s*explain\s/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when `sql` looks like a DDL statement.
 */
function isDDL(sql: string): boolean {
  const trimmed = sql.trim();
  return DDL_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Returns true when `sql` looks like a read-only query that should use
 * `db.query()` rather than `db.execute()`.
 */
function isReadQuery(sql: string): boolean {
  const trimmed = sql.trim();
  return READ_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Run a single SQL statement and return its result.
 */
async function runStatement(
  sql: string,
  maxRows: number,
): Promise<{ result?: unknown; error?: string }> {
  const db = await getDB();

  try {
    if (isReadQuery(sql)) {
      const rows = await db.query(sql);
      // Apply row limit
      const limited = rows.slice(0, maxRows);
      return { result: limited };
    }
    await db.execute(sql);
    return { result: { affected: true } };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Split a (possibly multi-statement) SQL string into individual statements.
 *
 * Handles:
 *   - Semicolon delimiters (SQLite uses `;` to separate statements).
 *   - Single-line comments (`-- ...`).
 *   - Simple string literals for semicolons inside strings.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let prev = '';

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1] ?? '';

    // Toggle comment
    if (!inSingleQuote && !inDoubleQuote) {
      if (ch === '-' && next === '-' && !inLineComment) {
        inLineComment = true;
        continue;
      }
      if (ch === '\n' && inLineComment) {
        inLineComment = false;
        continue;
      }
    }

    if (inLineComment) continue;

    // Toggle string literals
    if (ch === "'" && !inDoubleQuote) {
      // Handle escaped single quotes (SQL convention: '' → one ')
      if (inSingleQuote && prev === "'") {
        // Escaped quote inside string — keep it
      } else {
        inSingleQuote = !inSingleQuote;
      }
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
    }

    // Statement separator (outside strings)
    if (ch === ';' && !inSingleQuote && !inDoubleQuote) {
      const trimmed = current.trim();
      if (trimmed) {
        statements.push(trimmed);
      }
      current = '';
      prev = ch;
      continue;
    }

    current += ch;
    prev = ch;
  }

  // Last statement (no trailing semicolon)
  const trimmed = current.trim();
  if (trimmed) {
    statements.push(trimmed);
  }

  return statements;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute SQL code in a sandboxed database context.
 *
 * @param code   - The SQL source to execute (may contain multiple statements).
 * @param config - Sandbox configuration overrides.
 */
export async function executeSQL(
  code: string,
  config?: Partial<SandboxConfig>,
): Promise<SandboxResult> {
  const allowDDL = config?.allowDDL ?? false;
  const maxRows = config?.maxRows ?? DEFAULT_MAX_ROWS;

  const startTime = performance.now();

  const statements = splitStatements(code);

  if (statements.length === 0) {
    return {
      success: true,
      output: '',
      durationMs: 0,
      truncated: false,
    };
  }

  // Pre-scan: reject DDL statements when not allowed
  if (!allowDDL) {
    for (const stmt of statements) {
      if (isDDL(stmt)) {
        const durationMs = Math.round(performance.now() - startTime);
        return {
          success: false,
          output: '',
          error: `DDL statements are blocked. Set allowDDL: true to permit: ${stmt.slice(0, 80)}`,
          durationMs,
          truncated: false,
        };
      }
    }
  }

  // Execute each statement sequentially
  const outputs: string[] = [];
  let lastResult: unknown = undefined;
  let firstError: string | undefined;

  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    try {
      const { result, error } = await runStatement(stmt, maxRows);
      if (error) {
        firstError ??= error;
        outputs.push(`-- Statement ${i + 1} error: ${error}`);
        break; // Stop on first error
      }
      if (result !== undefined) {
        lastResult = result;
        if (isReadQuery(stmt)) {
          const rows = result as unknown[];
          const count = rows.length;
          const limited = count >= maxRows ? ` (limited to ${maxRows})` : '';
          outputs.push(`-- ${count} row(s) returned${limited}`);
        } else {
          outputs.push('-- OK');
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      firstError ??= msg;
      outputs.push(`-- Statement ${i + 1} error: ${msg}`);
      break;
    }
  }

  const durationMs = Math.round(performance.now() - startTime);

  return {
    success: firstError === undefined,
    output: outputs.join('\n'),
    error: firstError,
    result: lastResult,
    durationMs,
    truncated: false,
  };
}
