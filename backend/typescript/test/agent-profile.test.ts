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
import http from 'node:http';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { levelForSpecLevel } from '../src/host/agentProfileService.js';

const PORT = 18744;
const BASE = `http://127.0.0.1:${PORT}`;
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
    port: PORT,
    storageDsn: 'memory://',
    serviceName: 'test',
    serviceVersion: '0.0.1',
    enableConsoleTracer: false,
  });
  await new Promise<void>((res) => {
    server = app.listen(PORT, res);
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
});

describe('agent profile routes — happy path', () => {
  it('PUT creates the profile and derives autonomy.level from specLevel; GET round-trips it', async () => {
    const a = await newTenantClient();
    const id = await makeAgent(a, 'Fin Close Twin');

    const put = await a<ProfileResp>('PUT', `/v1/host/openwop-app/agents/${id}/profile`, SAMPLE_BODY);
    expect(put.status).toBe(200);
    const putBody = bodyOf(put);
    expect(putBody.profileId).toBe(id);
    expect(putBody.roleKey).toBe('finance-close');
    // draft-only → review (derived, since the body omitted `level`).
    expect(putBody.autonomy.specLevel).toBe('draft-only');
    expect(putBody.autonomy.level).toBe('review');

    const get = await a<ProfileResp>('GET', `/v1/host/openwop-app/agents/${id}/profile`);
    expect(get.status).toBe(200);
    const getBody = bodyOf(get);
    expect(getBody.configParameters?.materialityThreshold).toBe(5000);
    expect(getBody.autonomy.level).toBe('review');
  });

  it('PUT honors an explicit autonomy.level over the derived one + is idempotent (replace)', async () => {
    const a = await newTenantClient();
    const id = await makeAgent(a, 'Explicit Level Twin');

    const first = await a<ProfileResp>('PUT', `/v1/host/openwop-app/agents/${id}/profile`, {
      ...SAMPLE_BODY,
      autonomy: { specLevel: 'draft-only', level: 'guided' },
    });
    expect(first.status).toBe(200);
    const firstBody = bodyOf(first);
    // Explicit level wins over the draft-only→review mapping.
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
  const AUTH_PORT = 18745;
  const AUTH_BASE = `http://127.0.0.1:${AUTH_PORT}`;
  let authServer: http.Server;

  beforeAll(async () => {
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({
      port: AUTH_PORT,
      storageDsn: 'memory://',
      serviceName: 'test',
      serviceVersion: '0.0.1',
      enableConsoleTracer: false,
    });
    await new Promise<void>((res) => {
      authServer = app.listen(AUTH_PORT, res);
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
