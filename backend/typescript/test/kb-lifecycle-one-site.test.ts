/**
 * ADR 0643 D3 (`KBWF-5`) — KB lifecycle host events from ONE site per transition,
 * enumerated BY LANE on the booted app with a captured dispatcher (the
 * `crm-lifecycle-one-site.test.ts` shape).
 *
 * WHAT IS PINNED:
 *   document.ingested — route ingest 1 (ids-only payload, no `origin` on the wire);
 *     a first-time stable-id upsert 1; a same-id SAME-CONTENT re-upsert 0 (the
 *     content-hash guard returns before any write); a same-id CHANGED re-upsert 0
 *     `ingested` + 1 `updated { revision: 2 }` (the replace runs its ingest half
 *     silent — one transition, one event); the strategy BACKFILL sweep over N
 *     documents 0 per-row + ONE `ingested { count: N }` with NO documentId;
 *   document.deleted — route delete 1; `eraseSubjectKb` over N subject-keyed
 *     documents ZERO `host.kb.*` events of ANY type, and no delivered payload
 *     anywhere carries the subject key (the ERASURE lane is silent as a
 *     correctness rule — ADR 0643 review #5);
 *   reindex.started / completed — once each per reindex; reindex.failed —
 *     `{ reason: 'cancelled' }` on a cancel, `{ reason: 'lease-expired' }` when
 *     D1a's guard cancels a stale job;
 *   self-trigger (ADR 0617 D1a) — an agent-knowledge surface ingest from a run
 *     of workflow X, with a binding on `host.kb.document.ingested` → X, does NOT
 *     start X, while a second workflow bound to the same event DOES (the positive
 *     control that proves the skip is origin-based, not "nothing dispatched");
 *     the route lane, carrying no origin, starts both.
 *
 * SABOTAGE (run during the build; all restored): dropping the eraser's
 * `{ silent: true }` turns the zero-events row red; emitting `ingested` on the
 * same-id idempotent branch turns its row red; dropping the `origin` thread in
 * `ingestDocument` turns the self-trigger row red on "X must not re-trigger".
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createHostEventBinding, initHostEventDispatcher, type HostEventEnvelope } from '../src/host/hostEventDispatcher.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { __setHeadlessEmbedderForTest } from '../src/host/headlessAi.js';
import { upsertAgentProfile } from '../src/host/agentProfileService.js';
import { buildAgentKnowledgeSurface } from '../src/features/agent-knowledge/surface.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { KB_EVENT_TYPES } from '../src/features/kb/emit.js';
import {
  cancelReindex, createCollection, deleteDocument, drainReindex, eraseSubjectKb, getDocument, ingestDocument, startReindex, upsertDocument,
} from '../src/features/kb/kbService.js';

let BASE = '';
let server: http.Server;
let app: Express;
let storage: Storage;
let n = 0;

let delivered: HostEventEnvelope[] = [];
let startRunCalls: Array<{ tenantId: string; workflowId: string; metadata?: Record<string, unknown> }> = [];
const settle = () => new Promise((r) => setTimeout(r, 25));
const ofType = (type: string, tenantId?: string) => delivered.filter((e) => e.type === type && (!tenantId || e.tenantId === tenantId));
const kbEvents = (tenantId: string) => delivered.filter((e) => e.type.startsWith('host.kb.') && e.tenantId === tenantId);
const INGESTED = 'host.kb.document.ingested';
const UPDATED = 'host.kb.document.updated';
const DELETED = 'host.kb.document.deleted';
const R_STARTED = 'host.kb.reindex.started';
const R_COMPLETED = 'host.kb.reindex.completed';
const R_FAILED = 'host.kb.reindex.failed';

interface Res<T = Record<string, any>> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res<any>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

async function signup(c: Client): Promise<{ userId: string; tenantId: string }> {
  const tenantId = `org:kb-ls-${Date.now()}-${n++}`;
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `kb-ls-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user.userId, tenantId };
}
async function orgOf(c: Client): Promise<string> {
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return org.body.orgId as string;
}
const KB = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}${suffix}`;
const S = '/v1/host/openwop-app/strategy';

/** A deterministic fake provider embedder — no real credentials; its signature
 *  differs from the local floor so `startReindex` has work to do. */
function hash(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs', 'kb', 'strategy']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  __setHeadlessEmbedderForTest(async () => ({
    provider: 'openai', model: 'text-embedding-3-small',
    embed: async (texts: string[]) => texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }),
  }) as never);
  // Re-point the REAL dispatcher's two fanouts at capture seams (the app's own
  // storage + hostSuite stay, so bindings + the self-trigger guard are real).
  initHostEventDispatcher({
    storage,
    hostSuite: app.locals.hostSuite as StartRunDeps['hostSuite'],
    deliverWebhooks: async (event) => { delivered.push(event); },
    startRun: async (_deps, input) => { startRunCalls.push(input); return `run:fake-${startRunCalls.length}`; },
  });
});
afterAll(async () => {
  __setHeadlessEmbedderForTest(null);
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});
beforeEach(() => { delivered = []; startRunCalls = []; });

describe('ADR 0643 D3 — the closed world', () => {
  it('KB_EVENT_TYPES is exactly the six transitions this file enumerates', () => {
    expect([...KB_EVENT_TYPES].sort()).toEqual([DELETED, INGESTED, UPDATED, R_COMPLETED, R_FAILED, R_STARTED].sort());
  });
});

describe('ADR 0643 D3 — document.ingested / updated / deleted by lane', () => {
  it('route ingest → exactly 1 ingested, ids-only payload, no `origin` on the wire; route delete → exactly 1 deleted', async () => {
    const c = client();
    const { tenantId } = await signup(c);
    const orgId = await orgOf(c);
    const col = await c.post(KB(orgId, '/collections'), { name: 'Route' });
    expect(col.status, JSON.stringify(col.body)).toBe(201);
    const doc = await c.post(KB(orgId, `/collections/${col.body.collectionId}/documents`), { title: 'Cats', text: 'Cats groom themselves and purr when content.' });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);
    await settle();
    const evs = ofType(INGESTED, tenantId);
    expect(evs).toHaveLength(1);
    expect(evs[0]!.payload).toEqual({ orgId, collectionId: col.body.collectionId, documentId: doc.body.documentId });
    expect('origin' in evs[0]!).toBe(false);
    expect(kbEvents(tenantId)).toHaveLength(1);

    delivered = [];
    const del = await c.del(KB(orgId, `/collections/${col.body.collectionId}/documents/${doc.body.documentId}`));
    expect(del.status).toBe(204);
    await settle();
    const dels = ofType(DELETED, tenantId);
    expect(dels).toHaveLength(1);
    expect(dels[0]!.payload).toEqual({ orgId, collectionId: col.body.collectionId, documentId: doc.body.documentId });
    expect(kbEvents(tenantId)).toHaveLength(1);
  });

  it('stable-id upsert: first-time 1 ingested; same-id SAME-content re-upsert 0; same-id CHANGED re-upsert 0 ingested + 1 updated { revision: 2 }', async () => {
    const { tenantId } = await signup(client());
    const orgId = 'org-upsert';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Upsert' });
    await upsertDocument(tenantId, orgId, col.collectionId, 'stable-1', 'actor', { title: 'T', text: 'first body' });
    await settle();
    expect(ofType(INGESTED, tenantId)).toHaveLength(1);
    expect(ofType(INGESTED, tenantId)[0]!.payload).toEqual({ orgId, collectionId: col.collectionId, documentId: 'stable-1' });
    expect(kbEvents(tenantId)).toHaveLength(1);

    delivered = [];
    await upsertDocument(tenantId, orgId, col.collectionId, 'stable-1', 'actor', { title: 'T', text: 'first body' });
    await settle();
    expect(kbEvents(tenantId), 'a same-id, same-content re-upsert is not a transition — it must emit NOTHING').toHaveLength(0);

    delivered = [];
    await upsertDocument(tenantId, orgId, col.collectionId, 'stable-1', 'actor', { title: 'T', text: 'second body' });
    await settle();
    expect(ofType(INGESTED, tenantId), 'a replace is an `updated`, never a second `ingested`').toHaveLength(0);
    const upd = ofType(UPDATED, tenantId);
    expect(upd).toHaveLength(1);
    expect(upd[0]!.payload).toEqual({ orgId, collectionId: col.collectionId, documentId: 'stable-1', revision: 2 });
    expect(kbEvents(tenantId)).toHaveLength(1);
  });

  it('BACKFILL sweep (strategy reindex-kb) over N documents → 0 per-row ingested + ONE ingested { count: N } with no documentId', async () => {
    const c = client();
    const { tenantId } = await signup(c);
    const orgId = await orgOf(c);
    // Two strategies — the CRUD hook indexes each (2 route-lane `ingested`).
    const a = await c.post(S, { orgId, title: 'Strategy A' });
    const b = await c.post(S, { orgId, title: 'Strategy B' });
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    await settle();
    const colId = `mgd-strategy-${orgId}`;
    expect(ofType(INGESTED, tenantId).filter((e) => e.payload.collectionId === colId)).toHaveLength(2);
    // Make the sweep NON-VACUOUS: the content-hash guard makes an unchanged re-index
    // free (and eventless), so drop the two KB docs at the service and let the sweep
    // genuinely re-ingest them.
    await deleteDocument(tenantId, orgId, colId, a.body.id, undefined, { silent: true });
    await deleteDocument(tenantId, orgId, colId, b.body.id, undefined, { silent: true });
    expect(await getDocument(tenantId, orgId, colId, a.body.id)).toBeNull();

    delivered = [];
    const r = await c.post(`${S}/reindex-kb`, { orgId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.processed).toBe(2);
    expect(await getDocument(tenantId, orgId, colId, a.body.id), 'the sweep must actually have re-ingested').not.toBeNull();
    await settle();
    const perRow = ofType(INGESTED, tenantId).filter((e) => typeof e.payload.documentId === 'string');
    expect(perRow, 'a 10 000-document backfill must not ignite 10 000 bound runs').toHaveLength(0);
    const batch = ofType(INGESTED, tenantId).filter((e) => typeof e.payload.count === 'number');
    expect(batch).toHaveLength(1);
    expect(batch[0]!.payload).toEqual({ orgId, collectionId: colId, count: 2 });
    expect(kbEvents(tenantId)).toHaveLength(1);
  });
});

describe('ADR 0643 D3 (review #5) — the ERASURE lane is silent as a correctness rule', () => {
  it('eraseSubjectKb over N subject-keyed documents emits ZERO host.kb.* events, and no delivered payload carries the subject key', async () => {
    const { tenantId } = await signup(client());
    const SUBJECT = `user:leaver-${n++}`;
    const orgId = 'org-erase';
    // Two subject-keyed documents in two collections + one org document the subject
    // authored (attribution anonymized, never deleted) — the full eraser walk.
    const colA = await createCollection(tenantId, orgId, SUBJECT, { name: 'People A' });
    const colB = await createCollection(tenantId, orgId, 'someone-else', { name: 'People B' });
    await ingestDocument(tenantId, orgId, SUBJECT, colA.collectionId, { title: 'Profile', text: 'Leaver dossier alpha.' }, { documentId: `profile:${SUBJECT}` });
    await ingestDocument(tenantId, orgId, 'someone-else', colB.collectionId, { title: 'Profile', text: 'Leaver dossier beta.' }, { documentId: SUBJECT });
    await ingestDocument(tenantId, orgId, SUBJECT, colB.collectionId, { title: 'Policy', text: 'Receipts within 30 days.' });
    await settle();
    expect(ofType(INGESTED, tenantId), 'non-vacuity: the seeding lanes DO emit').toHaveLength(3);

    delivered = [];
    const result = await eraseSubjectKb(tenantId, SUBJECT);
    expect(result.documentsDeleted, 'non-vacuity: the eraser must have deleted the subject-keyed documents').toBe(2);
    expect(result.attributionsAnonymized).toBeGreaterThanOrEqual(2);
    expect(await getDocument(tenantId, orgId, colA.collectionId, `profile:${SUBJECT}`)).toBeNull();
    await settle();
    // COUNT: zero events of ANY kb type.
    expect(kbEvents(tenantId)).toEqual([]);
    expect(ofType(DELETED, tenantId)).toHaveLength(0);
    // PAYLOAD: the just-erased identifier reaches no subscriber, of any event type.
    for (const e of delivered) {
      expect(JSON.stringify(e.payload), `${e.type} carried the erased subject key`).not.toContain(SUBJECT);
    }
  });
});

describe('ADR 0643 D3 — reindex.started / completed / failed, one site each', () => {
  it('start → drain to cutover: exactly 1 started + 1 completed, 0 failed, ids-only payloads', async () => {
    const { tenantId } = await signup(client());
    const orgId = 'org-reindex';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Reindex' });
    for (let i = 0; i < 2; i++) await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: `Doc ${i}`, text: `# S${i}\nBody ${i} with searchable content.` });
    delivered = [];
    await startReindex(tenantId, orgId, col.collectionId, { provider: 'openai' });
    await settle();
    expect(ofType(R_STARTED, tenantId)).toHaveLength(1);
    expect(ofType(R_STARTED, tenantId)[0]!.payload).toEqual({ orgId, collectionId: col.collectionId });
    const done = await drainReindex(tenantId, orgId, col.collectionId);
    expect(done!.status).toBe('done');
    await settle();
    expect(ofType(R_COMPLETED, tenantId)).toHaveLength(1);
    expect(ofType(R_COMPLETED, tenantId)[0]!.payload).toEqual({ orgId, collectionId: col.collectionId });
    expect(ofType(R_FAILED, tenantId)).toHaveLength(0);
    expect(kbEvents(tenantId)).toHaveLength(2);
  });

  it('cancel → 1 failed { reason: "cancelled" }; a lease-expired job cancelled by the D1a guard → 1 failed { reason: "lease-expired" }', async () => {
    const { tenantId } = await signup(client());
    const orgId = 'org-reindex-fail';
    const col = await createCollection(tenantId, orgId, 'actor', { name: 'Cancel' });
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Doc', text: 'A body with searchable content.' });
    await startReindex(tenantId, orgId, col.collectionId, { provider: 'openai' });
    delivered = [];
    const cancelled = await cancelReindex(tenantId, orgId, col.collectionId);
    expect(cancelled!.status).toBe('cancelled');
    await settle();
    expect(ofType(R_FAILED, tenantId)).toHaveLength(1);
    expect(ofType(R_FAILED, tenantId)[0]!.payload).toEqual({ orgId, collectionId: col.collectionId, reason: 'cancelled' });
    expect(kbEvents(tenantId)).toHaveLength(1);

    // Lease expiry: start again, age the persisted row 31 minutes, then a write
    // trips `assertNoLiveReindex`, which cancels with the named reason.
    await startReindex(tenantId, orgId, col.collectionId, { provider: 'openai' });
    const kv = __hostExtStorage()!;
    const key = `hostext:kb:reindex:${tenantId}:${orgId}:${col.collectionId}`;
    const raw = await kv.kvGet(key);
    expect(raw, 'no persisted reindex job to age — the witness would be vacuous').not.toBeNull();
    const row = JSON.parse(raw!) as Record<string, unknown>;
    row.updatedAt = new Date(Date.now() - 31 * 60_000).toISOString();
    await kv.kvSet(key, JSON.stringify(row));
    delivered = [];
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'After lease', text: 'written once the stale job was cancelled' });
    await settle();
    const failed = ofType(R_FAILED, tenantId);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.payload).toEqual({ orgId, collectionId: col.collectionId, reason: 'lease-expired' });
    // …and the ingest itself emitted its own one event (the payload discipline holds
    // across the two: no error text, no title).
    expect(ofType(INGESTED, tenantId)).toHaveLength(1);
    expect(kbEvents(tenantId)).toHaveLength(2);
  });
});

describe('ADR 0617 D1a — the self-trigger guard on document.ingested', () => {
  it('an agent-knowledge surface ingest from run X does NOT re-trigger a binding on X; a second bound workflow DOES start; the route lane starts both', async () => {
    const c = client();
    const { tenantId, userId } = await signup(c);
    const orgId = await orgOf(c);
    const col = await createCollection(tenantId, orgId, userId, { name: 'Bound' });
    const agentId = `agent-kb-${n++}`;
    await upsertAgentProfile(tenantId, agentId, {
      roleKey: 'kb-agent',
      autonomy: { level: 'review', specLevel: 'recommend' },
      capabilities: ['knowledge'],
      knowledge: { collectionIds: [col.collectionId] },
    } as never);
    const binding = await createHostEventBinding({ tenantId, eventType: INGESTED, workflowId: 'wf-self-trigger', createdBy: userId });
    // Positive control: a SECOND workflow bound to the same event. If the
    // self-trigger row passed because nothing was dispatched at all, this one
    // would not start either — it must, so the skip is proven origin-based.
    await createHostEventBinding({ tenantId, eventType: INGESTED, workflowId: 'wf-other-listener', createdBy: userId });

    const surface = buildAgentKnowledgeSurface({ tenantId, runId: 'run:surface-1', workflowId: 'wf-self-trigger' } as BundleScope);
    const out = await surface.ingestDocument!({ agentId, collectionId: col.collectionId, title: 'From the run', text: 'Ingested by a workflow run.', contentTrust: 'trusted' }) as { documentId: string };
    expect(out.documentId).toBeTruthy();
    await settle();
    expect(ofType(INGESTED, tenantId)).toHaveLength(1);
    expect('origin' in ofType(INGESTED, tenantId)[0]!, '`origin` is dispatcher routing state, never a wire field').toBe(false);
    expect(startRunCalls.filter((r) => r.workflowId === 'wf-self-trigger'), 'ADR 0617 D1a — the emitting run must not re-trigger its own workflow').toHaveLength(0);
    expect(startRunCalls.filter((r) => r.workflowId === 'wf-other-listener'), 'the skip is origin-based: a different workflow bound to the same event DOES start').toHaveLength(1);

    const r = await c.post(KB(orgId, `/collections/${col.collectionId}/documents`), { title: 'From a human', text: 'Ingested through the route.' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    await settle();
    expect(ofType(INGESTED, tenantId)).toHaveLength(2);
    expect(startRunCalls.filter((r) => r.workflowId === 'wf-self-trigger'), 'a human/route emit carries no origin and DOES start the bound workflow').toHaveLength(1);
    expect(startRunCalls.filter((r) => r.workflowId === 'wf-other-listener')).toHaveLength(2);
    expect(startRunCalls.find((r) => r.workflowId === 'wf-self-trigger')!.metadata).toMatchObject({ hostEvent: { bindingId: binding.bindingId } });
  });
});
