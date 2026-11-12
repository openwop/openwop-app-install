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
 *
 * ADR 1023 D7 (#5453) made the authed publish refuse a funnel whose step pages
 * are unpublished (`step_pages_unpublished`, witnessed in funnels-phase1). This
 * file's re-publish runs while every step page is still published — the entry
 * page is unpublished only AFTER it — so it is asserted to succeed, and the
 * later 404s are caused by what each step changes, not by a funnel left dark.
 *
 * Sabotage witnesses (w103; src/features/funnels/funnelRouting.ts, routes.ts,
 * funnelsService.ts): each routing branch (unknown-step, completion, outcome
 * and utm matching, rule order) reds its unit case; dropping the org, toggle,
 * published-funnel or published-page check, or giving the unknown org its own
 * message, reds the uniform-404 case; dropping the outcome-vocabulary 400, the
 * unknown-from 400 or `complete: true` reds the routed-advance case; dropping the
 * `!vk` emit guard, the utm stamp or the completion outcome reds the events case.
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

interface Res<T> { status: number; body: T }
/** The public step read (`PublicFunnelStep`, the fields this file reads). */
interface StepBody { stepCount: number; step: { stepId: string; pageSlug: string } }
interface ErrorBody { error: string; message: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    // The wire is untyped: each caller names the body shape it then asserts exactly.
    const out = (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T;
    return { status: res.status, body: out };
  };
  return {
    get: <T = unknown>(p: string) => call<T>('GET', p),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
  };
}
const anon = () => client(); // no login — the public surface

async function marketer(): Promise<{ user: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const user = client();
  const login = await user.post<{ user: { tenantId: string } }>('/host/openwop-app/test/login', { email: `fp2-${Date.now()}-${n++}@acme.test` });
  expect(login.status).toBe(201);
  const org = await user.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Funnel Co' });
  expect(org.status).toBe(201);
  // A blank tenant would make the event reads below vacuously empty.
  expect(login.body.user.tenantId).not.toBe('');
  return { user, orgId: org.body.orgId, tenantId: login.body.user.tenantId };
}

const authed = (orgId: string, suffix = ''): string => `/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels${suffix}`;
const pub = (orgId: string, suffix = ''): string => `/host/openwop-app/public/${encodeURIComponent(orgId)}/funnels${suffix}`;

async function publishedPage(user: ReturnType<typeof client>, orgId: string, title: string): Promise<{ pageId: string; slug: string }> {
  const created = await user.post<{ pageId: string; slug: string }>(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title });
  expect(created.status).toBe(201);
  const pub2 = await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${created.body.pageId}/publish`);
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
    // Both rules match: the FIRST authored one wins.
    expect(resolveNextStepIx(steps, 's1', { outcome: 'accepted', utm: { source: 'newsletter' } })).toEqual({ ix: 3 });
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
    const created = await user.post<{ funnel: { funnelId: string } }>(authed(orgId), {
      name: 'Live Path', slug: 'live-path',
      steps: [
        { stepId: 'st-landing', kind: 'landing', pageId: landing.pageId },
        // ADR 0948 P2c — an upsell/downsell's outcome is now the server's (the buyer's
        // recorded decision; adr0948-p2c-money-steps), so the client-outcome rule
        // this leg exercises sits on a `sales` step, where a visitor still says it.
        { stepId: 'st-offer', kind: 'sales', pageId: offer.pageId, routing: [{ when: { outcome: 'declined' }, goto: 'st-thanks' }] },
        { stepId: 'st-extra', kind: 'sales', pageId: offer.pageId },
        { stepId: 'st-thanks', kind: 'thankyou', pageId: thanks.pageId },
      ],
    });
    expect(created.status).toBe(201);
    expect((await user.post(authed(orgId, `/${created.body.funnel.funnelId}/publish`))).status).toBe(200);
    return { user, orgId, tenantId, funnelId: created.body.funnel.funnelId, pages: { landing, offer, thanks } };
  }

  it('entry + deep-link + routed advance (outcome rule honored); complete at the end', async () => {
    const { orgId, pages } = await liveFunnel();
    const v = anon();

    const entry = await v.get<StepBody>(pub(orgId, '/live-path'));
    expect(entry.status).toBe(200);
    expect(entry.body.step.stepId).toBe('st-landing');
    expect(entry.body.step.pageSlug).toBe(pages.landing.slug);
    expect(entry.body.stepCount).toBe(4);

    const deep = await v.get<StepBody>(pub(orgId, '/live-path/steps/1'));
    expect(deep.status).toBe(200);
    expect(deep.body.step).toMatchObject({ stepId: 'st-offer', pageSlug: pages.offer.slug });

    // declined on the offer routes PAST st-extra straight to thanks
    const declined = await v.get<StepBody>(pub(orgId, '/live-path/next?from=st-offer&outcome=declined'));
    expect(declined.status).toBe(200);
    expect(declined.body.step).toMatchObject({ stepId: 'st-thanks', pageSlug: pages.thanks.slug });

    // sequential without an outcome
    const seq = await v.get<StepBody>(pub(orgId, '/live-path/next?from=st-offer'));
    expect(seq.status).toBe(200);
    expect(seq.body.step.stepId).toBe('st-extra');

    const done = await v.get<{ complete?: boolean; step?: unknown }>(pub(orgId, '/live-path/next?from=st-thanks'));
    expect(done.status).toBe(200);
    expect(done.body.complete).toBe(true);
    expect(done.body.step).toBeUndefined();

    // unknown from → 400; bad outcome vocabulary → 400 (typed, not a 404/500)
    const forged = await v.get<ErrorBody>(pub(orgId, '/live-path/next?from=forged'));
    expect(forged.status).toBe(400);
    expect(forged.body).toMatchObject({ error: 'validation_error', message: 'Unknown from step.' });
    const maybe = await v.get<ErrorBody>(pub(orgId, '/live-path/next?from=st-offer&outcome=maybe'));
    expect(maybe.status).toBe(400);
    expect(maybe.body).toMatchObject({ error: 'validation_error', message: 'outcome must be one of: accepted, declined' });
  });

  it('uniform 404s: unknown org, unpublished funnel, toggle off, unpublished step page', async () => {
    const { user, orgId, funnelId, pages } = await liveFunnel();
    const v = anon();

    // Every refusal below must be byte-identical to this one: no existence leak.
    const unknownOrg = await v.get<ErrorBody>(pub('org-does-not-exist', '/live-path'));
    expect(unknownOrg.status).toBe(404);
    expect(unknownOrg.body).toMatchObject({ error: 'not_found', message: 'Funnel not found.' });
    const uniform404 = async (path: string): Promise<void> => {
      const r = await v.get<ErrorBody>(pub(orgId, path));
      expect(r.status).toBe(404);
      expect(r.body).toEqual(unknownOrg.body);
    };

    // unpublish the funnel → gone
    expect((await user.post(authed(orgId, `/${funnelId}/unpublish`))).status).toBe(200);
    await uniform404('/live-path');
    // Re-publish while all three step pages are still published (ADR 1023 D7 allows it).
    expect((await user.post(authed(orgId, `/${funnelId}/publish`))).status).toBe(200);
    expect((await v.get(pub(orgId, '/live-path'))).status).toBe(200);

    // unpublish the ENTRY page → the step is unavailable (tolerate-on-read)
    const unpub = await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${pages.landing.pageId}/unpublish`);
    expect(unpub.status).toBe(200);
    await uniform404('/live-path');
    // the offer step (still published) stays reachable by deep-link
    const offer = await v.get<StepBody>(pub(orgId, '/live-path/steps/1'));
    expect(offer.status).toBe(200);
    expect(offer.body.step.stepId).toBe('st-offer');
    expect((await user.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${pages.landing.pageId}/publish`)).status).toBe(200);
    // Served again, so the toggle-off 404 below is the toggle's, not a leftover.
    expect((await v.get(pub(orgId, '/live-path'))).status).toBe(200);

    // toggle off → uniform 404 on the public surface
    const d = getToggleDefault('funnels');
    await saveConfig({ ...d!, status: 'off' }, 'test');
    try {
      await uniform404('/live-path');
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
    // Exactly: the entry view, the landing completion, and the routed view of the offer.
    expect(events.map((e) => `${e.eventType}:${String(e.payload.stepId)}`).sort()).toEqual([
      'funnel.step_completed:st-landing', 'funnel.step_viewed:st-landing', 'funnel.step_viewed:st-offer',
    ]);
    const find = (type: string, stepId: string) => events.find((e) => e.eventType === type && e.payload.stepId === stepId)?.payload;
    // the entry view carried the utm; the /next view legitimately did not
    expect(find('funnel.step_viewed', 'st-landing')).toMatchObject({ visitor: vk, funnelSlug: 'live-path', utm: { source: 'newsletter' } });
    const offerView = find('funnel.step_viewed', 'st-offer');
    expect(offerView).toMatchObject({ visitor: vk, funnelSlug: 'live-path' });
    expect(offerView).not.toHaveProperty('utm');
    expect(find('funnel.step_completed', 'st-landing')).toMatchObject({ visitor: vk, funnelSlug: 'live-path', outcome: 'accepted' });
  });
});
