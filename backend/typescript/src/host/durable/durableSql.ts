/**
 * Durable SQL host surface (Phase 2) — `host.db.sql` backed by a per-tenant
 * SQLite FILE instead of an in-memory database, so tables survive restarts.
 *
 * Why a file (not the shared Storage): raw SQL needs a real SQL engine, which
 * the `Storage` kv abstraction can't express. SQLite-file-per-tenant gives
 * durability + full tenant isolation (each tenant owns its own DB file) and is
 * fully testable here. It is SINGLE-NODE (a file is node-local) — for a
 * cross-instance SQL surface, a Postgres schema-per-tenant adapter (`sql`
 * backend id `postgres`) is the documented follow-up; this closes the
 * durability gap, not the multi-writer-scale one.
 *
 * Same query/execute/transaction contract + non-parametric-SQL guard (RFC 0018)
 * as the in-memory impl.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { BundleScope, SqlSurface } from '../inMemorySurfaces.js';

// Sample-grade injection heuristic — identical to the in-memory surface: flag
// template-literal interpolation and the classic OR '1'='1' shape.
const PARAM_REJECT_RE = /\$\{|\b(?:OR|AND)\b\s+(?:'[^']*'|"[^"]*")\s*=\s*(?:'[^']*'|"[^"]*")/i;

function sanitizeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || 'unknown';
}

let baseDir: string | null = null;
const pool = new Map<string, Database.Database>();

/** Wire the per-tenant SQLite directory. Called at boot from initDurableSurfaces. */
export function setDurableSqlDir(dir: string): void {
  baseDir = dir;
  mkdirSync(dir, { recursive: true });
}

/** Test/lifecycle affordance — close all open handles and reset. */
export function _resetDurableSqlForTesting(): void {
  for (const db of pool.values()) { try { db.close(); } catch { /* noop */ } }
  pool.clear();
  baseDir = null;
}

export function createDurableSql(scope: BundleScope, deps: { dir?: string } = {}): SqlSurface {
  const dir = deps.dir ?? baseDir;
  if (!dir) {
    throw new Error('Durable SQL surface used before setDurableSqlDir() wired the data directory at boot.');
  }
  mkdirSync(dir, { recursive: true });

  const dbFor = (): Database.Database => {
    let db = pool.get(scope.tenantId);
    if (!db) {
      db = new Database(join(dir, `${sanitizeSegment(scope.tenantId)}.db`));
      db.pragma('journal_mode = WAL');
      pool.set(scope.tenantId, db);
    }
    return db;
  };

  const requireParametric = (sql: string) => {
    if (PARAM_REJECT_RE.test(sql)) {
      throw Object.assign(new Error('Non-parametric SQL rejected by host (RFC 0018).'), { code: 'SQL_NON_PARAMETRIC' });
    }
  };

  return {
    async query(args: Record<string, unknown>) {
      const sqlStr = String(args.sql);
      requireParametric(sqlStr);
      const stmt = dbFor().prepare(sqlStr);
      const params = args.params;
      const rows = Array.isArray(params) ? stmt.all(...(params as unknown[])) : stmt.all();
      return { rows: rows as unknown[], count: (rows as unknown[]).length };
    },
    async execute(args: Record<string, unknown>) {
      const sqlStr = String(args.sql);
      requireParametric(sqlStr);
      const stmt = dbFor().prepare(sqlStr);
      const params = args.params;
      const info = Array.isArray(params) ? stmt.run(...(params as unknown[])) : stmt.run();
      return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) };
    },
    async transaction({ statements }) {
      const db = dbFor();
      const txn = db.transaction((stmts: Array<{ sql: string; params?: unknown[] }>) => {
        for (const s of stmts) {
          requireParametric(s.sql);
          db.prepare(s.sql).run(...(s.params ?? []));
        }
      });
      txn((statements as Array<{ sql: string; params?: unknown[] }>) ?? []);
      return { ok: true };
    },
  };
}
