/**
 * Durable vector / search / nosql host surfaces (Phase 2) over `Storage`.
 *
 * Closes the durability + cross-instance gap for `host.db.vector`,
 * `host.db.search`, and `host.db.nosql`: state lives in the shared `Storage`
 * (sqlite/Postgres) instead of process-local Maps, so it survives restarts and
 * is consistent across instances. Method-for-method parity with the in-memory
 * impls in inMemorySurfaces.ts.
 *
 * Sample-grade trade-off (documented, same as the in-memory impls): vector
 * `query` is brute-force cosine and search `query` is naive bag-of-words, both
 * O(n) prefix scans. Real ANN / full-text at scale wants pgvector / OpenSearch
 * — a separate engine-adapter follow-up; this change is about durability +
 * horizontal-scale correctness, which it fully delivers.
 */

import { randomUUID } from 'node:crypto';
import type {
  BundleScope, VectorSurface, SearchSurface, NoSqlSurface,
} from '../inMemorySurfaces.js';
import { requireDurableStorage } from './durableStore.js';
import { cosine, tokenize, assertSafeFilter, matchesFilter, project, applySort } from './queryHelpers.js';

const enc = encodeURIComponent;
type Doc = Record<string, unknown>;

interface VectorEntry { id: string; vector: number[]; metadata?: Record<string, unknown> }
interface SearchDoc { id: string; fields: Record<string, string | number | boolean> }

async function listParsed<T>(prefix: string): Promise<Array<{ key: string; value: T }>> {
  const rows = await requireDurableStorage().kvList(prefix);
  const out: Array<{ key: string; value: T }> = [];
  for (const r of rows) {
    try { out.push({ key: r.key, value: JSON.parse(r.value) as T }); } catch { /* skip corrupt */ }
  }
  return out;
}

// ── host.db.vector ──────────────────────────────────────────────────
export function createDurableVector(scope: BundleScope): VectorSurface {
  const t = enc(scope.tenantId);
  const prefix = (namespace: unknown) => `hostsurf:vector:${t}:${enc(String(namespace ?? 'default'))}:`;
  const storage = () => requireDurableStorage();
  return {
    async upsert({ namespace, items }) {
      const arr = items as VectorEntry[];
      for (const it of arr) await storage().kvSet(`${prefix(namespace)}${enc(it.id)}`, JSON.stringify(it));
      return { upserted: arr.length };
    },
    async query({ namespace, vector, topK }) {
      const q = vector as number[];
      const entries = await listParsed<VectorEntry>(prefix(namespace));
      const results = entries.map(({ value: e }) => ({ id: e.id, score: cosine(q, e.vector), metadata: e.metadata }));
      results.sort((a, b) => b.score - a.score);
      const k = typeof topK === 'number' && topK > 0 ? topK : 10;
      return { matches: results.slice(0, k) };
    },
    async delete({ namespace, ids }) {
      let n = 0;
      for (const id of ids as string[]) if (await storage().kvDelete(`${prefix(namespace)}${enc(id)}`)) n++;
      return { deleted: n };
    },
  };
}

// ── host.db.search ──────────────────────────────────────────────────
export function createDurableSearch(scope: BundleScope): SearchSurface {
  const t = enc(scope.tenantId);
  const prefix = (index: unknown) => `hostsurf:search:${t}:${enc(String(index ?? 'default'))}:`;
  const storage = () => requireDurableStorage();
  return {
    async index({ index, docs }) {
      const arr = docs as SearchDoc[];
      for (const d of arr) await storage().kvSet(`${prefix(index)}${enc(d.id)}`, JSON.stringify(d));
      return { indexed: arr.length };
    },
    async query({ index, q, k }) {
      const queryTokens = tokenize(String(q ?? ''));
      if (queryTokens.length === 0) return { hits: [] };
      const docs = await listParsed<SearchDoc>(prefix(index));
      const hits: Array<{ id: string; score: number; fields: Record<string, unknown> }> = [];
      for (const { value: d } of docs) {
        const docTokens = tokenize(Object.values(d.fields).map((v) => String(v)).join(' '));
        if (docTokens.length === 0) continue;
        let score = 0;
        for (const qt of queryTokens) {
          const tf = docTokens.filter((tok) => tok === qt).length;
          if (tf > 0) score += 1 + Math.log(1 + tf);
        }
        if (score > 0) hits.push({ id: d.id, score, fields: d.fields });
      }
      hits.sort((a, b) => b.score - a.score);
      const limit = typeof k === 'number' && k > 0 ? k : 10;
      return { hits: hits.slice(0, limit) };
    },
    async delete({ index, ids }) {
      let n = 0;
      for (const id of ids as string[]) if (await storage().kvDelete(`${prefix(index)}${enc(id)}`)) n++;
      return { deleted: n };
    },
  };
}

// ── host.db.nosql ───────────────────────────────────────────────────
export function createDurableNosql(scope: BundleScope): NoSqlSurface {
  const t = enc(scope.tenantId);
  const prefix = (ds: unknown, coll: unknown) =>
    `hostsurf:nosql:${t}:${enc(String(ds ?? 'default'))}::${enc(String(coll ?? 'default'))}:`;
  const storage = () => requireDurableStorage();

  return {
    async insert({ datasource, collection, docs }) {
      const arr = Array.isArray(docs) ? (docs as Doc[]) : [docs as Doc];
      const ids: string[] = [];
      for (const raw of arr) {
        const id = typeof raw._id === 'string' ? raw._id : `doc_${randomUUID()}`;
        await storage().kvSet(`${prefix(datasource, collection)}${enc(id)}`, JSON.stringify({ ...raw, _id: id }));
        ids.push(id);
      }
      return { inserted: ids.length, ids };
    },
    async find({ datasource, collection, filter, projection, sort, limit }) {
      const f = (filter as Doc) ?? {};
      assertSafeFilter(f);
      const rows = await listParsed<Doc>(prefix(datasource, collection));
      let hits = rows.map((r) => r.value).filter((d) => matchesFilter(d, f));
      hits = applySort(hits, sort as Doc | undefined);
      if (typeof limit === 'number' && limit >= 0) hits = hits.slice(0, limit);
      return { docs: hits.map((d) => project(d, projection as Doc | undefined)) };
    },
    async update({ datasource, collection, filter, update, upsert }) {
      const f = (filter as Doc) ?? {};
      assertSafeFilter(f);
      const u = (update as Doc) ?? {};
      const set = (u.$set as Doc | undefined) ?? (Object.keys(u).some((k) => k.startsWith('$')) ? {} : u);
      const unset = u.$unset as Doc | undefined;
      const rows = await listParsed<Doc>(prefix(datasource, collection));
      const matches = rows.filter((r) => matchesFilter(r.value, f));
      for (const { key, value: d } of matches) {
        Object.assign(d, set);
        if (unset) for (const k of Object.keys(unset)) delete d[k];
        await storage().kvSet(key, JSON.stringify(d));
      }
      if (matches.length === 0 && upsert === true) {
        const id = `doc_${randomUUID()}`;
        await storage().kvSet(`${prefix(datasource, collection)}${enc(id)}`, JSON.stringify({ ...f, ...set, _id: id }));
        return { matched: 0, modified: 0, upsertedId: id };
      }
      return { matched: matches.length, modified: matches.length };
    },
    async delete({ datasource, collection, filter }) {
      const f = (filter as Doc) ?? {};
      assertSafeFilter(f);
      const rows = await listParsed<Doc>(prefix(datasource, collection));
      let deleted = 0;
      for (const { key, value: d } of rows) if (matchesFilter(d, f)) { await storage().kvDelete(key); deleted++; }
      return { deleted };
    },
  };
}
