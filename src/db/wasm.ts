// Web SQLite adapter using sql.js — in-memory with optional Node.js file persistence.
// 来源: lib/services/database/database_connection_web.dart

import type { SQLiteAdapter } from './adapter';

let db: import('sql.js').Database | null = null;
let _nodeDbPath: string | null = null;

/** Resolve the persistent db file path when running in Node.js SSR. */
function resolveNodeDbPath(): string | null {
  if (typeof window !== 'undefined') return null; // browser — use in-memory only
  try {
    const nodePath = require('node:path') as typeof import('node:path');
    const appData = process.env.APPDATA
      || (process.env.HOME ? nodePath.join(process.env.HOME, '.local', 'share') : '');
    return nodePath.join(appData, 'com.openpaw.app', 'public', 'openpaw_cache.db');
  } catch {
    return null;
  }
}

async function getWasmDb() {
  if (!db) {
    const initSqlJs = (await import('sql.js')).default;
    const isNode = typeof window === 'undefined';
    const locateFile = isNode
      ? (() => {
          const nodePath = require('node:path');
          const candidates = [
            nodePath.resolve(process.cwd(), 'node_modules/sql.js/dist/sql-wasm.wasm'),
          ];
          return (file: string) => {
            try {
              const fs = require('node:fs');
              for (const c of candidates) {
                const p = nodePath.resolve(nodePath.dirname(c), file);
                if (fs.existsSync(p)) return p;
              }
            } catch { /* ignore */ }
            return `https://sql.js.org/dist/${file}`;
          };
        })()
      : (file: string) => `https://sql.js.org/dist/${file}`;
    const SQL = await initSqlJs({ locateFile });

    // Node.js: try to load existing db from disk
    if (isNode) {
      _nodeDbPath = resolveNodeDbPath();
      if (_nodeDbPath) {
        try {
          const fs = require('node:fs') as typeof import('node:fs');
          const nodePath = require('node:path') as typeof import('node:path');
          const dir = nodePath.dirname(_nodeDbPath);
          fs.mkdirSync(dir, { recursive: true });
          if (fs.existsSync(_nodeDbPath)) {
            const buffer = fs.readFileSync(_nodeDbPath);
            db = new SQL.Database(buffer);
            return db;
          }
        } catch { /* create new db below */ }
      }
    }

    db = new SQL.Database();
  }
  return db;
}

/** Persist in-memory db to disk (Node.js only, no-op in browser). */
function saveWasmDbIfNode(): void {
  if (!db || !_nodeDbPath) return;
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    const data = db.export();
    fs.writeFileSync(_nodeDbPath!, Buffer.from(data));
  } catch { /* best-effort */ }
}

export const wasmSQLiteAdapter: SQLiteAdapter = {
  async execute(sql: string, params: unknown[] = []) {
    const d = await getWasmDb();
    d.run(sql, params as any[]);
    saveWasmDbIfNode();
  },

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const d = await getWasmDb();
    const stmt = d.prepare(sql);
    if (params.length > 0) stmt.bind(params as any[]);
    const rows: T[] = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject() as unknown as T);
    }
    stmt.free();
    return rows;
  },

  async get<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const rows = await wasmSQLiteAdapter.query<T>(sql, params);
    return rows.length > 0 ? rows[0] : null;
  },

  async close() {
    db?.close();
    db = null;
  },
};
