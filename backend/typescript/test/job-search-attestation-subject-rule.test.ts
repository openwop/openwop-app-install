/**
 * ADR 0544 matrix row 8 — only the SUBJECT may attest their own conduct,
 * verified where the rule can actually be broken.
 *
 * ## Why this file exists separately, and what the first attempt got wrong
 *
 * The obvious route test — log two emails into one tenant, have the second try
 * to issue — is VACUOUS, and it took a measurement to see why. Both sessions
 * resolve to the SAME `User`: `resolveCallerUser` canonicalizes onto one durable
 * user whenever the home tenant is `user:`-prefixed
 * (`features/users/usersGuards.ts:85-93`), because a personal tenant IS one
 * human by definition and the canonicalization exists so that signing in through
 * a second auth channel does not fork them into two people. The comment there
 * says so explicitly: it is "gated on the `user:` prefix so a shared/org tenant
 * never routes here (that would merge distinct humans)".
 *
 * So in a personal workspace the subject rule cannot be violated — there is
 * nobody else — and a test staged there proves nothing while looking thorough.
 * I briefly read that collapse as a defect; it is intentional, and the evidence
 * that settles it is that an unrelated pre-existing route (`POST /grants`)
 * stamps the same `grantedBy` for both sessions.
 *
 * The rule bites in a REAL `ws:` shared workspace with two distinct humans, so
 * that is what this builds — through the production routes only (the ADR 0508
 * precedent), because a shared workspace assembled by hand is exactly the kind
 * of fixture that agrees with whatever the code does.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';
import { createApplyGrant, consumeSubmit } from '../src/host/applyGrant.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The de-facto-owner bypass hands OWNER scopes to any subject with no member
  // row, which would make the refusal below pass AS AN OWNER — vacuously.
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
}, 180_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

let n = 0;

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    for (const sc of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [])) {
      const m = /(__session=[^;]+)/.exec(sc);
      if (m) cookie = m[1]!;
    }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
  };
}

async function signIn(c: ReturnType<typeof client>): Promise<string> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `att-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId as string;
}

describe('ADR 0544 matrix row 8 — inside a REAL shared workspace', () => {
  it('a colleague cannot mint an attestation about a co-worker’s job search', async () => {
    // ── the applicant: a real ws: workspace, entered through the switch route ──
    const owner = client();
    const ownerUserId = await signIn(owner);
    const ws = await owner.post('/v1/host/openwop-app/workspaces', { name: `WS ${n++}` });
    expect(ws.status, JSON.stringify(ws.body)).toBe(201);
    const wsId = ws.body.workspaceId as string;
    expect(wsId, 'a personal tenant would make this test vacuous').toMatch(/^ws:/);
    expect((await owner.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(wsId)}/switch`)).status).toBe(200);

    // The workspace IS an org (`createWorkspace` returns `ws.orgId` as the
    // workspaceId), and `isWorkspaceMember` matches on `tenantId === orgId ===
    // workspaceId`. So the feature routes run against the WORKSPACE's own org —
    // an inner org would leave the colleague unable to switch in at all, which
    // is how the first attempt failed.
    const orgId = wsId;
    await enableTenantOverride('job-search', wsId, 'test');

    // A recorded submission belonging to the OWNER, in the workspace tenant.
    const g = await createApplyGrant({
      tenantId: wsId, orgId, subjectId: ownerUserId, grantedBy: ownerUserId,
      campaignId: 'camp-ws', maxSubmits: 10, maxPrepared: 3, ratePerHour: 4,
      origins: ['boards.example.com'], resumePolicy: 'default',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    await consumeSubmit(wsId, g.grantId, Date.now(), 'deal:ws-1');

    // ── the colleague: a DIFFERENT human, made a real member ──
    const mate = client();
    const mateUserId = await signIn(mate);
    expect(mateUserId).not.toBe(ownerUserId);

    // ADMIN specifically — matrix row 8 says the subject rule holds "never merely
    // org-admin", so the strongest non-owner role is the one worth refusing.
    const added = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, {
      displayName: 'Colleague', subject: mateUserId, roles: ['admin'],
    });
    expect(added.status, `member add failed: ${JSON.stringify(added.body)}`).toBe(201);
    expect((await mate.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(wsId)}/switch`)).status).toBe(200);

    // The premise, asserted rather than assumed: the colleague really is inside
    // the workspace and really can read it. Without this, a 403 below would be
    // indistinguishable from "was never admitted in the first place".
    const readable = await mate.get(`/v1/host/openwop-app/job-search/orgs/${encodeURIComponent(orgId)}/attestations`);
    expect(readable.status, `the colleague must genuinely be inside: ${JSON.stringify(readable.body)}`).toBe(200);

    // ── the rule ──
    const minted = await mate.post(`/v1/host/openwop-app/job-search/orgs/${encodeURIComponent(orgId)}/attestations`, {
      dealId: 'deal:ws-1',
    });
    expect(
      minted.status,
      `a colleague signed a statement about someone else's conduct: ${JSON.stringify(minted.body)}`,
    ).toBe(403);

    // …and nothing was written. A refusal that still minted would be worse than
    // no refusal, because the applicant would never see it.
    const after = await owner.get(`/v1/host/openwop-app/job-search/orgs/${encodeURIComponent(orgId)}/attestations`);
    expect(after.body.attestations ?? []).toHaveLength(0);

    // ── and the applicant themselves is NOT locked out by the same rule ──
    const own = await owner.post(`/v1/host/openwop-app/job-search/orgs/${encodeURIComponent(orgId)}/attestations`, {
      dealId: 'deal:ws-1',
    });
    expect(own.status, `the subject must still be able to attest: ${JSON.stringify(own.body)}`).toBe(201);
  }, 120_000);
});
