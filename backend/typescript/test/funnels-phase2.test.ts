/**
 * Funnels Phase 2 (ADR 0294 / Funnel A) — public serving + routing + step events:
 *  - routing purity: first-match rules (outcome/utm), sequential fallback,
 *    complete past the end, unknown-from error (unit, no HTTP);
 *  - public entry/step/next reads: published-funnel-only + published-page-only
 *    (an unpublished step page 404s the STEP — tolerate-on-read), toggle-off
 *    404s, unknown org 404s — all uniform, no existence leak;
 *  - routed advance honors outcome rules end-to-end over HTTP;
 *  - step events land on the CDP spine ONLY with a consented visitor key
 *    (vk + analytics consent), and never for anonymous reads.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { resolveNextStepIx } from '../src/features/funnels/funnelRouting.js';

let BASE: string; let server: http.Server; let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  // NOTE: 'consent' stays OFF ⇒ isAllowed is permissive (its documented
  // honest-opt-in posture) — the event test asserts the vk-gate, and a
  // separate assertion covers the no-vk anonymous path.
  for (const id of ['users', 'funnels', 'cdp']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
const anon = () => client(); // no login — the public surface

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const user = client();
  const login = await user.post('/v1/host/openwop-app/test/login', { email: `fp2-${Date.now()}-${n++}@acme.test` });
  const org = await user.post('/v1/host/openwop-app/orgs', { name: 'Funnel Co' });
  return { user, orgId: org.body.orgId, tenantId: login.body.user?.tenantId ?? '' };
}

const authed = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels${suffix}`;
const pub = (orgId: string, suffix = ''): string => `/v1/host/openwop-app/public/${encodeURIComponent(orgId)}/funnels${suffix}`;

async function publishedPage(user: ReturnType<typeof client>, orgId: string, title: string): Promise<{ pageId: string; slug: string }> {
  const created = await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title });
  expect(created.status).toBe(201);
  const pub2 = await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${created.body.pageId}/publish`);
  expect(pub2.status).toBe(200);
  return { pageId: created.body.pageId, slug: created.body.slug };
}

describe('funnelRouting — pure evaluation', () => {
  const steps = [
    { stepId: 's0' },
    { stepId: 's1', routing: [
      { when: { outcome: 'accepted' as const }, goto: 's3' },
      { when: { utm: { key: 'source', value: 'newsletter' } }, goto: 's0' },
    ] },
    { stepId: 's2' },
    { stepId: 's3' },
  ];
  it('sequential fallback and completion', () => {
    expect(resolveNextStepIx(steps, 's0', {})).toEqual({ ix: 1 });
    expect(resolveNextStepIx(steps, 's3', {})).toEqual({ complete: true });
  });
  it('first-match rules: outcome, then utm, else sequential', () => {
    expect(resolveNextStepIx(steps, 's1', { outcome: 'accepted' })).toEqual({ ix: 3 });
    expect(resolveNextStepIx(steps, 's1', { utm: { source: 'newsletter' } })).toEqual({ ix: 0 });
    expect(resolveNextStepIx(steps, 's1', { outcome: 'declined' })).toEqual({ ix: 2 });
  });
  it('unknown from errors (never silently restarts)', () => {
    expect(resolveNextStepIx(steps, 'nope', {})).toEqual({ error: 'unknown_step' });
  });
});

describe('funnels Phase 2 — public serving over HTTP', () => {
  async function liveFunnel() {
    const { user, orgId, tenantId } = await marketer();
    const landing = await publishedPage(user, orgId, 'Landing P2');
    const offer = await publishedPage(user, orgId, 'Offer P2');
    const thanks = await publishedPage(user, orgId, 'Thanks P2');
    const created = await user.post(authed(orgId), {
      name: 'Live Path', slug: 'live-path',
      steps: [
        { stepId: 'st-landing', kind: 'landing', pageId: landing.pageId },
        { stepId: 'st-offer', kind: 'upsell', pageId: offer.pageId, routing: [{ when: { outcome: 'declined' }, goto: 'st-thanks' }] },
        { stepId: 'st-extra', kind: 'sales', pageId: offer.pageId },
        { stepId: 'st-thanks', kind: 'thankyou', pageId: thanks.pageId },
      ],
    });
    expect(created.status).toBe(201);
    expect((await user.post(authed(orgId, `/${created.body.funnel.funnelId}/publish`))).status).toBe(200);
    return { user, orgId, tenantId, funnelId: created.body.funnel.funnelId, pages: { landing, offer, thanks } };
  }

  it('entry + deep-link + routed advance (outcome rule honored); complete at the end', async () => {
    const { orgId } = await liveFunnel();
    const v = anon();

    const entry = await v.get(pub(orgId, '/live-path'));
    expect(entry.status).toBe(200);
    expect(entry.body.step.stepId).toBe('st-landing');
    expect(entry.body.step.pageSlug).toBeTruthy();
    expect(entry.body.stepCount).toBe(4);

    const deep = await v.get(pub(orgId, '/live-path/steps/1'));
    expect(deep.body.step.stepId).toBe('st-offer');

    // declined on the offer routes PAST st-extra straight to thanks
    const declined = await v.get(pub(orgId, '/live-path/next?from=st-offer&outcome=declined'));
    expect(declined.status).toBe(200);
    expect(declined.body.step.stepId).toBe('st-thanks');

    // sequential without an outcome
    const seq = await v.get(pub(orgId, '/live-path/next?from=st-offer'));
    expect(seq.body.step.stepId).toBe('st-extra');

    const done = await v.get(pub(orgId, '/live-path/next?from=st-thanks'));
    expect(done.body.complete).toBe(true);

    // unknown from → 400; bad outcome vocabulary → 400
    expect((await v.get(pub(orgId, '/live-path/next?from=forged'))).status).toBe(400);
    expect((await v.get(pub(orgId, '/live-path/next?from=st-offer&outcome=maybe'))).status).toBe(400);
  });

  it('uniform 404s: unknown org, unpublished funnel, toggle off, unpublished step page', async () => {
    const { user, orgId, funnelId, pages } = await liveFunnel();
    const v = anon();

    expect((await v.get(pub('org-does-not-exist', '/live-path'))).status).toBe(404);

    // unpublish the funnel → gone
    await user.post(authed(orgId, `/${funnelId}/unpublish`));
    expect((await v.get(pub(orgId, '/live-path'))).status).toBe(404);
    await user.post(authed(orgId, `/${funnelId}/publish`));

    // unpublish the ENTRY page → the step is unavailable (tolerate-on-read)
    const unpub = await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${pages.landing.pageId}/unpublish`);
    expect(unpub.status).toBe(200);
    expect((await v.get(pub(orgId, '/live-path'))).status).toBe(404);
    // the offer step (still published) stays reachable by deep-link
    expect((await v.get(pub(orgId, '/live-path/steps/1'))).status).toBe(200);
    await user.post(`/v1/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${pages.landing.pageId}/publish`);

    // toggle off → uniform 404 on the public surface
    const d = getToggleDefault('funnels');
    await saveConfig({ ...d!, status: 'off' }, 'test');
    try {
      expect((await v.get(pub(orgId, '/live-path'))).status).toBe(404);
    } finally {
      await saveConfig({ ...d!, status: 'on' }, 'test');
    }
  });

  it('step events: a vk-carrying visitor lands funnel.step_* on the CDP spine; anonymous emits nothing', async () => {
    const { tenantId, orgId } = await liveFunnel();
    const v = anon();
    const vk = `vis-${Date.now()}`;
    const { listCollectedEvents } = await import('../src/features/cdp/collectService.js');

    // anonymous view (no vk) — must not emit
    await v.get(pub(orgId, '/live-path'));
    const before = (await listCollectedEvents(tenantId, 200)).filter((e) => e.eventType.startsWith('funnel.'));
    expect(before).toHaveLength(0);

    // vk-carrying view + routed advance (consent toggle off ⇒ permissive gate)
    expect((await v.get(pub(orgId, `/live-path?vk=${vk}&utm_source=newsletter`))).status).toBe(200);
    expect((await v.get(pub(orgId, `/live-path/next?from=st-landing&vk=${vk}&outcome=accepted`))).status).toBe(200);

    const events = (await listCollectedEvents(tenantId, 200)).filter((e) => e.eventType.startsWith('funnel.'));
    const types = events.map((e) => e.eventType).sort();
    expect(types).toContain('funnel.step_viewed');
    expect(types).toContain('funnel.step_completed');
    const viewedPayloads = events.filter((e) => e.eventType === 'funnel.step_viewed')
      .map((e) => e.payload as { visitor?: string; funnelSlug?: string; utm?: { source?: string } });
    expect(viewedPayloads.every((p) => p.visitor === vk && p.funnelSlug === 'live-path')).toBe(true);
    // the entry view carried the utm; the /next view legitimately did not
    expect(viewedPayloads.some((p) => p.utm?.source === 'newsletter')).toBe(true);
    const completed = events.find((e) => e.eventType === 'funnel.step_completed');
    expect((completed?.payload as { outcome?: string }).outcome).toBe('accepted');
  });
});
