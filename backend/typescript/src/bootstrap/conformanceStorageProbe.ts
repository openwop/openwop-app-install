/**
 * `core.conformance.storage-probe` — the conformance-RESERVED node behind the
 * `conformance-storage-probe` fixture (`v2-storage-cross-tenant-isolation`,
 * `spec/v2/core/storage.md` §Shared rules; ADR 0858 P3 storage follow-up).
 *
 * WHAT IT DOES. Calls the host's OWN storage surface for the run's tenant —
 * `ctx.storage` / `ctx.db`, the same bundle every storage pack node gets
 * (`buildHostSurfaceBundle`, tenant bound in the closure) — and nothing else.
 * It keeps no store, does no tenant handling and does no filtering of its own,
 * so an isolation failure it reports is the host's, not this file's. A
 * rejection fails the node with the rejection's code unchanged (`errors.md`
 * §Host-service refusals).
 *
 * FAMILIES. `PROBED_STORAGE_FAMILIES` is the single source of truth for which
 * families it implements. `storageFamilyAdvert.ts` advertises a probed family at
 * major 2 ONLY while this fixture is advertised — the fixture contract says a
 * host MUST NOT advertise it unless it implements every storage family it
 * advertises, and an advertised family without the fixture records `blocked`.
 * `blobStorage` is probed since the surface gained `list` and `delete` (ADR 0858
 * P3 blob, 2026-10-09); until then it was withheld because the contract's read
 * and delete need both. `searchIndex` and `nosql` are not storage families this
 * host advertises.
 *
 * MAPPING NOTES (fixtures.md §"The storage probe fixtures"):
 * - tableStorage: this host infers a table's schema on first insert, so
 *   `createTable("conformance_probe", { k, v })` is that first insert. The row id
 *   is supplied by the caller (the surface does not mint one), so `ref` is the
 *   key; `get(ref)` is `query({ id: ref })`, the surface's exact-match lookup.
 * - sql: one database (memory/durable) or schema (postgres) per tenant, so the
 *   datasource "conformance" is the tenant's own. The placeholder spelling is the
 *   selected driver's (`?` sqlite, `$1` postgres).
 * - blobStorage: the bucket "conformance" is the tenant's own (every object
 *   already lives under a per-tenant root), so `put(key, utf8(value),
 *   "text/plain")`, `get(key)` decoded as UTF-8, `list(prefix: key)` → its keys.
 * - vectorStore: `E(key)` is a deterministic unit vector from SHA-256(key), sized
 *   to the pgvector column when that backend is selected.
 *
 * GATE (corrected 2026-10-08). This first shipped behind `conformanceNodesEnabled()`
 * like every sibling, which made the P3 projection local-only: production runs
 * with conformance nodes OFF (NODE_ENV=production, LEAK-8 fail-closed), so the
 * probe never registered there and the five families stayed withheld. That switch
 * exists to keep the mock agent, `conformance.secret.echo` and similar test-only
 * nodes off a real host. This node is not that kind of surface: it calls only the
 * run tenant's own storage, exactly as any storage pack node does, under the same
 * quotas. So it has its own switch, `storageProbeEnabled()`, on by default, and
 * `host/index.ts` exempts its typeId from the conformance-nodes fixture filter.
 * The node registry stays the one source of truth: the fixture advert and the
 * family advert both read whether this typeId resolves.
 */
import { createHash } from 'node:crypto';
import type { NodeModule, NodeContext, NodeOutcome } from '../executor/types.js';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { resolveBackendId } from '../host/surfaceBackends.js';

export const CONFORMANCE_STORAGE_PROBE_TYPE_ID = 'core.conformance.storage-probe';
export const CONFORMANCE_STORAGE_PROBE_FIXTURE = 'conformance-storage-probe';

/** The storage families this probe implements — the only ones it may cover in an advert. */
export const PROBED_STORAGE_FAMILIES = ['kvStorage', 'cache', 'tableStorage', 'vectorStore', 'sql', 'blobStorage'] as const;
export type ProbedStorageFamily = (typeof PROBED_STORAGE_FAMILIES)[number];

const TARGET = 'conformance';
const TABLE = 'conformance_probe';
const CACHE_TTL_SECONDS = 300; // min(300, maxTtlSeconds); this host advertises no maxTtlSeconds.
const DEFAULT_VECTOR_DIM = 16;

type Surface = Record<string, (args: Record<string, unknown>) => Promise<Record<string, unknown>>>;
type Result = Record<string, unknown>;

/** E(key): a deterministic unit vector derived from `key` alone. */
export function probeEmbedding(key: string, dim: number): number[] {
  const out: number[] = [];
  let block = 0;
  while (out.length < dim) {
    const h = createHash('sha256').update(`${key}#${block++}`).digest();
    for (let i = 0; i < h.length && out.length < dim; i++) out.push(h[i]! / 255 - 0.5);
  }
  const norm = Math.hypot(...out) || 1;
  return out.map((x) => x / norm);
}

function vectorDim(): number {
  if (resolveBackendId('vector') === 'pgvector') {
    const d = Number(process.env.OPENWOP_VECTOR_PG_DIM);
    if (Number.isInteger(d) && d > 0) return d;
  }
  return DEFAULT_VECTOR_DIM;
}

/** `?` for the sqlite backends (memory, durable), `$n` for postgres. */
function sqlPlaceholder(n: number): string {
  return resolveBackendId('sql') === 'postgres' ? `$${n}` : '?';
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const strs = (vs: unknown[]): string[] => vs.filter((v): v is string => typeof v === 'string');

async function kv(s: Surface, action: string, key: string, value: string): Promise<Result> {
  if (action === 'write') { await s.set!({ key, value }); return { written: true }; }
  if (action === 'delete') { await s.delete!({ key }); return { deleted: true }; }
  const got = await s.get!({ key });
  const listed = await s.list!({ prefix: key });
  return {
    values: got['found'] === false ? [] : strs([got['value']]),
    keys: strs(Array.isArray(listed['keys']) ? listed['keys'] : []),
  };
}

async function cache(s: Surface, action: string, key: string, value: string): Promise<Result> {
  if (action === 'write') { await s.put!({ key, value, ttlSeconds: CACHE_TTL_SECONDS }); return { written: true }; }
  if (action === 'delete') { await s.evict!({ key }); return { deleted: true }; }
  const got = await s.get!({ key });
  const hit = got['hit'] === true || got['found'] === true;
  return { values: hit ? strs([got['value']]) : [], keys: hit ? [key] : [] };
}

async function table(s: Surface, action: string, key: string, value: string, ref: string | undefined): Promise<Result> {
  if (action === 'write') {
    const r = await s.insert!({ table: TABLE, row: { id: key, k: key, v: value } });
    return { written: true, ref: str(r['id']) ?? key };
  }
  if (action === 'delete') { await s.delete!({ table: TABLE, id: ref ?? key }); return { deleted: true }; }
  const rows: unknown[] = [];
  const byKey = await s.query!({ table: TABLE, filter: { k: key } });
  if (Array.isArray(byKey['rows'])) rows.push(...byKey['rows']);
  if (ref !== undefined) {
    const byRef = await s.query!({ table: TABLE, filter: { id: ref } });
    if (Array.isArray(byRef['rows'])) rows.push(...byRef['rows']);
  }
  const typed = rows as Array<{ k?: unknown; v?: unknown }>;
  return { values: strs(typed.map((r) => r.v)), keys: strs(typed.map((r) => r.k)) };
}

async function blob(s: Surface, action: string, key: string, value: string): Promise<Result> {
  if (action === 'write') {
    await s.put!({ key, contentBase64: Buffer.from(value, 'utf8').toString('base64'), contentType: 'text/plain' });
    return { written: true };
  }
  if (action === 'delete') { await s.delete!({ key }); return { deleted: true }; }
  const got = await s.get!({ key });
  const listed = await s.list!({ prefix: key });
  const entries = (Array.isArray(listed['entries']) ? listed['entries'] : []) as Array<{ key?: unknown }>;
  return {
    values: got['found'] === true && typeof got['contentBase64'] === 'string'
      ? [Buffer.from(got['contentBase64'], 'base64').toString('utf8')]
      : [],
    keys: strs(entries.map((e) => e.key)),
  };
}

async function vector(s: Surface, action: string, key: string, value: string): Promise<Result> {
  if (action === 'write') {
    await s.upsert!({ namespace: TARGET, items: [{ id: key, vector: probeEmbedding(key, vectorDim()), metadata: { value } }] });
    return { written: true };
  }
  if (action === 'delete') { await s.delete!({ namespace: TARGET, ids: [key] }); return { deleted: true }; }
  const r = await s.query!({ namespace: TARGET, vector: probeEmbedding(key, vectorDim()), topK: 10 });
  const matches = (Array.isArray(r['matches']) ? r['matches'] : []) as Array<{ id?: unknown; metadata?: { value?: unknown } }>;
  return { values: strs(matches.map((m) => m.metadata?.value)), keys: strs(matches.map((m) => m.id)) };
}

async function sql(s: Surface, action: string, key: string, value: string): Promise<Result> {
  if (action === 'write') {
    await s.execute!({ sql: `CREATE TABLE IF NOT EXISTS ${TABLE} (k TEXT NOT NULL, v TEXT NOT NULL)` });
    await s.execute!({ sql: `INSERT INTO ${TABLE} (k, v) VALUES (${sqlPlaceholder(1)}, ${sqlPlaceholder(2)})`, params: [key, value] });
    return { written: true };
  }
  if (action === 'delete') {
    await s.execute!({ sql: `CREATE TABLE IF NOT EXISTS ${TABLE} (k TEXT NOT NULL, v TEXT NOT NULL)` });
    await s.execute!({ sql: `DELETE FROM ${TABLE} WHERE k = ${sqlPlaceholder(1)}`, params: [key] });
    return { deleted: true };
  }
  // A tenant that never wrote has no table: create it empty rather than surface
  // a driver error, so the other tenant's read completes (empty) instead of failing
  // with a code storage.md does not list.
  await s.execute!({ sql: `CREATE TABLE IF NOT EXISTS ${TABLE} (k TEXT NOT NULL, v TEXT NOT NULL)` });
  const r = await s.query!({ sql: `SELECT k, v FROM ${TABLE} WHERE k = ${sqlPlaceholder(1)}`, params: [key] });
  const rows = (Array.isArray(r['rows']) ? r['rows'] : []) as Array<{ k?: unknown; v?: unknown }>;
  return { values: strs(rows.map((x) => x.v)), keys: strs(rows.map((x) => x.k)) };
}

function surfaceFor(ctx: NodeContext, family: ProbedStorageFamily): Surface | undefined {
  const storage = ctx.storage as unknown as Record<string, Surface | undefined> | undefined;
  const db = ctx.db as unknown as Record<string, Surface | undefined> | undefined;
  switch (family) {
    case 'kvStorage': return storage?.['kv'];
    case 'cache': return storage?.['cache'];
    case 'tableStorage': return storage?.['table'];
    case 'vectorStore': return db?.['vector'];
    case 'sql': return db?.['sql'];
    case 'blobStorage': return storage?.['blob'];
  }
}

export const storageProbeNode: NodeModule = {
  typeId: CONFORMANCE_STORAGE_PROBE_TYPE_ID,
  version: '1.0.0',
  sideEffecting: true,
  async execute(ctx: NodeContext): Promise<NodeOutcome> {
    // The fixture declares these as run variables; the run's inputs seed them.
    const v = (name: string): string | undefined => str(ctx.variables?.get(name));
    const family = v('family');
    const action = v('action');
    const key = v('key');
    const value = v('value') ?? '';
    const ref = v('ref');
    if (!family || !(PROBED_STORAGE_FAMILIES as readonly string[]).includes(family)) {
      return { status: 'failure', error: { code: 'host_capability_missing', message: `storage-probe does not implement family '${family ?? ''}'` } };
    }
    if (action !== 'write' && action !== 'read' && action !== 'delete') {
      return { status: 'failure', error: { code: 'validation_error', message: "storage-probe action must be 'write', 'read' or 'delete'" } };
    }
    if (!key) return { status: 'failure', error: { code: 'validation_error', message: 'storage-probe requires a key' } };
    const f = family as ProbedStorageFamily;
    const s = surfaceFor(ctx, f);
    if (!s) return { status: 'failure', error: { code: 'host_capability_missing', message: `${f} is not available to this node` } };
    try {
      let result: Result;
      switch (f) {
        case 'kvStorage': result = await kv(s, action, key, value); break;
        case 'cache': result = await cache(s, action, key, value); break;
        case 'tableStorage': result = await table(s, action, key, value, ref); break;
        case 'vectorStore': result = await vector(s, action, key, value); break;
        case 'sql': result = await sql(s, action, key, value); break;
        case 'blobStorage': result = await blob(s, action, key, value); break;
      }
      return { status: 'success', outputs: { result } };
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown; details?: unknown };
      return {
        status: 'failure',
        error: {
          code: typeof e.code === 'string' ? e.code : 'internal_error',
          message: typeof e.message === 'string' ? e.message : String(err),
          ...(e.details && typeof e.details === 'object' ? { details: e.details as Record<string, unknown> } : {}),
        },
      };
    }
  },
};

/**
 * `OPENWOP_CONFORMANCE_STORAGE_PROBE=false` turns the probe off (and with it the
 * five probed storage families at v2); anything else leaves it on. Read once, at
 * registration — like the conformance-nodes switch, a change needs a new boot.
 */
export function storageProbeEnabled(): boolean {
  return process.env.OPENWOP_CONFORMANCE_STORAGE_PROBE !== 'false';
}

let registered = false;

export function registerConformanceStorageProbeNode(): void {
  if (registered) return;
  if (!storageProbeEnabled()) return;
  getNodeRegistry().register(storageProbeNode);
  registered = true;
}
