/**
 * ADR 0473 Phase 5 — the super-admin workflow-proposal auto-approval policy
 * HTTP surface. Drives the real app: super-admin gate on every route (the
 * route-level authz only an HTTP test observes), list/enable/disable round-
 * trip, idempotent delete, and the tenantId validation.
 *
 * Wave 64: the "non-super-admin" used to be an UNAUTHENTICATED request, refused by
 * auth (401) before `requireSuperadmin` ran — so dropping the gate stayed green
 * (8fw5g1-pp-superadmin-get, vacuous). It is now a SIGNED-IN, non-superadmin user
 * (the env-gated test login), refused with exactly 403 `forbidden` by the gate
 * itself, and the refusal wrote nothing. Sabotage-witnessed: the gate on each verb
 * (pp-superadmin-*-r2), the tenantId check (pp-tenant-required), the delete
 * (pp-delete).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';

interface ErrorBody { error?: string; message?: string }

describe('workflow-proposal auto-approval policy routes (sqlite memory app)', () => {
  let server: http.Server;
  let BASE: string;
  const TOKEN = 'dev-token'; // wildcard bearer ⇒ superadmin
  const ADMIN = '/host/openwop-app/workflow-proposals/admin/policies';
  const TENANT = 'org:policy-route-test';
  const AGENT = 'vendor.openwop-app.workflow-author.agents.workflow-architect';
  const DENIED = { error: 'forbidden', message: 'Workflow-proposal auto-approval administration requires a superadmin principal.' };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint a signed-in NON-superadmin (ADR 0026 test seam)
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  /** `auth`: the superadmin bearer, or a session cookie of a signed-in plain user. */
  async function call<T = unknown>(method: string, path: string, auth: { bearer: true } | { cookie: string } = { bearer: true }): Promise<{ status: number; body: T }> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if ('bearer' in auth) headers.authorization = `Bearer ${TOKEN}`;
    else headers.cookie = auth.cookie;
    const res = await fetch(`${BASE}${path}`, { method, headers });
    // The one typed boundary: each call site names the body shape it reads.
    const raw = (await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: raw };
  }

  async function plainUserCookie(): Promise<string> {
    const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `policy-plain-${Date.now()}@acme.test` }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const cookie = getSetCookies(res.headers).map((c) => /(__session=[^;]+)/.exec(c)?.[1]).find(Boolean);
    if (!cookie) throw new Error('test login set no session cookie');
    return cookie;
  }

  it('rejects a signed-in non-super-admin caller on every verb (403 forbidden from the gate, nothing written)', async () => {
    const cookie = await plainUserCookie();
    // The exact gate message below is itself the control that auth ADMITTED the session:
    // an unauthenticated caller is refused 401 before this gate runs.
    for (const [method, path] of [
      ['GET', `${ADMIN}?tenantId=${TENANT}`],
      ['PUT', `${ADMIN}/${TENANT}/${AGENT}`],
      ['DELETE', `${ADMIN}/${TENANT}/${AGENT}`],
    ] as const) {
      const r = await call<ErrorBody>(method, path, { cookie });
      expect(r.status, `${method} ${path}`).toBe(403);
      expect(r.body, `${method} ${path}`).toMatchObject(DENIED);
    }
    // The refused PUT wrote no policy.
    const list = await call<{ items: Array<{ agentProfileId: string }> }>('GET', `${ADMIN}?tenantId=${encodeURIComponent(TENANT)}`);
    expect(list.body.items.some((p) => p.agentProfileId === AGENT)).toBe(false);
  });

  it('GET without tenantId is a 400', async () => {
    const r = await call<ErrorBody>('GET', ADMIN);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'validation_error', message: 'tenantId query parameter is required.' });
  });

  it('enable → list → disable round-trips (idempotent delete)', async () => {
    const put = await call<{ policy: { tenantId: string; agentProfileId: string; createdBy: string } }>('PUT', `${ADMIN}/${TENANT}/${AGENT}`);
    expect(put.status).toBe(200);
    expect(put.body.policy.tenantId).toBe(TENANT);
    expect(put.body.policy.agentProfileId).toBe(AGENT);
    expect(put.body.policy.createdBy).toBeTruthy();

    const list = await call<{ items: Array<{ agentProfileId: string }> }>('GET', `${ADMIN}?tenantId=${encodeURIComponent(TENANT)}`);
    expect(list.status).toBe(200);
    expect(list.body.items.some((p) => p.agentProfileId === AGENT)).toBe(true);

    const del = await call<{ removed: boolean }>('DELETE', `${ADMIN}/${TENANT}/${AGENT}`);
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);

    const delAgain = await call<{ removed: boolean }>('DELETE', `${ADMIN}/${TENANT}/${AGENT}`);
    expect(delAgain.status).toBe(200);
    expect(delAgain.body.removed).toBe(false);

    const after = await call<{ items: unknown[] }>('GET', `${ADMIN}?tenantId=${encodeURIComponent(TENANT)}`);
    expect(after.body.items.length).toBe(0);
  });
});
