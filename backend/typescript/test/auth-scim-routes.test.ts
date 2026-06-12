/**
 * SCIM 2.0 endpoints — route-level reachability through the FULL middleware stack
 * (RFC 0050 §B). The service-level contract is covered by `auth-scim.test.ts`;
 * this proves the HTTP boundary, which a service test can't see:
 *
 *  - the IdP's SCIM bearer (NOT an OPENWOP_API_KEY, NOT a JWT) actually REACHES
 *    the route's own `requireScimBearer` check even under the hardened
 *    bearer-required posture (`OPENWOP_AUTH_ENFORCE_BEARER=true`) a real SCIM
 *    adopter runs — i.e. `/scim/v2` is on the auth middleware's public-prefix
 *    allowlist. WITHOUT that, the global layer 401s the unrecognized bearer
 *    before the route runs and SCIM is silently unreachable in production.
 *  - a wrong / missing bearer is rejected (401) by the route, not minted into an
 *    anon session;
 *  - the endpoints 404 when `OPENWOP_SCIM_BEARER` is unset (they don't exist).
 *
 * Regression guard for the latent gating bug: the `/scim/v2/*` routes
 * self-authenticate with a constant-time SCIM-bearer compare, so they MUST bypass
 * the global session/bearer middleware (like the SAML ACS + /v1/interrupts/{token}).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authMiddleware } from '../src/middleware/auth.js';
import { errorEnvelopeMiddleware } from '../src/middleware/errorEnvelope.js';
import { registerScimAuthRoutes } from '../src/routes/authScim.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetUsersStore, getUserByPrincipal } from '../src/features/users/usersService.js';

const SCIM_BEARER = 'scim-secret-bearer-0123456789';
const dir = mkdtempSync(join(tmpdir(), 'owop-scim-routes-'));

let server: http.Server;
let port: number;

async function post(path: string, bearer: string | null, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
}

beforeAll(async () => {
  // The HARDENED posture: no anon fallback, bearer required. This is what makes
  // the public-prefix bypass load-bearing — without it the SCIM bearer 401s here.
  process.env.OPENWOP_AUTH_ENFORCE_BEARER = 'true';
  process.env.OPENWOP_SCIM_BEARER = SCIM_BEARER;
  process.env.OPENWOP_SCIM_TENANT = 'scim';

  const app: Express = express();
  app.use(express.json());
  app.use(authMiddleware()); // reads ENFORCE_BEARER at construction → set above first
  registerScimAuthRoutes(app);
  app.use(errorEnvelopeMiddleware());
  server = await new Promise<http.Server>((r) => { const s = app.listen(0, () => r(s)); });
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
  delete process.env.OPENWOP_SCIM_BEARER;
  delete process.env.OPENWOP_SCIM_TENANT;
});

beforeEach(() => {
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(join(dir, 'scim.db')));
  void __resetUsersStore();
});

describe('SCIM /scim/v2 routes — reachable under the hardened bearer-required posture', () => {
  it('a valid SCIM bearer REACHES the route and provisions (201) — not 401ed by the global layer', async () => {
    const res = await post('/scim/v2/Users', SCIM_BEARER, { userName: 'joiner@acme.test', displayName: 'Joiner' });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { userName: string; active: boolean; id: string };
    expect(json.userName).toBe('joiner@acme.test');
    expect(json.active).toBe(true);
    // provisioned into the SCIM tenant (OPENWOP_SCIM_TENANT), keyed scim:<userName>
    expect((await getUserByPrincipal('scim', 'scim:joiner@acme.test'))!.userId).toBe(json.id);
  });

  it('a wrong bearer is rejected by the route (401), not minted into an anon session', async () => {
    const res = await post('/scim/v2/Users', 'not-the-scim-bearer', { userName: 'x@acme.test' });
    expect(res.status).toBe(401);
  });

  it('no bearer → 401', async () => {
    const res = await post('/scim/v2/Users', null, { userName: 'x@acme.test' });
    expect(res.status).toBe(401);
  });

  it('Groups membership sync is reachable with the bearer (201)', async () => {
    await post('/scim/v2/Users', SCIM_BEARER, { userName: 'eng@acme.test' });
    const res = await post('/scim/v2/Groups', SCIM_BEARER, {
      displayName: 'Engineers',
      members: [{ value: 'eng@acme.test' }],
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { members: Array<{ value: string }> };
    expect(json.members).toEqual([{ value: 'eng@acme.test' }]);
  });
});

describe('SCIM /scim/v2 routes — 404 when OPENWOP_SCIM_BEARER is unset', () => {
  let s2: http.Server;
  let p2: number;
  beforeAll(async () => {
    delete process.env.OPENWOP_SCIM_BEARER; // SCIM provisioning OFF
    const app: Express = express();
    app.use(express.json());
    app.use(authMiddleware());
    registerScimAuthRoutes(app);
    app.use(errorEnvelopeMiddleware());
    s2 = await new Promise<http.Server>((r) => { const s = app.listen(0, () => r(s)); });
    p2 = (s2.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => s2.close(() => r()));
    process.env.OPENWOP_SCIM_BEARER = SCIM_BEARER; // restore for outer afterAll symmetry
  });

  it('POST /scim/v2/Users → 404 (the surface does not exist unconfigured)', async () => {
    const res = await fetch(`http://127.0.0.1:${p2}/scim/v2/Users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer anything' },
      body: JSON.stringify({ userName: 'x@y.test' }),
      redirect: 'manual',
    });
    expect(res.status).toBe(404);
  });
});
