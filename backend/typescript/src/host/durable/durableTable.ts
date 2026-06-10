/**
 * Durable table host surface (Phase 2) — `host.tableStorage` over `Storage`.
 *
 * One durable row per record (key `hostsurf:table:<tenant>:<table>::<id>`) and
 * a durable per-(tenant,table) schema registry, so the schema-on-first-insert
 * contract (RFC 0016 §B point 2) holds across instances and restarts — unlike
 * the in-memory impl, whose schema map is process-local.
 *
 * Method-for-method parity with `createTable` in inMemorySurfaces.ts, incl.
 * cursor pagination (base64(after_id)) and exact-match filters.
 *
 * Sample-grade trade-off (documented, same as the existing durable host-ext
 * store): `query`/`count` are prefix SCANS over the (tenant,table) keyspace —
 * fine at demo/medium scale and indexed by the kv primary key, but a
 * production store would index per queried column.
 */

import type { BundleScope, TableSurface } from '../inMemorySurfaces.js';
import { requireDurableStorage } from './durableStore.js';

type TableColType = 'string' | 'number' | 'boolean' | 'object';
interface TableRow { id: string; [field: string]: unknown; }

function inferColType(v: unknown): TableColType {
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  return 'object';
}

const ROW_ROOT = 'hostsurf:table:';
const SCHEMA_ROOT = 'hostsurf:tableschema:';
const enc = encodeURIComponent;

export function createDurableTable(scope: BundleScope): TableSurface {
  const tenantId = scope.tenantId;
  const rowPrefix = (table: unknown) => `${ROW_ROOT}${enc(tenantId)}:${enc(String(table))}::`;
  const rowKey = (table: unknown, id: unknown) => `${rowPrefix(table)}${String(id)}`;
  const schemaKey = (table: unknown) => `${SCHEMA_ROOT}${enc(tenantId)}:${enc(String(table))}`;
  const storage = () => requireDurableStorage();

  async function loadSchema(table: unknown): Promise<Record<string, TableColType> | null> {
    const raw = await storage().kvGet(schemaKey(table));
    if (!raw) return null;
    try { return JSON.parse(raw) as Record<string, TableColType>; } catch { return null; }
  }

  return {
    async insert({ table, row }) {
      const r = row as TableRow;
      const existing = await loadSchema(table);
      if (!existing) {
        // First insert — declare the schema from this row's columns.
        const schema: Record<string, TableColType> = {};
        for (const [col, val] of Object.entries(r)) {
          if (col === 'id') continue;
          schema[col] = inferColType(val);
        }
        await storage().kvSet(schemaKey(table), JSON.stringify(schema));
      } else {
        // Subsequent insert — every declared column MUST conform.
        for (const [col, val] of Object.entries(r)) {
          if (col === 'id') continue;
          const declared = existing[col];
          if (declared === undefined) continue; // new column — additive, allowed
          const got = inferColType(val);
          if (got !== declared) {
            throw Object.assign(new Error(`Column '${col}' declared as '${declared}', got '${got}'`), {
              code: 'table_schema_violation',
            });
          }
        }
      }
      await storage().kvSet(rowKey(table, r.id), JSON.stringify({ ...r }));
      return { id: r.id };
    },

    async update({ table, id, patch }) {
      const k = rowKey(table, id);
      const raw = await storage().kvGet(k);
      if (raw === null) return { updated: 0 };
      const cur = JSON.parse(raw) as TableRow;
      await storage().kvSet(k, JSON.stringify({ ...cur, ...(patch as Record<string, unknown>) }));
      return { updated: 1 };
    },

    async upsert({ table, row }) {
      const r = row as TableRow;
      const k = rowKey(table, r.id);
      const raw = await storage().kvGet(k);
      const existed = raw !== null;
      const cur = raw ? (JSON.parse(raw) as TableRow) : ({} as Partial<TableRow>);
      await storage().kvSet(k, JSON.stringify({ ...cur, ...r }));
      return { upserted: 1, created: !existed };
    },

    async delete({ table, id }) {
      const existed = await storage().kvDelete(rowKey(table, id));
      return { deleted: existed ? 1 : 0 };
    },

    async query({ table, filter, limit, cursor }) {
      const afterId = typeof cursor === 'string' && cursor.length > 0
        ? Buffer.from(cursor, 'base64').toString('utf8')
        : '';
      const lim = typeof limit === 'number' && limit > 0 ? limit : Number.MAX_SAFE_INTEGER;
      const stored = await storage().kvList(rowPrefix(table));
      const allMatching: TableRow[] = [];
      for (const r of stored) {
        let rowObj: TableRow;
        try { rowObj = JSON.parse(r.value) as TableRow; } catch { continue; }
        if (filter && typeof filter === 'object') {
          let ok = true;
          for (const [fk, fv] of Object.entries(filter as Record<string, unknown>)) {
            if (rowObj[fk] !== fv) { ok = false; break; }
          }
          if (!ok) continue;
        }
        allMatching.push(rowObj);
      }
      allMatching.sort((a, b) => a.id.localeCompare(b.id));
      const rows: TableRow[] = [];
      for (const rowObj of allMatching) {
        if (afterId && rowObj.id <= afterId) continue;
        rows.push(rowObj);
        if (rows.length >= lim) break;
      }
      const last = rows[rows.length - 1];
      const consumedThroughId = last ? last.id : afterId;
      const hasMore = allMatching.some((r) => r.id > consumedThroughId);
      const nextCursor = hasMore && last ? Buffer.from(last.id, 'utf8').toString('base64') : null;
      return { rows, count: rows.length, nextCursor };
    },

    async count({ table }) {
      const stored = await storage().kvList(rowPrefix(table));
      return { count: stored.length };
    },
  };
}
