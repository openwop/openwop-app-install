/**
 * ADR 1054 — webinars: a webinar belongs to one client (org), a workflow writes only with
 * write authority, and a registrant the provider never confirmed is never dropped.
 *
 * Fixture: one workspace (tenant) with two clients, A and B; OWNER owns both, VIEWER is a
 * viewer of A. Every leg goes through the real seams: the HTTP routes, `buildFeatureSurfaces`
 * (the ADR 0832 floor the executor binds), the Connections broker, and a local stub standing in
 * for Zoom (`OPENWOP_ZOOM_API_BASE`). Nothing calls the real Zoom.
 *
 * Red on unmodified main (each leg its own test, so one red does not hide the next):
 *  - D1: client B registering client A's Zoom webinar id got A's event back (201), with A's
 *    title overwritten; a webhook from B's connection rewrote A's title the same way.
 *  - D2: a viewer's run pushed a registrant and wrote a CRM activity; a viewer's run synced.
 *  - D3: a push the broker refused (an actorless run) was dropped, not queued; a 2xx with no
 *    `registrant_id` reported success with an empty id.
 * Added with the fix (the review's B1/B3/M2/m3 and D4): the stale-read first-writer race, the
 * untracked-id refusal, a refusal staying queued with its reason, the insert-once queue clock,
 * the connection check and pin, and tracked-only webhook ingest. Sabotage notes: see ADR 1054's
 * implementation record.
 *
 * Guards a single sabotage cannot see (measured in /grade-tests wave 98):
 *  - DOUBLE GUARD, two files: on the WEBHOOK lane another client's webinar is refused by
 *    `ingestWebinarEvent`'s own `tracked.orgId !== orgId` check (webinarProcessor.ts) AND, behind
 *    it, by `upsertMarketingEvent`'s `existing.orgId !== input.orgId` (marketingEvent.ts; reached
 *    because the webhook's title differs from the stored one). Turning off the upsert check alone
 *    leaves both webhook cases green; turning off both reds them (a held pair). The route 409 and
 *    the stale-read race reach ONLY the upsert check (they never pass through ingest), so turning
 *    it off alone reds those two: a single guard there.
 *  - The log line's "never the participant" is held for EMAILS by the host logger too (ADR 0733
 *    value mask): an email leaked at the call site is masked anyway, so it reds only with the
 *    `OPENWOP_LOG_MASK_PII*` flags off. The participant's NAME is not masked, and reds alone.
 *  - The run lane's other-client refusal is the surface's own check (the exact `event_in_other_org`
 *    code); ingest's check behind it would answer `not_recorded` instead.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces, type FeatureSurface } from '../src/host/featureSurfaces.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { createSecretConnection } from '../src/features/connections/connectionsService.js';
import { getMarketingEvent, upsertMarketingEvent, bindFormToEvent, unbindForm } from '../src/features/webinars/entities/marketingEvent.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { ingestWebinarEvent, onVerifiedWebinarWebhook } from '../src/features/webinars/webinarProcessor.js';
import { findContactByEmail } from '../src/features/crm/contactsService.js';
import { writeErasureTombstone } from '../src/features/consent/consentService.js';
import { listPendingPushes, enqueuePendingPush, recordPushFailure } from '../src/features/webinars/pendingPush.js';
import { runSubmissionSinks } from '../src/features/forms/submissionSinks.js';
import type { FormDef, Submission } from '../src/features/forms/formsService.js';
import { listActivitiesByIdPrefix } from '../src/features/crm/crmEntitiesService.js';

let BASE: string;
let server: http.Server;
let zoom: http.Server;
let n = 0;
/** What the stub Zoom answers next, and what it was sent. */
let zoomReply: { status: number; body: Record<string, unknown> } = { status: 201, body: {} };
/** Optional per-request answer (by the registrant email in the body). */
let zoomRoute: ((body: Record<string, unknown>) => { status: number; body: Record<string, unknown> }) | null = null;
const zoomHits: Array<{ path: string; auth: string; body: Record<string, unknown> }> = [];

const ENV_KEYS = ['OPENWOP_STORAGE_DSN', 'OPENWOP_SESSION_SECRET', 'OPENWOP_TEST_AUTH_ENABLED', 'OPENWOP_WEBHOOK_ALLOW_PRIVATE', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_ZOOM_API_BASE'] as const;
const savedEnv = new Map<string, string | undefined>();
const TOGGLES = ['users', 'webinars', 'crm', 'connections'] as const;

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv.set(k, process.env[k]);
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  zoom = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += String(c); });
    req.on('end', () => {
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      const body: Record<string, unknown> = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...parsed } : {};
      zoomHits.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? ''), body });
      const reply = zoomRoute ? zoomRoute(body) : zoomReply;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => zoom.listen(0, '127.0.0.1', r));
  process.env.OPENWOP_ZOOM_API_BASE = `http://127.0.0.1:${(zoom.address() as AddressInfo).port}/v2`;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of TOGGLES) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
}, 120_000);
afterAll(async () => {
  for (const id of TOGGLES) { const d = getToggleDefault(id); if (d) await saveConfig(d, 'test'); }
  for (const [k, v] of savedEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await new Promise<void>((res) => server.close(() => res()));
  await new Promise<void>((res) => zoom.close(() => res()));
});

interface Body { user?: { userId: string }; orgId?: string; eventId?: string; title?: string; error?: string; code?: string; pushed?: number; failed?: number; total?: number; items?: Array<{ pendingId: string; email: string; attempts: number; lastError?: string }>; removed?: boolean }
/** Narrow a parsed response to `Body` without a cast (the fields the cases read). */
function isBody(u: unknown): u is Body {
  if (u === null || typeof u !== 'object' || Array.isArray(u)) return false;
  if ('orgId' in u && typeof u.orgId !== 'string') return false;
  if ('eventId' in u && typeof u.eventId !== 'string') return false;
  if ('title' in u && typeof u.title !== 'string') return false;
  if ('error' in u && typeof u.error !== 'string') return false;
  if ('total' in u && typeof u.total !== 'number') return false;
  if ('items' in u && !Array.isArray(u.items)) return false;
  if ('user' in u && (u.user === null || typeof u.user !== 'object' || !('userId' in u.user) || typeof u.user.userId !== 'string')) return false;
  return true;
}
async function readBody(res: Response): Promise<Body> {
  const parsed: unknown = await res.json().catch(() => ({}));
  return isBody(parsed) ? parsed : {};
}
function client(): { post: (p: string, b?: unknown) => Promise<{ status: number; body: Body }>; get: (p: string) => Promise<{ status: number; body: Body }> } {
  let cookie = '';
  return {
    get: async (path) => {
      const res = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
      return { status: res.status, body: await readBody(res) };
    },
    post: async (path, body) => {
      const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: await readBody(res) };
    },
  };
}

const H = '/host/openwop-app';

async function fixture() {
  const tenantId = `org:wb1054-${Date.now()}-${n++}`;
  const owner = client();
  const ownerId = (await owner.post(`${H}/test/login`, { email: `wb-o-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const viewer = client();
  const viewerId = (await viewer.post(`${H}/test/login`, { email: `wb-v-${n++}@acme.test`, tenantId })).body.user?.userId ?? '';
  const orgA = (await owner.post(`${H}/orgs`, { name: 'Client A' })).body.orgId ?? '';
  const orgB = (await owner.post(`${H}/orgs`, { name: 'Client B' })).body.orgId ?? '';
  expect(ownerId && viewerId && orgA && orgB, 'fixture: two users and two clients exist').toBeTruthy();
  expect((await owner.post(`${H}/orgs/${encodeURIComponent(orgA)}/members`, { displayName: 'V', subject: viewerId, roles: ['viewer'] })).status).toBe(201);
  return { tenantId, ownerId, viewerId, orgA, orgB, owner, viewer };
}

const surfaces = (scope: BundleScope): Record<string, FeatureSurface> => buildFeatureSurfaces(scope);
const pid = (): string => `9${Date.now()}${n++}`;

describe('ADR 1054 D1 — a Zoom webinar id belongs to one client', () => {
  it('client B cannot register client A\'s webinar: refused, and A\'s event is untouched', async () => {
    const f = await fixture();
    const id = pid();
    const a = await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events`, { providerEventId: id, title: 'A launch' });
    expect(a.status).toBe(201);
    const b = await f.owner.post(`${H}/webinars/orgs/${f.orgB}/events`, { providerEventId: id, title: 'B overwrite' });
    expect(b.status, JSON.stringify(b.body)).toBe(409);
    expect(b.body.error).toBe('conflict');
    expect(JSON.stringify(b.body)).not.toContain('A launch');
    const stored = await getMarketingEvent(f.tenantId, f.orgA, a.body.eventId ?? '');
    expect(stored?.title).toBe('A launch');
    expect(stored?.orgId).toBe(f.orgA);
  });

  it('a webhook delivered for client B does not rewrite client A\'s event or record B\'s attendee', async () => {
    const f = await fixture();
    const id = pid();
    const a = await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events`, { providerEventId: id, title: 'A launch' });
    await ingestWebinarEvent(f.tenantId, f.orgB, undefined, { provider: 'zoom', providerEventId: id, phase: 'attended', participantEmail: `p${n++}@x.test`, title: 'B topic' });
    expect((await getMarketingEvent(f.tenantId, f.orgA, a.body.eventId ?? ''))?.title).toBe('A launch');
    expect(await listActivitiesByIdPrefix(f.tenantId, f.orgB, `act:webinar:${id}:`)).toEqual([]);
  });

  it('control: the same client registering its own webinar again is an idempotent update', async () => {
    const f = await fixture();
    const id = pid();
    const first = await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events`, { providerEventId: id, title: 'v1' });
    const again = await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events`, { providerEventId: id, title: 'v2' });
    expect(again.status).toBe(201);
    expect(again.body.eventId).toBe(first.body.eventId);
    expect(again.body.title).toBe('v2');
  });
});

describe('ADR 1054 D2 — a workflow writes webinars only with write authority', () => {
  it('a viewer\'s run cannot push a registrant, and no CRM activity is written', async () => {
    // The webinar is TRACKED and the org has a Zoom connection, so without the floor the call
    // would record an activity and push: both halves of the claim can fail.
    const f = await fixture();
    await zoomConn(f);
    const { providerEventId: id } = await trackA(f);
    zoomHits.length = 0;
    const w = surfaces({ tenantId: f.tenantId, runId: `r-${n++}`, actingUserId: f.viewerId }).webinars!;
    await expect(w.registerRegistrant!({ orgId: f.orgA, webinarId: id, email: `v${n++}@x.test` })).rejects.toMatchObject({ code: 'forbidden_scope' });
    expect(zoomHits).toHaveLength(0);
    expect(await listActivitiesByIdPrefix(f.tenantId, f.orgA, `act:webinar:${id}:`)).toEqual([]);
  });

  it('a viewer\'s run cannot start an attendance sync', async () => {
    const f = await fixture();
    const ev = await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events`, { providerEventId: pid() });
    const w = surfaces({ tenantId: f.tenantId, runId: `r-${n++}`, actingUserId: f.viewerId }).webinars!;
    await expect(w.syncEvent!({ orgId: f.orgA, eventId: ev.body.eventId })).rejects.toMatchObject({ code: 'forbidden_scope' });
  });
});

/** Track a webinar for client A through the real route and return its ids. */
async function trackA(f: Awaited<ReturnType<typeof fixture>>, body: Record<string, unknown> = {}): Promise<{ eventId: string; providerEventId: string }> {
  const providerEventId = pid();
  const ev = await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events`, { providerEventId, ...body });
  expect(ev.status, JSON.stringify(ev.body)).toBe(201);
  return { eventId: ev.body.eventId ?? '', providerEventId };
}
const zoomConn = (f: Awaited<ReturnType<typeof fixture>>, scope: 'org' | 'workspace' = 'org') =>
  createSecretConnection({ tenantId: f.tenantId, provider: 'zoom-webinar', kind: 'bearer', secret: 'ZOOM_TOKEN', scope, ...(scope === 'org' ? { orgId: f.orgA, userId: f.ownerId } : {}) });

describe('ADR 1054 D3 — register only into a tracked webinar; queue what can recover', () => {
  it('the real credential path: the owner\'s run pushes through the org connection to (stub) Zoom', async () => {
    const f = await fixture();
    await zoomConn(f);
    const { providerEventId: id } = await trackA(f);
    zoomReply = { status: 201, body: { registrant_id: 'reg-1', join_url: 'https://zoom.test/j/1' } };
    zoomHits.length = 0;
    const w = surfaces({ tenantId: f.tenantId, runId: `r-${n++}`, actingUserId: f.ownerId }).webinars!;
    const out = await w.registerRegistrant!({ orgId: f.orgA, webinarId: id, email: `ok${n++}@x.test`, name: 'Ada Lovelace' });
    expect(out).toMatchObject({ success: true, registrantId: 'reg-1', joinUrl: 'https://zoom.test/j/1', recorded: true });
    expect(zoomHits).toHaveLength(1);
    expect(zoomHits[0]!.path).toBe(`/v2/webinars/${id}/registrants`);
    expect(zoomHits[0]!.auth).toBe('Bearer ZOOM_TOKEN');
    expect(zoomHits[0]!.body).toMatchObject({ first_name: 'Ada', last_name: 'Lovelace' });
    expect(JSON.stringify(out)).not.toContain('ZOOM_TOKEN');
  });

  it('an UNTRACKED webinar id is refused before any push or write; no event is created', async () => {
    const f = await fixture();
    await zoomConn(f);
    const id = pid();
    zoomHits.length = 0;
    const w = surfaces({ tenantId: f.tenantId, runId: `r-${n++}`, actingUserId: f.ownerId }).webinars!;
    expect(await w.registerRegistrant!({ orgId: f.orgA, webinarId: id, email: `u${n++}@x.test` })).toEqual({ success: false, error: 'event_not_tracked', queued: false, recorded: false });
    expect(zoomHits).toHaveLength(0);
    expect(await getMarketingEvent(f.tenantId, f.orgA, `${f.tenantId}:zoom:${id}`)).toBeNull();
  });

  it('another client\'s webinar is refused before any push, through B\'s run', async () => {
    const f = await fixture();
    const { providerEventId } = await trackA(f);
    zoomHits.length = 0;
    const w = surfaces({ tenantId: f.tenantId, runId: `r-${n++}`, actingUserId: f.ownerId }).webinars!;
    expect(await w.registerRegistrant!({ orgId: f.orgB, webinarId: providerEventId, email: `b${n++}@x.test` })).toMatchObject({ success: false, error: 'event_in_other_org', queued: false });
    expect(zoomHits).toHaveLength(0);
  });

  it('a 2xx without a registrant id is a typed failure, and the registrant is queued', async () => {
    const f = await fixture();
    await zoomConn(f);
    const { eventId, providerEventId } = await trackA(f);
    zoomReply = { status: 201, body: {} };
    const w = surfaces({ tenantId: f.tenantId, runId: `r-${n++}`, actingUserId: f.ownerId }).webinars!;
    const email = `noid${n++}@x.test`;
    expect(await w.registerRegistrant!({ orgId: f.orgA, webinarId: providerEventId, email })).toMatchObject({ success: false, error: 'zoom_no_registrant_id', queued: true, recorded: true });
    expect((await listPendingPushes(f.tenantId, f.orgA, eventId)).map((p) => p.email)).toEqual([email]);
  });

  it('a Zoom refusal (400) stays queued WITH its reason; nothing is ever silently dropped', async () => {
    const f = await fixture();
    await zoomConn(f);
    const { eventId, providerEventId } = await trackA(f);
    // Zoom's message can echo the registrant; only the status and Zoom's numeric code are kept.
    zoomReply = { status: 400, body: { code: 300, message: `Invalid email: ${'bad'}@x.test` } };
    const w = surfaces({ tenantId: f.tenantId, runId: `r-${n++}`, actingUserId: f.ownerId }).webinars!;
    const email = `bad${n++}@x.test`;
    expect(await w.registerRegistrant!({ orgId: f.orgA, webinarId: providerEventId, email })).toMatchObject({ success: false, error: 'zoom_400:300', queued: true });
    expect((await listPendingPushes(f.tenantId, f.orgA, eventId)).map((p) => p.email)).toEqual([email]);
    const drain = await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events/${encodeURIComponent(eventId)}/push-registrants`);
    expect(drain.body).toMatchObject({ pushed: 0, failed: 1, failures: [{ email, reason: 'zoom_400:300' }] });
    const [stored] = await listPendingPushes(f.tenantId, f.orgA, eventId);
    expect(stored).toMatchObject({ attempts: 1, lastError: 'zoom_400:300' });
    expect(JSON.stringify(stored)).not.toContain('Invalid email');
    expect((await listPendingPushes(f.tenantId, f.orgA, eventId)).map((p) => p.email)).toEqual([email]);
  });

  it('the push goes through the TRACKED event\'s connection, not the broker\'s default pick', async () => {
    const f = await fixture();
    await zoomConn(f); // the org connection the broker would pick by default for the owner
    const ws = await createSecretConnection({ tenantId: f.tenantId, provider: 'zoom-webinar', kind: 'bearer', secret: 'WS_TOKEN', scope: 'workspace' });
    const { providerEventId } = await trackA(f, { connectionId: ws.connectionId });
    zoomReply = { status: 201, body: { registrant_id: 'reg-ws' } };
    zoomHits.length = 0;
    const w = surfaces({ tenantId: f.tenantId, runId: `r-${n++}`, actingUserId: f.ownerId }).webinars!;
    expect(await w.registerRegistrant!({ orgId: f.orgA, webinarId: providerEventId, email: `pin${n++}@x.test` })).toMatchObject({ success: true, registrantId: 'reg-ws' });
    expect(zoomHits.map((h) => h.auth)).toEqual(['Bearer WS_TOKEN']);
  });

  it('an ERASED person is never sent to Zoom or queued (the registration is recorded first)', async () => {
    const f = await fixture();
    await zoomConn(f);
    const { eventId, providerEventId } = await trackA(f);
    const email = `gone${n++}@x.test`;
    await writeErasureTombstone(f.tenantId, email);
    zoomHits.length = 0;
    const w = surfaces({ tenantId: f.tenantId, runId: `r-${n++}`, actingUserId: f.ownerId }).webinars!;
    expect(await w.registerRegistrant!({ orgId: f.orgA, webinarId: providerEventId, email })).toEqual({ success: false, error: 'not_recorded', queued: false, recorded: false });
    expect(zoomHits).toHaveLength(0);
    expect(await listPendingPushes(f.tenantId, f.orgA, eventId)).toEqual([]);
  });

  it('an actorless run cannot reach the org credential: the registrant is queued for an operator', async () => {
    const f = await fixture();
    await zoomConn(f);
    const { eventId, providerEventId } = await trackA(f);
    zoomHits.length = 0;
    const w = surfaces({ tenantId: f.tenantId, runId: `r-${n++}` }).webinars!;
    const email = `sys${n++}@x.test`;
    expect(await w.registerRegistrant!({ orgId: f.orgA, webinarId: providerEventId, email })).toMatchObject({ success: false, error: 'no_connection', queued: true });
    expect(zoomHits).toHaveLength(0);
    expect((await listPendingPushes(f.tenantId, f.orgA, eventId)).map((p) => p.email)).toEqual([email]);
  });

  it('a re-queue keeps the FIRST queuedAt (the retention clock is not restarted)', async () => {
    const f = await fixture();
    const { eventId, providerEventId } = await trackA(f);
    const w = surfaces({ tenantId: f.tenantId, runId: `r-${n++}` }).webinars!;
    const email = `twice${n++}@x.test`;
    await w.registerRegistrant!({ orgId: f.orgA, webinarId: providerEventId, email });
    const first = (await listPendingPushes(f.tenantId, f.orgA, eventId))[0]!.queuedAt;
    // The retry happens a minute later (fake Date only), so a restarted clock would differ.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.now() + 60_000));
      await w.registerRegistrant!({ orgId: f.orgA, webinarId: providerEventId, email });
    } finally { vi.useRealTimers(); }
    expect((await listPendingPushes(f.tenantId, f.orgA, eventId)).map((p) => p.queuedAt)).toEqual([first]);
  });
});

describe('ADR 1054 D1 — the claim is atomic and the connection is checked', () => {
  it('a first writer that read a STALE "absent" cannot overwrite the winner (the insert is atomic)', async () => {
    // Deterministic race: client A tracks the id; then client B's upsert is made to read the
    // row as absent ONCE (the read that loses a real race). An insert that is not
    // insert-if-absent overwrites A; the atomic one fails, re-reads, and refuses B.
    const f = await fixture();
    const { eventId, providerEventId } = await trackA(f, { title: 'A owns it' });
    const realGet = DurableCollection.prototype.get;
    let staleReads = 0;
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      if (id === eventId && staleReads === 0) { staleReads += 1; return null; }
      return realGet.call(this, id);
    });
    try {
      await expect(upsertMarketingEvent({ tenantId: f.tenantId, orgId: f.orgB, provider: 'zoom', providerEventId, title: 'B stole it' }))
        .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'event_in_other_org' } });
    } finally { spy.mockRestore(); }
    expect(staleReads).toBe(1);
    const stored = await getMarketingEvent(f.tenantId, f.orgA, eventId);
    expect(stored).toMatchObject({ orgId: f.orgA, title: 'A owns it' });
  });

  it('a connectionId of another client is refused (400); this client\'s and a workspace one are accepted', async () => {
    const f = await fixture();
    const other = await createSecretConnection({ tenantId: f.tenantId, provider: 'zoom-webinar', kind: 'bearer', secret: 'B', scope: 'org', orgId: f.orgB, userId: f.ownerId });
    const mine = await zoomConn(f);
    const ws = await zoomConn(f, 'workspace');
    expect((await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events`, { providerEventId: pid(), connectionId: other.connectionId })).status).toBe(400);
    expect((await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events`, { providerEventId: pid(), connectionId: mine.connectionId })).status).toBe(201);
    expect((await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events`, { providerEventId: pid(), connectionId: ws.connectionId })).status).toBe(201);
  });
});

describe('ADR 1054 D4 — only webinars the client tracks are ingested from webhooks', () => {
  const regBody = (id: string, email: string) => ({ event: 'meeting.registration_created', payload: { object: { id, topic: 'Team sync', registrant: { email, first_name: 'Int', last_name: 'Ernal' } } } });

  it('a registration for an untracked meeting creates no contact, no event, no activity', async () => {
    const f = await fixture();
    const conn = await zoomConn(f);
    const id = pid();
    const email = `internal${n++}@acme.test`;
    await onVerifiedWebinarWebhook({ tenantId: f.tenantId, connectionId: conn.connectionId, body: regBody(id, email), now: Date.now() });
    expect(await getMarketingEvent(f.tenantId, f.orgA, `${f.tenantId}:zoom:${id}`)).toBeNull();
    expect(await listActivitiesByIdPrefix(f.tenantId, f.orgA, `act:webinar:${id}:`)).toEqual([]);
    expect(await findContactByEmail(f.tenantId, email)).toBeFalsy();
  });

  it('a webhook from a second connection of the same client never re-pins the tracked event', async () => {
    const f = await fixture();
    const first = await zoomConn(f);
    const second = await zoomConn(f);
    const { eventId, providerEventId } = await trackA(f, { connectionId: first.connectionId });
    await onVerifiedWebinarWebhook({ tenantId: f.tenantId, connectionId: second.connectionId, body: regBody(providerEventId, `g${n++}@x.test`), now: Date.now() });
    expect((await getMarketingEvent(f.tenantId, f.orgA, eventId))?.connectionId).toBe(first.connectionId);
  });

  it('a webhook through client B\'s connection for client A\'s webinar records nothing for B, not even a contact', async () => {
    const f = await fixture();
    const bConn = await createSecretConnection({ tenantId: f.tenantId, provider: 'zoom-webinar', kind: 'bearer', secret: 'B', scope: 'org', orgId: f.orgB, userId: f.ownerId });
    const { providerEventId } = await trackA(f);
    const email = `bguest${n++}@x.test`;
    await onVerifiedWebinarWebhook({ tenantId: f.tenantId, connectionId: bConn.connectionId, body: regBody(providerEventId, email), now: Date.now() });
    expect(await listActivitiesByIdPrefix(f.tenantId, f.orgB, `act:webinar:${providerEventId}:`)).toEqual([]);
    expect(await listActivitiesByIdPrefix(f.tenantId, f.orgA, `act:webinar:${providerEventId}:`)).toEqual([]);
    expect(await findContactByEmail(f.tenantId, email)).toBeFalsy();
  });

  it('control: a tracked webinar\'s registration is recorded', async () => {
    const f = await fixture();
    const conn = await zoomConn(f);
    const { providerEventId } = await trackA(f);
    await onVerifiedWebinarWebhook({ tenantId: f.tenantId, connectionId: conn.connectionId, body: regBody(providerEventId, `guest${n++}@x.test`), now: Date.now() });
    expect((await listActivitiesByIdPrefix(f.tenantId, f.orgA, `act:webinar:${providerEventId}:`)).map((a) => a.activityId.split(':').pop())).toEqual(['registered']);
  });
});

describe('ADR 1054 review — the form sink, the queue order, the queue list, the no-op ingest', () => {
  it('the PUBLIC form sink never pushes or queues an erased person (record first, as the surface does)', async () => {
    const f = await fixture();
    await zoomConn(f);
    const { eventId } = await trackA(f);
    const formId = `form-${n++}`;
    await bindFormToEvent(f.tenantId, f.orgA, formId, eventId);
    const email = `erased${n++}@x.test`;
    await writeErasureTombstone(f.tenantId, email);
    zoomHits.length = 0;
    const form: FormDef = { formId, tenantId: f.tenantId, orgId: f.orgA, title: 'Signup', status: 'published', fields: [], createToContact: false, createdBy: f.ownerId, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z' };
    const submission: Submission = { submissionId: `sub-${n++}`, tenantId: f.tenantId, orgId: f.orgA, formId, values: { email }, meta: {}, createdAt: '2026-11-01T00:00:00.000Z' };
    await runSubmissionSinks(form, submission);
    expect(zoomHits).toHaveLength(0);
    expect(await listPendingPushes(f.tenantId, f.orgA, eventId)).toEqual([]);
  });

  it('50 rows Zoom keeps refusing do not block row 51: the drain takes the fewest-attempted first', async () => {
    // The fresh row's email sorts AFTER every `refused<i>@` (the store lists by key), so only the
    // drain's own order can bring it into the first 50 (w98: `fresh@` sorted first, and the case
    // passed with no ordering at all).
    const f = await fixture();
    await zoomConn(f);
    const { eventId, providerEventId } = await trackA(f);
    for (let i = 0; i < 50; i++) await enqueuePendingPush({ tenantId: f.tenantId, orgId: f.orgA, eventId, providerEventId, email: `refused${i}@x.test` });
    for (const row of await listPendingPushes(f.tenantId, f.orgA, eventId)) await recordPushFailure(row, 'zoom_400:300');
    await enqueuePendingPush({ tenantId: f.tenantId, orgId: f.orgA, eventId, providerEventId, email: 'zfresh@x.test' });
    zoomRoute = (body) => (String(body.email).startsWith('refused') ? { status: 400, body: { code: 300 } } : { status: 201, body: { registrant_id: 'reg-fresh' } });
    try {
      const drain = await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events/${encodeURIComponent(eventId)}/push-registrants`);
      expect(drain.body).toMatchObject({ pushed: 1, failed: 49 });
    } finally { zoomRoute = null; }
    const left = await listPendingPushes(f.tenantId, f.orgA, eventId);
    expect(left.map((r) => r.email)).not.toContain('zfresh@x.test');
    expect(left).toHaveLength(50);
    expect(Math.min(...left.map((r) => r.attempts ?? 0))).toBeGreaterThanOrEqual(1);
  });

  it('the queue list shows masked emails and Zoom\'s last answer; remove takes one out (viewer may read, not remove)', async () => {
    const f = await fixture();
    const { eventId, providerEventId } = await trackA(f);
    await enqueuePendingPush({ tenantId: f.tenantId, orgId: f.orgA, eventId, providerEventId, email: 'zed@example.test' });
    const [row] = await listPendingPushes(f.tenantId, f.orgA, eventId);
    await recordPushFailure(row!, 'zoom_400:300');
    const list = await f.owner.get(`${H}/webinars/orgs/${f.orgA}/events/${encodeURIComponent(eventId)}/pending`);
    expect(list.body).toMatchObject({ total: 1, items: [{ email: 'ze…@example.test', attempts: 1, lastError: 'zoom_400:300' }] });
    expect(JSON.stringify(list.body)).not.toContain('zed@');
    const pendingId = list.body.items![0]!.pendingId;
    // WEB-23 — the handle is random, not a hash a dictionary of emails reverses.
    expect(pendingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(pendingId).toBe(row!.pendingId);
    const viewerList = await f.viewer.get(`${H}/webinars/orgs/${f.orgA}/events/${encodeURIComponent(eventId)}/pending`);
    expect(viewerList.status).toBe(200);
    expect(viewerList.body.total).toBe(1);
    expect((await f.viewer.post(`${H}/webinars/orgs/${f.orgA}/events/${encodeURIComponent(eventId)}/pending/${pendingId}/remove`)).status).toBe(403);
    expect((await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events/${encodeURIComponent(eventId)}/pending/${pendingId}/remove`)).body).toEqual({ removed: true });
    expect(await listPendingPushes(f.tenantId, f.orgA, eventId)).toEqual([]);
    expect((await f.owner.post(`${H}/webinars/orgs/${f.orgA}/events/${encodeURIComponent(eventId)}/pending/${pendingId}/remove`)).status).toBe(404);
    // WEB-23, the half a regex cannot see: the same person queued again for the same event gets a
    // NEW handle (a hash of the key would hand back the old one).
    await enqueuePendingPush({ tenantId: f.tenantId, orgId: f.orgA, eventId, providerEventId, email: 'zed@example.test' });
    const [again] = await listPendingPushes(f.tenantId, f.orgA, eventId);
    expect(again?.pendingId).toMatch(/^[0-9a-f-]{36}$/);
    expect(again?.pendingId).not.toBe(pendingId);
  });

  it('an ingest that changes nothing on the event writes no event row (no contention on a join burst)', async () => {
    const f = await fixture();
    const { providerEventId } = await trackA(f, { title: 'Launch' });
    const cas = vi.spyOn(DurableCollection.prototype, 'compareAndSwap');
    const pia = vi.spyOn(DurableCollection.prototype, 'putIfAbsent');
    try {
      const outcome = await ingestWebinarEvent(f.tenantId, f.orgA, undefined, { provider: 'zoom', providerEventId, phase: 'attended', participantEmail: `j${n++}@x.test`, title: 'Launch' });
      expect(outcome).toBe('recorded');
      const eventWrites = [...cas.mock.calls.map((c) => c[1]), ...pia.mock.calls.map((c) => c[0])]
        .filter((row) => typeof (row as { providerEventId?: unknown }).providerEventId === 'string' && (row as { eventId?: unknown }).eventId !== undefined);
      expect(eventWrites).toEqual([]);
    } finally { cas.mockRestore(); pia.mockRestore(); }
  });

  it('a patch that keeps losing the event-row race still records the activity', async () => {
    const f = await fixture();
    const { eventId, providerEventId } = await trackA(f, { title: 'Launch' });
    const realCas = DurableCollection.prototype.compareAndSwap;
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(async function (this: DurableCollection<unknown>, expected: unknown, next: unknown) {
      if ((next as { eventId?: unknown }).eventId === eventId) return false; // always contended
      return realCas.call(this, expected, next);
    });
    try {
      expect(await ingestWebinarEvent(f.tenantId, f.orgA, undefined, { provider: 'zoom', providerEventId, phase: 'attended', participantEmail: `c${n++}@x.test`, title: 'Renamed by Zoom' })).toBe('recorded');
    } finally { spy.mockRestore(); }
    expect((await listActivitiesByIdPrefix(f.tenantId, f.orgA, `act:webinar:${providerEventId}:`)).map((a) => a.activityId.split(':').pop())).toEqual(['attended']);
  });

  it('D4: untracked webinar.* and meeting.* deliveries are ignored, logged with ids and a count, never the participant', async () => {
    const f = await fixture();
    const conn = await zoomConn(f);
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; });
    const emails: string[] = [];
    try {
      for (let i = 0; i < 100; i++) {
        const email = `untracked${i}-${n}@x.test`;
        emails.push(email);
        const body = i % 2 === 0
          ? { event: 'webinar.participant_joined', payload: { object: { id: pid(), participant: { email, user_name: 'Int Ernal' } } } }
          : { event: 'meeting.registration_created', payload: { object: { id: pid(), registrant: { email } } } };
        await onVerifiedWebinarWebhook({ tenantId: f.tenantId, connectionId: conn.connectionId, body, now: Date.now() });
      }
    } finally { spy.mockRestore(); }
    const logged = lines.filter((l) => l.includes('webinar_webhook_untracked'));
    expect(logged.length).toBeGreaterThan(0);
    for (const l of logged) {
      expect(l).toMatch(/"droppedSinceBoot":\d+/);
      for (const e of emails) expect(l).not.toContain(e);
      expect(l).not.toContain('Int Ernal');
    }
    expect(await findContactByEmail(f.tenantId, emails[0]!)).toBeFalsy();
    expect(await findContactByEmail(f.tenantId, emails[1]!)).toBeFalsy();
  });

  it('WEB-21: an unbind whose first event-row patch loses a race still clears the form pointer', async () => {
    const f = await fixture();
    const { eventId } = await trackA(f);
    const formId = `form-${n++}`;
    await bindFormToEvent(f.tenantId, f.orgA, formId, eventId);
    await upsertMarketingEvent({ tenantId: f.tenantId, orgId: f.orgA, provider: 'zoom', providerEventId: (await getMarketingEvent(f.tenantId, f.orgA, eventId))!.providerEventId, formId });
    const realCas = DurableCollection.prototype.compareAndSwap;
    let lost = 0;
    const spy = vi.spyOn(DurableCollection.prototype, 'compareAndSwap').mockImplementation(async function (this: DurableCollection<unknown>, expected: unknown, next: unknown) {
      if ((next as { eventId?: unknown }).eventId === eventId && lost === 0) { lost += 1; return false; }
      return realCas.call(this, expected, next);
    });
    try { await unbindForm(f.tenantId, formId); } finally { spy.mockRestore(); }
    expect(lost).toBe(1);
    expect((await getMarketingEvent(f.tenantId, f.orgA, eventId))?.formId).toBeUndefined();
  });
});
