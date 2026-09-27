/**
 * Analytics feature (ADR 0018) — ROUTE + service harness. Boots the real app and
 * drives: the PUBLIC beacon (records when permissive), the CONSENT gate (ADR 0020 —
 * 202 when analytics not consented, 201 once granted), authed reporting (summary +
 * events, RBAC), toggle-off 404, the well-known advertisement, and a surface/node
 * smoke. Proves the Analytics↔Consent pairing the ADRs mandate.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetAnalyticsStore, recordEvent, listEvents, deleteSubjectEvents } from '../src/features/analytics/analyticsService.js';
import { __resetOrgBeaconBudgetForTests } from '../src/features/analytics/routes.js';
import { buildAnalyticsSurface } from '../src/features/analytics/surface.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

let BASE: string;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'analytics']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client(initialCookie = '') {
  let cookie = initialCookie;
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    const sc = typeof h.getSetCookie === 'function' ? h.getSetCookie() : [];
    for (const c of sc) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), del: (p: string) => call('DELETE', p) };
}
const pub = client();
let n = 0;
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const su = await owner.post('/v1/host/openwop-app/test/login', { email: `an-${Date.now()}-${n++}@acme.test` });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId: su.body.user?.tenantId ?? su.body.tenantId ?? '' };
}
const enable = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

describe('Analytics: beacon + reporting', () => {
  it('is registered + advertises ctx.features.analytics', async () => {
    const { BACKEND_FEATURES } = await import('../src/features/index.js');
    expect(BACKEND_FEATURES.some((f) => f.id === 'analytics')).toBe(true);
    const disco = await pub.get('/.well-known/openwop');
    expect(disco.body.hostExtensions?.featureSurfaces).toContain('host.sample.analytics');
  });

  // ANL-15 (grade-code 2026-09-10) — the events response stripped only `tenantId`,
  // so `clickIds` (cross-site ad identifiers), `owx` and `visitorHash` shipped to
  // every workspace:read member, undeclared by the client type and rendered nowhere.
  it('ANL-15: the events response is projected to the DECLARED client shape', async () => {
    const { owner, orgId } = await ownerWithOrg();
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, {
      type: 'pageview', path: '/p', sessionKey: 's-proj', clickIds: { gclid: 'G-SECRET' }, owx: 'tok:not-a-real-token', referrer: 'https://ref.example/x',
    })).status).toBe(201);
    const ev = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/events`);
    expect(ev.status).toBe(200);
    const row = ev.body.events.find((e: { sessionKey?: string }) => e.sessionKey === 's-proj');
    expect(row).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(['eventId', 'orgId', 'path', 'referrer', 'sessionKey', 'ts', 'type']);
    expect(JSON.stringify(ev.body)).not.toContain('G-SECRET');
    expect(JSON.stringify(ev.body)).not.toContain('tok:not-a-real-token');
  });

  // ANL-12 — the query string / fragment is where tokens, emails and ids ride.
  it('ANL-12: path and referrer are stored WITHOUT query string or fragment', async () => {
    const { orgId, tenantId } = await ownerWithOrg();
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, {
      type: 'pageview', path: '/signup?email=alice%40example.com&utm_id=9', sessionKey: 's-q', referrer: 'https://partner.example/a?session=abc#frag',
    })).status).toBe(201);
    const row = (await listEvents(tenantId, orgId, 10)).find((e) => e.sessionKey === 's-q');
    expect(row?.path).toBe('/signup');
    expect(row?.referrer).toBe('https://partner.example/a');
    expect(JSON.stringify(row)).not.toContain('alice');
  });

  // ANL-UX-15 / ANL-UX-10 — `sessions` is a claim only when the beacon keyed the
  // traffic; the distinct totals behind the top-10 cut ride the wire.
  it('ANL-UX-15: `sessions` is OMITTED when no business row carried a sessionKey; totals ride the summary', async () => {
    const { owner, orgId } = await ownerWithOrg();
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', path: '/a' })).status).toBe(201);
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', path: '/b' })).status).toBe(201);
    const s1 = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`);
    expect(s1.body.summary.total).toBe(2);
    expect('sessions' in s1.body.summary, 'un-keyed traffic must not print a confident 0 sessions').toBe(false);
    expect(s1.body.summary.topPathsTotal).toBe(2);
    expect(s1.body.summary.utmSourcesTotal).toBe(0);
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', path: '/c', sessionKey: 'k1' })).status).toBe(201);
    const s2 = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`);
    expect(s2.body.summary.sessions).toBe(1);
  });

  // ANL-7 / ANL-19 — a per-ORG write budget: the beacon is unauthenticated and the
  // public renderer is an assignment oracle, so flooding a SITE is the abuse shape
  // the per-IP limiter cannot see. Behavioural, not a source pin.
  it('ANL-7: the beacon refuses (429 + Retry-After) once the per-org budget is spent; another org is unaffected', async () => {
    const { orgId } = await ownerWithOrg();
    const { orgId: otherOrg } = await ownerWithOrg();
    const prev = process.env.OPENWOP_ANALYTICS_BEACON_ORG_REQS_PER_MIN;
    process.env.OPENWOP_ANALYTICS_BEACON_ORG_REQS_PER_MIN = '2';
    __resetOrgBeaconBudgetForTests();
    try {
      expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', path: '/1' })).status).toBe(201);
      expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', path: '/2' })).status).toBe(201);
      // raw fetch: the test client keeps status+body only, and the header is the point
      const third = await fetch(`${BASE}/v1/host/openwop-app/public-analytics/${orgId}/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'pageview', path: '/3' }) });
      expect(third.status).toBe(429);
      expect(((await third.json()) as { error?: string }).error).toBe('rate_limited');
      expect(third.headers.get('retry-after')).toBe('60');
      expect((await pub.post(`/v1/host/openwop-app/public-analytics/${otherOrg}/collect`, { type: 'pageview', path: '/1' })).status, 'the budget is per ORG').toBe(201);
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_ANALYTICS_BEACON_ORG_REQS_PER_MIN; else process.env.OPENWOP_ANALYTICS_BEACON_ORG_REQS_PER_MIN = prev;
      __resetOrgBeaconBudgetForTests();
    }
  });

  it('public beacon records (consent off ⇒ permissive); reporting aggregates it', async () => {
    const { owner, orgId } = await ownerWithOrg();
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', path: '/home', sessionKey: 's1', utm: { source: 'google' } })).status).toBe(201);
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'conversion', sessionKey: 's1' })).status).toBe(201);

    const sum = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`);
    expect(sum.body.summary.total).toBe(2);
    expect(sum.body.summary.byType).toMatchObject({ pageview: 1, conversion: 1 });
    expect(sum.body.summary.sessions).toBe(1);
    expect(sum.body.summary.topPaths).toContainEqual({ path: '/home', count: 1 });
    expect(sum.body.summary.utmSources).toContainEqual({ source: 'google', count: 1 });
    const evs = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/events`);
    expect(evs.body.events).toHaveLength(2);
  });

  it('aggregates web-vital events into p75 + server-derived rating (ADR 0018 CWV fold-in)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    // LCP samples: [1000,1500,2000,2600] → nearest-rank p75 = ceil(0.75*4)-1 = idx 2 = 2000 → "good" (≤2500).
    for (const value of [1000, 1500, 2000, 2600]) {
      expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'event', name: 'web-vital', sessionKey: 'v1', props: { metric: 'LCP', value } })).status).toBe(201);
    }
    // One CLS sample well over the 0.25 poor threshold.
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'event', name: 'web-vital', sessionKey: 'v1', props: { metric: 'CLS', value: 0.4 } })).status).toBe(201);
    // CWV-1: an UNKNOWN metric name (open beacon → untrusted) must be IGNORED, not
    // aggregated into a junk vitals row; and a spoofed enormous value is CLAMPED.
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'event', name: 'web-vital', sessionKey: 'v1', props: { metric: 'JUNK', value: 5 } })).status).toBe(201);
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'event', name: 'web-vital', sessionKey: 'v1', props: { metric: 'FCP', value: 1e308 } })).status).toBe(201);
    const sum = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`);
    const vitals = sum.body.summary.vitals as { metric: string; p75: number; rating: string; count: number }[];
    expect(vitals).toContainEqual({ metric: 'LCP', p75: 2000, rating: 'good', count: 4 });
    expect(vitals).toContainEqual({ metric: 'CLS', p75: 0.4, rating: 'poor', count: 1 });
    expect(vitals.some((v) => v.metric === 'JUNK')).toBe(false); // unknown metric dropped
    expect(vitals.find((v) => v.metric === 'FCP')?.p75).toBe(900000); // clamped
    // CWV-2: web-vitals are TELEMETRY — they do NOT inflate the business-event tallies.
    expect(sum.body.summary.byType.event).toBe(0);
    expect(sum.body.summary.total).toBe(0);
  });

  // ANLWF-9 / ADR 0651 — the public-beacon refusals that had ZERO backend witness.
  // The rate-limit claim in routes.ts:6-7 is TRUE (the limiter mounts before the
  // routers and `public-analytics` has no rate-limit exemption) but was asserted
  // only in a docblock; the 413 props cap and the unknown-org half of the uniform
  // 404 were tested by nothing; and the consent test asserted the 202, never that
  // the store stayed empty. Each leg below pairs its refusal with a positive so it
  // cannot pass by the endpoint simply being broken.
  it('ANLWF-9: unknown org and analytics-off are the SAME uniform 404 on the beacon', async () => {
    const { orgId } = await ownerWithOrg();
    const base = (o: string) => `/v1/host/openwop-app/public-analytics/${encodeURIComponent(o)}/collect`;
    expect((await pub.post(base(orgId), { type: 'pageview', sessionKey: 'u-1' })).status).toBe(201);   // positive
    const unknown = await pub.post(base('org-does-not-exist'), { type: 'pageview', sessionKey: 'u-2' });
    expect(unknown.status).toBe(404);
    // The unknown-org body must be byte-identical to the analytics-off body — one
    // refusal, no oracle between "no such org" and "org exists, feature off".
    const off = getToggleDefault('analytics')!;
    await saveConfig({ ...off, status: 'off' }, 'test');
    try {
      const disabled = await pub.post(base(orgId), { type: 'pageview', sessionKey: 'u-3' });
      expect(disabled.status).toBe(404);
      expect(JSON.stringify(disabled.body)).toBe(JSON.stringify(unknown.body));
    } finally { await saveConfig({ ...off, status: 'on' }, 'test'); }
  });

  it('ANLWF-9: an oversize props bag is refused with 413, and a bag just under the cap lands', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const base = `/v1/host/openwop-app/public-analytics/${encodeURIComponent(orgId)}/collect`;
    const big = await pub.post(base, { type: 'event', sessionKey: 'p-1', props: { blob: 'x'.repeat(5000) } });
    expect(big.status, JSON.stringify(big.body).slice(0, 160)).toBe(413);
    const fine = await pub.post(base, { type: 'event', sessionKey: 'p-2', props: { note: 'x'.repeat(1000) } });
    expect(fine.status).toBe(201);
    const evs = (await owner.get(`/v1/host/openwop-app/analytics/orgs/${encodeURIComponent(orgId)}/events`)).body.events as Array<{ sessionKey?: string }>;
    expect(evs.some((e) => e.sessionKey === 'p-1'), 'the 413 must not have stored a row').toBe(false);
    expect(evs.some((e) => e.sessionKey === 'p-2')).toBe(true);
  });

  it('ANLWF-9: the beacon path is INSIDE the per-IP limiter (not on any exemption list)', async () => {
    const { __isSseExemptPathForTests } = await import('../src/middleware/rateLimit.js');
    expect(__isSseExemptPathForTests('/v1/host/openwop-app/public-analytics/org-x/collect')).toBe(false);
    // Mount order is the other half of the claim: the limiter is `app.use`d before
    // `registerAllRoutes`. Pinned from source so a reorder cannot pass silently.
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.ts'), 'utf8');
    expect(src.indexOf('app.use(ipRateLimitMiddleware())'), 'limiter must be mounted').toBeGreaterThan(0);
    expect(src.indexOf('app.use(ipRateLimitMiddleware())')).toBeLessThan(src.indexOf('registerAllRoutes('));
  });

  it('drops partial, garbage AND unresolvable experiment stamps — the event still lands (ADR 0236 D1 / ADR 0651 D3)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    // ANLWF-3 / ADR 0651 D3 — this leg used to assert a stamp for a FABRICATED
    // experiment id was persisted verbatim: the forgery, pinned as the contract. A
    // stamp is now RE-DERIVED at ingest and an id nothing owns yields no stamp (the
    // event still lands). The positive leg — a real running experiment, a forged
    // variant in, the DERIVED variant persisted — lives beside the experiment
    // fixtures in `cms-page-experiments.test.ts`.
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 'ex1', experiment: { id: 'pexp:1', variant: 'B' } })).status).toBe(201);
    // partial/garbage stamps → recorded WITHOUT an experiment field
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 'ex2', experiment: { id: 'pexp:1' } })).status).toBe(201);
    expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 'ex3', experiment: 'not-an-object' })).status).toBe(201);
    const evs = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/events`);
    const byKey = new Map((evs.body.events as Array<{ sessionKey?: string; experiment?: unknown }>).map((e) => [e.sessionKey, e.experiment]));
    expect(byKey.has('ex1'), 'the event itself must still land').toBe(true);
    expect(byKey.get('ex1'), 'an unknown experiment id must NOT be stamped').toBeUndefined();
    expect(byKey.get('ex2')).toBeUndefined();
    expect(byKey.get('ex3')).toBeUndefined();
  });
});

describe('Analytics: consent gate (ADR 0020 pairing) + toggle gating', () => {
  it('202 when analytics not consented, 201 once granted', async () => {
    const { orgId, tenantId } = await ownerWithOrg();
    expect(tenantId, 'a blank tenant would make the grant below address a different keyspace').toBeTruthy();
    try {
      await enable('consent', 'on'); // now isAllowed enforces; no record + opt-in default ⇒ deny
      const denied = await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 's2' });
      expect(denied.status).toBe(202);
      expect(denied.body.recorded).toBe(false);
      // grant analytics consent for s2, then the beacon records
      // CONS-2 — the public lane no longer accepts a caller-chosen `subjectKey`
      // (it minted an anonymous forgery vector into the authed keyspace). The
      // beacon's own `sessionKey` is still the consent subject, so the grant is
      // recorded through the in-process service, which is the same ONE writer
      // the public route now calls.
      const { mergeConsentCategories } = await import('../src/features/consent/consentService.js');
      await mergeConsentCategories({ tenantId, subjectKey: 's2', categories: { analytics: true }, source: 'public' });
      expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 's2' })).status).toBe(201);
    } finally {
      await enable('consent', 'off');
    }
  });

  it('toggle off ⇒ beacon + reporting both 404', async () => {
    const { owner, orgId } = await ownerWithOrg();
    try {
      await enable('analytics', 'off');
      expect((await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview' })).status).toBe(404);
      expect((await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary`)).status).toBe(404);
    } finally {
      await enable('analytics', 'on');
    }
  });
});

describe('Analytics: ctx.features.analytics + nodes', () => {
  it('surface summary projects + tenant-isolates; node query runs', async () => {
    await __resetAnalyticsStore();
    await recordEvent({ tenantId: 't1', orgId: 'o1', raw: { type: 'pageview', path: '/p', sessionKey: 'x' } });
    await recordEvent({ tenantId: 't2', orgId: 'o1', raw: { type: 'pageview' } }); // other tenant
    const surf = buildAnalyticsSurface({ tenantId: 't1' });
    const { summary } = (await surf.summary({ orgId: 'o1' })) as { summary: { total: number } };
    expect(summary.total).toBe(1); // tenant-isolated
    const { events } = (await surf.events({ orgId: 'o1' })) as { events: Record<string, unknown>[] };
    expect(events[0].tenantId).toBeUndefined(); // projected out

    const mod = await import('../../../packs/feature.analytics.nodes/index.mjs');
    const ctx = (i: Record<string, unknown>) => ({ features: { analytics: surf }, inputs: i });
    const q = await mod.nodes['feature.analytics.nodes.query'](ctx({ orgId: 'o1' }));
    expect(q.status).toBe('success');
    expect((q.outputs as { summary: { total: number } }).summary.total).toBe(1);

    // ANLWF-2 / ADR 0651 D2 — WF-ANL-1 was closed as an INSTANCE (the two exec-ops
    // chains got their `orgId` binding) and left open as a CLASS: the node still
    // coerced a missing `orgId` to '' (`index.mjs:48`), the surface passed it
    // through the coercing `surfaceStr`, and `summarize` filtered '' to nothing —
    // `status:'success'`, `summary.total: 0`. A fourth chain authored without the
    // binding reproduced the original Blocker with every test green. The repo's
    // non-negotiable is "invalid input is a typed failure, never
    // success-with-empty"; `consent/surface.ts:703-728` is the precedent — refuse
    // at the SURFACE, which the route, the node and the chat tool all traverse.
    // Both reads must refuse; the tenant-isolated positive above is the non-vacuity.
    await expect(mod.nodes['feature.analytics.nodes.query'](ctx({}))).rejects.toMatchObject({ code: 'validation_error' });
    await expect(mod.nodes['feature.analytics.nodes.events'](ctx({}))).rejects.toMatchObject({ code: 'validation_error' });
    await expect(surf.summary({ orgId: '' })).rejects.toMatchObject({ code: 'validation_error', details: { field: 'orgId' } });
  });

  it('consent data-subject delete cascades to analytics events (GDPR subject-erasure)', async () => {
    await __resetAnalyticsStore();
    await recordEvent({ tenantId: 'tErase', orgId: 'o1', raw: { type: 'pageview', sessionKey: 'subjX' } });
    await recordEvent({ tenantId: 'tErase', orgId: 'o1', raw: { type: 'pageview', sessionKey: 'subjY' } });
    expect((await listEvents('tErase', 'o1')).length).toBe(2);
    // consent owns the request; analytics registered a purge handler at module load
    const { deleteSubject } = await import('../src/features/consent/consentService.js');
    const result = await deleteSubject('tErase', 'subjX');
    expect(result.consentRecord).toBe(false); // no consent record — but the cascade still purges
    const remaining = await listEvents('tErase', 'o1');
    expect(remaining.map((e) => e.sessionKey)).toEqual(['subjY']); // subjX's events erased
  });

  // ── ANL-2: the eraser's REACH and the honesty of its outcome ────────────────
  // The pre-existing test above seeds two sessionKey-bearing rows and asserts
  // only the sessionKey match, so it could never see any of the following.

  it('ANL-2: a SESSIONLESS but HASHED row of the same visitor is erased (the transitive hop)', async () => {
    await __resetAnalyticsStore();
    // The row shape the beacon produces routinely: `consent` defaults OFF ⇒
    // permissive ingest ⇒ `sessionKey` absent, `visitorHash` present.
    await recordEvent({ tenantId: 'tHash', orgId: 'o1', raw: { type: 'pageview', sessionKey: 'subjX', path: '/a' }, visitorHash: 'h-subjX' });
    await recordEvent({ tenantId: 'tHash', orgId: 'o1', raw: { type: 'pageview', path: '/b?token=secret', referrer: 'https://ref.example/x', clickIds: { gclid: 'G-1' } }, visitorHash: 'h-subjX' });
    await recordEvent({ tenantId: 'tHash', orgId: 'o1', raw: { type: 'pageview', sessionKey: 'subjY', path: '/c' }, visitorHash: 'h-other' });
    expect((await listEvents('tHash', 'o1')).length).toBe(3);

    const outcome = await deleteSubjectEvents('tHash', 'subjX');
    // FAILS against the pre-ANL-2 eraser: it matched sessionKey only, so the
    // hashed sessionless row (carrying a gclid, a full referrer and a
    // query-bearing path) survived with removed === 1.
    expect(outcome).toEqual({ removed: 2, failed: 0, hashesReached: 1 });
    const left = await listEvents('tHash', 'o1');
    expect(left.map((e) => e.path)).toEqual(['/c']);
    expect(JSON.stringify(left)).not.toContain('G-1');
    expect(JSON.stringify(left)).not.toContain('ref.example');
  });

  it('ANL-2: the visitorHash is itself a usable subject key, and erasure is IDEMPOTENT', async () => {
    await __resetAnalyticsStore();
    await recordEvent({ tenantId: 'tHash2', orgId: 'o1', raw: { type: 'pageview', path: '/x' }, visitorHash: 'h-1' });
    expect(await deleteSubjectEvents('tHash2', 'h-1')).toEqual({ removed: 1, failed: 0, hashesReached: 1 });
    // Invoked once per ADR 0381-resolved key, so a second pass must be a clean
    // no-op — never a failure, never a double count.
    expect(await deleteSubjectEvents('tHash2', 'h-1')).toEqual({ removed: 0, failed: 0, hashesReached: 0 });
    expect(await deleteSubjectEvents('tHash2', '')).toEqual({ removed: 0, failed: 0, hashesReached: 0 });
  });

  it('ANL-2: erasure never crosses a tenant, even on an identical key', async () => {
    await __resetAnalyticsStore();
    await recordEvent({ tenantId: 'tA', orgId: 'o1', raw: { type: 'pageview', sessionKey: 'shared', path: '/a' }, visitorHash: 'h-shared' });
    await recordEvent({ tenantId: 'tB', orgId: 'o1', raw: { type: 'pageview', sessionKey: 'shared', path: '/b' }, visitorHash: 'h-shared' });
    expect((await deleteSubjectEvents('tA', 'shared')).removed).toBe(1);
    expect((await listEvents('tB', 'o1')).map((e) => e.path)).toEqual(['/b']);
  });

  it('ANL-2: a row linked to NO subject identifier is RETAINED — the stated limit, not a silent gap', async () => {
    await __resetAnalyticsStore();
    // The in-tree writer that produces exactly this: commerce writes a
    // `conversion` carrying props.orderId with no sessionKey and no hash.
    await recordEvent({ tenantId: 'tKeep', orgId: 'o1', raw: { type: 'conversion', props: { orderId: 'ord_1' } } });
    expect((await deleteSubjectEvents('tKeep', 'anything')).removed).toBe(0);
    // Retained by design (the crm:suppression precedent — say so rather than
    // implying coverage by silence). The retention purger + tenant teardown are
    // what reclaim it, and the eraser's docblock records that.
    expect((await listEvents('tKeep', 'o1')).length).toBe(1);
  });

  it('ANL-2: a delete that does NOT take is reported as a FAILED erasure, never a green receipt', async () => {
    await __resetAnalyticsStore();
    await recordEvent({ tenantId: 'tFail', orgId: 'o1', raw: { type: 'pageview', sessionKey: 'subjZ' } });
    const spy = vi.spyOn(DurableCollection.prototype, 'delete').mockResolvedValue(false);
    try {
      // The mechanism: a false delete counts against the erasure, not for it.
      expect(await deleteSubjectEvents('tFail', 'subjZ')).toMatchObject({ removed: 0, failed: 1 });
      // …and the wiring: the registered eraser throws, so the ADR 0381 fan-out
      // records a partial erasure instead of `ok`. (Mechanism and wiring tested
      // SEPARATELY — the ADR 0502 lesson.)
      const { deleteSubject } = await import('../src/features/consent/consentService.js');
      const result = await deleteSubject('tFail', 'subjZ');
      expect(result.erasure.failed).toBeGreaterThan(0);
      expect(result.erasure.failedFeatures).toContain('eraseSubjectAnalytics');
    } finally { spy.mockRestore(); }
    // And with the store healthy again the same key erases cleanly.
    expect((await deleteSubjectEvents('tFail', 'subjZ')).removed).toBe(1);
  });
});

/**
 * ANL-UX-2/3/4 R2 (review fold-in) — three "the fix reached one caller" defects.
 *
 * Boots the real app, so `analytics-visitor-identity` is registered and ON —
 * which matters: the measured-zero promotion below is DELIBERATELY gated on that
 * toggle, so a suite that never registered it would exercise the ABSENT branch
 * while looking like it exercised the zero branch.
 *
 * Rows are back-dated through an independent handle on the same namespace,
 * because `recordEvent` stamps `ts` itself and every claim here is about history
 * the current window cannot see.
 */
describe('ANL-UX-2/3/4 R2 — the summary stops fabricating, and starts distinguishing', () => {
  interface SeedRow { eventId: string; tenantId: string; orgId: string; type: string; ts: string; visitorHash?: string }
  const backdated = new DurableCollection<SeedRow>('analytics:event', (e) => e.eventId, undefined, (e) => e.tenantId);
  let bseq = 0;
  const seed = (tenantId: string, orgId: string, tsIso: string, visitorHash?: string): Promise<void> => backdated.put({
    eventId: `evt:r2-${bseq += 1}`, tenantId, orgId, type: 'pageview', ts: tsIso, ...(visitorHash ? { visitorHash } : {}),
  });
  const daysAgoIso = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

  it('ANL-UX-3 R2 — a MEASURED ZERO is emitted as 0; a window the dimension does not span is still absent', async () => {
    await __resetAnalyticsStore();
    const { summarizeForReport } = await import('../src/features/analytics/analyticsService.js');
    // The dimension began 45 days ago, so a 7-day window with no hashed rows is
    // a real measurement of zero — not "the dimension did not exist". Pre-fix
    // `computeSummary` emitted `uniqueVisitors` only when `uniques > 0`, so the
    // two states were indistinguishable on the wire and a 0 -> N tenant got no
    // delta at all.
    await seed('tZero', 'oZ', daysAgoIso(45), 'h-old');
    const zero = await summarizeForReport('tZero', 'oZ', 7);
    expect(zero.summary.uniqueVisitors, 'the dimension was live all window and nobody visited — that is a 0').toBe(0);
    expect(zero.summary.uniqueVisitorsSince).toBe(zero.lifetime.uniqueVisitorsSince);

    // The OTHER polarity on the same code path: a window the dimension does not
    // span is not a period over which zero could have been measured.
    await __resetAnalyticsStore();
    await seed('tLate', 'oL', daysAgoIso(2), 'h-new');
    await seed('tLate', 'oL', daysAgoIso(40));
    const late = await summarizeForReport('tLate', 'oL', 90);
    expect(late.summary.uniqueVisitors, 'the dimension began mid-window — 1, not a zero claim').toBe(1);
    expect(late.prior!.uniqueVisitors, 'the prior window predates the dimension — absent, never 0').toBeUndefined();
  });

  it('ANL-UX-4 R2 — `summarize` cannot produce a window-derived since date at all', async () => {
    await __resetAnalyticsStore();
    const { summarize, summarizeForReport } = await import('../src/features/analytics/analyticsService.js');
    await seed('tFab', 'oF', daysAgoIso(45), 'h-a');
    await seed('tFab', 'oF', daysAgoIso(1), 'h-b');
    // The fabricated value is now unrepresentable at the source, which is what
    // protects the THREE callers that never saw the route's override (the chat
    // tool, the workflow feature surface, the strategy metric sync).
    const windowed = await summarize('tFab', 'oF', daysAgoIso(7));
    expect(windowed.uniqueVisitors).toBe(1);
    expect(windowed.uniqueVisitorsSince, 'a window edge is not a deployment date').toBeUndefined();
    // …and the deployment-scoped date still reaches the report path.
    const report = await summarizeForReport('tFab', 'oF', 7);
    expect(report.summary.uniqueVisitorsSince).toBe(report.lifetime.uniqueVisitorsSince);
    expect(report.summary.uniqueVisitorsSince!.slice(0, 10)).toBe(daysAgoIso(45).slice(0, 10));
  });

  it('ANL-UX-4 R2 — the LLM-facing chat tool reports the deployment date, not the window edge', async () => {
    // The lane the first fix missed entirely: the route was corrected, the tool
    // was not, so a model asking about 7 days was told uniques had been counted
    // since ~8 days ago. Driven through the REAL provider with an acting user —
    // the existing fail-empty assertion could never discriminate this.
    const { owner, orgId } = await ownerWithOrg();
    const me = await owner.get('/v1/host/openwop-app/users/me');
    expect(me.status, JSON.stringify(me.body)).toBe(200);
    const tenantId: string = me.body.user?.tenantId ?? me.body.tenantId;
    const actingUserId: string = me.body.user?.userId ?? me.body.userId;
    expect(Boolean(tenantId && actingUserId), 'the harness must yield a real acting user').toBe(true);

    await seed(tenantId, orgId, daysAgoIso(45), 'h-a');
    await seed(tenantId, orgId, daysAgoIso(1), 'h-b');

    const { registerAnalyticsAgentTools, ANALYTICS_QUERY_TOOL_ID } = await import('../src/features/analytics/agentTools.js');
    const { createAgentToolProvider } = await import('../src/host/agentToolProvider.js');
    registerAnalyticsAgentTools();
    const { executeTool } = createAgentToolProvider({ tenantId, actingUserId });
    const out = await executeTool({ name: ANALYTICS_QUERY_TOOL_ID, input: { orgId, days: 7 } });
    expect(out.isError).toBeFalsy();
    const body = JSON.parse(out.content) as { summary?: { uniqueVisitors?: number; uniqueVisitorsSince?: string } };
    expect(body.summary, 'the tool must have real data here, or the assertion below is vacuous').toBeTruthy();
    expect(body.summary!.uniqueVisitors, 'one hashed day inside the 7-day window').toBe(1);
    expect(
      body.summary!.uniqueVisitorsSince?.slice(0, 10),
      'the model must be told when counting BEGAN, not where its window starts',
    ).toBe(daysAgoIso(45).slice(0, 10));
  });

  it('ANL-UX-2 R2 — `lifetime` is ALWAYS on the wire, so a client can tell "never" from "unknown"', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const res = await owner.get(`/v1/host/openwop-app/analytics/orgs/${orgId}/summary?days=7`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Never recorded ⇒ `firstEventAt` is omitted, but `lifetime` is PRESENT —
    // and it is `lifetime`'s own absence that means "this backend does not know",
    // which is the distinction the page needs to stop claiming "not installed".
    expect(res.body.firstEventAt).toBeUndefined();
    expect(res.body.lifetime, 'a backend that knows must SAY it knows').toBeTruthy();
    expect(res.body.lifetime.firstEventAt).toBeUndefined();
  });
});
