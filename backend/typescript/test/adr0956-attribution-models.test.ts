/**
 * ADR 0956 P1 (D1/D2) — touch paths, rule-based multi-touch models, the
 * session-last-click column, per-org attribution settings and the sub-toggle.
 *
 *   - `allocate` / `creditPath`: credits sum EXACTLY to the total for every
 *     model (a seeded property test over random paths), remainder to the last
 *     touch;
 *   - `buildTouchPaths`: lookback, contact joins through the deterministic link
 *     only, collapse of re-sent UTMs, the converting hit as a touch;
 *   - the report: `sessionLastClick` beside the unchanged converting-hit
 *     column, the model report summing exactly, the sub-toggle refusal;
 *   - erasure: paths are read from analytics rows, so erasing a session's
 *     events removes its touches from every path (no derived store to miss).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { ATTRIBUTION_MODELS, CONVERSION_UNITS, allocate, creditPath, modelWeights } from '../src/features/campaign-intel/attributionModels.js';
import { buildTouchPaths } from '../src/features/campaign-intel/touchPaths.js';
import { buildAttribution, buildModelReport } from '../src/features/campaign-intel/attribution.js';
import { buildCampaignIntelSurface } from '../src/features/campaign-intel/surface.js';
import { MULTI_TOUCH_TOGGLE, setAttributionSettings, parseAttributionSettings } from '../src/features/campaign-intel/attributionSettings.js';
import { eraseCampaignIntelSubject } from '../src/features/campaign-intel/erasure.js';
import { __putRawEventForTests, deleteSubjectEvents, type AnalyticsEvent } from '../src/features/analytics/analyticsService.js';
import { linkSession } from '../src/features/analytics/identityLinkService.js';
import { createBrief, setKernel, updateBrief } from '../src/features/campaign-brief/briefService.js';
import { finalizeFromBrief } from '../src/features/campaign-orchestration/campaignService.js';
import { nodes as intelNodes } from '../../../packs/feature.campaign-intel.nodes/index.mjs';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** Deterministic PRNG (mulberry32) so the property test is replayable. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('ADR 0956 D2 — models and the exact allocator (pure)', () => {
  it('credits sum EXACTLY to the total under every model (seeded property test, 5 000 paths)', () => {
    const r = rng(956);
    for (let i = 0; i < 1000; i++) {
      const n = 1 + Math.floor(r() * 12);
      const conv = T0;
      const times = Array.from({ length: n }, () => conv - Math.floor(r() * 90 * DAY)).sort((a, b) => a - b);
      const total = i % 4 === 0 ? 0 : i % 4 === 1 ? 1 : i % 4 === 2 ? CONVERSION_UNITS : Math.floor(r() * 1e12);
      for (const model of ATTRIBUTION_MODELS) {
        const credits = creditPath(model, times, conv, total, { halfLifeDays: 1 + Math.floor(r() * 30) });
        expect(credits).toHaveLength(n);
        expect(credits.every((c) => Number.isSafeInteger(c) && c >= 0)).toBe(true);
        expect(credits.reduce((s, c) => s + c, 0)).toBe(total);
      }
    }
  });

  it('known splits: remainder to the LAST touch; 40/20/40; first and last', () => {
    const t3 = [T0 - 2 * DAY, T0 - DAY, T0];
    expect(creditPath('linear', t3, T0, CONVERSION_UNITS, { halfLifeDays: 7 })).toEqual([333_333, 333_333, 333_334]);
    expect(creditPath('position_based', t3, T0, CONVERSION_UNITS, { halfLifeDays: 7 })).toEqual([400_000, 200_000, 400_000]);
    expect(creditPath('position_based', [...t3, T0], T0, 10, { halfLifeDays: 7 })).toEqual([4, 1, 1, 4]);
    expect(creditPath('first_touch', t3, T0, 7, { halfLifeDays: 7 })).toEqual([7, 0, 0]);
    expect(creditPath('last_click', t3, T0, 7, { halfLifeDays: 7 })).toEqual([0, 0, 7]);
    // time_decay: a touch one half-life older carries half the weight.
    const [old, recent] = modelWeights('time_decay', [T0 - 7 * DAY, T0], T0, { halfLifeDays: 7 });
    expect(recent! / old!).toBeCloseTo(2, 5);
    expect(allocate(5, [0, 0])).toEqual([0, 5]); // all-zero weights → last touch
  });
});

function ev(o: Partial<AnalyticsEvent> & { eventId: string; ts: string }): AnalyticsEvent {
  return { tenantId: 't', orgId: 'o', type: 'pageview', ...o };
}

describe('ADR 0956 D1 — buildTouchPaths (pure)', () => {
  const resolveCampaign = (k: string): string | null => ({ spring: 'c-spring', summer: 'c-summer' } as Record<string, string>)[k] ?? null;
  const base = { lookbackDays: 30, resolveCampaign, currencyExponent: () => 2 };

  it('a session that landed from a campaign and converted later without UTMs is credited to it; re-sent UTMs collapse', () => {
    const events = [
      ev({ eventId: 'e1', ts: iso(T0 - 3 * DAY), sessionKey: 'sA', utm: { campaign: 'spring', source: 'meta', medium: 'cpc' } }),
      ev({ eventId: 'e2', ts: iso(T0 - 3 * DAY + 1000), sessionKey: 'sA', utm: { campaign: 'spring', source: 'meta', medium: 'cpc' } }), // same visit, UTMs re-sent
      ev({ eventId: 'e3', ts: iso(T0), sessionKey: 'sA', type: 'conversion', props: { valueMinor: 1999, currency: 'usd' } }),
    ];
    const { paths, coverage } = buildTouchPaths({ ...base, events, contactBySession: new Map() });
    expect(paths).toHaveLength(1);
    expect(paths[0]!.unit).toEqual({ kind: 'session', id: 'sA' });
    expect(paths[0]!.touches.map((t) => t.campaignId)).toEqual(['c-spring']);
    expect(paths[0]!.value).toEqual({ minor: 1999, currency: 'USD' });
    expect(coverage).toEqual({ conversions: 1, contactPaths: 0, sessionPaths: 1, noTouch: 0 });
  });

  it('joins sessions into a contact path ONLY through the deterministic link; drops touches outside the lookback', () => {
    const events = [
      ev({ eventId: 'old', ts: iso(T0 - 40 * DAY), sessionKey: 'sB', utm: { campaign: 'summer' } }),
      ev({ eventId: 'b1', ts: iso(T0 - 5 * DAY), sessionKey: 'sB', utm: { campaign: 'summer' }, clickIds: { fbclid: 'x' } }),
      ev({ eventId: 'c1', ts: iso(T0 - 2 * DAY), sessionKey: 'sC', owx: 'tok' }),
      ev({ eventId: 'c2', ts: iso(T0), sessionKey: 'sC', type: 'conversion', props: { total: 12.5, currency: 'EUR' } }),
      ev({ eventId: 'z1', ts: iso(T0 - DAY), sessionKey: 'sZ', utm: { campaign: 'spring' } }), // an unlinked stranger
    ];
    const linked = new Map([['sB', 'crm:1'], ['sC', 'crm:1']]);
    const { paths, coverage } = buildTouchPaths({ ...base, events, contactBySession: linked });
    const p = paths[0]!;
    expect(p.unit).toEqual({ kind: 'contact', id: 'crm:1' });
    expect(p.touches.map((t) => [t.campaignId, t.channel])).toEqual([['c-summer', 'paid:meta'], [null, 'email']]);
    expect(p.value).toEqual({ minor: 1250, currency: 'EUR' });
    expect(coverage.contactPaths).toBe(1);
    // Without the link the conversion's path is its own session only.
    const unlinked = buildTouchPaths({ ...base, events, contactBySession: new Map() });
    expect(unlinked.paths[0]!.touches.map((t) => t.channel)).toEqual(['email']);
  });

  it('a conversion with no session is a path of its own hit (touch only if it carries UTMs)', () => {
    const { paths, coverage } = buildTouchPaths({ ...base, contactBySession: new Map(), events: [
      ev({ eventId: 'x', ts: iso(T0), type: 'conversion', utm: { campaign: 'spring' } }),
      ev({ eventId: 'y', ts: iso(T0), type: 'conversion' }),
    ] });
    expect(paths.map((p) => p.touches.length)).toEqual([1, 0]);
    expect(coverage.noTouch).toBe(1);
  });
});

interface Res { status: number; body: Record<string, unknown> }
let BASE = '';
let server: http.Server;
function client(): { call: (method: string, path: string, body?: unknown) => Promise<Res> } {
  let cookie = '';
  return {
    call: async (method, path, body) => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown> };
    },
  };
}

const KERNEL = {
  headline: 'H', supportingStatement: 'S', proofPoints: ['p'], primaryCta: 'go', secondaryCta: 'see',
  tone: 'warm', channelTones: {}, sourceDocIds: [], generatedAt: '2026-07-01T00:00:00Z',
};
async function makeCampaign(tenantId: string, orgId: string, name: string, utmCampaign: string): Promise<string> {
  const utm = { campaign: utmCampaign };
  const brief = await createBrief(tenantId, orgId, 'test', {
    name, objective: 'o', productName: 'p', personaIds: ['x'], messaging: { primaryValueProp: 'v' },
    channels: [{ type: 'ad_variants', enabled: true, config: {} }], utm,
  });
  await setKernel(tenantId, brief.id, KERNEL);
  await updateBrief(tenantId, brief.id, { status: 'confirmed' }, 'test');
  return (await finalizeFromBrief(tenantId, { ...brief, kernel: KERNEL, status: 'confirmed' as const, utm }, 'test')).id;
}
async function setToggle(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`toggle default missing: ${id}`);
  await saveConfig({ ...d, status }, 'test');
}

describe('ADR 0956 P1 — report, settings routes, sub-toggle, erasure', () => {
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    await setToggle('campaign-intel', 'on');
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  const tenantId = `mt-${Date.now()}`;
  let orgId = '';
  const owner = client();
  const peer = client();
  let spring = '';
  let summer = '';

  it('setup: org, two campaigns, a landing-then-convert session and a two-session contact', async () => {
    expect((await owner.call('POST', '/host/openwop-app/test/login', { email: `mt-o-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    orgId = String((await owner.call('POST', '/host/openwop-app/orgs', { name: 'Client M' })).body.orgId);
    expect((await peer.call('POST', '/host/openwop-app/test/login', { email: `mt-p-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
    spring = await makeCampaign(tenantId, orgId, 'Spring', 'spring');
    summer = await makeCampaign(tenantId, orgId, 'Summer', 'summer');
    const now = Date.now();
    const put = (o: Partial<AnalyticsEvent> & { eventId: string; ts: string }): Promise<void> => __putRawEventForTests({ tenantId, orgId, type: 'pageview', ...o });
    // Session A: lands from Spring, converts later on a page without UTMs.
    await put({ eventId: 'evt:a1', ts: iso(now - 2 * DAY), sessionKey: 'sessA', utm: { campaign: 'spring', source: 'meta', medium: 'cpc' } });
    await put({ eventId: 'evt:a2', ts: iso(now - DAY), sessionKey: 'sessA', type: 'conversion', props: { valueMinor: 1000, currency: 'USD' } });
    // Contact: session B from Summer, session C from Spring, converts in C.
    await put({ eventId: 'evt:b1', ts: iso(now - 5 * DAY), sessionKey: 'sessB', utm: { campaign: 'summer' } });
    await put({ eventId: 'evt:c1', ts: iso(now - 3 * DAY), sessionKey: 'sessC', utm: { campaign: 'spring' } });
    await put({ eventId: 'evt:c2', ts: iso(now - 3 * DAY + 60_000), sessionKey: 'sessC', type: 'conversion', utm: { campaign: 'spring' } });
    await linkSession(tenantId, 'sessB', 'crm:buyer', 'email-click');
    await linkSession(tenantId, 'sessC', 'crm:buyer', 'email-click');
  });

  it('report: sessionLastClick credits the landing campaign; the converting-hit column is unchanged', async () => {
    const r = await buildAttribution(tenantId, orgId);
    const row = (id: string) => r.rows.find((x) => x.campaignId === id)!;
    expect(row(spring).webConversions).toBe(1); // only c2 carried the key on its own hit
    expect(row(spring).sessionLastClick).toBe(2); // a2 (landed from Spring) + c2
    expect(row(summer).sessionLastClick).toBe(0);
    expect(r.pathCoverage).toEqual({ conversions: 2, contactPaths: 1, sessionPaths: 1, noTouch: 0 });
    expect(r.lookbackDays).toBe(30);
  });

  it('model report: refused while the sub-toggle is off; when on, every model sums exactly and linear splits the contact path', async () => {
    const path = `/host/openwop-app/campaign-intel/orgs/${orgId}/attribution/models`;
    await setToggle(MULTI_TOUCH_TOGGLE, 'off');
    expect((await owner.call('GET', path)).status).toBe(404);
    await expect(buildCampaignIntelSurface({ tenantId }).attributionModels({ orgId })).rejects.toMatchObject({ code: 'host_capability_disabled' });
    await setToggle(MULTI_TOUCH_TOGGLE, 'on');
    await expect(buildCampaignIntelSurface({ tenantId }).attributionModels({ orgId, model: 'linaer' })).rejects.toMatchObject({ code: 'validation_error' });
    expect((await peer.call('GET', path)).status).toBe(403);
    expect((await owner.call('GET', `${path}?model=bogus`)).status).toBe(400);
    const linear = await owner.call('GET', `${path}?model=linear`);
    expect(linear.status).toBe(200);
    for (const m of ATTRIBUTION_MODELS) {
      const rep = await buildModelReport(tenantId, orgId, m);
      const sum = rep.rows.reduce((s, x) => s + x.units, 0) + rep.unmapped.units;
      expect(sum).toBe(rep.creditedPaths * CONVERSION_UNITS);
      expect(rep.basis).toBe('modelled_web_conversions');
    }
    const lin = await buildModelReport(tenantId, orgId, 'linear');
    // Session A: all to Spring. Contact path: Summer, then Spring (c1; c2 re-sends it and collapses).
    expect(lin.rows.find((x) => x.campaignId === summer)?.units).toBe(500_000);
    expect(lin.rows.find((x) => x.campaignId === spring)?.units).toBe(1_500_000);
    expect(lin.rows.find((x) => x.campaignId === spring)?.value).toEqual([{ currency: 'USD', minor: 1000 }]);
    expect(lin.model).toBe('linear');
    expect((await buildModelReport(tenantId, orgId)).model).toBe('last_click'); // the org default
  });

  it('settings: default v0, CAS, closed-world, write needs workspace:write; the default model follows', async () => {
    const path = `/host/openwop-app/campaign-intel/orgs/${orgId}/attribution-settings`;
    expect((await owner.call('GET', path)).body).toMatchObject({ version: 0, isDefault: true, settings: { lookbackDays: 30, halfLifeDays: 7, defaultModel: 'last_click' } });
    expect((await owner.call('PUT', path, { defaultModel: 'linear' })).status).toBe(400);
    expect((await owner.call('PUT', path, { defaultModel: 'shapley', expectedVersion: 0 })).status).toBe(400);
    expect((await owner.call('PUT', path, { lookbackDays: 91, expectedVersion: 0 })).status).toBe(400);
    expect((await peer.call('PUT', path, { defaultModel: 'linear', expectedVersion: 0 })).status).toBe(403);
    const ok = await owner.call('PUT', path, { defaultModel: 'linear', lookbackDays: 1, expectedVersion: 0 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ version: 1 });
    expect((await owner.call('PUT', path, { defaultModel: 'first_touch', expectedVersion: 0 })).status).toBe(409);
    const rep = await buildModelReport(tenantId, orgId);
    expect(rep.model).toBe('linear');
    // A 1-day lookback drops the contact's Summer touch (2 days before c2);
    // session A's touch is exactly 1 day before its conversion and stays.
    expect(rep.rows.find((x) => x.campaignId === summer)?.units ?? 0).toBe(0);
    expect(rep.rows.find((x) => x.campaignId === spring)?.units).toBe(2 * CONVERSION_UNITS);
  });

  it('attribution-models node: passes the model through; a host without the method fails typed', async () => {
    const node = intelNodes['feature.campaign-intel.nodes.attribution-models'];
    const seen: unknown[] = [];
    const ci = { optimizeBudget: async () => ({}), attributionModels: async (a: unknown) => { seen.push(a); return { model: 'linear' }; } };
    const ok = await node({ features: { 'campaign-intel': ci }, inputs: { orgId: 'o1', model: 'linear' } });
    expect(ok.status).toBe('success');
    expect(seen).toEqual([{ orgId: 'o1', model: 'linear' }]);
    expect((await node({ features: { 'campaign-intel': { optimizeBudget: async () => ({}) } }, inputs: { orgId: 'o1' } })).error?.code).toBe('host_capability_missing');
  });

  it('erasure: deleting a session\'s analytics rows removes its touches from every path; settings keep, editor tombstoned', async () => {
    const before = await buildModelReport(tenantId, orgId, 'linear');
    expect(before.creditedPaths).toBe(2);
    const out = await deleteSubjectEvents(tenantId, 'sessA');
    expect(out.removed).toBe(2);
    const after = await buildModelReport(tenantId, orgId, 'linear');
    expect(after.creditedPaths).toBe(1); // no derived copy still credits session A
    expect((await buildAttribution(tenantId, orgId)).rows.find((x) => x.campaignId === spring)?.sessionLastClick).toBe(1);

    const T = `mt-erase-${Date.now()}`;
    await setAttributionSettings(T, 'org-e', parseAttributionSettings({ halfLifeDays: 3 }), 0, 'user:alice');
    expect((await eraseCampaignIntelSubject(T, 'user:alice')).rowsTouched).toBe(1);
  });
});
