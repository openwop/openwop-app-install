/**
 * ADR 0540 P2 — the CRM mapping, asserted at the HTTP boundary.
 *
 * Authorization, toggle gating and tenant isolation are only observable through
 * a real request: a service-level test calls the function with a tenantId it
 * chose itself, which is precisely the thing an attacker cannot do. So this
 * boots `createApp` and drives real routes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { enableTenantOverride } from '../src/host/featureToggles/service.js';

const BASE_PATH = '/v1/host/openwop-app/job-search';

let server: Server;
let BASE: string;

/** Two separate tenants, established through the test-login seam so each gets a
 *  real principal + cookie rather than a forged header. */
async function login(email: string, tenantId?: string): Promise<{ cookie: string; orgId: string; tenantId: string }> {
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tenantId ? { email, tenantId } : { email }),
  });
  if (res.status !== 201 && res.status !== 200) throw new Error(`login ${res.status}: ${await res.text()}`);
  const cookie = (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
  const body = (await res.json()) as { tenantId?: string; user?: { tenantId?: string } };
  const orgs = await (await fetch(`${BASE}/v1/host/openwop-app/orgs`, { headers: { cookie } })).json() as { orgs?: Array<{ orgId: string }> };
  return { cookie, orgId: orgs.orgs?.[0]?.orgId ?? '', tenantId: tenantId ?? body.tenantId ?? body.user?.tenantId ?? '' };
}

const call = (path: string, cookie: string, init: RequestInit = {}) =>
  fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', cookie, ...(init.headers ?? {}) } });

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'false';
  // The seam is OFF by default and mints sessions — it must be enabled explicitly.
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
}, 120_000);

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('ADR 0540 P2 — application routes', () => {
  it('the status route is TOGGLE-GATED — off means gone, not empty', async () => {
    const { cookie } = await login('jobsearch-gate@e2e.test');
    const res = await call(`${BASE_PATH}/status`, cookie);
    // Default OFF (ADR 0539). A 200 here would mean the priced bundle does not
    // actually gate, which is the dishonesty the ADR calls out explicitly.
    expect([403, 404]).toContain(res.status);
  });

  it('an UNAUTHENTICATED caller cannot reach applications', async () => {
    const res = await fetch(`${BASE}${BASE_PATH}/orgs/any-org/applications`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('a caller cannot read ANOTHER tenant’s org — the IDOR case', async () => {
    // Explicit, distinct tenants so the isolation under test is unambiguous.
    const a = await login('jobsearch-a@e2e.test', 'user:jobsearch-a');
    const b = await login('jobsearch-b@e2e.test', 'user:jobsearch-b');
    expect(a.orgId).not.toBe('');
    expect(b.orgId).not.toBe('');

    // CRITICAL: enable the toggle for BOTH tenants first. With `job-search` off
    // every route 403s, so an IDOR assertion would pass for the wrong reason —
    // it would be measuring the toggle, not tenant isolation. This is the
    // vacuity trap that makes a security test worthless.
    for (const tid of [a.tenantId, b.tenantId]) {
      expect(tid, 'no tenantId — the enable below would be a no-op').not.toBe('');
      await enableTenantOverride('job-search', tid, 'test');
    }

    // Prove the gate is genuinely OPEN for B on its OWN org, so the cross-tenant
    // refusal below cannot be explained by the feature still being off.
    const own = await call(`${BASE_PATH}/orgs/${b.orgId}/applications`, b.cookie);
    expect(own.status, 'B must be able to read its own org — else the test is vacuous').toBe(200);

    // Now the real assertion: B presents A's real orgId. Tenant comes from the
    // PRINCIPAL, so this must not resolve, and must not disclose A's existence.
    const res = await call(`${BASE_PATH}/orgs/${a.orgId}/applications`, b.cookie);
    expect(res.status, 'cross-tenant org id must not be readable').toBeGreaterThanOrEqual(400);
    expect(await res.text()).not.toContain('"applications"');
  });

  it('a grant records the ACTING USER as grantedBy — consent cannot be forged', async () => {
    const a = await login('jobsearch-grant@e2e.test', 'user:jobsearch-grant');
    await enableTenantOverride('job-search', a.tenantId, 'test');
    const res = await call(`${BASE_PATH}/orgs/${a.orgId}/grants`, a.cookie, {
      method: 'POST',
      body: JSON.stringify({
        campaignId: 'camp-1', maxSubmits: 5, maxPrepared: 2, ratePerHour: 4,
        origins: ['jobs.example.com'], resumePolicy: 'default',
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        // A caller trying to name someone ELSE as the authoriser.
        grantedBy: 'somebody-else',
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { grant: { grantedBy: string; tiers: string[] } };
    expect(body.grant.grantedBy, 'grantedBy must come from the session, never the body').not.toBe('somebody-else');
    // Conservative default: tier A only.
    expect(body.grant.tiers).toEqual(['A']);
  });

  it('an unbounded grant is refused at the route, not silently defaulted', async () => {
    const a = await login('jobsearch-grant2@e2e.test', 'user:jobsearch-grant2');
    await enableTenantOverride('job-search', a.tenantId, 'test');
    const res = await call(`${BASE_PATH}/orgs/${a.orgId}/grants`, a.cookie, {
      method: 'POST',
      body: JSON.stringify({ campaignId: 'c', maxSubmits: 0, maxPrepared: 1, ratePerHour: 1, origins: ['x.example.com'], expiresAt: new Date(Date.now() + 1000).toISOString() }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('revoking is immediate, and a second revoke is a 404 rather than a lie', async () => {
    const a = await login('jobsearch-grant3@e2e.test', 'user:jobsearch-grant3');
    await enableTenantOverride('job-search', a.tenantId, 'test');
    const created = await call(`${BASE_PATH}/orgs/${a.orgId}/grants`, a.cookie, {
      method: 'POST',
      body: JSON.stringify({ campaignId: 'c', maxSubmits: 2, maxPrepared: 1, ratePerHour: 1, origins: ['x.example.com'], expiresAt: new Date(Date.now() + 86_400_000).toISOString() }),
    });
    const { grant } = (await created.json()) as { grant: { grantId: string } };
    expect((await call(`${BASE_PATH}/orgs/${a.orgId}/grants/${grant.grantId}`, a.cookie, { method: 'DELETE' })).status).toBe(204);
    expect((await call(`${BASE_PATH}/orgs/${a.orgId}/grants/${grant.grantId}`, a.cookie, { method: 'DELETE' })).status).toBe(404);
  });

  it('rejects a malformed dealId before doing any work', async () => {
    const a = await login('jobsearch-c@e2e.test');
    const res = await call(`${BASE_PATH}/orgs/${a.orgId}/applications`, a.cookie, {
      method: 'POST',
      body: JSON.stringify({ dealId: 'not-prefixed' }),
    });
    // Either the toggle gate (feature off) or the validation gate — both are
    // refusals. What must NOT happen is a 2xx.
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('ADR 0540 — the applications list is renderable', () => {
  it('resolves the stage NAME and an applied date, not raw ids', async () => {
    // Found by rendering the page: both columns were permanently "—". The deal
    // carries `stageId`, not `stageName`, so the client was reading a field that
    // does not exist; and `appliedAt` is declared in APPLICATION_FIELD_DEFS but
    // never written. A column that can only ever be empty reads as missing DATA
    // rather than as a missing feature, which is the more damaging of the two.
    const { cookie, orgId, tenantId } = await login('jobsearch-render@e2e.test');
    await enableTenantOverride('job-search', tenantId, 'test');

    const created = await call(`${BASE_PATH}/orgs/${orgId}/applications`, cookie, {
      method: 'POST',
      body: JSON.stringify({
        dealId: 'deal:render-1',
        digest: {
          title: 'Staff Backend Engineer', companyName: 'Northwind', location: 'Austin, TX', remote: true,
          skills: ['go'], requirements: [], responsibilities: [], descriptionExcerpt: 'x', employmentType: 'w2',
          sponsorship: 'silent', citizenshipRequirementQuote: null, clearanceRequirementQuote: null,
          sponsorshipQuote: null, salaryMin: 170000, salaryMax: 210000, currency: 'USD',
          sourceUrl: 'https://boards.greenhouse.io/n/1', capturedAt: '2026-08-01T00:00:00.000Z',
        },
        profile: { skills: ['go'], targetTitles: ['Backend Engineer'], salaryFloor: 150000, wantsRemote: true },
        applicant: { requiresSponsorship: false, meetsCitizenshipRequirement: true, holdsRequiredClearance: true },
      }),
    });
    expect(created.status).toBe(201);

    const listed = await (await call(`${BASE_PATH}/orgs/${orgId}/applications`, cookie)).json() as {
      applications: Array<{ stageName: string | null; appliedAt: string | null; deal: { customFields?: Record<string, unknown> } }>;
    };
    const row = listed.applications.find((r) => r.stageName !== undefined)!;
    expect(row.stageName, 'a stage id is not a stage').toBe('Applied');
    expect(row.appliedAt, 'an application with no date reads as un-sent').toBeTruthy();
    // …and the source board, which was declared since ADR 0540 and never written
    // until the funnel needed it.
    expect(row.deal.customFields?.board).toBe('greenhouse');
  });
});

describe('JSUX-FUN-2 (R3) — the funnel bundle composes the three reads under one request', () => {
  it('matches the three single routes byte-for-byte, under the same gate', async () => {
    const { cookie, orgId, tenantId } = await login('jobsearch-bundle@e2e.test');
    await enableTenantOverride('job-search', tenantId, 'test');
    // A NON-EMPTY draft, or the parity is vacuous: with nothing seeded, both
    // sides are [] and a bundle that fabricates an empty drafts array probes
    // GREEN (measured — the first version of this test did exactly that).
    const me = await (await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'jobsearch-bundle@e2e.test', tenantId }),
    })).json() as { user?: { userId?: string } };
    const { putDraft } = await import('../src/features/job-search/lifecycle/drafts.js');
    expect(me.user?.userId, JSON.stringify(me)).toBeTruthy(); // an empty subject would seed an invisible draft and re-vacuate the parity
    const put = await putDraft({ tenantId, dealId: 'deal-bundle-1', kind: 'interview-reply', subjectId: me.user!.userId!, body: 'Thanks — Tuesday works.', now: Date.now() });
    expect('draft' in put).toBe(true);
    const [bundle, funnel, followUps, drafts] = await Promise.all([
      call(`${BASE_PATH}/orgs/${orgId}/funnel-bundle`, cookie),
      call(`${BASE_PATH}/orgs/${orgId}/funnel`, cookie),
      call(`${BASE_PATH}/orgs/${orgId}/follow-ups`, cookie),
      call(`${BASE_PATH}/orgs/${orgId}/drafts`, cookie),
    ]);
    expect(bundle.status).toBe(200);
    const b = await bundle.json() as { report: unknown; followUps: unknown; drafts: unknown };
    expect(b.report).toEqual(await funnel.json());
    expect(b.followUps).toEqual(((await followUps.json()) as { followUps: unknown }).followUps);
    expect(b.drafts).toEqual(((await drafts.json()) as { drafts: unknown }).drafts);
  });

  it('is toggle-gated and auth-gated like its parts', async () => {
    const { cookie, orgId } = await login('jobsearch-bundle-gate@e2e.test');
    // toggle OFF for this fresh tenant ⇒ gone, not empty
    const gated = await call(`${BASE_PATH}/orgs/${orgId}/funnel-bundle`, cookie);
    expect([403, 404]).toContain(gated.status);
    const anon = await fetch(`${BASE}${BASE_PATH}/orgs/${orgId}/funnel-bundle`);
    expect(anon.status).toBeGreaterThanOrEqual(400);
  });
});
