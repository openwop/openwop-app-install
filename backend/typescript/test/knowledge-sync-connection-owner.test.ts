/**
 * ADR 0605 Tier 3 — `KSC-2`: the same-tenant confused deputy.
 *
 * `POST /knowledge-sync` validated only `conn.tenantId`. `knowledgeSyncRunner` then
 * ADOPTS `conn.userId` as the acting identity for that source forever, so a member
 * with `workspace:write` could bind a COLLEAGUE'S Drive connection and have the
 * scheduler read the colleague's files into a collection of the binder's choosing.
 * The in-repo counter-example is `crm/gmailSyncService`, which rejects exactly this.
 *
 * Filed by the assessment as authenticated IDOR-BY-REFERENCE, and that framing is
 * kept here: no surface was found that LEAKS another member's `connectionId`, so the
 * tests below obtain it out of band (via the service) rather than pretending to an
 * end-to-end exploit. The missing check is real regardless of how the id is found.
 *
 * TWO LANES, because a gate on the CREATION lane is not a gate on the USE lane:
 *   - create/browse refuse a connection that is not the caller's;
 *   - the RUNNER, which has no caller, refuses a connection that no longer resolves
 *     to the user recorded as the source's creator.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/knowledgeSourceFetch.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listFolder: vi.fn(async () => ({ files: [], complete: true })),
}));

import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { upsertOAuthConnection } from '../src/features/connections/connectionsService.js';
import { createCollection } from '../src/features/kb/kbService.js';
import { createSyncSource } from '../src/features/knowledge-sync/knowledgeSyncService.js';
import { runKnowledgeSyncOnce } from '../src/features/knowledge-sync/knowledgeSyncRunner.js';

const KS = '/v1/host/openwop-app/knowledge-sync';
const NOW = '2026-06-22T00:00:00.000Z';
const FOLDER = '1AbcDEF_ghiJKL-mnoPQRstuVWxyz0123456789';

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
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
  };
}

beforeEach(async () => {
  const d = getToggleDefault('knowledge-sync');
  if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});

/** One tenant, one org, and the acting user's own subject id. */
async function member(who: string, tenantId: string): Promise<{ c: ReturnType<typeof client>; orgId: string; userId: string }> {
  const c = client();
  const login = await c.post('/v1/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  const orgId = (await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' })).body.orgId as string;
  // `POST /test/login` responds `{ user }` and the session's acting subject is
  // `user.userId` — which is exactly what `actingUserOf(req)` resolves to, and so
  // exactly what the guard compares against.
  const userId = login.body.user.userId as string;
  return { c, orgId, userId };
}

describe('KSC-2 — a sync source may not bind a colleague\'s connection', () => {
  it('CREATE: refuses a same-tenant connection owned by ANOTHER user (403)', async () => {
    const tenantId = `org:ks-deputy-${Date.now()}-${n++}`;
    const attacker = await member('ks-attacker', tenantId);
    expect(attacker.userId).toBeTruthy(); // the test is meaningless without a real subject

    // The victim's Drive connection — same tenant, a DIFFERENT user.
    const victimConn = await upsertOAuthConnection({
      tenantId, provider: 'google', orgId: attacker.orgId, userId: 'user:victim',
      tokens: { accessToken: 'victim-token', tokenType: 'Bearer', scopes: ['https://www.googleapis.com/auth/drive.readonly'] },
    });
    const col = await createCollection(tenantId, attacker.orgId, 'test', { name: 'Exfil' });

    const r = await attacker.c.post(KS, {
      orgId: attacker.orgId, connectionId: victimConn.connectionId, collectionId: col.collectionId,
      provider: 'google', externalFolderId: FOLDER, cadence: 'hourly',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(403);
    expect(r.body.error).toBe('forbidden');
  });

  it('BROWSE: refuses the same foreign connection (one shared predicate, not two copies)', async () => {
    const tenantId = `org:ks-deputy-br-${Date.now()}-${n++}`;
    const attacker = await member('ks-browser', tenantId);
    const victimConn = await upsertOAuthConnection({
      tenantId, provider: 'google', orgId: attacker.orgId, userId: 'user:victim2',
      tokens: { accessToken: 't', tokenType: 'Bearer', scopes: [] },
    });
    const r = await attacker.c.get(`${KS}/browse?orgId=${attacker.orgId}&connectionId=${encodeURIComponent(victimConn.connectionId)}`);
    expect(r.status).toBe(403);
    // ASSERT THE CAUSE, NOT THE CODE. `expect(status).toBe(403)` alone passed even
    // with the guard deleted: without it the request reaches `failClosed`, which
    // ALSO answers 403 ("Your connected account cannot access this source") because
    // the provider is unreachable here. Two different refusals wearing one status is
    // exactly the shape that makes a sabotage read as green.
    expect(r.body.message).toMatch(/must belong to you/i);
  });

  it('CREATE: accepts the caller\'s OWN connection and stamps createdBy', async () => {
    const tenantId = `org:ks-own-${Date.now()}-${n++}`;
    const me = await member('ks-owner', tenantId);
    const mine = await upsertOAuthConnection({
      tenantId, provider: 'google', orgId: me.orgId, userId: me.userId,
      tokens: { accessToken: 't', tokenType: 'Bearer', scopes: [] },
    });
    const col = await createCollection(tenantId, me.orgId, 'test', { name: 'Mine' });
    const r = await me.c.post(KS, {
      orgId: me.orgId, connectionId: mine.connectionId, collectionId: col.collectionId,
      provider: 'google', externalFolderId: FOLDER, cadence: 'hourly',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.source.createdBy).toBe(me.userId);
  });

  it('CREATE: a TENANT-LEVEL connection (no userId) is still allowed — nobody to impersonate', async () => {
    // The first draft of the guard was `conn.userId !== caller`, which ALSO refused
    // this. A connection that names no user makes the run act as the bare tenant,
    // so there is no deputy to confuse; refusing it would break a legitimate setup
    // in the name of a hole it does not have.
    const tenantId = `org:ks-tenantconn-${Date.now()}-${n++}`;
    const me = await member('ks-tenantconn', tenantId);
    const shared = await upsertOAuthConnection({
      tenantId, provider: 'google', orgId: me.orgId,
      tokens: { accessToken: 't', tokenType: 'Bearer', scopes: [] },
    });
    expect(shared.userId).toBeUndefined();
    const col = await createCollection(tenantId, me.orgId, 'test', { name: 'Shared' });
    const r = await me.c.post(KS, {
      orgId: me.orgId, connectionId: shared.connectionId, collectionId: col.collectionId,
      provider: 'google', externalFolderId: FOLDER, cadence: 'hourly',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

describe('KSC-2 USE LANE — the runner refuses to act as a different user', () => {
  it('a connection that no longer resolves to the source\'s creator FAILS the run', async () => {
    const tenantId = `org:ks-uselane-${Date.now()}-${n++}`;
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', orgId: 'org-u', userId: 'user:someone-else',
      tokens: { accessToken: 't', tokenType: 'Bearer', scopes: [] },
    });
    await createCollection(tenantId, 'org-u', 'test', { name: 'col' }, { collectionId: 'col' }); // ADR 0643 R4 Should 3 — the runner now resolves the target collection BEFORE listing; it must exist
    const source = await createSyncSource(tenantId, 'org-u', {
      connectionId: conn.connectionId, provider: 'google', externalFolderId: FOLDER,
      collectionId: 'col', cadence: 'hourly', createdBy: 'user:original-owner',
    }, NOW);

    await expect(runKnowledgeSyncOnce({ storage: {} as never }, source))
      .rejects.toThrow(/different user/i);
  });

  it('a matching creator runs normally', async () => {
    const tenantId = `org:ks-uselane-ok-${Date.now()}-${n++}`;
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', orgId: 'org-u', userId: 'user:same',
      tokens: { accessToken: 't', tokenType: 'Bearer', scopes: [] },
    });
    await createCollection(tenantId, 'org-u', 'test', { name: 'col' }, { collectionId: 'col' }); // ADR 0643 R4 Should 3 — the runner now resolves the target collection BEFORE listing; it must exist
    const source = await createSyncSource(tenantId, 'org-u', {
      connectionId: conn.connectionId, provider: 'google', externalFolderId: FOLDER,
      collectionId: 'col', cadence: 'hourly', createdBy: 'user:same',
    }, NOW);
    await expect(runKnowledgeSyncOnce({ storage: {} as never }, source)).resolves.toBeDefined();
  });

  it('a LEGACY source (no createdBy) keeps the previous behaviour rather than breaking', async () => {
    // Stated as a residual in ADR 0605: there is no recorded owner to compare
    // against, and inventing one would fabricate the fact the check depends on.
    const tenantId = `org:ks-uselane-legacy-${Date.now()}-${n++}`;
    const conn = await upsertOAuthConnection({
      tenantId, provider: 'google', orgId: 'org-u', userId: 'user:whoever',
      tokens: { accessToken: 't', tokenType: 'Bearer', scopes: [] },
    });
    await createCollection(tenantId, 'org-u', 'test', { name: 'col' }, { collectionId: 'col' }); // ADR 0643 R4 Should 3 — the runner now resolves the target collection BEFORE listing; it must exist
    const source = await createSyncSource(tenantId, 'org-u', {
      connectionId: conn.connectionId, provider: 'google', externalFolderId: FOLDER,
      collectionId: 'col', cadence: 'hourly',
    }, NOW);
    expect(source.createdBy).toBeUndefined();
    await expect(runKnowledgeSyncOnce({ storage: {} as never }, source)).resolves.toBeDefined();
  });
});
