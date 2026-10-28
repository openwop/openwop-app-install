/**
 * ADR 0998 P2 — vector/search surfaces accept the spec's and the
 * `core.openwop.db@1.0.1` pack's argument names, folded BEFORE the run prefix.
 *
 * Why this exists: three contracts named these arguments differently (spec
 * `collection`/`vectors[].embedding`/`embedding`/`k`; pack `collection`/
 * `records`/`query`/`limit`/`id`+`document`; backends `namespace`/`items`/
 * `vector`/`topK`/`q`/`docs`), so a SCHEMA-conforming core.db node wrote to and
 * read from the `default` vector namespace, sent an empty search query, and
 * indexed nothing. And because an alias can carry a store name, the fold is a
 * security boundary: it must run before ADR 0998's `wf:` prefix.
 *
 * Sabotage-witnessed (each red on its own):
 *  - old code (no canonicalizer): the schema-conforming node legs fail — the
 *    collection-isolation query returns the other collection's row, `hits` is
 *    absent, and search-index throws on a missing `docs`;
 *  - fold AFTER the prefix (prefix `namespace` only when given, then fold):
 *    `collection:'user:victim'` from a run reads the host's SECRET row;
 *  - alias wins over canonical: the precedence leg goes red;
 *  - `hits` built as a copy (`[...matches]`): the reference legs go red.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle, type SurfaceArgs, type SurfaceFn, type BlobSurface, type NoSqlSurface, type SearchSurface, type VectorSurface } from '../src/host/inMemorySurfaces.js';
import { hostLaneSurfaces, runNamespacedBundle } from '../src/host/runSurfaceNamespace.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function jsonFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  return { status: res.status, body: (text.length ? JSON.parse(text) : null) as T };
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }

let seq = 0;
/** Register a one-node workflow around a REAL pack node, run it, return its outputs + the run's tenant. */
async function runNode(typeId: string, config: Record<string, unknown>, inputs: Record<string, unknown> = {}): Promise<{ status: string; tenantId: string; out: Record<string, unknown> }> {
  const workflowId = `adr0998p2.${typeId}.${++seq}`;
  const reg = await jsonFetch('/host/openwop-app/workflows', {
    method: 'POST',
    body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'op', typeId, config }], edges: [] }),
  });
  expect(reg.status, `register ${typeId}`).toBeLessThan(300);
  const create = await jsonFetch<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs }) });
  expect(create.status).toBe(201);
  const { runId } = create.body;
  let status = 'pending';
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 25));
    status = (await jsonFetch<{ status: string }>(`/runs/${runId}`)).body.status;
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
  }
  // A run id is `<tenant>/<uuid>` on this host.
  const tenantId = runId.includes('/') ? runId.slice(0, runId.indexOf('/')) : '';
  const bundle = await jsonFetch<{ events?: BundleEvent[] }>(`/runs/${runId}/debug-bundle`);
  const ev = (bundle.body.events ?? []).find((e) => e.type === 'node.completed' && e.nodeId === 'op');
  return { status, tenantId, out: (ev?.payload?.outputs as Record<string, unknown>) ?? {} };
}

const ids = (rows: unknown): string[] => ((rows as Array<{ id: string }> | undefined) ?? []).map((r) => r.id);

describe('ADR 0998 P2: schema-conforming core.db nodes now reach the store they name', () => {
  it('vector-upsert {collection, records} + vector-query {collection, topK} keep collections apart and answer `hits`', async () => {
    // Exactly the pack 1.0.1 schemas: config {collection[, topK]}, inputs {records} / {vector}.
    expect((await runNode('core.db.vector-upsert', { collection: 'p2-a' }, { records: [{ id: 'row-a', vector: [1, 0, 0] }] })).out.upserted).toBe(1);
    expect((await runNode('core.db.vector-upsert', { collection: 'p2-b' }, { records: [{ id: 'row-b', vector: [0, 1, 0] }] })).out.upserted).toBe(1);

    // Query collection B with A's vector: only B's row may come back.
    const q = await runNode('core.db.vector-query', { collection: 'p2-b', topK: 5 }, { vector: [1, 0, 0] });
    expect(q.status).toBe('completed');
    expect(ids(q.out.hits), 'the pack output schema names the result `hits`').toEqual(['row-b']);
    expect(q.out.hits).toEqual(q.out.matches);
  });

  it('search-index {index} + {id, document} and search-query {index, limit} + {query} round-trip', async () => {
    const idx = await runNode('core.db.search-index', { index: 'p2-notes' }, { id: 'n1', document: { text: 'wombat field notes' } });
    expect(idx.status).toBe('completed');
    expect(idx.out.indexed).toBe(1);
    const q = await runNode('core.db.search-query', { index: 'p2-notes', limit: 5 }, { query: 'wombat' });
    expect(q.status).toBe('completed');
    expect(ids(q.out.hits)).toEqual(['n1']);
  });
});

describe('ADR 0998 P2: the fold runs BEFORE the run prefix', () => {
  it('a run naming a host namespace through the `collection` alias cannot read it', async () => {
    const tenantId = (await runNode('core.db.search-query', { index: 'probe', limit: 1 }, { query: 'x' })).tenantId;
    expect(tenantId).not.toBe('');
    const host = buildHostSurfaceBundle({ tenantId });
    await host.db.vector.upsert({ namespace: 'user:p2-victim', items: [{ id: 'm1', vector: [1, 0, 0], metadata: { content: 'SECRET-P2' } }] });

    const read = await runNode('core.db.vector-query', { collection: 'user:p2-victim', topK: 5 }, { vector: [1, 0, 0] });
    expect(read.status).toBe('completed');
    expect(JSON.stringify(read.out)).not.toMatch(/SECRET/);

    // Positive control: the same alias reaches the run's OWN namespace of that name.
    await runNode('core.db.vector-upsert', { collection: 'user:p2-victim' }, { records: [{ id: 'own', vector: [1, 0, 0] }] });
    expect(ids((await runNode('core.db.vector-query', { collection: 'user:p2-victim', topK: 5 }, { vector: [1, 0, 0] })).out.hits)).toEqual(['own']);
  });
});

/** Raw surfaces that record the exact args a backend receives. */
function recordingLanes(): { seen: Array<{ kind: string; verb: string; args: SurfaceArgs }>; host: ReturnType<typeof buildHostSurfaceBundle>; run: ReturnType<typeof runNamespacedBundle> } {
  const seen: Array<{ kind: string; verb: string; args: SurfaceArgs }> = [];
  const rec = (kind: string, verb: string, res: Record<string, unknown> = {}): SurfaceFn => async (args) => { seen.push({ kind, verb, args }); return res; };
  const matches = [{ id: 'x', score: 1 }];
  const raw = {
    vector: { upsert: rec('vector', 'upsert'), query: rec('vector', 'query', { matches }), delete: rec('vector', 'delete') } as VectorSurface,
    search: { index: rec('search', 'index'), query: rec('search', 'query', { hits: [] }), delete: rec('search', 'delete') } as SearchSurface,
    nosql: { find: rec('nosql', 'find'), insert: rec('nosql', 'insert'), update: rec('nosql', 'update'), delete: rec('nosql', 'delete') } as NoSqlSurface,
    blob: { put: rec('blob', 'put'), get: rec('blob', 'get'), delete: rec('blob', 'delete'), list: rec('blob', 'list'), presign: rec('blob', 'presign') } as BlobSurface,
  };
  const lanes = hostLaneSurfaces(raw);
  const base = buildHostSurfaceBundle({ tenantId: 'adr0998-p2-rec' });
  const host = { ...base, storage: { ...base.storage, blob: lanes.blob }, db: { ...base.db, vector: lanes.vector, search: lanes.search, nosql: lanes.nosql } };
  lanes.bind(host);
  return { seen, host, run: runNamespacedBundle(host) };
}

describe('ADR 0998 P2: backends only ever see canonical args', () => {
  it('spec-shape vector args fold to the backend names, and every alias is deleted', async () => {
    const { seen, run, host } = recordingLanes();
    await run.db.vector.upsert({ collection: 'c', vectors: [{ id: 'v', embedding: [1, 2] }] });
    await run.db.vector.query({ collection: 'c', embedding: [1, 2], k: 3 });
    await host.db.vector.query({ collection: 'c', embedding: [1, 2], k: 3 });
    expect(seen.map((s) => s.args)).toEqual([
      { namespace: 'wf:c', items: [{ id: 'v', vector: [1, 2] }] },
      { namespace: 'wf:c', vector: [1, 2], topK: 3 },
      { namespace: 'c', vector: [1, 2], topK: 3 },
    ]);
  });

  it('pack-shape search args fold to q/k/docs', async () => {
    const { seen, run } = recordingLanes();
    await run.db.search.index({ index: 'i', id: 'd', document: { t: 'x' } });
    await run.db.search.query({ index: 'i', query: 'x', limit: 2 });
    expect(seen.map((s) => s.args)).toEqual([
      { index: 'wf:i', docs: [{ id: 'd', fields: { t: 'x' } }] },
      { index: 'wf:i', q: 'x', k: 2 },
    ]);
  });

  it('the canonical name wins when both are given, on both lanes', async () => {
    const { seen, run, host } = recordingLanes();
    await run.db.vector.query({ namespace: 'mine', collection: 'user:victim', vector: [1], embedding: [9], topK: 1, k: 9 });
    await host.db.vector.query({ namespace: 'agent:a', collection: 'user:victim', vector: [1], topK: 1 });
    await run.db.search.query({ index: 'i', q: 'canon', query: 'alias', k: 1, limit: 9 });
    expect(seen.map((s) => s.args)).toEqual([
      { namespace: 'wf:mine', vector: [1], topK: 1 },
      { namespace: 'agent:a', vector: [1], topK: 1 },
      { index: 'wf:i', q: 'canon', k: 1 },
    ]);
  });

  it('collection AND namespace with different values: the store receives ONLY the canonical, wf:-prefixed namespace, and no alias key', async () => {
    const { seen, run } = recordingLanes();
    await run.db.vector.query({ namespace: 'mine', collection: 'user:victim', vector: [1], topK: 1 });
    await run.db.vector.upsert({ namespace: 'mine', collection: 'user:victim', items: [{ id: 'i', vector: [1] }], vectors: [{ id: 'v', embedding: [2] }], records: [] });
    await run.db.vector.delete({ namespace: 'mine', collection: 'user:victim', ids: ['i'] });
    await run.db.search.query({ index: 'i', q: 'canon', query: 'alias', k: 1, limit: 9 });
    expect(seen).toHaveLength(4);
    const ALIASES = ['collection', 'vectors', 'records', 'embedding', 'k', 'query', 'limit', 'document'];
    for (const { kind, verb, args } of seen) {
      const at = `${kind}.${verb}`;
      for (const alias of ALIASES) {
        // `k` is the canonical name on search; an alias only on vector.
        if (alias === 'k' && kind === 'search') continue;
        expect(Object.keys(args), `${at} forwarded alias ${alias}`).not.toContain(alias);
      }
      if (kind === 'vector') expect(args.namespace, at).toBe('wf:mine');
      expect(JSON.stringify(args), `${at} carried the alias value`).not.toMatch(/user:victim|alias/);
    }
  });

  it('`hits` and `matches` are the same array, on both lanes', async () => {
    const { run, host } = recordingLanes();
    const r = await run.db.vector.query({ namespace: 'n', vector: [1] });
    const h = await host.db.vector.query({ namespace: 'n', vector: [1] });
    expect(r.hits).toBe(r.matches);
    expect(h.hits).toBe(h.matches);
    expect(r.matches).toEqual([{ id: 'x', score: 1 }]);
  });
});

describe('ADR 0998 P2: the conformance seam keeps both shapes', () => {
  const surface = (op: string, args: Record<string, unknown>) =>
    jsonFetch<Record<string, unknown>>('/host/openwop-app/test/surface', { method: 'POST', body: JSON.stringify({ tenantId: 'p2-seam', surface: 'vector', op, args }) });

  it('the host shape (vector-knn-roundtrip) and the spec shape both round-trip', async () => {
    await surface('upsert', { namespace: 'knn-host', items: [{ id: 'h1', vector: [1, 0] }, { id: 'h2', vector: [0, 1] }] });
    expect(ids((await surface('query', { namespace: 'knn-host', vector: [1, 0], topK: 1 })).body.matches)).toEqual(['h1']);

    await surface('upsert', { collection: 'knn-spec', vectors: [{ id: 's1', embedding: [1, 0] }, { id: 's2', embedding: [0, 1] }] });
    const spec = await surface('query', { collection: 'knn-spec', embedding: [0, 1], k: 1 });
    expect(spec.status).toBe(200);
    expect(ids(spec.body.matches)).toEqual(['s2']);
  });
});
