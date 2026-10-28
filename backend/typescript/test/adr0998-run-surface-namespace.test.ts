/**
 * ADR 0998 — a workflow run cannot name a host feature's vector / search /
 * nosql / blob store.
 *
 * Why this exists: those surfaces are scoped per tenant only, host features keep
 * member- and org-private data in them under names they choose (subject memory
 * `user:<id>`, KB chunks `<orgId>/<collectionId>`, chat search `chat-search`),
 * and the `core.openwop.db` / `core.openwop.storage` nodes pass a caller-chosen
 * name straight through. Before ADR 0998 any member's workflow could read,
 * overwrite or delete them (CS2WF-4).
 *
 * Every leg drives the REAL pack nodes through createApp → register → run, and
 * every "cannot" leg has a positive control on the same node and name, so a
 * node that silently returns nothing cannot pass. Sabotage-witnessed: with the
 * executor's `runNamespacedBundle(...)` wrap removed, the read, poison and
 * delete legs go red (the run reads SECRET text, overwrites and deletes the host
 * rows); with the host-lane guard removed, the refusal legs go red; with the
 * fail-closed strip turned into a pass-through, the stubbed-backend legs go red.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { RUN_SURFACE_PREFIX, hostLaneSurfaces, runNamespacedBundle } from '../src/host/runSurfaceNamespace.js';
import type { BlobSurface, NoSqlSurface, SearchSurface, SurfaceFn, VectorSurface } from '../src/host/inMemorySurfaces.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
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
  return { status: res.status, body: (await res.json()) as T };
}

interface BundleEvent { type?: string; nodeId?: string; payload?: Record<string, unknown> }

let seq = 0;
/** Register a one-node workflow around a REAL pack node, run it, return its outputs + the run's tenant. */
async function runNode(typeId: string, config: Record<string, unknown>, inputs: Record<string, unknown> = {}): Promise<{ status: string; tenantId: string; out: Record<string, unknown> }> {
  const workflowId = `adr0998.${typeId}.${++seq}`;
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
    const snap = await jsonFetch<{ status: string }>(`/runs/${runId}`);
    status = snap.body.status;
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
  }
  // A run id is `<tenant>/<uuid>` on this host (the conformance storage scenarios read it the same way).
  const tenantId = runId.includes('/') ? runId.slice(0, runId.indexOf('/')) : '';
  const bundle = await jsonFetch<{ events?: BundleEvent[] }>(`/runs/${runId}/debug-bundle`);
  const ev = (bundle.body.events ?? []).find((e) => e.type === 'node.completed' && e.nodeId === 'op');
  return { status, tenantId, out: (ev?.payload?.outputs as Record<string, unknown>) ?? {} };
}

/** The run tenant, learned from a real run id (never assumed). */
let TENANT = '';
async function runTenant(): Promise<string> {
  if (TENANT) return TENANT;
  const r = await runNode('core.db.search-query', { index: 'probe', q: 'x' });
  expect(r.status).toBe('completed');
  expect(r.tenantId, 'the run id names its tenant').not.toBe('');
  TENANT = r.tenantId;
  return TENANT;
}

const VEC = [1, 0, 0, 0];
const contents = (out: Record<string, unknown>): string[] =>
  ((out.matches as Array<{ metadata?: Record<string, unknown> }> | undefined) ?? []).map((m) => String(m.metadata?.content ?? m.metadata?.text ?? ''));
const hitIds = (out: Record<string, unknown>): string[] => ((out.hits as Array<{ id: string }> | undefined) ?? []).map((h) => h.id);

describe('ADR 0998: a run cannot READ a host feature namespace', () => {
  it('core.db.vector-query cannot read a member-private user:<id> namespace or a KB <org>/<collection> namespace', async () => {
    const host = buildHostSurfaceBundle({ tenantId: await runTenant() });
    await host.db.vector.upsert({ namespace: 'user:victim', items: [{ id: 'm1', vector: VEC, metadata: { content: 'SECRET-USER-MEMORY' } }] });
    await host.db.vector.upsert({ namespace: 'org-b/col-1', items: [{ id: 'c1', vector: VEC, metadata: { text: 'SECRET-KB-CHUNK' } }] });

    for (const namespace of ['user:victim', 'org-b/col-1']) {
      const read = await runNode('core.db.vector-query', { collection: 'x', namespace, topK: 5 }, { vector: VEC });
      expect(read.status).toBe('completed');
      expect(contents(read.out).join('|'), `run read of ${namespace}`).not.toMatch(/SECRET/);
    }

    // Positive control: the SAME node and name round-trip the run's own data.
    const own = await runNode('core.db.vector-upsert', { collection: 'x', namespace: 'user:victim' }, { items: [{ id: 'r1', vector: VEC, metadata: { content: 'RUN-OWN' } }] });
    expect(own.status).toBe('completed');
    const back = await runNode('core.db.vector-query', { collection: 'x', namespace: 'user:victim', topK: 5 }, { vector: VEC });
    expect(contents(back.out)).toEqual(['RUN-OWN']);
  });

  it('core.db.search-query cannot read the host chat-search index', async () => {
    const host = buildHostSurfaceBundle({ tenantId: await runTenant() });
    await host.db.search.index({ index: 'chat-search', docs: [{ id: 'msg-1', fields: { text: 'zebracorn private message' } }] });

    const read = await runNode('core.db.search-query', { index: 'chat-search', q: 'zebracorn' });
    expect(read.status).toBe('completed');
    expect(hitIds(read.out)).toEqual([]);

    const own = await runNode('core.db.search-index', { index: 'chat-search' }, { docs: [{ id: 'run-1', fields: { text: 'zebracorn run doc' } }] });
    expect(own.status).toBe('completed');
    const back = await runNode('core.db.search-query', { index: 'chat-search', q: 'zebracorn' });
    expect(hitIds(back.out)).toEqual(['run-1']);
  });
});

describe('ADR 0998: a run cannot POISON or DELETE a host feature namespace', () => {
  it('vector upsert from a run never overwrites the host row of the same namespace + id', async () => {
    const host = buildHostSurfaceBundle({ tenantId: await runTenant() });
    await host.db.vector.upsert({ namespace: 'user:target', items: [{ id: 'h1', vector: VEC, metadata: { content: 'ORIGINAL' } }] });

    const poison = await runNode('core.db.vector-upsert', { collection: 'x', namespace: 'user:target' }, { items: [{ id: 'h1', vector: VEC, metadata: { content: 'POISON' } }] });
    expect(poison.status).toBe('completed');
    expect(poison.out.upserted).toBe(1);
    expect(contents(await host.db.vector.query({ namespace: 'user:target', vector: VEC, topK: 5 }))).toEqual(['ORIGINAL']);
  });

  it('vector delete from a run never removes the host row of the same namespace + id', async () => {
    const host = buildHostSurfaceBundle({ tenantId: await runTenant() });
    await host.db.vector.upsert({ namespace: 'user:target-del', items: [{ id: 'h2', vector: VEC, metadata: { content: 'KEEP' } }] });

    const del = await runNode('core.db.vector-delete', { collection: 'x', namespace: 'user:target-del' }, { ids: ['h2'] });
    expect(del.status).toBe('completed');
    expect(contents(await host.db.vector.query({ namespace: 'user:target-del', vector: VEC, topK: 5 }))).toEqual(['KEEP']);
  });

  it('search index from a run never touches the host index of the same name', async () => {
    const host = buildHostSurfaceBundle({ tenantId: await runTenant() });
    await host.db.search.index({ index: 'chat-search', docs: [{ id: 'keep-1', fields: { text: 'quokkaword host doc' } }] });

    const poison = await runNode('core.db.search-index', { index: 'chat-search' }, { docs: [{ id: 'keep-1', fields: { text: 'injectedword' } }] });
    expect(poison.status).toBe('completed');
    expect(hitIds(await host.db.search.query({ index: 'chat-search', q: 'injectedword' }))).toEqual([]);

    // core.openwop.db ships no search-delete node; the vector leg above witnesses delete.
    expect(hitIds(await host.db.search.query({ index: 'chat-search', q: 'quokkaword' }))).toEqual(['keep-1']);
  });
});

describe('ADR 0998: blob keys are run-scoped', () => {
  it('a run cannot read a host-written blob, its own keys round-trip unprefixed, and host code never sees them bare', async () => {
    const host = buildHostSurfaceBundle({ tenantId: await runTenant() });
    await host.storage.blob.put({ key: 'retention-export/run-x.ndjson', contentBase64: Buffer.from('SECRET-EVENTS').toString('base64') });

    const read = await runNode('core.storage.blob-get', { key: 'retention-export/run-x.ndjson' });
    expect(read.status).toBe('completed');
    expect(read.out.found).toBe(false);

    const put = await runNode('core.storage.blob-put', { key: 'mine.txt' }, { contentBase64: Buffer.from('RUN-BLOB').toString('base64') });
    expect(put.status).toBe('completed');
    expect(put.out.key, 'the run sees its own key, not the stored one').toBe('mine.txt');
    const back = await runNode('core.storage.blob-get', { key: 'mine.txt' });
    expect(Buffer.from(String(back.out.contentBase64), 'base64').toString()).toBe('RUN-BLOB');
    expect((await host.storage.blob.get({ key: 'mine.txt' })).found).toBe(false);
  });
});

describe('ADR 0998: retention-export/ and every other host blob key is unreachable from a run', () => {
  it('get, presign and list from a run never reach a host key, even with export off', async () => {
    const tenantId = await runTenant();
    const host = buildHostSurfaceBundle({ tenantId });
    const KEY = 'retention-export/run-y.ndjson';
    await host.storage.blob.put({ key: KEY, contentBase64: Buffer.from('SECRET-EVENTS').toString('base64') });
    expect((await host.storage.blob.get({ key: KEY })).found, 'control: the host row exists').toBe(true);

    expect((await runNode('core.storage.blob-get', { key: KEY })).out.found).toBe(false);
    const presign = await runNode('core.storage.blob-presign', { key: KEY });
    expect(presign.status).toBe('completed');
    expect(presign.out.url, 'no presigned URL is minted for a host key').toBeUndefined();

    // list has no pack node; drive the run lane the executor hands a node.
    const run = runNamespacedBundle(buildHostSurfaceBundle({ tenantId }));
    await run.storage.blob.put({ key: 'run-own.txt', contentBase64: Buffer.from('x').toString('base64') });
    const keys = ((await run.storage.blob.list({})).entries as Array<{ key: string }>).map((e) => e.key);
    expect(keys, 'pinned under wf: and returned stripped').toContain('run-own.txt');
    expect(keys.filter((k) => k.startsWith('retention-export/') || k.startsWith(RUN_SURFACE_PREFIX))).toEqual([]);
  });
});

describe('ADR 0998: the run lane FAILS CLOSED on anything outside its keyspace', () => {
  /** A bundle whose raw surfaces are stubs that return foreign (non-wf:) names. */
  function stubbedRunLane(): ReturnType<typeof runNamespacedBundle> {
    const fn = (res: Record<string, unknown>): SurfaceFn => async () => res;
    const raw = {
      vector: { upsert: fn({}), delete: fn({}), query: fn({ matches: [{ id: 'a', namespace: 'user:victim', metadata: { content: 'SECRET' } }, { id: 'b', namespace: 'wf:mine', metadata: { content: 'OWN' } }] }) } as VectorSurface,
      search: { index: fn({}), delete: fn({}), query: fn({ hits: [{ id: 'h', index: 'chat-search', fields: { text: 'SECRET' } }] }) } as SearchSurface,
      nosql: { insert: fn({}), update: fn({}), delete: fn({}), find: fn({ datasource: 'host-ds', docs: [] }) } as NoSqlSurface,
      blob: {
        get: fn({ found: true, key: 'retention-export/r.ndjson', contentBase64: 'U0VDUkVU' }),
        put: fn({ ok: true, key: 'wf:mine.txt' }),
        delete: fn({ ok: true }),
        presign: fn({ url: 'u' }),
        list: fn({ entries: [{ key: 'retention-export/r.ndjson', sizeBytes: 1 }, { key: 'wf:mine.txt', sizeBytes: 1 }] }),
      } as BlobSurface,
    };
    const fake = { ...buildHostSurfaceBundle({ tenantId: 'adr0998-stub' }) };
    hostLaneSurfaces(raw).bind(fake);
    return runNamespacedBundle(fake);
  }

  it('drops foreign rows from vector/search results and blob lists, and never passes one through', async () => {
    const run = stubbedRunLane();
    const v = await run.db.vector.query({ namespace: 'x', vector: VEC });
    expect(v.matches).toEqual([{ id: 'b', namespace: 'mine', metadata: { content: 'OWN' } }]);
    expect((await run.db.search.query({ index: 'x', q: 'y' })).hits).toEqual([]);
    await expect(run.db.nosql.find({ datasource: 'x', collection: 'c', filter: {} })).rejects.toMatchObject({ code: 'RUN_KEYSPACE_VIOLATION' });
    expect((await run.storage.blob.list({})).entries).toEqual([{ key: 'mine.txt', sizeBytes: 1 }]);
    expect((await run.storage.blob.put({ key: 'mine.txt', contentBase64: '' })).key).toBe('mine.txt');
  });

  it("a run's own nosql document keeps a user field that happens to be called datasource", async () => {
    const run = runNamespacedBundle(buildHostSurfaceBundle({ tenantId: 'adr0998-nosql-user-field' }));
    await run.db.nosql.insert({ datasource: 'crm', collection: 'leads', docs: [{ _id: 'l1', datasource: 'salesforce' }] });
    expect((await run.db.nosql.find({ datasource: 'crm', collection: 'leads', filter: {} })).docs).toEqual([{ _id: 'l1', datasource: 'salesforce' }]);
  });

  it('a single-item result naming a foreign key is an error that names no key', async () => {
    const err = await stubbedRunLane().storage.blob.get({ key: 'x' }).catch((e: unknown) => e as Error & { code?: string });
    expect(err).toBeInstanceOf(Error);
    expect((err as { code?: string }).code).toBe('RUN_KEYSPACE_VIOLATION');
    expect((err as Error).message).not.toMatch(/retention-export|SECRET/);
  });
});

describe('ADR 0998: the host lane refuses the run keyspace', () => {
  it('every named surface refuses a wf:-prefixed name from host code', async () => {
    const host = buildHostSurfaceBundle({ tenantId: 'adr0998-host' });
    const name = `${RUN_SURFACE_PREFIX}anything`;
    await expect(host.db.vector.query({ namespace: name, vector: VEC })).rejects.toMatchObject({ code: 'RESERVED_NAMESPACE' });
    await expect(host.db.vector.upsert({ namespace: name, items: [] })).rejects.toMatchObject({ code: 'RESERVED_NAMESPACE' });
    await expect(host.db.search.query({ index: name, q: 'x' })).rejects.toMatchObject({ code: 'RESERVED_NAMESPACE' });
    await expect(host.db.nosql.find({ datasource: name, collection: 'c', filter: {} })).rejects.toMatchObject({ code: 'RESERVED_NAMESPACE' });
    await expect(host.storage.blob.get({ key: name })).rejects.toMatchObject({ code: 'RESERVED_NAMESPACE' });
    await expect(host.storage.blob.list({ prefix: name })).rejects.toMatchObject({ code: 'RESERVED_NAMESPACE' });
    // Control: an ordinary host name still works.
    await expect(host.db.vector.query({ namespace: 'agent:a', vector: VEC })).resolves.toBeDefined();
  });

  it('the run lane wraps every verb, and refuses a bundle that is not a host bundle', async () => {
    const host = buildHostSurfaceBundle({ tenantId: 'adr0998-verbs' });
    const run = runNamespacedBundle(host);
    for (const [k, s] of [['vector', host.db.vector], ['search', host.db.search], ['nosql', host.db.nosql], ['blob', host.storage.blob]] as const) {
      const r = k === 'blob' ? run.storage.blob : run.db[k];
      expect(Object.keys(r).sort(), `${k} verbs`).toEqual(Object.keys(s).sort());
      for (const verb of Object.keys(r)) expect(r[verb as keyof typeof r], `${k}.${verb}`).not.toBe(s[verb as keyof typeof s]);
    }
    expect(() => runNamespacedBundle({ ...host })).toThrow(/ADR 0998/);
  });
});

describe('ADR 0998 ratchet: the executor only ever hands a node the run lane', () => {
  const SRC = join(__dirname, '..', 'src');
  const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });

  it('every buildHostSurfaceBundle( call under src/executor is wrapped in runNamespacedBundle(', () => {
    const calls = files(join(SRC, 'executor')).flatMap((f) => {
      const text = readFileSync(f, 'utf8');
      return [...text.matchAll(/(\w+\()?buildHostSurfaceBundle\(/g)].map((m) => ({ f, wrapper: m[1] ?? '' }));
    });
    expect(calls.length, 'the executor builds the run bundle').toBeGreaterThan(0);
    expect(calls.filter((c) => c.wrapper !== 'runNamespacedBundle(')).toEqual([]);
  });

  it('NodeContext db/storage are assigned from that bundle in exactly one place', () => {
    const sites = files(SRC).flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/^\s+(db|storage): surfaces\.(db|storage),/gm)].map(() => f));
    expect(sites.map((f) => f.slice(SRC.length + 1)).sort()).toEqual(['executor/executor.ts', 'executor/executor.ts']);
  });
});
