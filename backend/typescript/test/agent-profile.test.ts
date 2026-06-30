/**
 * Rich agent profile (ADR 0031) — host-extension routes + service.
 *
 * Surface under test (ADR 0031 §2):
 *   GET /v1/host/openwop-app/agents/:id/profile
 *   PUT /v1/host/openwop-app/agents/:id/profile
 *
 * The HTTP boundary is where authz is observable, so the route tests cover:
 *   - GET/PUT happy path (incl. autonomy `level` DERIVED from `specLevel`)
 *   - auth required (no bearer / no cookie → 401 under enforce-bearer)
 *   - tenant isolation (tenant B cannot read OR write tenant A's profile)
 *   - fail-closed on a missing/foreign agent (404, never leaks existence)
 *
 * Two distinct REAL tenants come from the test-login cookie sessions (each
 * email → its own personalTenant), the same device the site-page tests use.
 * A small pure-service block covers the spec→roster autonomy mapping table.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import {
  levelForSpecLevel,
  specLevelForLevel,
  syncAgentProfileAutonomy,
  upsertAgentProfile,
  getAgentProfile,
  activateAgentCapability,
  setAgentKnowledge,
  setAgentTwin,
  resolveAgentToolPermissions,
  backfillProfileReadPermissions,
} from '../src/host/agentProfileService.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // Cookie-per-visitor posture: the test-login route mints a per-email session
  // cookie (each email → its own personalTenant), giving us distinct REAL
  // tenants for the isolation tests. The "auth required → 401" case runs against
  // a SEPARATE cookies-disabled instance below (enforce-bearer would 401 the
  // login route itself, since /test/login isn't a public prefix).
  process.env.OPENWOP_DEPLOY_POSTURE = 'cookie-per-visitor';
  delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({
    port: 0,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});

afterAll(async () => {
  delete process.env.OPENWOP_DEPLOY_POSTURE;
  if (server) await new Promise<void>((res) => server.close(() => res()));
});

interface RawResponse<T> {
  status: number;
  /** Parsed JSON body, or `undefined` for a 204 No Content response. */
  body: T | undefined;
}

/** A cookie-bound client = one distinct tenant (its email's personalTenant). */
type Client = <T = unknown>(method: string, path: string, body?: unknown) => Promise<RawResponse<T>>;

async function newTenantClient(): Promise<Client> {
  let cookie = '';
  const call: Client = async <T>(method: string, path: string, body?: unknown): Promise<RawResponse<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) {
      const m = /(__session=[^;]+)/.exec(ck);
      if (m) cookie = m[1];
    }
    if (res.status === 204) return { status: 204, body: undefined };
    return { status: res.status, body: (await res.json()) as T };
  };
  const login = await call('POST', '/v1/host/openwop-app/test/login', { email: `profile-${n++}@x.test` });
  expect(login.status).toBe(201);
  return call;
}

/** Assert a JSON body is present (not a 204) and return it narrowed. */
function bodyOf<T>(res: RawResponse<T>): T {
  expect(res.body).toBeDefined();
  return res.body as T;
}

/** Create a standing roster member owned by `client`'s tenant; return its id. */
async function makeAgent(client: Client, persona: string): Promise<string> {
  const created = await client<{ rosterId: string }>('POST', '/v1/host/openwop-app/roster', {
    persona,
    agentRef: { agentId: 'core.openwop.agents.brief-writer' },
  });
  expect(created.status).toBe(201);
  expect(bodyOf(created).rosterId.startsWith('host:')).toBe(true);
  return bodyOf(created).rosterId;
}

/** The route's profile response shape (subset asserted in the tests). */
interface ProfileResp {
  profileId: string;
  roleKey: string;
  autonomy: { level: string; specLevel: string };
  configParameters?: { materialityThreshold?: number };
  createdAt: string;
  updatedAt: string;
}

const SAMPLE_BODY = {
  roleKey: 'finance-close',
  configParameters: { materialityThreshold: 5000 },
  permissions: { read: ['erp', 'docs'], write: ['tasks', 'drafts'], never: ['postJournal'] },
  hitl: ['journalPosting', 'paymentInstruction'],
  escalation: { contacts: ['controller@'], triggers: ['missingEvidence'] },
  channels: { approval: 'slack:#finance-approvals', delivery: 'email' },
  adminControls: ['sodPolicy'],
  riskCompliance: ['SoD', 'dualReview'],
  requiredConnections: ['erp', 'docStorage'],
  metrics: ['daysToClose'],
  // No `level` → the route derives it from specLevel (draft-only → review).
  autonomy: { specLevel: 'draft-only' as const },
};

describe('agent profile autonomy mapping (pure)', () => {
  it('maps the four spec levels to the three roster levels (ADR 0031 table)', () => {
    expect(levelForSpecLevel('draft-only')).toBe('review');
    expect(levelForSpecLevel('recommend')).toBe('review');
    expect(levelForSpecLevel('execute-with-approval')).toBe('guided');
    expect(levelForSpecLevel('autonomous-within-policy')).toBe('auto');
  });

  it('specLevelForLevel inverts the map, preserving draft-only for review (ADR 0101)', () => {
    expect(specLevelForLevel('guided')).toBe('execute-with-approval');
    expect(specLevelForLevel('auto')).toBe('autonomous-within-policy');
    expect(specLevelForLevel('review')).toBe('recommend');
    expect(specLevelForLevel('review', 'draft-only')).toBe('draft-only');
    expect(specLevelForLevel('review', 'recommend')).toBe('recommend');
  });
});

describe('backfillProfileReadPermissions (ADR 0102 migration)', () => {
  it('adds missing read tokens to profiles with permissions, idempotently; leaves permission-less profiles ungated', async () => {
    const t = 'tenant-backfill';
    const withPerms = 'host:bf-perms';
    const noPerms = 'host:bf-noperms';
    await upsertAgentProfile(t, withPerms, {
      roleKey: 'r', permissions: { read: ['crm.read'], write: ['kanban.card.write'], never: ['email.send'] },
      autonomy: { specLevel: 'recommend' },
    });
    await upsertAgentProfile(t, noPerms, { roleKey: 'r', autonomy: { specLevel: 'recommend' } }); // no permissions block

    const tokens = ['openwop:ai', 'openwop:core'];
    const n = await backfillProfileReadPermissions(tokens);
    expect(n).toBeGreaterThanOrEqual(1);
    // tokens appended to read; write + never untouched
    expect((await getAgentProfile(t, withPerms))?.permissions).toEqual({
      read: ['crm.read', 'openwop:ai', 'openwop:core'], write: ['kanban.card.write'], never: ['email.send'],
    });
    // a profile with NO permissions stays ungated (untouched)
    expect((await getAgentProfile(t, noPerms))?.permissions).toBeUndefined();
    // idempotent: re-run leaves the already-covered profile exactly as-is
    await backfillProfileReadPermissions(tokens);
    expect((await getAgentProfile(t, withPerms))?.permissions?.read).toEqual(['crm.read', 'openwop:ai', 'openwop:core']);
  });
});

describe('resolveAgentToolPermissions (ADR 0102 wiring)', () => {
  it('returns the profile permissions for a standing (host:) agent, undefined otherwise', async () => {
    const t = 'tenant-perms';
    const id = 'host:perm-agent';
    await upsertAgentProfile(t, id, {
      roleKey: 'r',
      permissions: { read: ['crm.read'], write: [], never: ['email.send'] },
      autonomy: { specLevel: 'recommend' },
    });
    expect(await resolveAgentToolPermissions(t, id)).toEqual({ read: ['crm.read'], write: [], never: ['email.send'] });
    // a pack/manifest agent (no host: prefix) has no profile → ungated
    expect(await resolveAgentToolPermissions(t, 'pack.researcher')).toBeUndefined();
    // cross-tenant → fail-closed undefined
    expect(await resolveAgentToolPermissions('other-tenant', id)).toBeUndefined();
    // host: agent with no profile → undefined
    expect(await resolveAgentToolPermissions(t, 'host:missing')).toBeUndefined();
  });
});

describe('agent profile autonomy sync + data preservation (ADR 0101)', () => {
  it('syncAgentProfileAutonomy moves the stored level + specLevel in lockstep', async () => {
    const t = 'tenant-sync';
    const id = 'host:sync-1';
    await upsertAgentProfile(t, id, { roleKey: 'r', autonomy: { specLevel: 'recommend' } });
    expect((await getAgentProfile(t, id))?.autonomy).toMatchObject({ level: 'review', specLevel: 'recommend' });

    await syncAgentProfileAutonomy(t, id, 'auto');
    expect((await getAgentProfile(t, id))?.autonomy).toMatchObject({ level: 'auto', specLevel: 'autonomous-within-policy' });

    // No profile / cross-tenant → no-op (fail-closed), never throws.
    await syncAgentProfileAutonomy(t, 'host:absent', 'guided');
    await syncAgentProfileAutonomy('other-tenant', id, 'guided');
    expect((await getAgentProfile(t, id))?.autonomy.level).toBe('auto');
  });

  it('a full-replace PUT preserves subsystem-owned capabilities / knowledge / twin', async () => {
    const t = 'tenant-preserve';
    const id = 'host:preserve-1';
    // Seed the subsystem-owned fields the governance editor never resends.
    await activateAgentCapability(t, id, 'assistant', { roleKey: 'r', autonomy: { specLevel: 'recommend' } });
    await setAgentKnowledge(t, id, { collectionIds: ['kb-1'], memoryWritable: true }, { roleKey: 'r', autonomy: { specLevel: 'recommend' } });
    await setAgentTwin(t, id, { userId: 'user-7', linkedBy: 'admin-1', linkedAt: '2026-06-22T00:00:00Z' }, { roleKey: 'r', autonomy: { specLevel: 'recommend' } });

    // A guardrails save (no capabilities/knowledge/twin in the input) must NOT wipe them.
    await upsertAgentProfile(t, id, { roleKey: 'r', permissions: { read: [], write: [], never: ['email.send'] }, autonomy: { specLevel: 'recommend' } });
    const after = await getAgentProfile(t, id);
    expect(after?.capabilities).toContain('assistant');
    expect(after?.knowledge?.collectionIds).toEqual(['kb-1']);
    expect(after?.twin?.userId).toBe('user-7');
    expect(after?.permissions?.never).toEqual(['email.send']);
  });
});

describe('agent profile routes — happy path', () => {
  it('PUT derives the profile autonomy from roster.autonomyLevel (ADR 0101 SSoT), not the body; GET round-trips', async () => {
    const a = await newTenantClient();
    const id = await makeAgent(a, 'Fin Close'); // default roster autonomy = auto

    // The body's autonomy is IGNORED — `roster.autonomyLevel` is the single source
    // of truth (owned by the Edit-details modal). The default 'auto' derives the
    // `autonomous-within-policy` spec level, regardless of the body's `draft-only`.
    const put = await a<ProfileResp>('PUT', `/v1/host/openwop-app/agents/${id}/profile`, SAMPLE_BODY);
    expect(put.status).toBe(200);
    const putBody = bodyOf(put);
    expect(putBody.profileId).toBe(id);
    expect(putBody.roleKey).toBe('finance-close');
    expect(putBody.autonomy.level).toBe('auto');
    expect(putBody.autonomy.specLevel).toBe('autonomous-within-policy');

    // Move the single source of truth → the profile follows it.
    const patched = await a<{ rosterId: string }>('PATCH', `/v1/host/openwop-app/roster/${id}`, { autonomyLevel: 'review' });
    expect(patched.status).toBe(200);

    const get = await a<ProfileResp>('GET', `/v1/host/openwop-app/agents/${id}/profile`);
    expect(get.status).toBe(200);
    const getBody = bodyOf(get);
    expect(getBody.configParameters?.materialityThreshold).toBe(5000);
    expect(getBody.autonomy.level).toBe('review'); // synced from the roster PATCH
  });

  it('PUT ignores the body autonomy.level — roster.autonomyLevel is authoritative; replace is idempotent', async () => {
    const a = await newTenantClient();
    const id = await makeAgent(a, 'Explicit Level');
    const setLevel = await a<{ rosterId: string }>('PATCH', `/v1/host/openwop-app/roster/${id}`, { autonomyLevel: 'guided' });
    expect(setLevel.status).toBe(200);

    const first = await a<ProfileResp>('PUT', `/v1/host/openwop-app/agents/${id}/profile`, {
      ...SAMPLE_BODY,
      autonomy: { specLevel: 'draft-only', level: 'auto' },
    });
    expect(first.status).toBe(200);
    const firstBody = bodyOf(first);
    // The body asked for `auto`; the roster says `guided` → the SSoT wins (ADR 0101).
    expect(firstBody.autonomy.level).toBe('guided');

    const second = await a<ProfileResp>('PUT', `/v1/host/openwop-app/agents/${id}/profile`, {
      ...SAMPLE_BODY,
      roleKey: 'finance-close-v2',
    });
    expect(second.status).toBe(200);
    const secondBody = bodyOf(second);
    // createdAt preserved across the replace; the row stays a single profile.
    expect(secondBody.createdAt).toBe(firstBody.createdAt);
    expect(secondBody.roleKey).toBe('finance-close-v2');
  });

  it('GET 404s before any profile is written (no profile yet, but agent exists)', async () => {
    const a = await newTenantClient();
    const id = await makeAgent(a, 'No Profile Yet');
    const get = await a('GET', `/v1/host/openwop-app/agents/${id}/profile`);
    expect(get.status).toBe(404);
  });

  it('PUT rejects a malformed body (400)', async () => {
    const a = await newTenantClient();
    const id = await makeAgent(a, 'Bad Body Twin');
    // Missing roleKey.
    expect((await a('PUT', `/v1/host/openwop-app/agents/${id}/profile`, { autonomy: { specLevel: 'draft-only' } })).status).toBe(400);
    // Bad specLevel.
    expect(
      (await a('PUT', `/v1/host/openwop-app/agents/${id}/profile`, { roleKey: 'x', autonomy: { specLevel: 'made-up' } })).status,
    ).toBe(400);
  });
});

describe('agent profile routes — auth required', () => {
  // A SEPARATE cookies-disabled instance: with no cookie path to fall back to,
  // a request carrying no Bearer token is strictly 401'd by the global auth
  // middleware (before the route runs) — proving auth is required on the
  // profile surface. (The cookie instance above can't show this: it mints an
  // anon session for a credential-less request.)
  let AUTH_BASE: string;
  let authServer: http.Server;

  beforeAll(async () => {
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: 0,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    await new Promise<void>((res) => {
      authServer = app.listen(0, () => { AUTH_BASE = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`; res(); });
    });
  });
  afterAll(async () => {
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    if (authServer) await new Promise<void>((res) => authServer.close(() => res()));
  });

  it('a request with no bearer (cookies disabled) is 401 for both GET and PUT', async () => {
    const get = await fetch(`${AUTH_BASE}/v1/host/openwop-app/agents/host:anything-00000000/profile`);
    expect(get.status).toBe(401);
    const put = await fetch(`${AUTH_BASE}/v1/host/openwop-app/agents/host:anything-00000000/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(SAMPLE_BODY),
    });
    expect(put.status).toBe(401);
  });
});

describe('agent profile routes — tenant isolation + fail-closed', () => {
  it('tenant B cannot READ tenant A\'s profile (404, no existence leak)', async () => {
    const a = await newTenantClient();
    const b = await newTenantClient();
    const id = await makeAgent(a, 'A Owned Twin');
    expect((await a('PUT', `/v1/host/openwop-app/agents/${id}/profile`, SAMPLE_BODY)).status).toBe(200);

    // B reads A's agent id → 404 (the agent isn't in B's roster).
    expect((await b('GET', `/v1/host/openwop-app/agents/${id}/profile`)).status).toBe(404);
    // A can still read its own.
    expect((await a('GET', `/v1/host/openwop-app/agents/${id}/profile`)).status).toBe(200);
  });

  it('tenant B cannot WRITE tenant A\'s profile (404, and A\'s profile is unchanged)', async () => {
    const a = await newTenantClient();
    const b = await newTenantClient();
    const id = await makeAgent(a, 'A Write Guard Twin');
    expect((await a('PUT', `/v1/host/openwop-app/agents/${id}/profile`, SAMPLE_BODY)).status).toBe(200);

    // B's PUT against A's agent fails closed.
    const bWrite = await b('PUT', `/v1/host/openwop-app/agents/${id}/profile`, { ...SAMPLE_BODY, roleKey: 'hijacked' });
    expect(bWrite.status).toBe(404);

    // A's profile is untouched.
    const after = await a<{ roleKey: string }>('GET', `/v1/host/openwop-app/agents/${id}/profile`);
    expect(after.status).toBe(200);
    expect(bodyOf(after).roleKey).toBe('finance-close');
  });

  it('fails closed on an unknown agent id (404 for both GET and PUT)', async () => {
    const a = await newTenantClient();
    expect((await a('GET', '/v1/host/openwop-app/agents/host:nope-00000000/profile')).status).toBe(404);
    expect((await a('PUT', '/v1/host/openwop-app/agents/host:nope-00000000/profile', SAMPLE_BODY)).status).toBe(404);
  });
});
