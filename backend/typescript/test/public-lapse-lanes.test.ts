/**
 * ADR 0820 §7 (G9) — the owner-lapse policy, lane by lane, over real HTTP.
 *
 * For every public runtime the gating audit named, four scenarios:
 *   - knob UNSET + owner refused by their plan ⇒ serves exactly as today (the
 *     regression pin: the policy ships off);
 *   - knob set + owner lapsed WITHIN grace ⇒ serves;
 *   - knob set + owner lapsed BEYOND grace ⇒ the lane's own "unavailable" shape;
 *   - knob set + entitlement FAULT ⇒ serves (a billing outage darkens nothing).
 * Plus the POSITIVE control (knob set + entitled ⇒ serves), and the storefront's
 * new kill switch (commerce toggle OFF ⇒ 404; it served before this change).
 *
 * The plan verdict is driven through the host entitlement seam (registered AFTER
 * boot, so it replaces billing's for the tenant-scoped check), refusing ONLY the
 * feature under test, so one lane's lapse cannot leak into another's result. The
 * grace start comes from a registered billing source (1 day ago = within grace,
 * 30 days ago = beyond a 14-day knob).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { registerTenantEntitlementCheck } from '../src/host/entitlementSeam.js';
import { PUBLIC_LAPSE_GRACE_ENV, __resetPublicLapse, registerEntitlementEndedAtSource } from '../src/host/publicLapse.js';
import { addDomain, verifyDomain, invalidateHostCache } from '../src/host/customDomains.js';
import { upsertPixel } from '../src/features/campaign-connectors/pixelService.js';
import { upsertMarketingEvent, bindFormToEvent } from '../src/features/webinars/entities/marketingEvent.js';
import { computeEventCounts } from '../src/features/webinars/webinarSyncService.js';
import { runSubmissionSinks } from '../src/features/forms/submissionSinks.js';
import type { FormDef, Submission } from '../src/features/forms/formsService.js';
import { OpenwopError } from '../src/types.js';

const DAY = 86_400_000;
let BASE: string;
let PORT = 0;
let server: http.Server;

/** The plan verdict for the tenant-scoped seam: refuse only these feature ids. */
const refused = new Set<string>();
let fault = false;

interface Res { status: number; body: any }
function client(withCookie = true) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(withCookie && cookie ? { cookie } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (withCookie) for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* text body (llms.txt) */ }
    return { status: res.status, body: parsed };
  };
  return { get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h), post: (p: string, b?: unknown) => call('POST', p, b) };
}
function withHost(path: string, host: string): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path, headers: { host } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let body: unknown = data; try { body = JSON.parse(data); } catch { /* text */ } resolve({ status: res.statusCode ?? 0, body }); });
    });
    req.on('error', reject);
    req.end();
  });
}

const enable = async (id: string, status: 'on' | 'off' = 'on'): Promise<void> => {
  const d = getToggleDefault(id);
  if (d) await saveConfig({ ...d, status }, 'test'); // ids with no default (retired/always-on) are on
};

let tenantId = '';
let orgId = '';
let owner: ReturnType<typeof client>;
const anon = (): ReturnType<typeof client> => client(false);

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  delete process.env[PUBLIC_LAPSE_GRACE_ENV];
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${PORT}`; res(); }); });
  // Last wins: replaces billing's tenant check registered at boot.
  registerTenantEntitlementCheck(async (_tenantId, featureId) => {
    if (fault) throw new Error('entitlement store unreachable');
    if (refused.has(featureId)) throw new OpenwopError('forbidden', 'Your plan (free) does not include this feature.', 403, { feature: featureId });
  });
  for (const id of ['users', 'crm', 'cdp', 'commerce', 'commerce-ucp', 'funnels', 'campaign-connectors', 'dealers', 'docs', 'podcasts', 'webinars', 'custom-domains']) await enable(id);

  owner = client();
  const login = await owner.post('/host/openwop-app/test/login', { email: `lapse-${Date.now()}@acme.test` });
  tenantId = login.body.user?.tenantId ?? '';
  orgId = (await owner.post('/host/openwop-app/orgs', { name: 'Lapse Co' })).body.orgId;
  expect(tenantId).not.toBe('');
  expect(orgId).toBeTruthy();
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
  delete process.env.OPENWOP_COMMERCE_OFFSESSION_ENABLED;
  delete process.env[PUBLIC_LAPSE_GRACE_ENV];
  await new Promise<void>((res) => server.close(() => res()));
});

type Scenario = 'unset' | 'entitled' | 'grace' | 'beyond' | 'fault';
async function arrange(featureId: string, s: Scenario): Promise<void> {
  await __resetPublicLapse();
  refused.clear();
  fault = false;
  if (s === 'unset') { delete process.env[PUBLIC_LAPSE_GRACE_ENV]; refused.add(featureId); return; }
  process.env[PUBLIC_LAPSE_GRACE_ENV] = '14';
  if (s === 'entitled') return;
  if (s === 'fault') { fault = true; return; }
  refused.add(featureId);
  const endedAt = new Date(Date.now() - (s === 'grace' ? 1 : 30) * DAY).toISOString();
  registerEntitlementEndedAtSource(async () => endedAt);
}

type Outcome = 'served' | 'unavailable';
interface Lane { name: string; featureId: string; probe: () => Promise<Outcome> }

const store = (sfx: string): string => `/host/openwop-app/public-store/${encodeURIComponent(orgId)}${sfx}`;
const storeLapsed = (r: Res): Outcome => (r.status === 404 && r.body?.message === 'Store not found.' ? 'unavailable' : 'served');

let funnelSlug = '';
let partnerToken = '';
let webinarSeq = 0;
const PROVIDER_EVENT = 'lapse-777';

const LANES: Lane[] = [
  { name: 'storefront: product list', featureId: 'commerce', probe: async () => storeLapsed(await anon().get(store('/products'))) },
  { name: 'storefront: product detail', featureId: 'commerce', probe: async () => storeLapsed(await anon().get(store('/products/no-such-product'))) },
  { name: 'storefront: checkout', featureId: 'commerce', probe: async () => storeLapsed(await anon().post(store('/checkout'), {})) },
  { name: 'storefront: one-click', featureId: 'commerce', probe: async () => storeLapsed(await anon().post(store('/orders/no-such-order/one-click'), { productId: 'p' })) },
  { name: 'storefront: quote accept', featureId: 'commerce', probe: async () => storeLapsed(await anon().post(store('/quotes/no-such-quote/accept'), {})) },
  {
    name: 'UCP merchant discovery', featureId: 'commerce-ucp',
    probe: async () => ((await anon().get(`/host/openwop-app/commerce/ucp/orgs/${encodeURIComponent(orgId)}/.well-known/ucp`)).status === 200 ? 'served' : 'unavailable'),
  },
  {
    name: 'funnel runtime', featureId: 'funnels',
    probe: async () => ((await anon().get(`/host/openwop-app/public/${encodeURIComponent(orgId)}/funnels/${funnelSlug}`)).status === 200 ? 'served' : 'unavailable'),
  },
  {
    name: 'pixels', featureId: 'campaign-connectors',
    probe: async () => (((await anon().get(`/host/openwop-app/public/${encodeURIComponent(orgId)}/pixels?vk=vis-1`)).body?.pixels ?? []).length > 0 ? 'served' : 'unavailable'),
  },
  {
    name: 'conversions relay', featureId: 'campaign-connectors',
    probe: async () => ((await anon().post(`/host/openwop-app/public/${encodeURIComponent(orgId)}/conversions`, { vk: 'vis-1', eventId: `e-${Date.now()}-${Math.random()}`, eventName: 'lead' })).body?.reason === 'not_enabled' ? 'unavailable' : 'served'),
  },
  {
    name: 'webinar form sink', featureId: 'webinars',
    probe: async () => {
      const before = (await computeEventCounts(tenantId, orgId, PROVIDER_EVENT)).registrantCount;
      const now = new Date().toISOString();
      const form: FormDef = { formId: 'form:lapse', tenantId, orgId, title: 'Register', status: 'published', fields: [], createToContact: false, createdBy: 'test', createdAt: now, updatedAt: now };
      const submission: Submission = { submissionId: `s-${webinarSeq}`, tenantId, orgId, formId: 'form:lapse', values: { email: `reg-${webinarSeq++}@x.test` }, meta: {}, createdAt: now };
      await runSubmissionSinks(form, submission);
      const after = (await computeEventCounts(tenantId, orgId, PROVIDER_EVENT)).registrantCount;
      return after > before ? 'served' : 'unavailable';
    },
  },
  {
    name: 'dealer partner portal', featureId: 'dealers',
    probe: async () => ((await anon().get(`/host/openwop-app/partner/${partnerToken}`)).status === 200 ? 'served' : 'unavailable'),
  },
  {
    name: 'docs llms.txt', featureId: 'docs',
    probe: async () => ((await anon().get(`/host/openwop-app/public/${encodeURIComponent(orgId)}/llms.txt`)).status === 200 ? 'served' : 'unavailable'),
  },
  {
    name: 'podcast show index', featureId: 'podcasts',
    probe: async () => ((await anon().get(`/host/openwop-app/public/${encodeURIComponent(orgId)}/podcasts`)).status === 200 ? 'served' : 'unavailable'),
  },
  {
    name: 'custom-domain serving', featureId: 'custom-domains',
    // The middleware's own 404 is `Not found.`; the storefront behind it is unaffected
    // (commerce is not refused), so a 200 means the bound host served.
    probe: async () => ((await withHost(`/host/openwop-app/public-store/${encodeURIComponent(orgId)}/products`, 'shop.lapse-test.example')).status === 200 ? 'served' : 'unavailable'),
  },
];

describe('ADR 0820 §7 — lane fixtures', () => {
  it('seeds a funnel, a pixel, a webinar binding, a partner link and a live custom domain', async () => {
    const page = await owner.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages`, { title: 'Lapse Landing' });
    await owner.post(`/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}/pages/${page.body.pageId}/publish`);
    const funnel = await owner.post(`/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels`, { name: 'Lapse', slug: 'lapse-path', steps: [{ stepId: 'l1', kind: 'landing', pageId: page.body.pageId }] });
    expect(funnel.status, JSON.stringify(funnel.body)).toBe(201);
    await owner.post(`/host/openwop-app/funnels/orgs/${encodeURIComponent(orgId)}/funnels/${funnel.body.funnel.funnelId}/publish`);
    funnelSlug = 'lapse-path';

    await upsertPixel(tenantId, orgId, { platform: 'meta', pixelId: 'px-lapse' });

    const ev = await upsertMarketingEvent({ tenantId, orgId, provider: 'zoom', providerEventId: PROVIDER_EVENT, title: 'Lapse webinar' });
    await bindFormToEvent(tenantId, orgId, 'form:lapse', ev.eventId);

    const D = `/host/openwop-app/dealers/orgs/${encodeURIComponent(orgId)}`;
    const companyId = (await owner.post(`/host/openwop-app/crm/orgs/${encodeURIComponent(orgId)}/companies`, { name: 'Dealer Co' })).body.companyId;
    const dealerId = (await owner.post(`${D}/dealers`, { name: 'North Dealer', companyId, tier: 'Gold' })).body.dealerId;
    const mint = await owner.post(`${D}/dealers/${dealerId}/portal-token`);
    expect(mint.status, JSON.stringify(mint.body)).toBe(201);
    partnerToken = mint.body.token;

    const d = await addDomain({ tenantId, orgId, createdBy: 'test', hostname: 'shop.lapse-test.example' });
    const live = await verifyDomain(tenantId, orgId, 'shop.lapse-test.example', async () => [[d.verificationToken]]);
    expect(live?.status).toBe('live');
    invalidateHostCache();
  });
});

describe.each(LANES)('ADR 0820 §7 — $name', (lane) => {
  it('knob UNSET + owner refused ⇒ serves exactly as today (regression pin)', async () => {
    await arrange(lane.featureId, 'unset');
    expect(await lane.probe()).toBe('served');
  });
  it('POSITIVE control: knob set + owner entitled ⇒ serves', async () => {
    await arrange(lane.featureId, 'entitled');
    expect(await lane.probe()).toBe('served');
  });
  it('knob set + owner lapsed within grace ⇒ serves', async () => {
    await arrange(lane.featureId, 'grace');
    expect(await lane.probe()).toBe('served');
  });
  it('knob set + owner lapsed beyond grace ⇒ unavailable', async () => {
    await arrange(lane.featureId, 'beyond');
    expect(await lane.probe()).toBe('unavailable');
  });
  it('knob set + entitlement FAULT ⇒ serves', async () => {
    await arrange(lane.featureId, 'fault');
    expect(await lane.probe()).toBe('served');
  });
});

describe('ADR 0820 §7 — the storefront kill switch (gating-audit commerce #1)', () => {
  it('commerce toggle OFF ⇒ every public-store route answers the uniform 404; ON ⇒ served', async () => {
    await arrange('commerce', 'unset');
    refused.clear();
    const storeLanes = LANES.filter((l) => l.featureId === 'commerce');
    try {
      await enable('commerce', 'off');
      for (const l of storeLanes) expect(await l.probe(), l.name).toBe('unavailable');
    } finally {
      await enable('commerce', 'on');
    }
    for (const l of storeLanes) expect(await l.probe(), l.name).toBe('served');
  });
});
