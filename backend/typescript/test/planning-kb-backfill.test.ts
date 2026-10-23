/**
 * ADR 0100 Phase 3 — content-hash guard + backfill routes. ROUTE harness.
 *   - the upsert content-hash guard skips re-embed when indexable text is
 *     unchanged (observed via the doc's preserved `createdAt`), and re-ingests
 *     when it changes
 *   - POST /{strategy,priority-matrix}/reindex-kb sweeps entities the KB is
 *     MISSING (always-on gating only catches future CRUD)
 *   - the managed Priority-Matrix collection, on FIRST creation, backfills the
 *     org's pre-existing lists
 *   - reindex is toggle- + workspace:write-gated
 *
 * How the "missing from the KB" state is made: KB is always-on (its toggle was
 * removed, ADR 0010/0024 graduation), and every list / idea / strategy is
 * indexed at create time, so the old premise ("create while KB is off") cannot
 * arise — round 1 of /grade-tests 8f w1 probed the old cases VACUOUS (the backfill
 * body deleted, both still green). The cases now delete the KB rows (or the
 * whole managed collection) through `kbService` directly — the managed-collection
 * HTTP routes refuse it by design (`assertNotManaged`) — and then assert the
 * sweep put them BACK. A no-op sweep leaves them missing.
 *
 * Time: the hash-guard case fakes only `Date` and advances it 1 s between writes
 * (it used to sleep 5 ms on the real clock).
 *
 * Sabotages each case is red against (probed): the hash guard skipping on a
 * changed text, the strategy / PM backfill loop emptied, the `processed` count
 * changed, the first-creation backfill call dropped, the write-scope check removed.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { deleteCollection, deleteDocument, KB_MAINTENANCE_CALLER, type KnowledgeDocument } from '../src/features/kb/kbService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // (`kb` and `projects` used to be flipped here too; neither is a registered toggle
  // any more, so the old helper silently skipped them.)
  for (const id of ['strategy', 'priority-matrix']) await setToggle(id, 'on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T> { status: number; body: T }
interface ErrBody { error: string; message: string; details?: Record<string, unknown> }
interface Entity { id: string }
interface DocList { documents: Array<Omit<KnowledgeDocument, 'text'>> }
interface Client {
  get: <T>(p: string) => Promise<Res<T>>;
  post: <T>(p: string, b?: unknown) => Promise<Res<T>>;
  patch: <T>(p: string, b?: unknown) => Promise<Res<T>>;
}
function client(): Client {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
/** Throws on an unregistered toggle: a silent no-op flip would make a gate case vacuous. */
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`toggle ${id} is not registered`);
  await saveConfig({ ...d, status }, 'test');
};
const S = '/host/openwop-app/strategy';
const L = '/host/openwop-app/priority-matrix/lists';
const stratCol = (orgId: string): string => `mgd-strategy-${orgId}`;
const pmCol = (orgId: string): string => `mgd-priority-matrix-${orgId}`;

async function ownerWithOrg(): Promise<{ owner: Client; orgId: string; tenantId: string }> {
  const owner = client();
  const tenantId = `org:bf-${Date.now()}-${n++}`;
  const r = await owner.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: uniqEmail('bf'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId };
}
async function stratDoc(owner: Client, orgId: string, id: string): Promise<KnowledgeDocument> {
  const r = await owner.get<KnowledgeDocument>(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(stratCol(orgId))}/documents/${encodeURIComponent(id)}`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
}
async function docIds(owner: Client, orgId: string, colId: string): Promise<string[]> {
  const docs = await owner.get<DocList>(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents`);
  expect(docs.status, JSON.stringify(docs.body)).toBe(200);
  return docs.body.documents.map((d) => d.documentId).sort();
}

describe('ADR 0100 P3 — content-hash guard', () => {
  it('skips re-embed when text is unchanged (createdAt preserved), re-ingests on change', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date());
    try {
      const { owner, orgId } = await ownerWithOrg();
      const s = (await owner.post<Entity>(S, { orgId, title: 'Hash me', summary: 'stable' })).body;
      const created1 = (await stratDoc(owner, orgId, s.id)).createdAt;
      expect(created1).toBeTruthy();

      vi.setSystemTime(Date.now() + 1_000);
      // No content change to the indexable text → guard skips → createdAt preserved.
      expect((await owner.patch(`${S}/${s.id}`, { summary: 'stable' })).status).toBe(200);
      expect((await stratDoc(owner, orgId, s.id)).createdAt).toBe(created1);

      vi.setSystemTime(Date.now() + 1_000);
      // Real content change → re-ingested → createdAt advances to the new instant.
      expect((await owner.patch(`${S}/${s.id}`, { summary: 'CHANGED' })).status).toBe(200);
      const created3 = (await stratDoc(owner, orgId, s.id)).createdAt;
      expect(created3 > created1).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe('ADR 0100 P3 — backfill routes', () => {
  it('strategy reindex-kb re-sweeps the org’s strategies (idempotent; kb always-on)', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const a = (await owner.post<Entity>(S, { orgId, title: 'Pre-existing A' })).body;
    const b = (await owner.post<Entity>(S, { orgId, title: 'Pre-existing B' })).body;
    // Make the KB MISS both (the state a reindex exists for), and prove it does.
    for (const id of [a.id, b.id]) await deleteDocument(tenantId, orgId, stratCol(orgId), id, KB_MAINTENANCE_CALLER);
    expect(await docIds(owner, orgId, stratCol(orgId))).toEqual([]);

    const r = await owner.post<{ processed: number }>(`${S}/reindex-kb`, { orgId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.processed).toBe(2);
    expect(await docIds(owner, orgId, stratCol(orgId))).toEqual([a.id, b.id].sort());
    // idempotent: a second sweep changes nothing
    expect((await owner.post<{ processed: number }>(`${S}/reindex-kb`, { orgId })).body.processed).toBe(2);
    expect(await docIds(owner, orgId, stratCol(orgId))).toEqual([a.id, b.id].sort());
  });

  it('priority-matrix reindex-kb sweeps pre-existing lists + ideas', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const list = (await owner.post<Entity>(L, { orgId, name: 'Old list' })).body;
    const idea = (await owner.post<Entity>(`${L}/${encodeURIComponent(list.id)}/ideas`, { title: 'Old idea' })).body;
    const want = [`pm-idea:${idea.id}`, `pm-list:${list.id}`];
    expect(await docIds(owner, orgId, pmCol(orgId))).toEqual(want); // indexed at create
    for (const id of want) await deleteDocument(tenantId, orgId, pmCol(orgId), id, KB_MAINTENANCE_CALLER);
    expect(await docIds(owner, orgId, pmCol(orgId))).toEqual([]);

    const r = await owner.post<{ processed: number }>('/host/openwop-app/priority-matrix/reindex-kb', { orgId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.processed).toBe(1); // one list (its idea rides along)
    expect(await docIds(owner, orgId, pmCol(orgId))).toEqual(want);
  });

  // (Removed earlier) "AUTO-backfills pre-existing strategies on first collection
  // creation" — the strategy twin of the case below. Not restored: this file
  // keeps the Priority-Matrix leg only.

  it('AUTO-backfills pre-existing priority-matrix lists on first collection creation', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    const old = (await owner.post<Entity>(L, { orgId, name: 'Old list before the collection' })).body;
    // Drop the whole managed collection: the org now has a list and NO collection —
    // the "predecessor" state the first-creation backfill exists for.
    await deleteCollection(tenantId, orgId, pmCol(orgId), KB_MAINTENANCE_CALLER);
    expect((await owner.get<ErrBody>(`/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(pmCol(orgId))}`)).status).toBe(404);

    // Creating a new list re-creates the collection; its first creation must
    // backfill the OLD list, which no CRUD event re-indexes.
    const fresh = (await owner.post<Entity>(L, { orgId, name: 'New list after' })).body;
    expect(await docIds(owner, orgId, pmCol(orgId))).toEqual([`pm-list:${fresh.id}`, `pm-list:${old.id}`].sort());
  });

  it('reindex-kb is toggle- and write-gated', async () => {
    const { owner, orgId, tenantId } = await ownerWithOrg();
    await setToggle('strategy', 'off');
    try {
      const off = await owner.post<ErrBody>(`${S}/reindex-kb`, { orgId });
      expect(off.status).toBe(404);
      expect(off.body).toMatchObject({ error: 'not_found', details: { feature: 'strategy' } });
    } finally { await setToggle('strategy', 'on'); }

    // a SAME-tenant member of the org without workspace:write (a viewer) → 403 from
    // the scope check itself (a different-tenant stranger would be refused earlier)
    const viewer = client();
    const v = await viewer.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: uniqEmail('viewer'), tenantId });
    expect(v.status).toBe(201);
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: v.body.user.userId, roles: ['viewer'] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    const refused = await viewer.post<ErrBody>(`${S}/reindex-kb`, { orgId });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: 'forbidden_scope', message: 'Missing required scope: workspace:write', details: { requiredScope: 'workspace:write', orgId } });
    // positive control: the owner is served
    expect((await owner.post(`${S}/reindex-kb`, { orgId })).status).toBe(200);
  });
});
