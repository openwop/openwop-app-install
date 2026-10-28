/**
 * ADR 0795 D2–D6, over HTTP, in the production posture (RFC 0049 enforcement
 * OFF, demo mode ON):
 *   D2  a key reaches a vendor route only through a declared workspace scope
 *   D3  scopes are explicit at mint and come from a registry
 *   D4  lifetime is validated, defaulted and capped
 *   D5  a key travels in a header (the run-events stream excepted)
 *   D6  a key stops when its issuer does
 * D1 (the resolvers) is `adr0795-key-authority.test.ts`.
 *
 * TST-BKA-2. Red when: the vendor floor admits an undeclared scope, or asks
 * `workspace:read` of a write; `report` on the floor refuses; the MCP exemption
 * widens past `POST …/mcp`, or an own-gate prefix matches a sibling; a key may
 * act as another member; a narrowed key keeps superadmin; the review inbox's
 * `approvals:respond` check is dropped; empty or unknown scopes mint; the
 * lifetime default, past/too-far/null checks, or the unparseable-is-expired
 * rule go; `?apiKey=` is accepted on an ordinary route or refused on the event
 * stream; a removed member's keys are not revoked; a non-member's key
 * authenticates; presence becomes membership-defined everywhere; a rekey or an
 * erasure leaves keys behind; the expiry notice repeats or fires early;
 * lastUsedAt is written on every use.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { createMember, createOrg, deleteMember, deleteOrg, listMembers, rekeyMemberSubject } from '../src/host/accessControlService.js';
import { eraseDeveloperKeysForSubject, issueApiKey, listApiKeys, verifyApiKey } from '../src/features/developer-keys/apiKeyService.js';
import { ownsKeyGate } from '../src/middleware/keyVendorGate.js';
import { resetIssuerLiveCacheForTests } from '../src/middleware/auth.js';
import { bareRunId } from './support/bareRunId.js';

const TENANT = 'adr0795-policy';
const OPERATOR = 'adr0795-operator-key';
const H = '/host/openwop-app';
const KEYS = `${H}/developer-keys`;
const DAY = 86_400_000;
const SWITCHES = ['OPENWOP_KEY_VENDOR_GATE', 'OPENWOP_KEY_QUERY_PARAM', 'OPENWOP_KEY_AUTHORITY', 'OPENWOP_API_KEY_ALLOW_NO_EXPIRY', 'OPENWOP_SUPERADMIN_TENANTS'] as const;
const BOOT = ['OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_AUTHORIZATION_ENFORCEMENT', 'OPENWOP_DEMO_MODE', 'OPENWOP_API_KEYS'] as const;
const saved: Record<string, string | undefined> = {};
let BASE = ''; let server: http.Server;

beforeAll(async () => {
  for (const k of [...SWITCHES, ...BOOT]) saved[k] = process.env[k];
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  delete process.env.OPENWOP_AUTHORIZATION_ENFORCEMENT;
  process.env.OPENWOP_DEMO_MODE = 'true';
  process.env.OPENWOP_API_KEYS = `${OPERATOR}:${TENANT}`;
  for (const k of SWITCHES) delete process.env[k];
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'adr0795-policy', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 120_000);
afterEach(() => { for (const k of SWITCHES) delete process.env[k]; resetIssuerLiveCacheForTests(); });
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/** The fields these cases read from the route answers and the error envelope. */
interface ResBody {
  error?: string;
  message?: string;
  details?: { code?: string; requiredScope?: string; unknown?: string[] };
  token?: string;
  key?: { scopes?: string[]; expiresAt?: string };
  policy?: unknown;
  runId?: string;
  status?: string;
  interrupts?: Array<{ interruptId: string; nodeId: string }>;
}
interface Res { status: number; body: ResBody | undefined }
async function call(method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', connection: 'close', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json: unknown = await res.json().catch(() => undefined);
  return { status: res.status, body: isResBody(json) ? json : undefined };
}
/** Every field of ResBody is optional, so any JSON object is one; a non-object answer is no body. */
function isResBody(v: unknown): v is ResBody {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
async function key(scopes?: string[], tenantId: string = TENANT, createdBy = 'user:adr0795'): Promise<string> {
  return (await issueApiKey({ tenantId, name: 'k', createdBy, ...(scopes ? { scopes } : {}) })).token;
}
const refusedByGate = (r: Res): boolean => r.status === 403 && r.body?.details?.code === 'key_scope_required';

describe('ADR 0795 D2 — the vendor floor', () => {
  it('a key that declares only protocol scopes is refused a vendor read, naming workspace:read', async () => {
    const r = await call('GET', `${H}/roster`, await key(['runs:read', 'runs:create']));
    expect(refusedByGate(r), JSON.stringify(r)).toBe(true);
    expect(r.body?.details?.requiredScope).toBe('workspace:read');
  });

  it('workspace:read passes the floor for a read and is refused a write, naming workspace:write', async () => {
    const ro = await key(['workspace:read']);
    expect((await call('GET', `${H}/roster`, ro)).status).toBe(200);
    const w = await call('POST', `${H}/crm/contacts`, ro, { name: 'x' });
    expect(refusedByGate(w), JSON.stringify(w)).toBe(true);
    expect(w.body?.details?.requiredScope).toBe('workspace:write');
  });

  it('workspace:write passes the floor for a write; an undeclared key and `*` pass both', async () => {
    // Past the floor the request is the ROUTE's to answer: anything but the
    // floor's own refusal, and never a server error.
    const passed = (r: Res): void => { expect(refusedByGate(r), JSON.stringify(r)).toBe(false); expect(r.status).toBeLessThan(500); };
    passed(await call('POST', `${H}/crm/contacts`, await key(['workspace:read', 'workspace:write']), { name: 'x' }));
    for (const scopes of [undefined, ['*']]) {
      const k = await key(scopes);
      expect((await call('GET', `${H}/roster`, k)).status).toBe(200);
      passed(await call('POST', `${H}/crm/contacts`, k, { name: 'x' }));
    }
  });

  it('a vendor mirror of a protocol operation is left to its own scope gate (runs:read reaches the review inbox)', async () => {
    const r = await call('GET', `${H}/reviews`, await key(['runs:read']));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // ...and that route's own gate still refuses a key without runs:read.
    const none = await call('GET', `${H}/reviews`, await key(['artifacts:read']));
    expect(none.status).toBe(403);
    expect(refusedByGate(none)).toBe(false);
    expect(none.body?.error).toBe('forbidden');
    expect(none.body?.details?.requiredScope, 'the route’s own protocol-scope refusal').toBe('runs:read');
  });

  it('the path is case-sensitive: a mis-cased spelling is not a way round the floor (it routed, ungated)', async () => {
    const narrow = await key(['runs:read']);
    // ADR 0812 P3c-0 — the vendor root is unversioned now; the `/v1` spellings
    // this enumerated are the retired path space (410 whatever their case).
    for (const path of ['/HOST/openwop-app/roster', '/V1/host/openwop-app/roster', '/host/OPENWOP-APP/roster']) {
      expect((await call('GET', path, narrow)).status, path).toBe(404);
    }
    // Mis-cased AFTER the vendor root: still under the floor, so still refused.
    expect(refusedByGate(await call('GET', '/host/openwop-app/ROSTER', narrow))).toBe(true);
    // The same class, on the rule it was found on: a credential-less protocol
    // call is 401 under ONE spelling and must not reach the handler under another.
    expect((await call('POST', '/runs', undefined, { workflowId: 'openwop-app.uppercase', inputs: {} })).status).toBe(401);
    // Never the handler (it answered 201 / workflow errors). This app has
    // cookies disabled, so no session is minted and the answer is 401; with
    // cookies on it is the router's 404.
    for (const path of ['/V1/runs', '/RUNS']) {
      expect([401, 404], path).toContain((await call('POST', path, undefined, { workflowId: 'openwop-app.uppercase', inputs: {} })).status);
    }
  });

  it('a key cannot act as another member: x-openwop-act-as is refused before any route reads it', async () => {
    const ws = 'ws:adr0795-actas';
    const org = await createOrg({ tenantId: ws, createdBy: 'user:founder', name: 'A', orgId: ws });
    const owner = await createMember({ orgId: org.orgId, tenantId: ws, displayName: 'Founder', subject: 'user:founder', roles: ['owner'] });
    await createMember({ orgId: org.orgId, tenantId: ws, displayName: 'Vi', subject: 'user:vi', roles: ['viewer'] });
    const k = await key(['workspace:read', 'workspace:write'], ws, 'user:vi');
    const add = { displayName: 'Planted', subject: 'user:planted', roles: ['admin'] };
    const plain = await call('POST', `${H}/orgs/${encodeURIComponent(ws)}/members`, k, add);
    expect(plain.status, 'a viewer’s key cannot add a member').toBe(403);
    const acting = await call('POST', `${H}/orgs/${encodeURIComponent(ws)}/members`, k, add, { 'x-openwop-act-as': owner.memberId });
    expect(acting.status, JSON.stringify(acting.body)).toBe(403);
    expect(acting.body?.details?.code).toBe('key_cannot_act_as');
    expect((await listMembers(ws, ws)).some((m) => m.subject === 'user:planted')).toBe(false);
    process.env.OPENWOP_KEY_AUTHORITY = 'report';
    const reported = await call('GET', `${H}/roster`, k, undefined, { 'x-openwop-act-as': owner.memberId });
    expect(reported.body?.details?.code, 'report refuses nothing').not.toBe('key_cannot_act_as');
  });

  it('deciding through the review inbox needs approvals:respond: a runs:read key reads it and cannot decide', async () => {
    // A REAL open approval gate in this tenant: an unknown review 404s before the
    // scope check, so only a live one reaches it.
    const workflowId = `wf.adr0795.review.${Date.now()}`;
    const made = await call('POST', `${H}/workflows`, OPERATOR, { workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { prompt: 'Ship it?' } }], edges: [] });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const started = await call('POST', '/runs', OPERATOR, { workflowId, inputs: {} });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const runId = String(started.body?.runId);
    // Ceiling: the run reaches its gate asynchronously, with no hook to await.
    await vi.waitFor(async () => {
      expect((await call('GET', `/runs/${runId}`, OPERATOR)).body?.status).toBe('waiting-approval');
    }, { timeout: 15_000, interval: 25 });
    const interrupts = (await call('GET', `${H}/runs/${bareRunId(runId)}/interrupts`, OPERATOR)).body?.interrupts ?? [];
    const interruptId = interrupts.find((i) => i.nodeId === 'gate')?.interruptId;
    expect(interruptId, JSON.stringify(interrupts)).toBeTruthy();

    const reader = await key(['runs:read']);
    expect((await call('GET', `${H}/reviews`, reader)).status).toBe(200);
    const decide = await call('POST', `${H}/reviews/interrupt:${interruptId}/actions/approve`, reader, {});
    expect(decide.status, JSON.stringify(decide.body)).toBe(403);
    // Double guard: the route's `requireProtocolScope(req, 'approvals:respond')`
    // refuses first (`forbidden`); the ADR 0778 decide floor behind it
    // (`requireInterruptDecider`, `forbidden_scope`) would refuse too. The exact
    // envelope pins the outer one.
    expect(decide.body?.error).toBe('forbidden');
    expect(decide.body?.details?.requiredScope).toBe('approvals:respond');
    expect((await call('GET', `/runs/${runId}`, OPERATOR)).body?.status, 'the gate is still open').toBe('waiting-approval');
  });

  it('the MCP exemption is the mount, not the prefix', () => {
    const V = '/host/openwop-app';
    expect(ownsKeyGate('POST', `${V}/mcp`)).toBe(true);
    expect(ownsKeyGate('GET', `${V}/mcp`)).toBe(false);
    expect(ownsKeyGate('PATCH', `${V}/mcp/exposure`)).toBe(false);
    expect(ownsKeyGate('POST', `${V}/mcp/invoke`)).toBe(false);
  });

  it('a narrowed key minted in a superadmin tenant is not superadmin; an undeclared one is', async () => {
    process.env.OPENWOP_SUPERADMIN_TENANTS = TENANT;
    const FT = `${H}/feature-toggles/admin/configs`;
    const narrow = await call('GET', FT, await key(['workspace:read']));
    const wide = await call('GET', FT, await key());
    expect(wide.status, JSON.stringify(wide.body)).toBe(200);
    expect(narrow.status, 'a workspace:read key reached a superadmin surface').toBe(403);
    expect(narrow.body?.error).toBe('forbidden');
    expect(narrow.body?.message, 'the superadmin refusal, not the vendor floor').toMatch(/requires a superadmin principal/);
  });

  it('the own-gate list is exact: a sibling of an exempt route is not exempt', () => {
    const V = '/host/openwop-app';
    expect(ownsKeyGate('GET', `${V}/runs/r1/interrupts`)).toBe(true);
    expect(ownsKeyGate('POST', `${V}/runs/r1/interrupts`)).toBe(false);
    expect(ownsKeyGate('GET', `${V}/runs/r1/anything-else`)).toBe(false);
    expect(ownsKeyGate('GET', `${V}/chat/sessions`)).toBe(false);
    expect(ownsKeyGate('GET', `${V}/chat/sessions/running`)).toBe(true);
    expect(ownsKeyGate('GET', `${V}/reviewsx`)).toBe(false);
  });

  it('report and off let the request through; a person-less operator key is never gated (CONTROL)', async () => {
    const narrow = await key(['runs:read']);
    for (const mode of ['report', 'off']) {
      process.env.OPENWOP_KEY_VENDOR_GATE = mode;
      expect(refusedByGate(await call('GET', `${H}/roster`, narrow)), mode).toBe(false);
    }
    delete process.env.OPENWOP_KEY_VENDOR_GATE;
    expect(refusedByGate(await call('GET', `${H}/roster`, narrow))).toBe(true);
    expect(refusedByGate(await call('GET', `${H}/roster`, OPERATOR))).toBe(false);
  });
});

describe('ADR 0795 D3 — explicit, real scopes at mint', () => {
  it('omitting scopes is refused: unrestricted is a choice, not a default', async () => {
    for (const body of [{ name: 'k' }, { name: 'k', scopes: [] }]) {
      const r = await call('POST', KEYS, OPERATOR, body);
      expect(r.status, JSON.stringify(r.body)).toBe(400);
      expect(r.body?.details?.code).toBe('scopes_required');
      expect(r.body?.token).toBeUndefined();
    }
  });

  it('a scope nothing checks is refused by name (runs:write minted a key that could do nothing)', async () => {
    const r = await call('POST', KEYS, OPERATOR, { name: 'k', scopes: ['runs:read', 'runs:write'] });
    expect(r.status).toBe(400);
    expect(r.body?.details?.code).toBe('unknown_scope');
    expect(r.body?.details?.unknown).toEqual(['runs:write']);
  });

  it('`*`, protocol, workspace and a feature-registered grammar are all mintable', async () => {
    for (const scopes of [['*'], ['runs:create', 'runs:read'], ['workspace:read', 'workspace:write'], ['entities:catalog:read'], ['entities:admin']]) {
      const r = await call('POST', KEYS, OPERATOR, { name: 'k', scopes });
      expect(r.status, `${scopes.join(',')}: ${JSON.stringify(r.body)}`).toBe(201);
      expect(r.body?.key?.scopes).toEqual(scopes);
    }
    expect((await call('POST', KEYS, OPERATOR, { name: 'k', scopes: ['entities:catalog:delete'] })).status).toBe(400);
  });
});

describe('ADR 0795 D4 — a validated, defaulted, capped lifetime', () => {
  const mint = (expiresAt?: unknown) => call('POST', KEYS, OPERATOR, { name: 'k', scopes: ['runs:read'], ...(expiresAt !== undefined ? { expiresAt } : {}) });

  it('omitting expiresAt applies the 90-day default, not "never"', async () => {
    const r = await mint();
    expect(r.status).toBe(201);
    const at = Date.parse(r.body?.key?.expiresAt ?? '');
    expect(Math.abs(at - (Date.now() + 90 * DAY))).toBeLessThan(60_000);
  });

  it.each([
    ['tomorrow', 'expiry_unparseable'],
    [12345, 'expiry_unparseable'],
    ['2000-01-01T00:00:00Z', 'expiry_in_past'],
    [new Date(Date.now() + 400 * DAY).toISOString(), 'expiry_too_far'],
    [null, 'expiry_required'],
  ])('expiresAt %j is refused (%s) and nothing is issued', async (value, code) => {
    const r = await mint(value);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body?.details?.code).toBe(code);
    expect(r.body?.token).toBeUndefined();
  });

  it('a lifetime inside the cap is honoured; null is honoured only where the operator allows it', async () => {
    const want = new Date(Date.now() + 10 * DAY).toISOString();
    expect((await mint(want)).body?.key?.expiresAt).toBe(want);
    process.env.OPENWOP_API_KEY_ALLOW_NO_EXPIRY = 'true';
    const never = await mint(null);
    expect(never.status).toBe(201);
    expect(never.body?.key?.expiresAt).toBeUndefined();
  });

  it('a stored expiry that does not parse is EXPIRED (it used to mean never)', async () => {
    const { token } = await issueApiKey({ tenantId: TENANT, name: 'legacy', createdBy: 'user:adr0795', expiresAt: 'tomorrow' });
    expect(await verifyApiKey(token)).toBeNull();
    expect((await call('GET', '/runs', token)).status).toBe(401);
  });

  it('the list tells the page what this deployment will issue', async () => {
    const r = await call('GET', KEYS, OPERATOR);
    expect(r.body?.policy).toEqual({ defaultLifetimeDays: 90, maxLifetimeDays: 366, allowNoExpiry: false, disabled: false });
  });
});

describe('ADR 0795 D5 — a key travels in a header', () => {
  it('?apiKey=owk_… is refused on an ordinary route and still works in the header', async () => {
    const k = await key(['runs:read']);
    const viaUrl = await call('GET', `/runs?apiKey=${encodeURIComponent(k)}`);
    expect(viaUrl.status, JSON.stringify(viaUrl.body)).toBe(401);
    expect(viaUrl.body?.message).toMatch(/Authorization header/);
    expect((await call('GET', '/runs', k)).status).toBe(200);
  });

  it('the run-events stream keeps the query form (EventSource cannot set a header)', async () => {
    const k = await key(['runs:create', 'runs:read']);
    const run = await call('POST', '/runs', k, { workflowId: 'openwop-app.uppercase', inputs: {} });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    const res = await fetch(`${BASE}/runs/${run.body?.runId}/events?apiKey=${encodeURIComponent(k)}`, { headers: { accept: 'text/event-stream', connection: 'close' } });
    expect(res.status).toBe(200);
    await res.body?.cancel();
  });

  it('report lets it through; an operator env key is not affected (CONTROL)', async () => {
    const k = await key(['runs:read']);
    process.env.OPENWOP_KEY_QUERY_PARAM = 'report';
    expect((await call('GET', `/runs?apiKey=${encodeURIComponent(k)}`)).status).toBe(200);
    delete process.env.OPENWOP_KEY_QUERY_PARAM;
    expect((await call('GET', `/runs?apiKey=${OPERATOR}`)).status).toBe(200);
  });
});

describe('ADR 0795 D6 — a key stops when its issuer does', () => {
  it('removing a member from a shared workspace revokes the keys they issued there', async () => {
    const ws = 'ws:adr0795-leaver';
    const org = await createOrg({ tenantId: ws, createdBy: 'user:founder', name: 'L', orgId: ws });
    await createMember({ orgId: org.orgId, tenantId: ws, displayName: 'Founder', subject: 'user:founder', roles: ['owner'] });
    const m = await createMember({ orgId: org.orgId, tenantId: ws, displayName: 'Leaver', subject: 'user:leaver', roles: ['editor'] });
    const k = await key(['runs:read'], ws, 'user:leaver');
    const other = await key(['runs:read'], ws, 'user:founder');
    expect((await call('GET', '/runs', k)).status).toBe(200);
    await deleteMember(m.memberId);
    expect((await call('GET', '/runs', k)).status).toBe(401);
    expect(await verifyApiKey(k), 'revoked, not merely unauthorised').toBeNull();
    expect((await call('GET', '/runs', other)).status, 'a colleague’s key is untouched').toBe(200);
  });

  it('a key whose issuer is nobody in a shared workspace does not authenticate — even with enforcement off', async () => {
    const ws = 'ws:adr0795-stranger';
    const org = await createOrg({ tenantId: ws, createdBy: 'user:founder', name: 'S', orgId: ws });
    await createMember({ orgId: org.orgId, tenantId: ws, displayName: 'Founder', subject: 'user:founder', roles: ['owner'] });
    const k = await key(['runs:read'], ws, 'user:never-a-member');
    const r = await call('GET', '/runs', k);
    expect(r.status, JSON.stringify(r.body)).toBe(401);
    process.env.OPENWOP_KEY_AUTHORITY = 'report';
    resetIssuerLiveCacheForTests();
    expect((await call('GET', '/runs', k)).status, 'report changes nothing').toBe(200);
  });

  it('CONTROL — where membership is not how one is present, "no member row" is not "gone"', async () => {
    expect((await call('GET', '/runs', await key(['runs:read'], TENANT, 'user:not-a-member')))).toMatchObject({ status: 200 });
    expect((await call('GET', '/runs', await key(['runs:read'], 'user:adr0795p', 'user:owner')))).toMatchObject({ status: 200 });
  });

  it('deleting an ORG takes its members’ keys with it (a removal that bypasses deleteMember)', async () => {
    const ws = 'ws:adr0795-orgdel';
    const root = await createOrg({ tenantId: ws, createdBy: 'user:founder', name: 'Root', orgId: ws });
    await createMember({ orgId: root.orgId, tenantId: ws, displayName: 'Founder', subject: 'user:founder', roles: ['owner'] });
    const sub = await createOrg({ tenantId: ws, createdBy: 'user:founder', name: 'Sub' });
    await createMember({ orgId: sub.orgId, tenantId: ws, displayName: 'Only here', subject: 'user:only-sub', roles: ['editor'] });
    const k = await key(['runs:read'], ws, 'user:only-sub');
    expect(await verifyApiKey(k)).not.toBeNull();
    await deleteOrg(sub.orgId);
    expect(await verifyApiKey(k), 'the issuer has no membership left in the tenant').toBeNull();
  });

  it('rekeying a subject moves the keys it issued: binding an account does not orphan them', async () => {
    const ws = 'ws:adr0795-rekey';
    const org = await createOrg({ tenantId: ws, createdBy: 'oidc:rk', name: 'K', orgId: ws });
    await createMember({ orgId: org.orgId, tenantId: ws, displayName: 'Rk', subject: 'oidc:rk', roles: ['owner'] });
    const k = await key(['runs:read'], ws, 'oidc:rk');
    expect((await call('GET', '/runs', k)).status).toBe(200);
    await rekeyMemberSubject('oidc:rk', 'user:rk-canonical');
    resetIssuerLiveCacheForTests();
    expect((await call('GET', '/runs', k)).status, 'the member row moved; the key must follow').toBe(200);
    expect((await listApiKeys(ws, { callerSubject: 'x', isAdmin: true })).every((r) => r.createdBy === 'user:rk-canonical')).toBe(true);
  });

  it('a removed member’s key stays dead across the cache: the removal revokes, the cache only backs it up', async () => {
    const ws = 'ws:adr0795-cache';
    const org = await createOrg({ tenantId: ws, createdBy: 'user:founder', name: 'C', orgId: ws });
    await createMember({ orgId: org.orgId, tenantId: ws, displayName: 'Founder', subject: 'user:founder', roles: ['owner'] });
    const m = await createMember({ orgId: org.orgId, tenantId: ws, displayName: 'L', subject: 'user:cache-leaver', roles: ['editor'] });
    const k = await key(['runs:read'], ws, 'user:cache-leaver');
    expect((await call('GET', '/runs', k)).status, 'warms the live=true cache entry').toBe(200);
    await deleteMember(m.memberId);
    // NO cache reset here: a stale `live: true` must not keep the key working.
    expect((await call('GET', '/runs', k)).status).toBe(401);
  });

  it('erasing a subject deletes their keys: the token no longer verifies and the row is gone', async () => {
    const t = 'adr0795-erase';
    const mine = await issueApiKey({ tenantId: t, name: 'mine', createdBy: 'user:erased' });
    const theirs = await issueApiKey({ tenantId: t, name: 'theirs', createdBy: 'user:kept' });
    await eraseDeveloperKeysForSubject(t, 'user:erased');
    expect(await verifyApiKey(mine.token)).toBeNull();
    expect(await verifyApiKey(theirs.token)).not.toBeNull();
    // Deleted, not revoked: a revoked row would still carry the subject's
    // `createdBy` and the key's name.
    const left = await listApiKeys(t, { callerSubject: 'x', isAdmin: true });
    expect(left.map((k) => k.keyId)).toEqual([theirs.key.keyId]);
  });
});

describe('ADR 0795 D4 — expiry is not a surprise, and use is not a write per request', () => {
  const ALL = { callerSubject: 'x', isAdmin: true } as const;
  const rowOf = async (tenantId: string, keyId: string) => (await listApiKeys(tenantId, ALL)).find((k) => k.keyId === keyId)!;
  const settle = async (pred: () => Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 100 && !(await pred()); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('a key USED inside its last 14 days is MARKED for one notice; a key with months left is not (delivery itself is not asserted here)', async () => {
    const t = 'adr0795-notice';
    const soon = await issueApiKey({ tenantId: t, name: 'soon', createdBy: 'user:n', expiresAt: new Date(Date.now() + 5 * DAY).toISOString() });
    const later = await issueApiKey({ tenantId: t, name: 'later', createdBy: 'user:n', expiresAt: new Date(Date.now() + 60 * DAY).toISOString() });
    expect((await rowOf(t, soon.key.keyId)).expiryNoticeAt, 'not before it is used').toBeUndefined();
    await verifyApiKey(soon.token);
    await verifyApiKey(later.token);
    await settle(async () => (await rowOf(t, soon.key.keyId)).expiryNoticeAt !== undefined);
    const first = (await rowOf(t, soon.key.keyId)).expiryNoticeAt;
    expect(first).toBeDefined();
    await settle(async () => (await rowOf(t, later.key.keyId)).lastUsedAt !== undefined);
    expect((await rowOf(t, later.key.keyId)).expiryNoticeAt).toBeUndefined();
    // Used again, past the five-minute resolution so this use itself WRITES:
    // settle on that write (the positive control), then the notice is unchanged.
    const usedAt = (await rowOf(t, soon.key.keyId)).lastUsedAt;
    const again = Date.now() + 6 * 60_000;
    await verifyApiKey(soon.token, again);
    await settle(async () => (await rowOf(t, soon.key.keyId)).lastUsedAt !== usedAt);
    expect((await rowOf(t, soon.key.keyId)).lastUsedAt, 'the second use wrote').toBe(new Date(again).toISOString());
    expect((await rowOf(t, soon.key.keyId)).expiryNoticeAt).toBe(first);
  });

  it('lastUsedAt has five-minute resolution: a second use moments later writes nothing', async () => {
    const t = 'adr0795-lastused';
    const k = await issueApiKey({ tenantId: t, name: 'k', createdBy: 'user:n' });
    const t0 = Date.now();
    await verifyApiKey(k.token, t0, { ip: '10.0.0.1' });
    await settle(async () => (await rowOf(t, k.key.keyId)).lastUsedAt !== undefined);
    expect((await rowOf(t, k.key.keyId)).lastUsedAt).toBe(new Date(t0).toISOString());
    // A use one minute later from another address: inside the resolution, so
    // NOTHING is written (no lastUsedAt, no lastUsedIp).
    await verifyApiKey(k.token, t0 + 60_000, { ip: '10.0.0.2' });
    // Drain, so a write that use wrongly fired lands before the next read
    // (otherwise the two swaps could race and hide it).
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r));
    // A use six minutes later IS due; it writes, and it carries no address of
    // its own, so the stored address is whichever earlier use was WRITTEN.
    await verifyApiKey(k.token, t0 + 6 * 60_000);
    await settle(async () => (await rowOf(t, k.key.keyId)).lastUsedAt === new Date(t0 + 6 * 60_000).toISOString());
    const row = await rowOf(t, k.key.keyId);
    expect(row.lastUsedAt).toBe(new Date(t0 + 6 * 60_000).toISOString());
    expect(row.lastUsedIp, 'the one-minute use wrote nothing').toBe('10.0.0.1');
  });
});
