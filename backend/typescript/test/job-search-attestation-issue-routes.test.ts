/**
 * ADR 0544 P4 — issuance + preview, asserted at the HTTP boundary.
 *
 * The service-level tests already pin the derivation and the refusals. These
 * exist because the two rules P4 adds are AUTHORIZATION rules, and a
 * service-level test proves nothing about those: it calls the function with an
 * `issuedBy` it chose itself, which is exactly the thing a real caller cannot
 * do. Only a real request establishes that the acting user comes from the
 * session and that a second user cannot mint an attestation about the first.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';
import { createApplyGrant, consumeSubmit } from '../src/host/applyGrant.js';

const BASE_PATH = '/v1/host/openwop-app/job-search';

let server: Server;
let BASE: string;

async function login(email: string, tenantId?: string): Promise<{ cookie: string; orgId: string; tenantId: string; userId: string }> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tenantId ? { email, tenantId } : { email }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`login ${res.status}: ${await res.text()}`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const body = (await res.json()) as { tenantId?: string; user?: { tenantId?: string; userId?: string } };
  void tenantId;
  const orgs = await (await fetch(`${BASE}/v1/host/openwop-app/orgs`, { headers: { cookie } })).json() as { orgs?: Array<{ orgId: string }> };
  const me = await (await fetch(`${BASE}/v1/host/openwop-app/me`, { headers: { cookie } })).json() as { user?: { userId?: string } };
  return {
    cookie,
    orgId: orgs.orgs?.[0]?.orgId ?? '',
    tenantId: tenantId ?? body.tenantId ?? body.user?.tenantId ?? '',
    userId: me.user?.userId ?? body.user?.userId ?? '',
  };
}

const call = (path: string, cookie: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'false';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
}, 180_000);

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

/** A signed-in applicant with the feature on and one recorded submission. */
async function applicantWithSubmission(email: string, dealId: string) {
  const s = await login(email);
  await enableTenantOverride('job-search', s.tenantId, 'test');
  const g = await createApplyGrant({
    tenantId: s.tenantId, orgId: s.orgId, subjectId: s.userId, grantedBy: s.userId,
    campaignId: 'camp-route', maxSubmits: 10, maxPrepared: 3, ratePerHour: 4,
    origins: ['boards.example.com'], resumePolicy: 'default',
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  });
  await consumeSubmit(s.tenantId, g.grantId, Date.now(), dealId);
  return s;
}

describe('ADR 0544 P4 — issuance at the HTTP boundary', () => {
  it('previews the exact claims, then issues, and returns the token ONCE', async () => {
    const s = await applicantWithSubmission('attest-owner@e2e.test', 'deal:route-1');

    const pre = await call(`${BASE_PATH}/orgs/${s.orgId}/applications/deal:route-1/attestation-preview`, s.cookie);
    expect(pre.status).toBe(200);
    const preview = (await pre.json()) as { claims: Array<{ type: string }> };
    expect(preview.claims.length).toBeGreaterThan(0);

    const issued = await call(`${BASE_PATH}/orgs/${s.orgId}/attestations`, s.cookie, {
      method: 'POST', body: JSON.stringify({ dealId: 'deal:route-1' }),
    });
    expect(issued.status).toBe(201);
    const body = (await issued.json()) as { token?: string };
    expect(body.token, 'the raw token is returned exactly once, here').toBeTruthy();

    // …and never again: the list projection has no token and no hash.
    const list = await (await call(`${BASE_PATH}/orgs/${s.orgId}/attestations`, s.cookie)).text();
    expect(list).not.toContain(body.token!);
  });

  it('the route takes NO campaignId — supplying one changes nothing', async () => {
    // The P2 hole was a body field. Sending it now must not be honoured, or the
    // fix is only a convention.
    const s = await applicantWithSubmission('attest-nocampaign@e2e.test', 'deal:route-2');
    const res = await call(`${BASE_PATH}/orgs/${s.orgId}/attestations`, s.cookie, {
      method: 'POST', body: JSON.stringify({ dealId: 'deal:route-2', campaignId: 'camp-somebody-elses' }),
    });
    expect(res.status).toBe(201);
    const { token } = (await res.json()) as { token: string };
    const view = await (await fetch(`${BASE}/v1/host/openwop-app/public-attestations/${token}`)).text();
    expect(view).not.toContain('camp-somebody-elses');
  });

  it('refuses an application this host has no record of sending', async () => {
    const s = await applicantWithSubmission('attest-nosend@e2e.test', 'deal:route-3');
    const res = await call(`${BASE_PATH}/orgs/${s.orgId}/attestations`, s.cookie, {
      method: 'POST', body: JSON.stringify({ dealId: 'deal:invented-by-hand' }),
    });
    expect(res.status).toBe(404);
  });

  it('another TENANT cannot reach the application at all', async () => {
    // NOTE what this does and does not prove. Two sessions in one PERSONAL
    // tenant resolve to the SAME user by design (`resolveCallerUser`
    // canonicalizes a `user:`-prefixed home tenant onto one durable user), so a
    // "colleague" staged here would be the same human and the subject rule would
    // be untestable — vacuous, while looking thorough. This case is therefore
    // about ISOLATION only: a different tenant is scoped out before any lookup.
    //
    // The subject rule itself is verified where it can actually be broken — a
    // real `ws:` workspace with two distinct humans — in
    // `job-search-attestation-subject-rule.test.ts`.
    const owner = await applicantWithSubmission('attest-victim@e2e.test', 'deal:route-4');
    const outsider = await login('attest-outsider@e2e.test');
    await enableTenantOverride('job-search', outsider.tenantId, 'test');

    const res = await call(`${BASE_PATH}/orgs/${owner.orgId}/attestations`, outsider.cookie, {
      method: 'POST', body: JSON.stringify({ dealId: 'deal:route-4' }),
    });
    expect(res.status, 'an outsider must never mint one').toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    // …and the applicant's ledger is untouched.
    const mine = await (await call(`${BASE_PATH}/orgs/${owner.orgId}/attestations`, owner.cookie)).json() as { attestations: unknown[] };
    expect(mine.attestations).toHaveLength(0);
  });

  it('a preview from another tenant carries no claims', async () => {
    const owner = await applicantWithSubmission('attest-victim2@e2e.test', 'deal:route-5');
    const outsider = await login('attest-outsider2@e2e.test');
    await enableTenantOverride('job-search', outsider.tenantId, 'test');
    const res = await call(`${BASE_PATH}/orgs/${owner.orgId}/applications/deal:route-5/attestation-preview`, outsider.cookie);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await res.text(), 'a refusal must not carry the claims it refused').not.toContain('applications-in-window');
  });

  it('is TOGGLE-GATED — off means gone', async () => {
    const s = await login('attest-toggleoff@e2e.test');
    const res = await call(`${BASE_PATH}/orgs/${s.orgId}/attestations`, s.cookie, {
      method: 'POST', body: JSON.stringify({ dealId: 'deal:whatever' }),
    });
    expect([403, 404]).toContain(res.status);
  });
});
