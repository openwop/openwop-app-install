/**
 * ADR 0627 D5 (`CRM-15`) — the Gmail connection pin is honoured at the BROKER,
 * the cursor is honest, and a dead or capped sync pauses itself.
 *
 * Before: `connectionId` was returned by the surface and never read by the node;
 * the invoke contract had no pin; `selectAuthorizedConnection` fell through
 * `userConn ?? orgConn ?? wsConn`, so a user connection flipped to
 * `needs-reconsent` silently read the WORKSPACE Google mailbox; the 5,000-cap
 * 409 was caught and warned while the cursor advanced past every dropped
 * message; `syncGmailNow` ignored `paused`.
 *
 * Witnesses (each names the exact seam):
 *   - broker: a pinned `needs-reconsent` user connection with an ACTIVE workspace
 *     Google connection present → the unpinned lane (the old behaviour) still
 *     finds the workspace row; the PINNED lane refuses — no fall-through. A pin
 *     to another user's row, a foreign provider, or a workspace row is refused;
 *     a pin to the actor's own active row returns EXACTLY that row.
 *   - invoker: a refused pin surfaces as `connector_pinned_connection_unusable`
 *     (distinct from `connector_no_connection`), before any dial.
 *   - seam: the broker's own `needs-reconsent` flip fires
 *     `fireConnectionStatusChanged` → the crm consumer marks the sync
 *     `needs-reconsent` + disables its job; the revoke seam still pauses (with
 *     `pausedReason: 'connection-revoked'`).
 *   - cursor + self-pause: a `capped` append → cursor UNCHANGED, row
 *     `paused/capped`, job disabled, typed node failure; the REAL cap error
 *     classifies as `capped`, anything else as `failed`.
 *   - refusals: `syncGmailNow` on paused → 409 `validation_error` with the
 *     reason; on needs-reconsent → 422 `credential_unavailable`; the node
 *     refuses the same rows WITHOUT touching the connector.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { OpenwopError } from '../src/types.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createConnectorInvoker } from '../src/host/connectorInvoker.js';
import { onConnectionStatusChanged, type ConnectionStatusChangedEvent } from '../src/host/connectionLifecycle.js';
import { getJob } from '../src/host/schedulingService.js';
import { createHostEventBinding, initHostEventDispatcher, type HostEventEnvelope } from '../src/host/hostEventDispatcher.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import {
  __setConnectionStatusForTests,
  connectionExists,
  createSecretConnection,
  findUserConnection,
  getConnection,
  probeConnection,
  resolveConnectionCredential,
  revokeConnection,
  upsertOAuthConnection,
} from '../src/features/connections/connectionsService.js';
import type { RunRecord } from '../src/types.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { assertUnderCap, getActivity } from '../src/features/crm/crmEntitiesService.js';
import {
  createGmailSync,
  getGmailSync,
  gmailAppendOutcomeOf,
  markGmailSyncStatus,
  syncGmailNow,
  updateGmailSync,
} from '../src/features/crm/gmailSyncService.js';
import { getSetCookies } from './headerCookies.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const PACK_DIR = join(REPO, 'packs/feature.crm.nodes');
type NodeOut = { status: string; outputs?: Record<string, any>; error?: { code: string; message: string } };
type NodeFn = (ctx: Record<string, unknown>) => Promise<NodeOut>;

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const ORG = 'org-1';
let server: http.Server;
let BASE = '';
let storage: Storage;
let hostSuite: StartRunDeps['hostSuite'];
let gmailSyncNode: NodeFn;
const statusEvents: ConnectionStatusChangedEvent[] = [];
let n = 0;
const tenant = (): string => `org:crm-pin-${Date.now()}-${n++}`;

/** An oauth2 google connection whose token is EXPIRED with no refresh token —
 *  the broker flips it to `needs-reconsent` the first time it resolves it. */
async function deadGoogleConnection(tenantId: string, userId: string) {
  const conn = await upsertOAuthConnection({
    tenantId, provider: 'google', userId,
    tokens: { accessToken: 'stale', tokenType: 'Bearer', scopes: GMAIL_SCOPES, expiresAt: new Date(Date.now() - 60_000).toISOString() },
  });
  const probe = await probeConnection(tenantId, conn.connectionId);
  expect(probe).toEqual({ ok: false, status: 'needs-reconsent' });
  return conn;
}
async function liveGoogleConnection(tenantId: string, userId: string) {
  return upsertOAuthConnection({ tenantId, provider: 'google', userId, tokens: { accessToken: 'live', tokenType: 'Bearer', scopes: GMAIL_SCOPES } });
}
const crmSurface = (tenantId: string, runId: string) => buildHostSurfaceBundle({ tenantId, runId }).features.crm!;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as StartRunDeps['hostSuite'];
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
  // A second, observing subscriber — the crm consumer is registered by the real boot.
  onConnectionStatusChanged('test-observer', async (e) => { statusEvents.push(e); });
  const mod = (await import(pathToFileURL(join(PACK_DIR, 'index.mjs')).href)) as { nodes: Record<string, NodeFn> };
  gmailSyncNode = mod.nodes['feature.crm.nodes.gmail-sync']!;
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('broker — a pin is EXACT; the user→org→workspace fall-through is never consulted under a pin', () => {
  it('a needs-reconsent user connection + an active WORKSPACE google connection: unpinned finds the workspace row, pinned refuses', async () => {
    const T = tenant();
    const dead = await deadGoogleConnection(T, 'user:u1');
    const ws = await createSecretConnection({ tenantId: T, provider: 'google', kind: 'api_key', secret: 'ws-secret', scope: 'workspace' });
    expect((await getConnection(T, dead.connectionId))!.status).toBe('needs-reconsent');

    // The OLD behaviour, still correct for an UNPINNED caller: fall through to the workspace credential.
    const unpinned = await resolveConnectionCredential({ tenantId: T, provider: 'google', actingUserId: 'user:u1' });
    expect(unpinned?.connection.connectionId).toBe(ws.connectionId);

    // The pinned lane: the dead row is refused and NOTHING is substituted.
    expect(await connectionExists({ tenantId: T, provider: 'google', actingUserId: 'user:u1', connectionId: dead.connectionId })).toBe(false);
    expect(await resolveConnectionCredential({ tenantId: T, provider: 'google', actingUserId: 'user:u1', connectionId: dead.connectionId })).toBeNull();
  });

  it('a pin to the actor\'s own ACTIVE row returns exactly that row; another user\'s row, a foreign provider, a workspace row, and an unknown id are refused', async () => {
    const T = tenant();
    const mine = await liveGoogleConnection(T, 'user:u1');
    const theirs = await liveGoogleConnection(T, 'user:u2');
    const ws = await createSecretConnection({ tenantId: T, provider: 'google', kind: 'api_key', secret: 'ws', scope: 'workspace' });
    const pin = (connectionId: string, actingUserId?: string, provider = 'google') =>
      resolveConnectionCredential({ tenantId: T, provider, ...(actingUserId ? { actingUserId } : {}), connectionId });

    expect((await pin(mine.connectionId, 'user:u1'))?.connection.connectionId).toBe(mine.connectionId);
    expect((await pin(mine.connectionId, 'user:u1'))?.provenance.connectionId).toBe(mine.connectionId);
    expect(await pin(theirs.connectionId, 'user:u1'), 'another user\'s mailbox').toBeNull();
    expect(await pin(mine.connectionId, undefined), 'a system run cannot claim a user row').toBeNull();
    expect(await pin(mine.connectionId, 'user:u1', 'slack'), 'provider mismatch').toBeNull();
    expect(await pin(ws.connectionId, 'user:u1'), 'a workspace row is not pin-addressable (ADR 0627 D5 names two shapes)').toBeNull();
    expect(await pin('conn:does-not-exist', 'user:u1')).toBeNull();
    // …and a pin never widens: with the pin refused, the unpinned lane would have
    // found `mine` — proving the refusal is the pin, not the tenant.
    expect((await resolveConnectionCredential({ tenantId: T, provider: 'google', actingUserId: 'user:u1' }))?.connection.connectionId).toBe(mine.connectionId);
  });

  it('invoker: a refused pin is `connector_pinned_connection_unusable` — distinct from `connector_no_connection`, before any dial', async () => {
    const T = tenant();
    const dead = await deadGoogleConnection(T, 'user:u1');
    await createSecretConnection({ tenantId: T, provider: 'google', kind: 'api_key', secret: 'ws', scope: 'workspace' });
    await storage.insertRun({ runId: 'run-pin', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    const invoker = createConnectorInvoker({ storage });
    const url = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1';
    const pinned = await invoker.invoke('google', { context: { tenantId: T, runId: 'run-pin', actingUserId: 'user:u1' }, request: { url, method: 'GET', connectionId: dead.connectionId } });
    expect(pinned).toEqual({ ok: false, error: 'connector_pinned_connection_unusable' });
    const nobody = await invoker.invoke('google', { context: { tenantId: 'org:empty-tenant', runId: 'run-pin' }, request: { url, method: 'GET' } });
    expect(nobody).toEqual({ ok: false, error: 'connector_no_connection' });
  });
});

describe('seam — a connection status change reaches the crm consumer; revoke still pauses', () => {
  it('the broker\'s needs-reconsent flip fires fireConnectionStatusChanged; the sync is marked needs-reconsent and its job disabled', async () => {
    const T = tenant();
    const conn = await upsertOAuthConnection({
      tenantId: T, provider: 'google', userId: 'user:u1',
      tokens: { accessToken: 'stale', tokenType: 'Bearer', scopes: GMAIL_SCOPES, expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    expect((await getJob(sync.jobId))!.enabled).toBe(true);
    const before = statusEvents.length;

    expect(await probeConnection(T, conn.connectionId)).toEqual({ ok: false, status: 'needs-reconsent' });

    const fired = statusEvents.slice(before).filter((e) => e.connectionId === conn.connectionId);
    expect(fired).toEqual([{ tenantId: T, connectionId: conn.connectionId, provider: 'google', status: 'needs-reconsent', previousStatus: 'active' }]);
    const row = (await getGmailSync(T, sync.syncId))!;
    expect(row.status).toBe('needs-reconsent');
    expect(row.pausedReason).toBeUndefined();
    expect((await getJob(sync.jobId))!.enabled).toBe(false);

    // A second resolve of the same dead row is NOT a transition: no second event.
    expect(await probeConnection(T, conn.connectionId)).toEqual({ ok: false, status: 'needs-reconsent' });
    expect(statusEvents.slice(before).filter((e) => e.connectionId === conn.connectionId)).toHaveLength(1);
  });

  it('revoke pauses with pausedReason connection-revoked; a user resume clears the reason', async () => {
    const T = tenant();
    const conn = await liveGoogleConnection(T, 'user:u1');
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    expect(await revokeConnection(T, conn.connectionId)).toBe(true);
    const row = (await getGmailSync(T, sync.syncId))!;
    expect(row.status).toBe('paused');
    expect(row.pausedReason).toBe('connection-revoked');
    expect((await getJob(sync.jobId))!.enabled).toBe(false);
    // The pinned row is GONE: a resume with no Google connection is a typed 422 (BLOCKER-2, never a stuck loop)…
    await expect(updateGmailSync(T, sync.syncId, { status: 'active' })).rejects.toMatchObject({ code: 'credential_unavailable', httpStatus: 422 });
    // …and after reconnecting, the resume re-binds and clears the reason.
    const reconnected = await liveGoogleConnection(T, 'user:u1');
    const resumed = (await updateGmailSync(T, sync.syncId, { status: 'active' }))!;
    expect(resumed.status).toBe('active');
    expect(resumed.pausedReason).toBeUndefined();
    expect(resumed.connectionId).toBe(reconnected.connectionId);
    expect((await getJob(sync.jobId))!.enabled).toBe(true);
  });
});

describe('cursor honesty + self-pause (ADR 0627 D5(b)/(c))', () => {
  it('the REAL per-org cap error classifies as `capped`; anything else is `failed`', () => {
    let capErr: unknown;
    try { assertUnderCap(5000, 5000, 'activities'); } catch (e) { capErr = e; }
    expect(capErr).toBeInstanceOf(OpenwopError);
    expect(gmailAppendOutcomeOf(capErr)).toBe('capped');
    expect(gmailAppendOutcomeOf(new OpenwopError('not_found', 'Contact not found.', 404))).toBe('failed');
    expect(gmailAppendOutcomeOf(new Error('storage down'))).toBe('failed');
  });

  it('cap hit mid-pass → cursor UNCHANGED, row paused/capped, job disabled, typed node failure', async () => {
    const T = tenant();
    const conn = await liveGoogleConnection(T, 'user:u1');
    const contact = await createContact({ tenantId: T, name: 'Ada', email: 'ada@acme.test' });
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    // The REAL surface for everything (the row read, the contact match, the
    // status write) — only the append is forced to the cap outcome, because
    // filling 5,000 activities is not what this witness is about.
    const real = crmSurface(T, 'run-cap');
    const crm = { ...real, logGmailActivity: async () => ({ success: false, outcome: 'capped' }) };
    const invokes: string[] = [];
    const connectors = {
      invoke: async (_id: string, request: { url: string; connectionId?: string }) => {
        invokes.push(request.connectionId ?? '');
        if (request.url.includes('/messages?')) return { ok: true, status: 200, data: { messages: [{ id: 'msg-1' }, { id: 'msg-2' }] } };
        return { ok: true, status: 200, data: { threadId: 'th', internalDate: String(Date.now() - 1000), payload: { headers: [{ name: 'From', value: 'ada@acme.test' }] } } };
      },
    };
    const out = await gmailSyncNode({ runId: 'run-cap', nodeId: 'sync', config: { gmailSyncId: sync.syncId }, inputs: {}, features: { crm }, connectors });
    expect(out.status).toBe('failure');
    expect(out.error?.code).toBe('validation_error');
    expect(out.error?.message).toContain('capped');
    expect(invokes.every((c) => c === conn.connectionId)).toBe(true);
    const row = (await getGmailSync(T, sync.syncId))!;
    expect(row.cursor, 'a message whose append was capped must not carry the cursor').toBeUndefined();
    expect(row.status).toBe('paused');
    expect(row.pausedReason).toBe('capped');
    expect((await getJob(sync.jobId))!.enabled).toBe(false);
    expect(contact.contactId).toBeTruthy();
  });

  it('a refused pin at the connector → row needs-reconsent, job disabled, typed node failure', async () => {
    const T = tenant();
    const conn = await liveGoogleConnection(T, 'user:u1');
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    const connectors = { invoke: async () => ({ ok: false, error: 'connector_pinned_connection_unusable' }) };
    const out = await gmailSyncNode({ runId: 'run-refused', nodeId: 'sync', config: { gmailSyncId: sync.syncId }, inputs: {}, features: { crm: crmSurface(T, 'run-refused') }, connectors });
    expect(out.status).toBe('failure');
    expect(out.error?.code).toBe('credential_unavailable');
    const row = (await getGmailSync(T, sync.syncId))!;
    expect(row.status).toBe('needs-reconsent');
    expect((await getJob(sync.jobId))!.enabled).toBe(false);
  });

  it('the node refuses a paused / needs-reconsent sync WITHOUT touching the connector; syncGmailNow refuses with typed codes; the route maps them', async () => {
    const T = tenant();
    const conn = await liveGoogleConnection(T, 'user:u1');
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    let dials = 0;
    const connectors = { invoke: async () => { dials += 1; return { ok: true, status: 200, data: { messages: [] } }; } };
    const runNode = () => gmailSyncNode({ runId: 'run-refuse', nodeId: 'sync', config: { gmailSyncId: sync.syncId }, inputs: {}, features: { crm: crmSurface(T, 'run-refuse') }, connectors });
    const deps = { storage, hostSuite: { workflowCatalog: { getWorkflow: async () => null }, providerPolicyResolver: { resolveForRun: async () => [] } } } as unknown as Parameters<typeof syncGmailNow>[0];

    await markGmailSyncStatus(T, sync.syncId, 'paused', 'capped');
    let out = await runNode();
    expect(out.status).toBe('failure');
    expect(out.error?.code).toBe('validation_error');
    expect(out.error?.message).toContain('capped');
    await expect(syncGmailNow(deps, T, sync.syncId)).rejects.toMatchObject({ code: 'validation_error', httpStatus: 409, details: { status: 'paused', pausedReason: 'capped' } });

    await markGmailSyncStatus(T, sync.syncId, 'needs-reconsent');
    out = await runNode();
    expect(out.status).toBe('failure');
    expect(out.error?.code).toBe('credential_unavailable');
    await expect(syncGmailNow(deps, T, sync.syncId)).rejects.toMatchObject({ code: 'credential_unavailable', httpStatus: 422, details: { status: 'needs-reconsent' } });
    expect(dials, 'a refused sync must never reach the connector').toBe(0);
  });

  it('HTTP: POST sync-now on a self-paused sync is a 409 carrying the reason (what the Gmail tab renders)', async () => {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
      return { status: res.status, body: await res.json().catch(() => undefined) };
    };
    const T = tenant();
    const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `pin-${Date.now()}@acme.test`, tenantId: T });
    expect(login.status, JSON.stringify(login.body)).toBe(201);
    const userId = login.body.user.userId as string;
    const org = await call('POST', '/v1/host/openwop-app/orgs', { name: 'Acme' });
    expect(org.status).toBe(201);
    const conn = await liveGoogleConnection(T, userId);
    const created = await call('POST', '/v1/host/openwop-app/crm/gmail-sync', { orgId: org.body.orgId, connectionId: conn.connectionId, cadence: 'hourly' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    await markGmailSyncStatus(T, created.body.sync.syncId, 'paused', 'capped');
    const refused = await call('POST', `/v1/host/openwop-app/crm/gmail-sync/${created.body.sync.syncId}/sync-now`);
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(refused.body.error).toBe('validation_error');
    expect(refused.body.details).toMatchObject({ status: 'paused', pausedReason: 'capped' });
    // The row the tab lists carries both fields.
    const list = await call('GET', `/v1/host/openwop-app/crm/gmail-sync?orgId=${encodeURIComponent(org.body.orgId)}`);
    expect(list.body.syncs[0]).toMatchObject({ status: 'paused', pausedReason: 'capped' });
  });
});

/** A stubbed connector that lists `messages` newest-first and serves each
 *  message's metadata with a From header matching the seeded contact. */
function gmailStub(messages: Array<{ id: string; internalDate: number }>) {
  const invokes: Array<{ url: string; connectionId?: string }> = [];
  return {
    invokes,
    connectors: {
      invoke: async (_id: string, request: { url: string; connectionId?: string }) => {
        invokes.push({ url: request.url, connectionId: request.connectionId });
        if (request.url.includes('/messages?')) return { ok: true, status: 200, data: { messages: messages.map((m) => ({ id: m.id })) } };
        const id = decodeURIComponent(request.url.split('/messages/')[1]!.split('?')[0]!);
        const m = messages.find((x) => x.id === id)!;
        return { ok: true, status: 200, data: { threadId: `th-${id}`, internalDate: String(m.internalDate), payload: { headers: [{ name: 'From', value: 'ada@acme.test' }] } } };
      },
    },
  };
}

describe('cursor ordering (review BLOCKER-1) — Gmail lists NEWEST-FIRST, so the cursor lands BEFORE the oldest unsettled message', () => {
  const base = Date.now() - 3_600_000;
  const t3 = base + 180_000; const t2 = base + 120_000; const t1 = base + 60_000; // 03:00 / 02:00 / 01:00

  async function fixture(outcomeFor: (messageId: string) => 'logged' | 'failed' | 'capped') {
    const T = tenant();
    const conn = await liveGoogleConnection(T, 'user:u1');
    await createContact({ tenantId: T, name: 'Ada', email: 'ada@acme.test' });
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    const real = crmSurface(T, 'run-order');
    const appended: string[] = [];
    const crm = {
      ...real,
      logGmailActivity: async (args: Record<string, unknown>) => {
        const outcome = outcomeFor(args.messageId as string);
        if (outcome === 'logged') { appended.push(args.messageId as string); return real.logGmailActivity!(args); }
        return { success: false, outcome };
      },
    };
    return { T, sync, crm, appended };
  }
  const runNode = (syncId: string, crm: unknown, connectors: unknown) =>
    gmailSyncNode({ runId: 'run-order', nodeId: 'sync', config: { gmailSyncId: syncId }, inputs: {}, features: { crm }, connectors });

  it('(A) logged / FAILED / logged → cursor lands one second before the failed middle message (not at the newest)', async () => {
    const { T, sync, crm, appended } = await fixture((id) => (id === 'm2' ? 'failed' : 'logged'));
    const stub = gmailStub([{ id: 'm3', internalDate: t3 }, { id: 'm2', internalDate: t2 }, { id: 'm1', internalDate: t1 }]);
    const out = await runNode(sync.syncId, crm, stub.connectors);
    expect(out.status, JSON.stringify(out.error)).toBe('success');
    expect(out.outputs).toEqual({ scanned: 3, matched: 2, truncated: false });
    expect(appended.sort()).toEqual(['m1', 'm3']);
    const row = (await getGmailSync(T, sync.syncId))!;
    expect(row.cursor, 'a high-water mark would have carried m2 past the cursor forever').toBe(new Date(t2 - 1000).toISOString());
    expect(row.status).toBe('active');
  });

  it('(B) logged / CAPPED / unreached → cursor HELD (the unreached message is older and its date unknown), row paused/capped', async () => {
    const { T, sync, crm } = await fixture((id) => (id === 'm2' ? 'capped' : 'logged'));
    const stub = gmailStub([{ id: 'm3', internalDate: t3 }, { id: 'm2', internalDate: t2 }, { id: 'm1', internalDate: t1 }]);
    const out = await runNode(sync.syncId, crm, stub.connectors);
    expect(out.status).toBe('failure');
    expect(out.error?.code).toBe('validation_error');
    const row = (await getGmailSync(T, sync.syncId))!;
    expect(row.cursor, 'm1 was never reached — advancing past it would lose it across the pause').toBeUndefined();
    expect(row.status).toBe('paused');
    expect(row.pausedReason).toBe('capped');
    // Only two of the three metadata fetches happened (the break is honoured).
    expect(stub.invokes.filter((i) => i.url.includes('/messages/')).length).toBe(2);
  });

  it("(B') logged / CAPPED as the LAST message → cursor lands before the capped message, row paused/capped", async () => {
    const { T, sync, crm } = await fixture((id) => (id === 'm1' ? 'capped' : 'logged'));
    const stub = gmailStub([{ id: 'm2', internalDate: t2 }, { id: 'm1', internalDate: t1 }]);
    const out = await runNode(sync.syncId, crm, stub.connectors);
    expect(out.status).toBe('failure');
    const row = (await getGmailSync(T, sync.syncId))!;
    expect(row.cursor).toBe(new Date(t1 - 1000).toISOString());
    expect(row.status).toBe('paused');
    expect(row.pausedReason).toBe('capped');
  });

  it('a message whose metadata fetch fails HOLDS the cursor (unsettled, date unknown) — the stated other horn', async () => {
    const { T, sync, crm } = await fixture(() => 'logged');
    const stub = gmailStub([{ id: 'm2', internalDate: t2 }, { id: 'm1', internalDate: t1 }]);
    const broken = { invoke: async (id: string, request: { url: string; connectionId?: string }) => (request.url.includes('/messages/m1') ? { ok: false, status: 500 } : stub.connectors.invoke(id, request)) };
    const out = await runNode(sync.syncId, crm, broken);
    expect(out.status).toBe('success');
    expect(out.outputs).toEqual({ scanned: 2, matched: 1, truncated: false });
    expect((await getGmailSync(T, sync.syncId))!.cursor).toBeUndefined();
  });
});

describe("an EMPTY pin is a refusal, not an un-pin (review SHOULD-1) — all three layers gate on `!== undefined`", () => {
  it("broker: connectionId '' → null even though the unpinned lane finds the actor's row; invoker: → connector_pinned_connection_unusable", async () => {
    const T = tenant();
    const mine = await liveGoogleConnection(T, 'user:u1');
    expect((await resolveConnectionCredential({ tenantId: T, provider: 'google', actingUserId: 'user:u1' }))?.connection.connectionId).toBe(mine.connectionId);
    expect(await resolveConnectionCredential({ tenantId: T, provider: 'google', actingUserId: 'user:u1', connectionId: '' })).toBeNull();
    expect(await connectionExists({ tenantId: T, provider: 'google', actingUserId: 'user:u1', connectionId: '' })).toBe(false);
    await storage.insertRun({ runId: 'run-empty-pin', workflowId: 'w', tenantId: T, status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    const out = await createConnectorInvoker({ storage }).invoke('google', {
      context: { tenantId: T, runId: 'run-empty-pin', actingUserId: 'user:u1' },
      request: { url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1', method: 'GET', connectionId: '' },
    });
    expect(out).toEqual({ ok: false, error: 'connector_pinned_connection_unusable' });
  });
});

describe('a dead pin has an exit (review BLOCKER-2) and re-consent IS the resume (review SHOULD-3)', () => {
  it('revoke → reconnect (NEW connectionId) → PATCH active RE-BINDS the pin; the next sync runs on the new pin', async () => {
    const T = tenant();
    const first = await liveGoogleConnection(T, 'user:u1');
    await createContact({ tenantId: T, name: 'Ada', email: 'ada@acme.test' });
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: first.connectionId, cadence: 'daily' });
    expect(await revokeConnection(T, first.connectionId)).toBe(true);
    expect((await getGmailSync(T, sync.syncId))!.status).toBe('paused');

    // No google connection at all → the resume is a typed 422 naming the fix (never a silent stuck loop) — the GONE copy, not "needs re-consent".
    await expect(updateGmailSync(T, sync.syncId, { status: 'active' })).rejects.toMatchObject({ code: 'credential_unavailable', httpStatus: 422, details: { reason: 'gone' } });
    expect((await getGmailSync(T, sync.syncId))!.status).toBe('paused');

    // Reconnect: the row was deleted, so the re-consent mints a NEW id — a FRESH
    // insert is not a status transition: no status-changed event (review NIT-5).
    const eventsBefore = statusEvents.length;
    const second = await liveGoogleConnection(T, 'user:u1');
    expect(second.connectionId).not.toBe(first.connectionId);
    expect(statusEvents.length, 'a fresh insert fires no status-changed event').toBe(eventsBefore);
    expect((await findUserConnection(T, 'google', 'user:u1'))?.connectionId).toBe(second.connectionId);

    const resumed = (await updateGmailSync(T, sync.syncId, { status: 'active' }))!;
    expect(resumed.status).toBe('active');
    expect(resumed.connectionId, 'the resume must re-bind to the owner\'s current google row').toBe(second.connectionId);
    expect((await getJob(sync.jobId))!.enabled).toBe(true);

    const stub = gmailStub([{ id: 'm1', internalDate: Date.now() - 1000 }]);
    const out = await gmailSyncNode({ runId: 'run-rebound', nodeId: 'sync', config: { gmailSyncId: sync.syncId }, inputs: {}, features: { crm: crmSurface(T, 'run-rebound') }, connectors: stub.connectors });
    expect(out.status, JSON.stringify(out.error)).toBe('success');
    expect(stub.invokes.length).toBe(2);
    expect(stub.invokes.every((i) => i.connectionId === second.connectionId), 'every invoke carries the NEW pin').toBe(true);
    // …and a resume on a HEALTHY pin keeps it (no gratuitous re-bind).
    await updateGmailSync(T, sync.syncId, { status: 'paused' });
    expect((await updateGmailSync(T, sync.syncId, { status: 'active' }))!.connectionId).toBe(second.connectionId);
  });

  it("a needs-reconsent sync whose connection is then REVOKED flips to paused/connection-revoked (not stuck on 're-consent this deleted row')", async () => {
    const T = tenant();
    const conn = await upsertOAuthConnection({
      tenantId: T, provider: 'google', userId: 'user:u1',
      tokens: { accessToken: 'stale', tokenType: 'Bearer', scopes: GMAIL_SCOPES, expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    await probeConnection(T, conn.connectionId);
    expect((await getGmailSync(T, sync.syncId))!.status).toBe('needs-reconsent');
    expect(await revokeConnection(T, conn.connectionId)).toBe(true);
    const row = (await getGmailSync(T, sync.syncId))!;
    expect(row.status).toBe('paused');
    expect(row.pausedReason).toBe('connection-revoked');
  });

  it('a re-consent on the SAME row (needs-reconsent → active) fires the seam and AUTO-RESUMES the sync (row + job); a user pause is untouched', async () => {
    const T = tenant();
    const conn = await upsertOAuthConnection({
      tenantId: T, provider: 'google', userId: 'user:u1',
      tokens: { accessToken: 'stale', tokenType: 'Bearer', scopes: GMAIL_SCOPES, expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    const userPaused = await createGmailSync({ tenantId: T, orgId: 'org-2', userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    await updateGmailSync(T, userPaused.syncId, { status: 'paused' });
    await probeConnection(T, conn.connectionId);
    expect((await getGmailSync(T, sync.syncId))!.status).toBe('needs-reconsent');
    expect((await getJob(sync.jobId))!.enabled).toBe(false);
    const before = statusEvents.length;

    // The OAuth callback lane: same identity tuple ⇒ SAME connectionId, status back to active.
    const revived = await liveGoogleConnection(T, 'user:u1');
    expect(revived.connectionId).toBe(conn.connectionId);
    expect(revived.status).toBe('active');
    expect(statusEvents.slice(before).filter((e) => e.connectionId === conn.connectionId)).toEqual([
      { tenantId: T, connectionId: conn.connectionId, provider: 'google', status: 'active', previousStatus: 'needs-reconsent' },
    ]);
    const row = (await getGmailSync(T, sync.syncId))!;
    expect(row.status).toBe('active');
    expect(row.connectionId).toBe(conn.connectionId);
    expect((await getJob(sync.jobId))!.enabled).toBe(true);
    expect((await getGmailSync(T, userPaused.syncId))!.status, 'a user pause is not a re-consent state').toBe('paused');
    // A re-consent of an already-active row is not a transition: no event.
    const again = statusEvents.length;
    await liveGoogleConnection(T, 'user:u1');
    expect(statusEvents.length).toBe(again);
  });
});

describe('scheduler-run → real executor → broker (review SHOULD-2): the run acts as the sync owner and the broker sees the sync pin', () => {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: await res.json().catch(() => undefined) };
  };
  const settle = async (tenantId: string, runId: string): Promise<RunRecord | undefined> => {
    let run: RunRecord | undefined;
    for (let i = 0; i < 600; i++) {
      run = (await storage.listRuns({ tenantId, limit: 50 })).find((r) => r.runId === runId);
      if (run && !['pending', 'running'].includes(run.status)) return run;
      await new Promise((r) => setTimeout(r, 25));
    }
    return run;
  };

  it('a sync pinned to a connection the broker cannot refresh, with an active WORKSPACE google row present: the real run marks the sync needs-reconsent — the broker refused THE PIN under the owner, no fall-through', async () => {
    cookie = '';
    const T = tenant();
    const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `pin-run-${Date.now()}@acme.test`, tenantId: T });
    expect(login.status).toBe(201);
    const userId = login.body.user.userId as string;
    const org = await call('POST', '/v1/host/openwop-app/orgs', { name: 'Acme' });
    // Active at pin time, dead at resolve time: expired, no refresh token.
    const dying = await upsertOAuthConnection({
      tenantId: T, provider: 'google', userId,
      tokens: { accessToken: 'stale', tokenType: 'Bearer', scopes: GMAIL_SCOPES, expiresAt: new Date(Date.now() - 60_000).toISOString() },
    });
    await createSecretConnection({ tenantId: T, provider: 'google', kind: 'api_key', secret: 'ws', scope: 'workspace' });
    const created = await call('POST', '/v1/host/openwop-app/crm/gmail-sync', { orgId: org.body.orgId, connectionId: dying.connectionId, cadence: 'hourly' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const syncId = created.body.sync.syncId as string;

    const now = await call('POST', `/v1/host/openwop-app/crm/gmail-sync/${syncId}/sync-now`);
    expect(now.status, JSON.stringify(now.body)).toBe(202);
    const run = await settle(T, now.body.runId as string);
    expect(run, 'the real run must reach a terminal state').toBeTruthy();
    expect((run!.metadata as { actingUserId?: string }).actingUserId).toBe(userId);
    expect(run!.status).toBe('failed');
    const row = (await getGmailSync(T, syncId))!;
    expect(row.status, 'an unpinned broker would have fallen through to the workspace row and dialed').toBe('needs-reconsent');
    expect((await getConnection(T, dying.connectionId))!.status).toBe('needs-reconsent');
  }, 30_000);

  it("a sync pinned to the owner's ACTIVE row: the real run passes the broker's pin gate (owner === actingUserId) and reaches the dial — the row is NOT marked needs-reconsent", async () => {
    cookie = '';
    const T = tenant();
    const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `pin-run2-${Date.now()}@acme.test`, tenantId: T });
    expect(login.status).toBe(201);
    const userId = login.body.user.userId as string;
    const org = await call('POST', '/v1/host/openwop-app/orgs', { name: 'Acme' });
    const live = await liveGoogleConnection(T, userId);
    const created = await call('POST', '/v1/host/openwop-app/crm/gmail-sync', { orgId: org.body.orgId, connectionId: live.connectionId, cadence: 'hourly' });
    expect(created.status).toBe(201);
    const syncId = created.body.sync.syncId as string;
    const now = await call('POST', `/v1/host/openwop-app/crm/gmail-sync/${syncId}/sync-now`);
    expect(now.status).toBe(202);
    const run = await settle(T, now.body.runId as string);
    expect(run).toBeTruthy();
    expect((run!.metadata as { actingUserId?: string }).actingUserId).toBe(userId);
    // The dial itself may fail in this environment (no network / a bogus
    // bearer) — that is a `connector_error`, not a pin refusal: the row stays active.
    const row = (await getGmailSync(T, syncId))!;
    expect(row.status).toBe('active');
    expect((await getConnection(T, live.connectionId))!.status).toBe('active');
  }, 30_000);
});

describe('truncation is bounded (review SHOULD-1): a truncated pass HOLDS the cursor and persists a scan window; later passes drain below it', () => {
  /** A Gmail stub with `total` messages newest-first ONE PER PAGE, honouring
   *  `pageToken` and a `before:` bound in `q` — so 10 pages/pass is the cap. */
  function pagedGmail(total: number, newestMs: number) {
    const all = Array.from({ length: total }, (_, i) => ({ id: `p${i}`, internalDate: newestMs - i * 60_000 }));
    const listings: string[] = [];
    const connectors = {
      invoke: async (_id: string, request: { url: string; connectionId?: string }) => {
        const u = new URL(request.url);
        if (u.pathname.endsWith('/messages')) {
          const q = u.searchParams.get('q') ?? '';
          listings.push(q);
          const before = /before:(\d+)/.exec(q);
          const after = /after:(\d+)/.exec(q);
          // Real Gmail honours BOTH bounds (seconds-granular).
          const pool = all.filter((m) => (!after || m.internalDate >= Number(after[1]) * 1000) && (!before || m.internalDate < Number(before[1]) * 1000));
          const start = Number(u.searchParams.get('pageToken') ?? '0');
          const page = pool.slice(start, start + 1);
          const next = start + 1 < pool.length ? String(start + 1) : undefined;
          return { ok: true, status: 200, data: { messages: page.map((m) => ({ id: m.id })), ...(next ? { nextPageToken: next } : {}) } };
        }
        const id = decodeURIComponent(u.pathname.split('/messages/')[1]!);
        const m = all.find((x) => x.id === id)!;
        return { ok: true, status: 200, data: { threadId: `th-${id}`, internalDate: String(m.internalDate), payload: { headers: [{ name: 'From', value: 'ada@acme.test' }] } } };
      },
    };
    return { all, listings, connectors };
  }

  it('12 messages, 10/pass: pass 1 → cursor held + window {before: oldest reached, newest: newest settled}; pass 2 drains → window cleared, cursor past the FIRST pass\'s newest, all 12 logged', async () => {
    const T = tenant();
    const conn = await liveGoogleConnection(T, 'user:u1');
    const contact = await createContact({ tenantId: T, name: 'Ada', email: 'ada@acme.test' });
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    const newestMs = Date.now() - 3_600_000;
    const gmail = pagedGmail(12, newestMs);
    const crm = crmSurface(T, 'run-trunc');
    const node = () => gmailSyncNode({ runId: 'run-trunc', nodeId: 'sync', config: { gmailSyncId: sync.syncId }, inputs: {}, features: { crm }, connectors: gmail.connectors });

    const pass1 = await node();
    expect(pass1.status, JSON.stringify(pass1.error)).toBe('success');
    expect(pass1.outputs).toEqual({ scanned: 10, matched: 10, truncated: true });
    let row = (await getGmailSync(T, sync.syncId))!;
    expect(row.cursor, 'a truncated pass must not advance — p10/p11 are older and unreached').toBeUndefined();
    expect(row.scan).toEqual({ before: new Date(gmail.all[9]!.internalDate).toISOString(), newest: new Date(newestMs).toISOString() });
    expect(gmail.listings[0]).not.toContain('before:');

    const pass2 = await node();
    expect(pass2.status).toBe('success');
    // The bounded listing re-lists p9 (a cheap duplicate) + p10 + p11 — NOT the same newest 10 again.
    expect(gmail.listings[gmail.listings.length - 1]).toContain(`before:${Math.floor(gmail.all[9]!.internalDate / 1000) + 1}`);
    expect(pass2.outputs).toEqual({ scanned: 3, matched: 2, truncated: false });
    row = (await getGmailSync(T, sync.syncId))!;
    expect(row.scan).toBeUndefined();
    expect(row.cursor, 'the closed window advances past the window\'s newest settled message').toBe(new Date(newestMs - 1000).toISOString());
    for (const m of gmail.all) expect(await getActivity(T, ORG, `act:gmail:${ORG}:${m.id}:${contact.contactId}`), m.id).toBeTruthy();

    // Pass 3 from the advanced cursor: nothing new above it.
    const pass3 = await node();
    expect(pass3.outputs).toMatchObject({ truncated: false, matched: 0 });
  });
});

describe('a transient refresh failure is retried on resume (review SHOULD-2) — the 422 copy tells re-consent from gone', () => {
  it('owned row parked needs-reconsent with a still-valid token: PATCH active revives it (→ active fires), sync runs on the same pin', async () => {
    const T = tenant();
    const conn = await liveGoogleConnection(T, 'user:u1'); // valid token, no expiry
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    await __setConnectionStatusForTests(conn.connectionId, 'needs-reconsent'); // what a Google 5xx during refresh leaves behind
    expect((await getGmailSync(T, sync.syncId))!.status).toBe('needs-reconsent'); // the seam marked it
    const before = statusEvents.length;
    const resumed = (await updateGmailSync(T, sync.syncId, { status: 'active' }))!;
    expect(resumed.status).toBe('active');
    expect(resumed.connectionId).toBe(conn.connectionId);
    expect((await getConnection(T, conn.connectionId))!.status).toBe('active');
    expect(statusEvents.slice(before).filter((e) => e.connectionId === conn.connectionId)).toEqual([
      { tenantId: T, connectionId: conn.connectionId, provider: 'google', status: 'active', previousStatus: 'needs-reconsent' },
    ]);
    expect((await getJob(sync.jobId))!.enabled).toBe(true);
  });

  it('owned row whose token really cannot be refreshed: 422 with reason needs-reconsent (not "gone"); a deleted row with no replacement: reason gone', async () => {
    const T = tenant();
    const dead = await deadGoogleConnection(T, 'user:u1');
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: dead.connectionId, cadence: 'daily' });
    await expect(updateGmailSync(T, sync.syncId, { status: 'active' })).rejects.toMatchObject({ code: 'credential_unavailable', httpStatus: 422, details: { reason: 'needs-reconsent' } });
    expect((await getConnection(T, dead.connectionId))!.status).toBe('needs-reconsent');
    await revokeConnection(T, dead.connectionId);
    await expect(updateGmailSync(T, sync.syncId, { status: 'active' })).rejects.toMatchObject({ code: 'credential_unavailable', httpStatus: 422, details: { reason: 'gone' } });
  });
});

describe('the hold is bounded over time (review SHOULD-3): an unsettled message is released after the budget, and the loss is logged', () => {
  it('the same message unfetchable across 6 passes → held for 5, then released: cursor advances past it, warn names the id', async () => {
    const T = tenant();
    const conn = await liveGoogleConnection(T, 'user:u1');
    await createContact({ tenantId: T, name: 'Ada', email: 'ada@acme.test' });
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    const t2 = Date.now() - 3_600_000; const t1 = t2 - 60_000;
    const stub = gmailStub([{ id: 'm2', internalDate: t2 }, { id: 'm1', internalDate: t1 }]);
    const broken = { invoke: async (id: string, request: { url: string; connectionId?: string }) => (request.url.includes('/messages/m1') ? { ok: false, status: 500 } : stub.connectors.invoke(id, request)) };
    const crm = crmSurface(T, 'run-budget');
    const node = () => gmailSyncNode({ runId: 'run-budget', nodeId: 'sync', config: { gmailSyncId: sync.syncId }, inputs: {}, features: { crm }, connectors: broken });
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { lines.push(String(chunk)); return true; }) as never);
    try {
      for (let pass = 1; pass <= 5; pass += 1) {
        const out = await node();
        expect(out.status, `pass ${pass}`).toBe('success');
        const row = (await getGmailSync(T, sync.syncId))!;
        expect(row.cursor, `pass ${pass}: still held`).toBeUndefined();
        expect(row.unsettled).toEqual({ m1: { passes: pass } });
      }
      expect(lines.some((l) => l.includes('gmail_sync_message_released'))).toBe(false);
      const sixth = await node();
      expect(sixth.status).toBe('success');
      const row = (await getGmailSync(T, sync.syncId))!;
      expect(row.unsettled).toBeUndefined();
      expect(row.cursor, 'released: the cursor advances past the newest settled message').toBe(new Date(t2 - 1000).toISOString());
      const warn = lines.find((l) => l.includes('gmail_sync_message_released'));
      expect(warn, 'the loss must be visible in the operator log').toBeTruthy();
      expect(warn).toContain('"level":"warn"');
      expect(warn).toContain('"messageId":"m1"');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('ADR 0617 D1a — the activity a sync run appends carries the RUN origin (X1 review): a binding on the emitting workflow is skipped, another listener starts', () => {
  it('one activity.logged, no origin on the wire, self-binding skipped, other-listener started', async () => {
    // Re-point the REAL dispatcher's two fanouts at capture seams (storage +
    // hostSuite stay real, so bindings + the self-trigger guard are real) —
    // the `crm-lifecycle-one-site` shape. Last describe in the file on purpose.
    const delivered: HostEventEnvelope[] = [];
    const startRunCalls: Array<{ workflowId: string }> = [];
    initHostEventDispatcher({
      storage,
      hostSuite,
      deliverWebhooks: async (event) => { delivered.push(event); },
      startRun: async (_deps, input) => { startRunCalls.push({ workflowId: input.workflowId }); return `run:fake-${startRunCalls.length}`; },
    });
    const T = tenant();
    const conn = await liveGoogleConnection(T, 'user:u1');
    await createContact({ tenantId: T, name: 'Ada', email: 'ada@acme.test' });
    const sync = await createGmailSync({ tenantId: T, orgId: ORG, userId: 'user:u1', connectionId: conn.connectionId, cadence: 'daily' });
    await createHostEventBinding({ tenantId: T, eventType: 'host.crm.activity.logged', workflowId: 'wf-gmail-self', createdBy: 'test' });
    // Positive control — proves the skip is origin-based, not "nothing dispatched".
    await createHostEventBinding({ tenantId: T, eventType: 'host.crm.activity.logged', workflowId: 'wf-other-listener', createdBy: 'test' });

    const stub = gmailStub([{ id: 'm-origin', internalDate: Date.now() - 1000 }]);
    const crm = buildHostSurfaceBundle({ tenantId: T, runId: 'run:gmail-origin', workflowId: 'wf-gmail-self' } as Parameters<typeof buildHostSurfaceBundle>[0]).features.crm!;
    const out = await gmailSyncNode({ runId: 'run:gmail-origin', nodeId: 'sync', config: { gmailSyncId: sync.syncId }, inputs: {}, features: { crm }, connectors: stub.connectors });
    expect(out.status, JSON.stringify(out.error)).toBe('success');
    expect(out.outputs).toMatchObject({ matched: 1 });
    for (let i = 0; i < 40 && delivered.filter((e) => e.type === 'host.crm.activity.logged' && e.tenantId === T).length === 0; i++) await new Promise((r) => setTimeout(r, 25));

    const evs = delivered.filter((e) => e.type === 'host.crm.activity.logged' && e.tenantId === T);
    expect(evs).toHaveLength(1);
    expect('origin' in evs[0]!, 'origin is a dispatcher-side guard, never on the wire').toBe(false);
    expect(startRunCalls.filter((r) => r.workflowId === 'wf-gmail-self'), 'the run that appended the activity must not re-trigger its own workflow').toHaveLength(0);
    expect(startRunCalls.filter((r) => r.workflowId === 'wf-other-listener'), 'a different workflow bound to the same event DOES start (the skip is origin-based)').toHaveLength(1);
  });
});

