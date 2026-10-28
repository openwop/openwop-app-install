/**
 * ADR 0956 P2 (D6) — ROAS reconciliation and AdMap.
 *
 *   - the exit fixture: three platforms each claim the SAME conversion. The
 *     report shows claims 3 vs measured 1 (overlap 2) and flags every platform's
 *     sustained inflation;
 *   - reported and measured are never summed; a platform that reports no revenue
 *     has no reported ROAS (null, not 0);
 *   - AdMap: a dispatched ad joins its landing sessions and conversions on
 *     `utm_id` = the ad reference, resolves its landing page and the funnel step
 *     that renders it, places a pre-P0 ledger row by its brief, and says the
 *     message-match score is owed;
 *   - the model gate: only last_click until the multi-touch sub-toggle is on.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildReconciliation, platformOfTouch, sustainedInflation, SUSTAIN_DAYS } from '../src/features/campaign-intel/reconciliation.js';
import { buildAdMap, slugForLanding } from '../src/features/campaign-intel/adMap.js';
import { buildCampaignIntelSurface } from '../src/features/campaign-intel/surface.js';
import { MULTI_TOUCH_TOGGLE } from '../src/features/campaign-intel/attributionSettings.js';
import { __putRawEventForTests, type AnalyticsEvent } from '../src/features/analytics/analyticsService.js';
import { __putDispatchRecordForTests } from '../src/host/adsAdapter.js';
import { persistRecords } from '../src/features/campaign-connectors/performanceService.js';
import { computeDerived } from '../src/features/campaign-connectors/csvImport.js';
import { createBrief, setKernel, updateBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { createPage, transitionPage } from '../src/features/cms/cmsService.js';
import { createFunnel } from '../src/features/funnels/funnelsService.js';
import { nodes as intelNodes } from '../../../packs/feature.campaign-intel.nodes/index.mjs';

const DAY = 86_400_000;
const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

describe('ADR 0956 D6 — pure pieces', () => {
  it('sustained inflation needs every one of the last 7 windows above the line', () => {
    const asOf = '2026-10-20';
    const d = (n: number): string => isoDay(Date.parse(`${asOf}T00:00:00Z`) - n * DAY);
    // One claim and a third of a measured conversion six days ago: inside all 7 windows.
    expect(sustainedInflation(new Map([[d(6), 3]]), new Map([[d(6), 1]]), asOf)).toEqual({ flagged: true, daysAbove: SUSTAIN_DAYS });
    // The same claim yesterday: only two windows contain it.
    expect(sustainedInflation(new Map([[d(1), 3]]), new Map([[d(1), 1]]), asOf)).toEqual({ flagged: false, daysAbove: 2 });
    // At or under the line is never flagged.
    expect(sustainedInflation(new Map([[d(6), 3]]), new Map([[d(6), 2]]), asOf).flagged).toBe(false);
  });

  it('a touch maps to its platform by click id, else by utm_source', () => {
    expect(platformOfTouch({ at: '', campaignId: null, channel: 'x', clickIdKind: 'gclid', source: 'facebook' })).toBe('google');
    expect(platformOfTouch({ at: '', campaignId: null, channel: 'x', source: 'Instagram' })).toBe('meta');
    expect(platformOfTouch({ at: '', campaignId: null, channel: 'x', source: 'newsletter' })).toBeNull();
  });

  it('landing URLs resolve to a slug only on the org\'s own site', async () => {
    expect(await slugForLanding('/p/spring?utm_id=a', 'org-1')).toEqual({ slug: 'spring' });
    expect(await slugForLanding('/', 'org-1')).toEqual({ slug: 'home' });
    const prior = process.env.OPENWOP_PUBLIC_BASE_URL;
    process.env.OPENWOP_PUBLIC_BASE_URL = 'https://api.example';
    try {
      expect(await slugForLanding('https://api.example/host/openwop-app/public/org-1/pages/spring', 'org-1')).toEqual({ slug: 'spring' });
      expect(await slugForLanding('https://api.example/host/openwop-app/public/org-2/pages/spring', 'org-1')).toEqual({ unresolved: 'other_org' });
    } finally { if (prior === undefined) delete process.env.OPENWOP_PUBLIC_BASE_URL; else process.env.OPENWOP_PUBLIC_BASE_URL = prior; }
    expect(await slugForLanding('/p/%ZZ', 'org-1')).toEqual({ unresolved: 'invalid_url' });
  });
});

let BASE = '';
let server: http.Server;
function client(): { call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }> } {
  let cookie = '';
  return {
    call: async (method, path, body) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
    },
  };
}
const KERNEL = { headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see', tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z' };
async function makeCampaign(tenantId: string, orgId: string, name: string, utmCampaign: string): Promise<{ campaignId: string; briefId: string }> {
  const utm = { campaign: utmCampaign };
  const brief = await createBrief(tenantId, orgId, 'test', { name, objective: 'o', productName: 'p', personaIds: ['x'], messaging: { primaryValueProp: 'v' }, channels: [{ type: 'ad_variants', enabled: true, config: {} }], utm, budget: { totalMinor: 100000, currency: 'USD' } });
  await setKernel(tenantId, brief.id, KERNEL);
  await updateBrief(tenantId, brief.id, { status: 'confirmed' }, 'test');
  const c = await finalizeFromBrief(tenantId, { ...brief, kernel: KERNEL, status: 'confirmed' as const, utm, budget: { totalMinor: 100000, currency: 'USD' } }, 'test');
  return { campaignId: c.id, briefId: brief.id };
}
async function setToggle(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`toggle default missing: ${id}`);
  await saveConfig({ ...d, status }, 'test');
}
function perfRow(platform: 'meta' | 'google' | 'tiktok', date: string, spend: number, conversions: number, revenue: number | null) {
  const base = { spend, impressions: 1000, clicks: 50, conversions, revenue: revenue ?? 0 };
  return { platform, campaignName: 'Spring', adSet: 'a', date, ...base, ...computeDerived(base), revenue };
}

describe('ADR 0956 P2 — reconciliation + AdMap over real stores', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    await setToggle('campaign-intel', 'on');
    await setToggle('funnels', 'on');
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  const tenantId = `recon-${Date.now()}`;
  let orgId = '';
  let spring = { campaignId: '', briefId: '' };
  const owner = client();
  const peer = client();
  const now = new Date();
  const sixDaysAgo = Date.parse(`${isoDay(now.getTime())}T12:00:00Z`) - 6 * DAY;

  it('setup: one conversion touched by Meta, Google and TikTok; each platform claims it', async () => {
    expect((await owner.call('POST', '/host/openwop-app/test/login', { email: `recon-o-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    orgId = String((await owner.call('POST', '/host/openwop-app/orgs', { name: 'Client R' })).body.orgId);
    expect((await peer.call('POST', '/host/openwop-app/test/login', { email: `recon-p-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    spring = await makeCampaign(tenantId, orgId, 'Spring', 'spring');
    const put = (o: Partial<AnalyticsEvent> & { eventId: string; ts: string }): Promise<void> => __putRawEventForTests({ tenantId, orgId, type: 'pageview', ...o });
    const t = (h: number): string => new Date(sixDaysAgo + h * 3_600_000).toISOString();
    await put({ eventId: 'evt:m', ts: t(0), sessionKey: 'sess1', utm: { campaign: 'spring', source: 'facebook', id: 'ref-meta' }, clickIds: { fbclid: 'f' } });
    await put({ eventId: 'evt:g', ts: t(1), sessionKey: 'sess1', utm: { campaign: 'spring', source: 'google' }, clickIds: { gclid: 'g' } });
    await put({ eventId: 'evt:t', ts: t(2), sessionKey: 'sess1', utm: { campaign: 'spring', source: 'tiktok', medium: 'paid-social' } });
    await put({ eventId: 'evt:c', ts: t(3), sessionKey: 'sess1', type: 'conversion', props: { valueMinor: 9000, currency: 'USD' } });
    const d = isoDay(sixDaysAgo);
    await persistRecords(tenantId, orgId, [perfRow('meta', d, 30, 1, 90), perfRow('google', d, 30, 1, 90), perfRow('tiktok', d, 30, 1, null)], 'csv', spring.campaignId);
  });

  it('exit fixture: claims 3 vs measured 1 (overlap 2), and every platform is flagged; never summed', async () => {
    const r = await buildReconciliation(tenantId, orgId, 'linear', now);
    expect(r.overlap).toEqual([{ campaignId: spring.campaignId, campaignName: 'Spring', platformClaims: 3, measured: 1, overlap: 2 }]);
    expect(r.rows.map((x) => x.platform).sort()).toEqual(['google', 'meta', 'tiktok']);
    for (const row of r.rows) {
      expect(row.reportedConversions).toBe(1);
      expect(row.measuredConversions).toBeCloseTo(1 / 3, 4);
      expect(row.inflation.ratio).toBeCloseTo(3, 3);
      expect(row.inflation.flagged).toBe(true);
    }
    const tiktok = r.rows.find((x) => x.platform === 'tiktok')!;
    expect(tiktok.reportedRevenue).toBeNull(); // cannot report revenue — not a 0
    expect(tiktok.reportedRoas).toBeNull();
    // Measured value is the conversion's own 90.00 split three ways, in the campaign currency.
    expect(r.rows.reduce((s, x) => s + x.measuredRevenue, 0)).toBeCloseTo(90, 2);
    expect(r.calibration).toBeNull();
    expect(r.rows.find((x) => x.platform === 'meta')!.measuredRoas).toBeCloseTo(1, 4); // 30.00 credited / 30 spend
    // Under last click only the last touch (TikTok) is measured; the others claim with none measured.
    const lc = await buildReconciliation(tenantId, orgId, 'last_click', now);
    expect(lc.rows.find((x) => x.platform === 'meta')!.inflation).toMatchObject({ measuredZero: true, flagged: true });
  });

  it('AdMap: joins on utm_id, resolves the page and its funnel step, places a pre-P0 row by its brief, owes the match score', async () => {
    const page = await createPage({ tenantId, orgId, title: 'Spring offer', slug: 'spring', createdBy: 'test' });
    await transitionPage(tenantId, orgId, page.pageId, 'publish', 'test');
    await createFunnel({ tenantId, orgId, name: 'Launch', slug: 'launch', steps: [{ kind: 'landing', pageId: page.pageId }], createdBy: 'test' } as never);
    await __putDispatchRecordForTests({ tenantId, platform: 'meta', platformCampaignId: 'pc1', platformAdSetId: 'as1', platformAdId: 'ad-meta', createdAt: new Date().toISOString(), briefId: spring.briefId, orgId, adRef: 'ref-meta', landingUrl: '/p/spring?utm_campaign=spring&utm_content=arm-b&utm_id=ref-meta' });
    // Written before P0: no orgId, no landing URL — placed by its brief.
    await __putDispatchRecordForTests({ tenantId, platform: 'google', platformCampaignId: 'pc2', platformAdSetId: 'as2', platformAdId: 'ad-legacy', createdAt: new Date().toISOString(), briefId: spring.briefId });
    // Another client's ad never appears.
    await __putDispatchRecordForTests({ tenantId, platform: 'meta', platformCampaignId: 'pc3', platformAdSetId: 'as3', platformAdId: 'ad-other', createdAt: new Date().toISOString(), orgId: 'org-someone-else' });
    const map = await buildAdMap(tenantId, orgId, 'linear');
    expect(map.rows.map((r) => r.platformAdId).sort()).toEqual(['ad-legacy', 'ad-meta']);
    const ad = map.rows.find((r) => r.platformAdId === 'ad-meta')!;
    expect(ad).toMatchObject({ adRef: 'ref-meta', campaignId: spring.campaignId, variantKey: 'arm-b', landingSessions: 1, spend: null, clicks: null, messageMatch: { status: 'owed' } });
    expect(ad.conversions).toBeCloseTo(1 / 3, 4);
    expect(ad.landing).toMatchObject({ kind: 'cms_page', pageId: page.pageId, funnelSteps: [expect.objectContaining({ funnelName: 'Launch' })] });
    expect(map.rows.find((r) => r.platformAdId === 'ad-legacy')!.landing).toEqual({ kind: 'unresolved', reason: 'no_landing_url' });
  });

  it('an absolute link on a host bound to no org of ours is external (custom-host lookup)', async () => {
    expect(await slugForLanding('https://someone-else.example/x', orgId)).toEqual({ external: 'someone-else.example' });
    expect(await slugForLanding('//someone-else.example/p/spring', orgId)).toEqual({ external: 'someone-else.example' });
    expect(await slugForLanding(`https://someone-else.example/host/openwop-app/public/${orgId}/pages/spring`, orgId)).toEqual({ external: 'someone-else.example' });
    expect(await slugForLanding('javascript:alert(1)', orgId)).toEqual({ unresolved: 'invalid_url' });
  });

  it('counts tracked landings that never convert, and never duplicates credit for a shared reference', async () => {
    await __putRawEventForTests({ tenantId, orgId, eventId: 'evt:bounce', type: 'pageview', ts: new Date().toISOString(), sessionKey: 'bounce-only', utm: { id: 'ref-meta', campaign: 'spring' } });
    const before = await buildAdMap(tenantId, orgId, 'linear');
    expect(before.rows.find((r) => r.platformAdId === 'ad-meta')).toMatchObject({ landingSessions: 2 });
    const secondKey = `ads:test-shared-${tenantId}`;
    await __putDispatchRecordForTests({ idemKey: secondKey, tenantId, orgId, platform: 'google', platformCampaignId: 'pc-shared', platformAdSetId: 'as-shared', platformAdId: 'ad-shared', createdAt: new Date().toISOString(), adRef: 'ref-meta' });
    const shared = await buildAdMap(tenantId, orgId, 'linear');
    expect(shared.rows.filter((r) => r.adRef === 'ref-meta')).toEqual([
      expect.objectContaining({ landingSessions: null, conversions: null }),
      expect.objectContaining({ landingSessions: null, conversions: null }),
    ]);
  });

  it('the funnel source toggle is live while always-on CMS pages remain readable', async () => {
    try {
      await setToggle('funnels', 'off');
      const map = await buildAdMap(tenantId, orgId);
      expect(map.rows.find((r) => r.platformAdId === 'ad-meta')?.landing).toMatchObject({ kind: 'cms_page', funnelSteps: [] });
      // CMS has no toggle (ADR 0027); disabling funnels cannot hide the owning page.
      expect(getToggleDefault('cms')).toBeNull();
    } finally { await setToggle('funnels', 'on'); }
  });

  it('routes: org-scoped reads; a non-member is refused; a model needs the sub-toggle', async () => {
    await setToggle(MULTI_TOUCH_TOGGLE, 'off');
    const base = `/host/openwop-app/campaign-intel/orgs/${orgId}`;
    const r = await owner.call('GET', `${base}/reconciliation`);
    expect(r.status).toBe(200);
    expect(r.body.model).toBe('last_click');
    expect((await owner.call('GET', `${base}/admap`)).status).toBe(200);
    expect((await owner.call('GET', `${base}/reconciliation?model=linear`)).status).toBe(400);
    expect((await peer.call('GET', `${base}/reconciliation`)).status).toBe(403);
    expect((await peer.call('GET', `${base}/admap`)).status).toBe(403);
  });

  it('model gate: only last_click until multi-touch is on (route and surface agree); nodes pass through', async () => {
    await setToggle(MULTI_TOUCH_TOGGLE, 'off');
    const surface = buildCampaignIntelSurface({ tenantId });
    expect((await surface.reconciliation!({ orgId })).model).toBe('last_click');
    await expect(surface.reconciliation!({ orgId, model: 'linear' })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(surface.adMap!({ orgId, model: 'bogus' })).rejects.toMatchObject({ code: 'validation_error' });
    await setToggle(MULTI_TOUCH_TOGGLE, 'on');
    expect((await surface.reconciliation!({ orgId, model: 'linear' })).model).toBe('linear');
    const ci = { optimizeBudget: async () => ({}), reconciliation: async (a: unknown) => ({ got: a }), adMap: async (a: unknown) => ({ got: a }) };
    expect((await intelNodes['feature.campaign-intel.nodes.reconciliation']({ features: { 'campaign-intel': ci }, inputs: { orgId: 'o', model: 'linear' } })).outputs).toEqual({ got: { orgId: 'o', model: 'linear' } });
    expect((await intelNodes['feature.campaign-intel.nodes.ad-map']({ features: { 'campaign-intel': { optimizeBudget: async () => ({}) } }, inputs: { orgId: 'o' } })).error?.code).toBe('host_capability_missing');
  });
});
