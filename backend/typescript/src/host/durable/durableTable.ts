/**
 * Durable table host surface (Phase 2) — `host.tableStorage` over `Storage`.
 *
 * One durable row per record (key `hostsurf:table:<tenant>:<table>::<id>`) and
 * a durable per-(tenant,table) schema registry, so the declared schema
 * (`createTable`, RFC 0228 G4; or, without it, the first insert's columns,
 * RFC 0016 §B point 2) holds across instances and restarts — unlike the
 * in-memory impl, whose schema map is process-local. insert, update and upsert
 * refuse a row whose declared columns carry another type (storage.md
 * §tableStorage: rows MUST conform to the declared schema).
 *
 * Method-for-method parity with `createTable` in inMemorySurfaces.ts, incl.
 * cursor pagination (base64(after_id)) and exact-match filters.
 *
 * Reads (ADR 0868): `query` pages through the (tenant,table) key range in
 * the database — an unfiltered page reads `limit + 1` rows — and `count` is
 * counted there. A FILTERED query still scans the range in batches until its
 * page fills (no per-column index); a selective filter on a large table reads
 * many rows, which `surface_scan_heavy` reports.
 */

import { randomUUID } from 'node:crypto';
import type { BundleScope, TableColType, TableSurface } from '../inMemorySurfaces.js';
import { countPrefix, requireDurableStorage, scanPrefix, SCAN_BATCH } from './durableStore.js';
import { assertRowConforms, declaredTableSchema, inferColType, sameTableSchema, tableQueryLimit } from '../inMemorySurfaces.js';

interface TableRow { id: string; [field: string]: unknown; }

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
    // RFC 0228 G4 — `createTable(name, schema)`. The registry write is one
    // compare-and-swap (absent → declared), so two instances declaring the same
    // table cannot both win; the loser compares by value.
    async createTable({ table, columns }) {
      const want = declaredTableSchema(columns);
      const next = JSON.stringify(want);
      const r = await storage().kvCompareAndSwap(schemaKey(table), null, next);
      if (r.swapped) return { ok: true, created: true };
      let have: Record<string, TableColType> | null = null;
      try { have = r.actual ? (JSON.parse(r.actual) as Record<string, TableColType>) : null; } catch { have = null; }
      if (!have || !sameTableSchema(have, want)) {
        throw Object.assign(new Error(`Table '${String(table)}' is already declared with another schema`), {
          code: 'table_schema_violation',
        });
      }
      return { ok: true, created: false };
    },

    async insert({ table, row }) {
      const r = { ...(row as Record<string, unknown>) } as TableRow;
      // storage.md §tableStorage: insert → rowId. A row without one gets one.
      if (r.id === undefined || r.id === null || r.id === '') r.id = randomUUID();
      const existing = await loadSchema(table);
      if (!existing) {
        // No createTable — declare the schema from this first row's columns.
        const schema: Record<string, TableColType> = {};
        for (const [col, val] of Object.entries(r)) {
          if (col === 'id') continue;
          schema[col] = inferColType(val);
        }
        await storage().kvSet(schemaKey(table), JSON.stringify(schema));
      } else {
        // Every declared column MUST conform; a new column is additive.
        assertRowConforms(existing, r);
      }
      await storage().kvSet(rowKey(table, r.id), JSON.stringify({ ...r }));
      return { id: r.id };
    },

    async update({ table, id, patch }) {
      const k = rowKey(table, id);
      const raw = await storage().kvGet(k);
      if (raw === null) return { updated: 0 };
      const schema = await loadSchema(table);
      if (schema) assertRowConforms(schema, (patch ?? {}) as Record<string, unknown>);
      const cur = JSON.parse(raw) as TableRow;
      await storage().kvSet(k, JSON.stringify({ ...cur, ...(patch as Record<string, unknown>) }));
      return { updated: 1 };
    },

    async upsert({ table, row }) {
      const r = row as TableRow;
      const schema = await loadSchema(table);
      if (schema) assertRowConforms(schema, r);
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
      // ADR 0868: pages in the database, in byte order of the id (the key
      // suffix). Unfiltered, one call reads `limit + 1` rows (the extra one
      // answers `nextCursor`); filtered, it reads pages of SCAN_BATCH until the
      // page is full. It used to load and parse the whole table every call.
      const afterId = typeof cursor === 'string' && cursor.length > 0
        ? Buffer.from(cursor, 'base64').toString('utf8')
        : '';
      const lim = tableQueryLimit(limit);
      const prefix = rowPrefix(table);
      const hasFilter = !!filter && typeof filter === 'object' && Object.keys(filter as object).length > 0;
      const matches: TableRow[] = [];
      for await (const r of scanPrefix(prefix, {
        batch: hasFilter ? SCAN_BATCH : lim + 1,
        after: afterId ? `${prefix}${afterId}` : undefined,
        op: 'table.query',
      })) {
        let rowObj: TableRow;
        try { rowObj = JSON.parse(r.value) as TableRow; } catch { continue; }
        if (hasFilter) {
          let ok = true;
          for (const [fk, fv] of Object.entries(filter as Record<string, unknown>)) {
            if (rowObj[fk] !== fv) { ok = false; break; }
          }
          if (!ok) continue;
        }
        matches.push(rowObj);
        if (matches.length > lim) break;
      }
      const rows = matches.slice(0, lim);
      const last = rows[rows.length - 1];
      const nextCursor = matches.length > lim && last ? Buffer.from(String(last.id), 'utf8').toString('base64') : null;
      return { rows, count: rows.length, nextCursor };
    },

    async count({ table }) {
      return { count: await countPrefix(rowPrefix(table)) };
    },
  };
}
