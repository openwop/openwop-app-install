/**
 * Analytics feature (ADR 0018) — ROUTE + service harness. Boots the real app and
 * drives: the PUBLIC beacon (records when permissive), the CONSENT gate (ADR 0020 —
 * 202 when analytics not consented, 201 once granted), authed reporting (summary +
 * events, RBAC), toggle-off 404, the well-known advertisement, and a surface/node
 * smoke. Proves the Analytics↔Consent pairing the ADRs mandate.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __resetAnalyticsStore, recordEvent, listEvents } from '../src/features/analytics/analyticsService.js';
import { buildAnalyticsSurface } from '../src/features/analytics/surface.js';

const PORT = 18785;
const BASE = `http://127.0.0.1:${PORT}`;
let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true'; // mint authenticated users (ADR 0026)
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
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
async function ownerWithOrg(): Promise<{ owner: ReturnType<typeof client>; orgId: string }> {
  const owner = client();
  const su = await owner.post('/v1/host/openwop-app/test/login', { email: `an-${Date.now()}-${n++}@acme.test` });
  expect(su.status, JSON.stringify(su.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}
const enable = async (id: string, status: 'on' | 'off'): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status }, 'test'); };

describe('Analytics: beacon + reporting', () => {
  it('is registered + advertises ctx.features.analytics', async () => {
    const { BACKEND_FEATURES } = await import('../src/features/index.js');
    expect(BACKEND_FEATURES.some((f) => f.id === 'analytics')).toBe(true);
    const disco = await pub.get('/.well-known/openwop');
    expect(disco.body.hostExtensions?.featureSurfaces).toContain('host.sample.analytics');
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
});

describe('Analytics: consent gate (ADR 0020 pairing) + toggle gating', () => {
  it('202 when analytics not consented, 201 once granted', async () => {
    const { orgId } = await ownerWithOrg();
    try {
      await enable('consent', 'on'); // now isAllowed enforces; no record + opt-in default ⇒ deny
      const denied = await pub.post(`/v1/host/openwop-app/public-analytics/${orgId}/collect`, { type: 'pageview', sessionKey: 's2' });
      expect(denied.status).toBe(202);
      expect(denied.body.recorded).toBe(false);
      // grant analytics consent for s2, then the beacon records
      await pub.post(`/v1/host/openwop-app/public-consent/${orgId}`, { subjectKey: 's2', categories: { analytics: true } });
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
});
