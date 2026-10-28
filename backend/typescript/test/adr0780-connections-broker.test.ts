/**
 * ADR 0780 — the connections broker's write authority, owner spellings, revoke
 * integrity and DSAR erasure, witnessed at the HTTP boundary where the defect
 * lived (the ADR 0711 harness: `sharedWorkspace: true`, membership in the
 * workspace-ROOT org, member rows created BEFORE login) and at the service
 * boundary for the races.
 *
 *  - D1: a Viewer cannot bind a credential; `scope` is a closed set; a WORKSPACE
 *    row is admin-only to create AND to manage; revoking one's own row stays open
 *    to every role.
 *  - D2: a row keyed by the legacy `oidc:` spelling is its owner's to list and
 *    revoke, and nobody else's; the broker reads org `connections:use` and a
 *    `user:` actor's rows by every spelling of the same human.
 *  - D3: a revoke racing a refresh leaves no row and no secret; a re-consent
 *    racing a refresh keeps the re-consent; a secret that disagrees with its row
 *    fails closed; a failed secret removal throws.
 *  - D4: the DSAR eraser revokes the subject's user rows (both spellings) and
 *    in-flight grants, and nothing else.
 *  - D5: inbound PUT refuses an unknown or foreign workflow and a short secret.
 *
 * Tracker: TST-BCN-1 (/grade-tests wave 60). Probe-witnessed, among others:
 *   - red when the create path's `requireTenantWrite`, the closed `scope` set, the
 *     WORKSPACE create/manage gate, the cross-tenant org refusal or the user-row
 *     owner check is dropped (legs 1–5); when the inbound PUT's
 *     `requireTenantWrite` is dropped (leg 14); when the signing-secret floor drops
 *     (leg 13);
 *   - red when `actingUserIds` aliases outside the home tenant (7, 7b), when the
 *     org-use check reads one spelling only (6), when the eraser drops its subject
 *     filter, its pending-grant delete or its pending-throw (7b, 12, 12b);
 *   - red when the refresh write-back scrub (8b), the newer-secret check (9b), the
 *     stale-generation refusal (10), the revoke's rethrow (11) or the sweep's
 *     live-row guard (11f) is dropped, and when revoke removes the secret before
 *     the row (11b).
 *
 * DOUBLE GUARDS (a single-guard probe stays green by design):
 *   - Leg 8: `refreshAndWriteBack` checks the row/generation BEFORE its write AND
 *     scrubs its own write when the row is gone AFTER it. Breaking both reds it.
 *   - Leg 9: the same pre-write generation check AND the `currentGeneration >
 *     generation` check (leg 9b witnesses the second alone).
 *   - Legs 13 / 13b (foreign workflow): the OUTER guard is the launch funnel
 *     `resolveTenantWorkflow` (`host/resolveLaunchDefinition.ts`), which treats a
 *     workflow another tenant owns as not-found; the INNER guards are the inbound
 *     PUT's and the dispatch-time `isAuthoredByOtherTenant` checks
 *     (`features/connections/routes.ts`, `inboundWebhooks.ts`). All of them read
 *     `isAuthoredByOtherTenant` (`host/workflowOwnership.ts`); breaking that one
 *     predicate reds both legs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { bareRunId } from './support/bareRunId.js';

// The provider token endpoint, held open by a test until it releases it.
const egress = vi.hoisted(() => ({ gate: null as Promise<void> | null, calls: 0, fail: false }));
vi.mock('../src/host/webhookEgressGuard.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/webhookEgressGuard.js')>();
  return {
    ...actual,
    guardedEgressFetch: vi.fn(async () => {
      egress.calls += 1;
      if (egress.gate) await egress.gate;
      if (egress.fail) return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ access_token: `at-refreshed-${egress.calls}`, expires_in: 3600, scope: 'chat:write' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  };
});
// A switch to make the secret store refuse a removal (D3.3).
const secretFault = vi.hoisted(() => ({
  failRemove: false,
  beforeSet: null as null | ((ref: string) => Promise<void>),
  beforeRemove: null as null | ((ref: string) => Promise<void>),
}));
vi.mock('../src/byok/secretResolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/byok/secretResolver.js')>();
  return {
    ...actual,
    removeSecret: vi.fn(async (...args: Parameters<typeof actual.removeSecret>) => {
      if (secretFault.beforeRemove) await secretFault.beforeRemove(args[0]);
      if (secretFault.failRemove) throw new Error('kms unavailable');
      return actual.removeSecret(...args);
    }),
    // A hook that runs just before a secret write lands (leg 8b: a revoke landing
    // between the refresh's row check and its write).
    setSecret: vi.fn(async (...args: Parameters<typeof actual.setSecret>) => {
      const hook = secretFault.beforeSet;
      if (hook) { secretFault.beforeSet = null; await hook(args[0]); }
      return actual.setSecret(...args);
    }),
  };
});

import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { createUser, userIdFor } from '../src/features/users/usersService.js';
import { configureKmsClient, createLocalAesKmsClient, _resetKmsForTesting } from '../src/byok/kmsEncryption.js';
import { resolveSecret, setSecret } from '../src/byok/secretResolver.js';
import {
  createSecretConnection,
  getConnection,
  listConnections,
  resolveConnectionCredential,
  revokeConnection,
  upsertOAuthConnection,
  eraseSubjectConnections,
  __setConnectionStatusForTests,
  sweepSecretTombstones,
} from '../src/features/connections/connectionsService.js';
import { handleInboundEvent, setInboundConfig } from '../src/features/connections/inboundWebhooks.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { createHmac } from 'node:crypto';
import { beginAuthorization, consumePendingAuth } from '../src/features/connections/oauthFlow.js';

const C = '/host/openwop-app/connections';
let server: Server;
let BASE = '';
let storage: Storage;
let hostSuite: HostAdapterSuite;
let WS = '';
const ADMIN = 'oidc:b780-admin';
const EDITOR = 'oidc:b780-editor';
const VIEWER = 'oidc:b780-viewer';
const OTHER = 'oidc:b780-other';
const ENV_TENANT = 'b780-env-tenant';
const CONNECTOR = 'oidc:b780-connector';

async function login(subject: string, tenantId: string, sharedWorkspace = true): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId, displayName: subject, sharedWorkspace }),
  });
  expect(res.status, 'test seam must mint a session').toBeLessThan(300);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function call(path: string, cookie: string, method = 'GET', body?: unknown): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const parsed: unknown = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  return { status: res.status, body: parsed };
}

/** Read a nested field of an untyped JSON body, without a cast. */
function field(value: unknown, ...path: string[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = Reflect.get(cur, key);
  }
  return cur;
}

/** A string field, or '' (so a missing id fails the next assertion, not a type check). */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The `connectionId`s of a `GET /connections` body. */
function connectionIds(body: unknown): string[] {
  const rows = field(body, 'connections');
  return Array.isArray(rows) ? rows.map((r: unknown) => text(field(r, 'connectionId'))) : [];
}

const expiredOAuth = (accessToken: string): Parameters<typeof upsertOAuthConnection>[0]['tokens'] => ({
  accessToken,
  refreshToken: 'rt-1',
  tokenType: 'Bearer',
  scopes: ['chat:write'],
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
});

beforeAll(async () => {
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_OAUTH_SLACK_CLIENT_ID = 'cid';
  process.env.OPENWOP_OAUTH_SLACK_CLIENT_SECRET = 'csecret';
  // A key scoped to one tenant (leg 3b). Read at boot, so set before createApp.
  process.env.OPENWOP_API_KEYS = `dev-token:*,b780-env-key:${ENV_TENANT}`;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  hostSuite = app.locals.hostSuite as HostAdapterSuite;
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));
  const ws = await createWorkspace({ name: 'ADR 0780 workspace', ownerSubject: 'oidc:b780-owner' });
  WS = ws.orgId ?? ws.tenantId;
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: userIdFor(WS, ADMIN), roles: ['admin'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Viewer', subject: userIdFor(WS, VIEWER), roles: ['viewer'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Other', subject: userIdFor(WS, OTHER), roles: ['editor'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Connector', subject: userIdFor(WS, CONNECTOR), roles: ['editor'] });
});

afterAll(async () => {
  delete process.env.OPENWOP_API_KEYS;
  _resetKmsForTesting();
  await new Promise<void>((r) => server.close(() => r()));
});

describe('ADR 0780 D1 — who may bind a credential', () => {
  it('leg 1: a Viewer cannot create or authorize; an editor can create their own', async () => {
    const viewer = await login(VIEWER, WS);
    const refused = await call(C, viewer, 'POST', { provider: 'servicenow', kind: 'api_key', secret: 'sn-viewer-key-123' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(field(refused.body, 'details', 'requiredScope')).toBe('workspace:write');
    const auth = await call(`${C}/slack/authorize`, viewer, 'POST', {});
    expect(auth.status, JSON.stringify(auth.body)).toBe(403);

    const editor = await login(EDITOR, WS);
    const made = await call(C, editor, 'POST', { provider: 'servicenow', kind: 'api_key', secret: 'sn-editor-key-123' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(field(made.body, 'userId')).toBe(userIdFor(WS, EDITOR));
    const editorAuth = await call(`${C}/slack/authorize`, editor, 'POST', {});
    expect(editorAuth.status, JSON.stringify(editorAuth.body)).toBe(200);
  });

  it('leg 2: scope is a closed set, and a WORKSPACE row is admin-only to create', async () => {
    const editor = await login(EDITOR, WS);
    const bogus = await call(C, editor, 'POST', { provider: 'servicenow', kind: 'api_key', secret: 'sn-key-12345678', scope: 'everyone' });
    expect(bogus.status, JSON.stringify(bogus.body)).toBe(400);
    const planted = await call(C, editor, 'POST', { provider: 'servicenow', kind: 'api_key', secret: 'sn-key-12345678', scope: 'workspace' });
    expect(planted.status, JSON.stringify(planted.body)).toBe(403);
    expect(field(planted.body, 'details', 'requiredScope')).toBe('host:connections:manage');

    const admin = await login(ADMIN, WS);
    const made = await call(C, admin, 'POST', { provider: 'servicenow', kind: 'api_key', secret: 'sn-key-12345678', scope: 'workspace' });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    expect(field(made.body, 'connectionId')).toBeTypeOf('string');
    expect(field(made.body, 'userId')).toBeUndefined();
    expect(field(made.body, 'orgId')).toBeUndefined();
  });

  it('leg 3: a WORKSPACE row is admin-only to delete, probe and re-wire', async () => {
    const row = await createSecretConnection({ tenantId: WS, provider: 'zoom', kind: 'bearer', secret: 'zoom-ws-token-123', scope: 'workspace' });
    const editor = await login(EDITOR, WS);
    for (const refused of [
      await call(`${C}/${encodeURIComponent(row.connectionId)}`, editor, 'DELETE'),
      await call(`${C}/${encodeURIComponent(row.connectionId)}/test`, editor, 'POST'),
    ]) {
      expect(refused.status, JSON.stringify(refused.body)).toBe(403);
      expect(field(refused.body, 'details', 'requiredScope')).toBe('host:connections:manage');
    }
    expect(await getConnection(WS, row.connectionId)).not.toBeNull();
    const admin = await login(ADMIN, WS);
    expect((await call(`${C}/${encodeURIComponent(row.connectionId)}`, admin, 'DELETE')).status).toBe(204);
  });

  it('leg 3b: a scoped env key is the tenant owner (ADR 0601 C4) — but only for orgs IN its tenant', async () => {
    const post = (body: Record<string, unknown>) => fetch(`${BASE}${C}`, {
      method: 'POST',
      headers: { authorization: 'Bearer b780-env-key', 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'servicenow', kind: 'api_key', secret: 'sn-env-key-12345', ...body }),
    });
    const ws = await post({ scope: 'workspace' });
    expect(ws.status, `the operator key must pass the workspace axis: ${await ws.clone().text()}`).toBe(201);
    expect((await post({ scope: 'org', orgId: WS })).status, 'an org of ANOTHER tenant').toBe(403);
  });

  it('leg 4: revoking one\'s OWN connection stays open to a Viewer (never trapped with a live token)', async () => {
    const row = await createSecretConnection({ tenantId: WS, provider: 'heygen', kind: 'api_key', secret: 'hg-viewer-key-12', scope: 'user', userId: userIdFor(WS, VIEWER) });
    const viewer = await login(VIEWER, WS);
    expect((await call(`${C}/${encodeURIComponent(row.connectionId)}`, viewer, 'DELETE')).status).toBe(204);
    expect(await getConnection(WS, row.connectionId)).toBeNull();
  });
});

describe('ADR 0780 D2 — the same human by every spelling, and nobody else', () => {
  it('leg 5: a row keyed by the legacy `oidc:` spelling is listed and revocable by its owner only', async () => {
    const row = await createSecretConnection({ tenantId: WS, provider: 'runway', kind: 'api_key', secret: 'rw-legacy-key-12', scope: 'user', userId: EDITOR });
    const other = await login(OTHER, WS);
    const otherList = await call(C, other, 'GET');
    expect(otherList.status).toBe(200);
    expect(connectionIds(otherList.body).includes(row.connectionId)).toBe(false);
    const otherDelete = await call(`${C}/${encodeURIComponent(row.connectionId)}`, other, 'DELETE');
    expect(otherDelete.status).toBe(403);
    expect(field(otherDelete.body, 'message')).toBe('Only the connecting user may manage this connection.');

    const editor = await login(EDITOR, WS);
    const mine = await call(C, editor, 'GET');
    expect(connectionIds(mine.body).includes(row.connectionId), 'the owner must see a row written before the bind').toBe(true);
    expect((await call(`${C}/${encodeURIComponent(row.connectionId)}`, editor, 'DELETE')).status).toBe(204);
  });

  it('leg 6: an `oidc:`-stamped actor may use an org row its human holds `connections:use` on', async () => {
    const admin = await login(ADMIN, WS);
    const org = await call(C, admin, 'POST', { provider: 'sendgrid', kind: 'api_key', secret: 'SG.org-key-12345', scope: 'org' });
    expect(org.status, JSON.stringify(org.body)).toBe(201);
    // The member row is keyed `user:<id>`; the run carries the legacy principal.
    const r = await resolveConnectionCredential({ tenantId: WS, provider: 'sendgrid', actingUserId: ADMIN });
    expect(r?.secret).toBe('SG.org-key-12345');
    // Refuse side: a non-holder under the same shape gets nothing.
    expect(await resolveConnectionCredential({ tenantId: WS, provider: 'sendgrid', actingUserId: VIEWER })).toBeNull();
  });

  it('leg 7: a `user:` actor does NOT alias outside its home tenant (principals are not issuer-qualified)', async () => {
    // ADR 0780 D2 CORRECTION (ce): the first cut aliased `user:` → its principal in
    // ANY tenant. Principal ids carry no issuer, so this is a refuse-side witness.
    const home = 'user:b780-home';
    const principal = 'oidc:b780-roaming';
    const { userId } = await createUser({ tenantId: home, principalId: principal });
    await createSecretConnection({ tenantId: WS, provider: 'openai-images', kind: 'api_key', secret: 'el-roaming-key-1', scope: 'user', userId: principal });
    expect(await resolveConnectionCredential({ tenantId: WS, provider: 'openai-images', actingUserId: userId })).toBeNull();
    // In its HOME tenant the alias still holds (#4215).
    await createSecretConnection({ tenantId: home, provider: 'openai-images', kind: 'api_key', secret: 'el-home-key-123', scope: 'user', userId: principal });
    expect((await resolveConnectionCredential({ tenantId: home, provider: 'openai-images', actingUserId: userId }))?.secret).toBe('el-home-key-123');
  });

  it('leg 7b: two IdPs, one `scim:jsmith` string, a shared workspace — X never gets T\'s jsmith', async () => {
    // X's home row carries `scim:jsmith` from IdP A; T holds a legacy connection
    // keyed `scim:jsmith` that belongs to T's OWN jsmith from IdP B.
    const homeX = 'user:b780-idp-a-home';
    const { userId: x } = await createUser({ tenantId: homeX, principalId: 'scim:jsmith' });
    const theirs = await createSecretConnection({ tenantId: WS, provider: 'heygen', kind: 'api_key', secret: 'hg-t-jsmith-key1', scope: 'user', userId: 'scim:jsmith' });
    expect(await resolveConnectionCredential({ tenantId: WS, provider: 'heygen', actingUserId: x }), 'a run as X in T must resolve NO credential').toBeNull();
    await eraseSubjectConnections(WS, x);
    expect(await getConnection(WS, theirs.connectionId), 'erasing X must leave T\'s jsmith intact').not.toBeNull();
    expect(await resolveSecret(`connection:${theirs.connectionId}`, { tenantId: WS })).not.toBeNull();
  });
});

describe('ADR 0780 D3 — revoke means revoked', () => {
  it('leg 8: a revoke that lands during a refresh leaves no row and no secret', async () => {
    const conn = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: 'user:b780-race-1', tokens: expiredOAuth('at-old') });
    let release!: () => void;
    egress.gate = new Promise<void>((r) => { release = r; });
    const resolving = resolveConnectionCredential({ tenantId: WS, provider: 'slack', actingUserId: 'user:b780-race-1' });
    await vi.waitFor(() => expect(egress.calls).toBeGreaterThan(0));
    expect(await revokeConnection(WS, conn.connectionId)).toBe(true);
    release();
    egress.gate = null;
    expect(await resolving).toBeNull();
    expect(await getConnection(WS, conn.connectionId), 'the row must not be re-created').toBeNull();
    expect(await resolveSecret(`connection:${conn.connectionId}`, { tenantId: WS }), 'the refreshed token must not survive the revoke').toBeNull();
  });

  it('leg 8b: a revoke landing between the refresh\'s row check and its write is scrubbed by the refresh itself', async () => {
    const conn = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: 'user:b780-race-1b', tokens: expiredOAuth('at-old') });
    secretFault.beforeSet = async (ref) => {
      if (ref === `connection:${conn.connectionId}`) await revokeConnection(WS, conn.connectionId);
    };
    try {
      expect(await resolveConnectionCredential({ tenantId: WS, provider: 'slack', actingUserId: 'user:b780-race-1b' })).toBeNull();
    } finally {
      secretFault.beforeSet = null;
    }
    expect(await getConnection(WS, conn.connectionId)).toBeNull();
    expect(await resolveSecret(`connection:${conn.connectionId}`, { tenantId: WS }), 'the write that landed after the revoke must be removed').toBeNull();
  });

  it('leg 8c: a status patch never re-creates a row deleted after the patch read it', async () => {
    const row = await createSecretConnection({ tenantId: WS, provider: 'servicenow', kind: 'api_key', secret: 'sn-patch-key-123', scope: 'user', userId: 'user:b780-patch' });
    const get = DurableCollection.prototype.get;
    let armed = true;
    const spy = vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      const value = await get.call(this, id);
      if (armed && id === row.connectionId && value) {
        armed = false;
        await this.delete(id); // a revoke landing between the patch's read and its write
      }
      return value;
    });
    try {
      await __setConnectionStatusForTests(row.connectionId, 'needs-reconsent');
    } finally {
      spy.mockRestore();
    }
    expect(await getConnection(WS, row.connectionId), 'the patch must not resurrect the row').toBeNull();
  });

  it('leg 9: a re-consent that lands during a refresh wins, and the refresh does not overwrite it', async () => {
    const owner = 'user:b780-race-2';
    const conn = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: owner, tokens: expiredOAuth('at-old') });
    let release!: () => void;
    egress.gate = new Promise<void>((r) => { release = r; });
    const calls = egress.calls;
    const resolving = resolveConnectionCredential({ tenantId: WS, provider: 'slack', actingUserId: owner });
    await vi.waitFor(() => expect(egress.calls).toBeGreaterThan(calls));
    const fresh = { ...expiredOAuth('at-reconsented'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    const again = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: owner, tokens: fresh });
    expect(again.connectionId).toBe(conn.connectionId);
    release();
    egress.gate = null;
    await resolving;
    const now = await resolveConnectionCredential({ tenantId: WS, provider: 'slack', actingUserId: owner });
    expect(now?.secret).toBe('at-reconsented');
  });

  it('leg 9b: a refresh never writes over a NEWER secret (a re-consent between its secret write and its row swap)', async () => {
    const owner = 'user:b780-race-2b';
    const conn = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: owner, tokens: expiredOAuth('at-old') });
    let release!: () => void;
    egress.gate = new Promise<void>((r) => { release = r; });
    const calls = egress.calls;
    const resolving = resolveConnectionCredential({ tenantId: WS, provider: 'slack', actingUserId: owner });
    await vi.waitFor(() => expect(egress.calls).toBeGreaterThan(calls));
    await setSecret(`connection:${conn.connectionId}`, JSON.stringify({ accessToken: 'at-mid-swap', tokenType: 'Bearer', scopes: [], generation: 'zzzzzzzzzz.mid-swap' }), { tenantId: WS });
    release();
    egress.gate = null;
    await resolving;
    const stored = JSON.parse((await resolveSecret(`connection:${conn.connectionId}`, { tenantId: WS }))!) as { accessToken: string };
    expect(stored.accessToken, 'the refresh must not overwrite the newer grant').toBe('at-mid-swap');
  });

  it('leg 10: a secret that does not belong to its row fails closed', async () => {
    const owner = 'user:b780-gen';
    const conn = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: owner, tokens: { ...expiredOAuth('at-x'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    // OLDER than the row: a refresh's write-back that landed over a re-consent.
    await setSecret(`connection:${conn.connectionId}`, JSON.stringify({ accessToken: 'at-stray', tokenType: 'Bearer', scopes: [], generation: '0000000000.stale' }), { tenantId: WS });
    expect(await resolveConnectionCredential({ tenantId: WS, provider: 'slack', actingUserId: owner })).toBeNull();
    expect((await getConnection(WS, conn.connectionId))?.status).toBe('needs-reconsent');
  });

  it('leg 10b: a NEWER secret (a re-consent whose row swap has not landed) is used, and the row is not flipped', async () => {
    const owner = 'user:b780-gen-new';
    const conn = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: owner, tokens: { ...expiredOAuth('at-x'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    await setSecret(`connection:${conn.connectionId}`, JSON.stringify({ accessToken: 'at-newer', tokenType: 'Bearer', scopes: [], generation: 'zzzzzzzzzz.newer' }), { tenantId: WS });
    expect((await resolveConnectionCredential({ tenantId: WS, provider: 'slack', actingUserId: owner }))?.secret).toBe('at-newer');
    expect((await getConnection(WS, conn.connectionId))?.status).toBe('active');
  });

  it('leg 10c: legacy material with no generation (a pre-0780 writer) is accepted', async () => {
    const owner = 'user:b780-gen-legacy';
    const conn = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: owner, tokens: { ...expiredOAuth('at-x'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    await setSecret(`connection:${conn.connectionId}`, JSON.stringify({ accessToken: 'at-legacy', tokenType: 'Bearer', scopes: [] }), { tenantId: WS });
    expect((await resolveConnectionCredential({ tenantId: WS, provider: 'slack', actingUserId: owner }))?.secret).toBe('at-legacy');
  });

  it('leg 10d: an EXPIRED newer secret on an older row refreshes against the secret\'s generation (CONNCD-11)', async () => {
    const owner = 'user:b780-newer-expired';
    const conn = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: owner, tokens: { ...expiredOAuth('at-x'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    // A re-consent that crashed between its secret write and its row swap.
    await setSecret(`connection:${conn.connectionId}`, JSON.stringify({ ...expiredOAuth('at-orphaned'), refreshToken: 'rt-newer', scopes: ['chat:write', 'files:read'], generation: 'zzzzzzzzzz.crashed' }), { tenantId: WS });
    const r = await resolveConnectionCredential({ tenantId: WS, provider: 'slack', actingUserId: owner });
    expect(r?.secret, 'the refresh must land, not be discarded as "a newer secret exists"').toMatch(/^at-refreshed-/);
    expect((await getConnection(WS, conn.connectionId))?.generation).toBe('zzzzzzzzzz.crashed');
    expect((await getConnection(WS, conn.connectionId))?.scopes, 'the row describes the adopted grant').toEqual(['chat:write', 'files:read']);
    const stored = JSON.parse((await resolveSecret(`connection:${conn.connectionId}`, { tenantId: WS }))!) as { accessToken: string };
    expect(stored.accessToken).toMatch(/^at-refreshed-/);
  });

  it('leg 11: a failed secret removal is surfaced, tombstoned, and swept once the store recovers', async () => {
    const row = await createSecretConnection({ tenantId: WS, provider: 'servicenow', kind: 'api_key', secret: 'sn-fault-key-123', scope: 'user', userId: 'user:b780-fault' });
    secretFault.failRemove = true;
    try {
      await expect(revokeConnection(WS, row.connectionId)).rejects.toThrow('kms unavailable');
      expect((await sweepSecretTombstones(WS)).pending).toBeGreaterThan(0);
    } finally {
      secretFault.failRemove = false;
    }
    expect(await resolveSecret(`connection:${row.connectionId}`, { tenantId: WS }), 'still stored until the sweep').not.toBeNull();
    expect((await sweepSecretTombstones(WS)).pending).toBe(0);
    expect(await resolveSecret(`connection:${row.connectionId}`, { tenantId: WS })).toBeNull();
  });

  it('leg 11f: a sweep landing between a revoke\'s tombstone and its row delete keeps the tombstone (CONNCD-12)', async () => {
    const row = await createSecretConnection({ tenantId: WS, provider: 'servicenow', kind: 'api_key', secret: 'sn-sweep-race-12', scope: 'user', userId: 'user:b780-sweep-race' });
    const del = DurableCollection.prototype.delete;
    let swept = false;
    const spy = vi.spyOn(DurableCollection.prototype, 'delete').mockImplementation(async function (this: DurableCollection<unknown>, id: string) {
      if (!swept && id === row.connectionId) {
        swept = true;
        // The daemon tick, between the tombstone put and the row delete. The store
        // is HEALTHY for this sweep, so only the live-row guard keeps it from
        // removing a live connection's token and dropping the tombstone.
        await sweepSecretTombstones(WS);
        // Then the revoke's own removal fails, so the tombstone is all that names the token.
        secretFault.failRemove = true;
      }
      return del.call(this, id);
    });
    try {
      await expect(revokeConnection(WS, row.connectionId)).rejects.toThrow('kms unavailable');
    } finally {
      secretFault.failRemove = false;
      spy.mockRestore();
    }
    expect(swept, 'the sweep must have run inside the revoke').toBe(true);
    expect((await sweepSecretTombstones(WS)).removed, 'the tombstone must still name the orphaned token').toBeGreaterThan(0);
    expect(await resolveSecret(`connection:${row.connectionId}`, { tenantId: WS })).toBeNull();
  });

  it('leg 11g: one subject\'s stuck removal does not fail ANOTHER subject\'s DSAR (CONNCD-13)', async () => {
    const stuck = await createSecretConnection({ tenantId: WS, provider: 'servicenow', kind: 'api_key', secret: 'sn-stuck-key-123', scope: 'user', userId: 'user:b780-stuck-y' });
    secretFault.failRemove = true;
    try {
      await expect(revokeConnection(WS, stuck.connectionId)).rejects.toThrow();
    } finally {
      secretFault.failRemove = false;
    }
    // Y's tombstone stays pending while the store refuses removals for Y only.
    const { userId: x } = await createUser({ tenantId: WS, principalId: 'oidc:b780-x-clean' });
    await createSecretConnection({ tenantId: WS, provider: 'runway', kind: 'api_key', secret: 'rw-x-clean-12345', scope: 'user', userId: x });
    secretFault.beforeRemove = async (ref) => { if (ref === `connection:${stuck.connectionId}`) throw new Error('still stuck'); };
    try {
      await expect(eraseSubjectConnections(WS, x)).resolves.toEqual({ rowsTouched: 1 });
      // Non-vacuity: Y's removal really is still stuck while X's DSAR succeeded.
      expect((await sweepSecretTombstones(WS)).pending).toBeGreaterThan(0);
    } finally {
      secretFault.beforeRemove = null;
    }
    expect((await sweepSecretTombstones(WS)).pending).toBe(0);
    expect(await resolveSecret(`connection:${stuck.connectionId}`, { tenantId: WS })).toBeNull();
  });

  it('leg 11b: revoke removes the ROW before the secret', async () => {
    const row = await createSecretConnection({ tenantId: WS, provider: 'servicenow', kind: 'api_key', secret: 'sn-order-key-123', scope: 'user', userId: 'user:b780-order' });
    let rowAtRemoval: unknown = 'unset';
    secretFault.beforeRemove = async (ref) => {
      if (ref === `connection:${row.connectionId}`) rowAtRemoval = await getConnection(WS, row.connectionId);
    };
    try {
      await revokeConnection(WS, row.connectionId);
    } finally {
      secretFault.beforeRemove = null;
    }
    expect(rowAtRemoval, 'nothing may resolve the credential while its secret is being removed').toBeNull();
  });

  it('leg 11c: a revoke landing inside a re-consent never resurrects the revoked id', async () => {
    const owner = 'user:b780-reconsent-revoke';
    const first = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: owner, tokens: expiredOAuth('at-1') });
    secretFault.beforeSet = async (ref) => {
      if (ref === `connection:${first.connectionId}`) await revokeConnection(WS, first.connectionId);
    };
    let second;
    try {
      second = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: owner, tokens: expiredOAuth('at-2') });
    } finally {
      secretFault.beforeSet = null;
    }
    expect(second.connectionId, 'the consent lands on a NEW id').not.toBe(first.connectionId);
    expect(await getConnection(WS, first.connectionId)).toBeNull();
    expect(await resolveSecret(`connection:${first.connectionId}`, { tenantId: WS })).toBeNull();
  });

  it('leg 11d: a refresh that FAILS after a re-consent does not flip the re-consented row', async () => {
    const owner = 'user:b780-fail-after-reconsent';
    await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: owner, tokens: expiredOAuth('at-old') });
    let release!: () => void;
    egress.gate = new Promise<void>((r) => { release = r; });
    const calls = egress.calls;
    const resolving = resolveConnectionCredential({ tenantId: WS, provider: 'slack', actingUserId: owner });
    await vi.waitFor(() => expect(egress.calls).toBeGreaterThan(calls));
    const fresh = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: owner, tokens: { ...expiredOAuth('at-fresh'), expiresAt: new Date(Date.now() + 3_600_000).toISOString() } });
    egress.fail = true;
    release();
    try {
      expect(await resolving).toBeNull();
    } finally {
      egress.gate = null;
      egress.fail = false;
    }
    expect((await getConnection(WS, fresh.connectionId))?.status, 'a stale failure must not park a fresh consent').toBe('active');
  });

  it('leg 11e: one human re-consenting under the other spelling keeps ONE row', async () => {
    const principal = 'oidc:b780-one-row';
    const { userId } = await createUser({ tenantId: WS, principalId: principal });
    const a = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: principal, tokens: expiredOAuth('at-a') });
    const b = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId, tokens: expiredOAuth('at-b') });
    expect(b.connectionId).toBe(a.connectionId);
    // The canonical spelling wins, so the legacy row migrates forward …
    expect(b.userId).toBe(userId);
    // … and a later legacy-stamped consent (the connect lane) does not regress it.
    const c = await upsertOAuthConnection({ tenantId: WS, provider: 'slack', userId: principal, tokens: expiredOAuth('at-c') });
    expect(c.userId).toBe(userId);
    expect((await listConnections(WS, [principal, userId])).filter((c) => c.provider === 'slack' && (c.userId === principal || c.userId === userId))).toHaveLength(1);
  });
});

describe('ADR 0780 D4 — the DSAR eraser', () => {
  it('leg 12: revokes the subject\'s user rows under both spellings and their in-flight grants, nothing else', async () => {
    const principal = 'oidc:b780-erased';
    const { userId } = await createUser({ tenantId: WS, principalId: principal });
    const byUser = await createSecretConnection({ tenantId: WS, provider: 'runway', kind: 'api_key', secret: 'rw-erase-key-123', scope: 'user', userId });
    const byPrincipal = await createSecretConnection({ tenantId: WS, provider: 'heygen', kind: 'api_key', secret: 'hg-erase-key-123', scope: 'user', userId: principal });
    const org = await createSecretConnection({ tenantId: WS, provider: 'zoom', kind: 'bearer', secret: 'zoom-org-token-1', scope: 'org', orgId: WS });
    const someoneElse = await createSecretConnection({ tenantId: WS, provider: 'runway', kind: 'api_key', secret: 'rw-other-key-123', scope: 'user', userId: 'user:b780-bystander' });
    const { state } = await beginAuthorization({ provider: 'slack', tenantId: WS, userId, reqOrigin: 'http://localhost' });

    const report = await eraseSubjectConnections(WS, userId);
    expect(report.rowsTouched).toBe(3);
    expect(await getConnection(WS, byUser.connectionId)).toBeNull();
    expect(await getConnection(WS, byPrincipal.connectionId)).toBeNull();
    expect(await resolveSecret(`connection:${byUser.connectionId}`, { tenantId: WS })).toBeNull();
    expect(await getConnection(WS, org.connectionId)).not.toBeNull();
    expect(await getConnection(WS, someoneElse.connectionId)).not.toBeNull();
    expect(await consumePendingAuth(state), 'a grant started before the erasure must not complete after it').toBeNull();
    // Idempotent: a second key / a re-run touches nothing.
    expect((await eraseSubjectConnections(WS, userId)).rowsTouched).toBe(0);
  });
});

describe('ADR 0780 D4 — the eraser never reports success over a stored token', () => {
  it('leg 12b: a failed removal fails the pass but finishes it; the retry sweeps and then succeeds', async () => {
    const { userId } = await createUser({ tenantId: WS, principalId: 'oidc:b780-erase-fault' });
    const a = await createSecretConnection({ tenantId: WS, provider: 'runway', kind: 'api_key', secret: 'rw-fault-a-12345', scope: 'user', userId });
    const b = await createSecretConnection({ tenantId: WS, provider: 'heygen', kind: 'api_key', secret: 'hg-fault-b-12345', scope: 'user', userId });
    secretFault.failRemove = true;
    try {
      await expect(eraseSubjectConnections(WS, userId)).rejects.toThrow(/still pending/);
    } finally {
      secretFault.failRemove = false;
    }
    // Both rows were reached on the failing pass (neither stopped the other).
    expect(await getConnection(WS, a.connectionId)).toBeNull();
    expect(await getConnection(WS, b.connectionId)).toBeNull();
    // The DSAR retry finds no rows — and still has to clear the tokens.
    await eraseSubjectConnections(WS, userId);
    expect(await resolveSecret(`connection:${a.connectionId}`, { tenantId: WS })).toBeNull();
    expect(await resolveSecret(`connection:${b.connectionId}`, { tenantId: WS })).toBeNull();
  });
});

describe('ADR 0780 D5 — inbound targets a workflow this workspace may run', () => {
  it('leg 13: unknown or foreign workflow and a short secret are refused; an owned one is accepted', async () => {
    const editor = await login(EDITOR, WS);
    const owned = await call('/host/openwop-app/workflows', editor, 'POST', { workflowId: `b780-owned-${Date.now()}`, nodes: [{ nodeId: 'n', typeId: 'core.noop', config: {} }], edges: [] });
    expect([200, 201], JSON.stringify(owned.body)).toContain(owned.status);
    const outsider = await login('oidc:b780-outsider', 'user:b780-outsider-home', false);
    const foreign = await call('/host/openwop-app/workflows', outsider, 'POST', { workflowId: `b780-foreign-${Date.now()}`, nodes: [{ nodeId: 'n', typeId: 'core.noop', config: {} }], edges: [] });
    expect([200, 201], JSON.stringify(foreign.body)).toContain(foreign.status);

    const row = await createSecretConnection({ tenantId: WS, provider: 'slack', kind: 'bearer', secret: 'xoxb-inbound-1234', scope: 'user', userId: userIdFor(WS, EDITOR) });
    const put = (body: Record<string, unknown>) => call(`${C}/${encodeURIComponent(row.connectionId)}/inbound`, editor, 'PUT', body);
    const secret = 's'.repeat(32);
    const ownedId = text(field(owned.body, 'workflowId'));
    const foreignId = text(field(foreign.body, 'workflowId'));
    expect(ownedId).not.toBe('');
    expect(foreignId).not.toBe('');
    // Each refusal is the one named (they share `validation_error`, so code alone cannot tell them apart).
    const unknown = await put({ workflowId: 'b780-does-not-exist', signingSecret: secret });
    expect(unknown.status).toBe(400);
    expect(field(unknown.body, 'message')).toBe("Workflow 'b780-does-not-exist' was not found in this workspace.");
    const foreignPut = await put({ workflowId: foreignId, signingSecret: secret });
    expect(foreignPut.status).toBe(400);
    expect(field(foreignPut.body, 'details', 'field')).toBe('workflowId');
    expect(field(foreignPut.body, 'message')).toContain('was not found in this workspace.');
    const short = await put({ workflowId: ownedId, signingSecret: 'short' });
    expect(short.status).toBe(400);
    expect(field(short.body, 'details', 'field')).toBe('signingSecret');
    const ok = await put({ workflowId: ownedId, signingSecret: secret });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
  });

  it('leg 13b: a config saved before the check that names ANOTHER workspace\'s workflow fires nothing', async () => {
    const outsider = await login('oidc:b780-outsider2', 'user:b780-outsider2-home', false);
    const foreign = await call('/host/openwop-app/workflows', outsider, 'POST', { workflowId: `b780-foreign2-${Date.now()}`, nodes: [{ nodeId: 'n', typeId: 'core.noop', config: {} }], edges: [] });
    expect([200, 201]).toContain(foreign.status);
    const editor = await login(EDITOR, WS);
    const owned = await call('/host/openwop-app/workflows', editor, 'POST', { workflowId: `b780-owned2-${Date.now()}`, nodes: [{ nodeId: 'n', typeId: 'core.noop', config: {} }], edges: [] });
    const secret = 'k'.repeat(32);
    const fire = async (workflowId: string, eventId: string) => {
      const row = await createSecretConnection({ tenantId: WS, provider: 'slack', kind: 'bearer', secret: 'xoxb-dispatch-123', scope: 'user', userId: userIdFor(WS, EDITOR) });
      await setInboundConfig({ tenantId: WS, connectionId: row.connectionId, provider: 'slack', workflowId, signingSecret: secret });
      const rawBody = JSON.stringify({ type: 'event_callback', event_id: eventId, event: { type: 'message', text: 'hi' } });
      const ts = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex')}`;
      return handleInboundEvent({ storage, hostSuite }, { connectionId: row.connectionId, rawBody, body: JSON.parse(rawBody) as Record<string, unknown>, headers: { timestamp: ts, signature }, now: Date.now() });
    };
    const refused = await fire(text(field(foreign.body, 'workflowId')), `Ev-foreign-${Date.now()}`);
    expect(refused.status).toBe('accepted');
    expect((refused as { runId?: string | null }).runId, 'another workspace\'s workflow must not run here').toBeNull();
    const fired = await fire(text(field(owned.body, 'workflowId')), `Ev-owned-${Date.now()}`);
    expect((fired as { runId?: string | null }).runId, 'non-vacuity: an owned workflow does fire').toBeTruthy();
  });

  it('leg 14: a Viewer who owns a connection still cannot wire a public ingest', async () => {
    const row = await createSecretConnection({ tenantId: WS, provider: 'slack', kind: 'bearer', secret: 'xoxb-viewer-12345', scope: 'user', userId: userIdFor(WS, VIEWER) });
    const viewer = await login(VIEWER, WS);
    const res = await call(`${C}/${encodeURIComponent(row.connectionId)}/inbound`, viewer, 'PUT', { workflowId: 'anything', signingSecret: 's'.repeat(32) });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    // The tenant-write refusal, not the owner check (the Viewer OWNS this row).
    expect(field(res.body, 'details', 'requiredScope')).toBe('workspace:write');
    expect((await listConnections(WS, userIdFor(WS, VIEWER))).some((c) => c.connectionId === row.connectionId)).toBe(true);
  });
});

describe('ADR 0780 D2 — the credential-interrupt connect lane under a legacy run stamp', () => {
  beforeAll(() => {
    process.env.OPENWOP_OAUTH_ADVERTISE = 'true';
    process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = 'https://host.example';
  });
  afterAll(() => {
    delete process.env.OPENWOP_OAUTH_ADVERTISE;
    delete process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL;
  });

  it('leg 15: the owner of an `oidc:`-stamped run can connect; the grant lands under the run\'s spelling and resolves it', async () => {
    const editor = await login(CONNECTOR, WS);
    const wf = `b780-cred-${Date.now()}`;
    const reg = await call('/host/openwop-app/workflows', editor, 'POST', {
      workflowId: wf,
      nodes: [{ nodeId: 'use-credential', typeId: 'core.noop', config: { auth: { type: 'oauth2', provider: 'slack', scopes: ['chat:write'] } } }],
      edges: [],
    });
    expect([200, 201], JSON.stringify(reg.body)).toContain(reg.status);
    const started = await call('/runs', editor, 'POST', { workflowId: wf, inputs: {} });
    expect([200, 201, 202], JSON.stringify(started.body)).toContain(started.status);
    const runId = text(field(started.body, 'runId'));
    expect(runId).not.toBe('');
    await vi.waitFor(async () => expect((await storage.getRun(bareRunId(runId)))?.status).toBe('waiting-input'), { timeout: 5000, interval: 50 });
    // The #4215 shape: the run carries the legacy principal, the caller presents `user:`.
    const run = await storage.getRun(bareRunId(runId));
    await storage.updateRun(bareRunId(runId), { metadata: { ...(run!.metadata as Record<string, unknown>), actingUserId: CONNECTOR } });

    const other = await login(OTHER, WS);
    const refused = await fetch(`${BASE}/host/openwop-app/connections/connect/${encodeURIComponent(bareRunId(runId))}/use-credential`, { headers: { cookie: other }, redirect: 'manual' });
    expect(refused.status).toBe(403);

    const open = await fetch(`${BASE}/host/openwop-app/connections/connect/${encodeURIComponent(bareRunId(runId))}/use-credential`, { headers: { cookie: editor }, redirect: 'manual' });
    expect(open.status, await open.clone().text()).toBe(302);
    const state = new URL(open.headers.get('location') ?? '').searchParams.get('state')!;
    const cb = await fetch(`${BASE}/host/openwop-app/connections/slack/callback?state=${encodeURIComponent(state)}&code=abc`, { headers: { cookie: editor }, redirect: 'manual' });
    expect(cb.status, await cb.clone().text()).toBe(302);
    expect(cb.headers.get('location')).toContain('connected=slack');
    const rows = await listConnections(WS, CONNECTOR);
    expect(rows.some((c) => c.provider === 'slack' && c.userId === CONNECTOR), 'bound under the run\'s recorded spelling').toBe(true);
    await vi.waitFor(async () => expect((await storage.getRun(bareRunId(runId)))?.status).toBe('completed'), { timeout: 5000, interval: 50 });
  });
});
