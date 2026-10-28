/**
 * ADR 0951 P1 — heat maps: aggregate, identifier-free, consent-gated, bot-free.
 *
 * Exit criteria:
 *  - NO identifier in `analytics:heat` (schema test): the row type's field set is
 *    pinned and contains no visitor-identifying field, AND the stored JSON after a
 *    real ingest carrying a sessionKey, consent token, IP and UA contains none of
 *    their values;
 *  - bot traffic is excluded from the aggregates and counted separately.
 * Plus: consent refusal records nothing (uniform 204), the sub-toggle gates both
 * lanes, the input contract is closed-world (typed 400s), the per-row cell cap and
 * the experiment arm k-anonymity floor hold, and the authed read is member-only.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setPolicy } from '../src/features/consent/consentService.js';
import {
  HEAT_ROW_FIELDS, MAX_CELLS_PER_ROW, MAX_SECTIONS_PER_ROW, MAX_PAGES_PER_ORG, MIN_ARM_VIEWS, OTHER_CELL, listHeatPages, __listHeatRowsForTests, __resetHeatStoreForTests, gridCell, readHeatmap, recordHeat,
} from '../src/features/analytics/heatStore.js';
import { isAutomatedTraffic } from '../src/features/analytics/botTraffic.js';
import { __resetOrgBeaconBudgetForTests } from '../src/features/analytics/routes.js';
import { __runKvAgeOutOnce } from '../src/host/kvAgeOut.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';

let BASE: string;
let server: http.Server;
const setToggle = async (id: string, status: 'on' | 'off'): Promise<void> => {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default for ${id}`);
  await saveConfig({ ...d, status }, 'test');
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await setToggle('analytics', 'on');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(async () => {
  await __resetHeatStoreForTests();
  __resetOrgBeaconBudgetForTests();
  await setToggle('analytics.heatmaps', 'off');
  await setToggle('consent', 'off');
});

interface Res<T = unknown> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
  return { get: <T>(p: string) => call<T>('GET', p), post: <T>(p: string, b?: unknown, h?: Record<string, string>) => call<T>('POST', p, b, h) };
}
let seq = 0;
async function ownerWithOrg() {
  const owner = client();
  const su = await owner.post('/host/openwop-app/test/login', { email: `heat-${Date.now()}-${seq++}@acme.test` });
  expect(su.status).toBe(201);
  const org = await owner.post<{ orgId: string; tenantId?: string }>('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { owner, orgId: org.body.orgId, tenantId: String(org.body.tenantId ?? '') };
}
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const SESSION_SENTINEL = 'vk-0951-SENTINEL-session';
const IP_SENTINEL = '203.0.113.51';
const pub = client();
const heat = (orgId: string, body: Record<string, unknown>, ua = BROWSER_UA) =>
  pub.post(`/host/openwop-app/public-analytics/${orgId}/heat`, { sessionKey: SESSION_SENTINEL, page: '/pricing', device: 'desktop', ...body }, { 'user-agent': ua, 'x-forwarded-for': IP_SENTINEL });
const EVENTS = [
  { t: 'click', x: 0.5, y: 0.1 },
  { t: 'click', sel: 'cta-buy' },
  { t: 'scroll', depth: 0.6 },
  { t: 'attn', section: 'hero', ms: 4000 },
];

describe('ADR 0951 P1 — no identifier in analytics:heat (exit criterion)', () => {
  it('the row type carries no visitor-identifying field', () => {
    const forbidden = /session|visitor|subject|user|ip|agent|ua$|hash|token|email|phone|key$/i;
    // `pageKey` is the page, not a person — the only `*Key` field, named explicitly.
    const offenders = HEAT_ROW_FIELDS.filter((f) => f !== 'pageKey' && forbidden.test(f));
    expect(offenders).toEqual([]);
    expect([...HEAT_ROW_FIELDS].sort()).toEqual(['arm', 'attention', 'bots', 'clicks', 'day', 'dayStart', 'device', 'orgId', 'pageKey', 'scroll', 'tenantId', 'updatedAt', 'views'].sort());
  });

  it('a real ingest with a session key, token, IP and UA stores none of them', async () => {
    const { orgId } = await ownerWithOrg();
    await setToggle('analytics.heatmaps', 'on');
    const r = await heat(orgId, { events: EVENTS });
    expect(r.status).toBe(204);
    const stored = await __listHeatRowsForTests();
    expect(stored).toHaveLength(1);
    const json = JSON.stringify(stored);
    for (const s of [SESSION_SENTINEL, IP_SENTINEL, 'Safari/605']) expect(json).not.toContain(s);
    for (const row of stored) expect(Object.keys(row).sort()).toEqual([...HEAT_ROW_FIELDS].sort());
    expect(stored[0]).toMatchObject({ pageKey: '/pricing', device: 'desktop', views: 1, bots: 0, arm: '' });
    expect(stored[0]!.clicks).toEqual({ [gridCell(0.5, 0.1)]: 1, 's:cta-buy': 1 });
    expect(stored[0]!.attention).toEqual({ hero: { ms: 4000, views: 1 } });
  });
});

describe('ADR 0951 P1 — bots are excluded and counted separately (exit criterion)', () => {
  it('classifies crawlers, AI agents, headless browsers, HTTP libraries and a missing UA as automated', () => {
    for (const ua of ['Googlebot/2.1', 'Mozilla/5.0 HeadlessChrome/120', 'python-requests/2.31', 'curl/8.4', 'ChatGPT-User/1.0', '']) {
      expect(isAutomatedTraffic(ua, false), ua).toBe(true);
    }
    expect(isAutomatedTraffic(BROWSER_UA, false)).toBe(false);
    expect(isAutomatedTraffic(BROWSER_UA, true), 'the page reported navigator.webdriver').toBe(true);
  });

  it('a bot batch adds no cells, no views and no scroll; it increments `bots`', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await setToggle('analytics.heatmaps', 'on');
    expect((await heat(orgId, { events: EVENTS })).status).toBe(204); // a human first: the page exists
    expect((await heat(orgId, { events: EVENTS }, 'Mozilla/5.0 (compatible; Googlebot/2.1)')).status).toBe(204);
    expect((await heat(orgId, { events: EVENTS, automation: true })).status).toBe(204);
    const v = await owner.get<{ views: number; bots: number; totalClicks: number }>(`/host/openwop-app/analytics/orgs/${orgId}/heatmap?page=%2Fpricing`);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ views: 1, bots: 2, totalClicks: 2 });
  });

  it('bot traffic alone never creates a page (so it cannot fill the page cap)', async () => {
    const { orgId } = await ownerWithOrg();
    await setToggle('analytics.heatmaps', 'on');
    await heat(orgId, { page: '/bots-only', events: EVENTS }, 'AhrefsBot/7.0');
    expect(await __listHeatRowsForTests()).toEqual([]);
  });
});

describe('ADR 0951 P1 — consent and toggles', () => {
  it('a visitor whose analytics consent is refused records nothing (uniform 204)', async () => {
    const { orgId, tenantId } = await ownerWithOrg();
    await setToggle('analytics.heatmaps', 'on');
    await setToggle('consent', 'on');
    await setPolicy(tenantId, { defaultMode: 'opt-in' });
    const r = await heat(orgId, { events: EVENTS });
    expect(r.status).toBe(204);
    expect(await __listHeatRowsForTests()).toEqual([]);
  });

  it('heat maps OFF: the beacon records nothing (same 204), the config says off, the read 404s', async () => {
    const { owner, orgId } = await ownerWithOrg();
    expect((await heat(orgId, { events: EVENTS })).status).toBe(204);
    expect(await __listHeatRowsForTests()).toEqual([]);
    const cfg = await pub.get<{ heatmaps: boolean }>(`/host/openwop-app/public-analytics/${orgId}/capture-config`);
    expect(cfg.body).toEqual({ heatmaps: false });
    expect((await owner.get(`/host/openwop-app/analytics/orgs/${orgId}/heatmap/pages`)).status).toBe(404);
    await setToggle('analytics.heatmaps', 'on');
    expect((await pub.get<{ heatmaps: boolean }>(`/host/openwop-app/public-analytics/${orgId}/capture-config`)).body).toEqual({ heatmaps: true });
  });
});

describe('ADR 0951 P1 — closed-world input', () => {
  it.each([
    [{ page: '' }, 'page'],
    [{ device: 'watch' }, 'device'],
    [{ events: [] }, 'events'],
    [{ events: new Array(51).fill({ t: 'scroll', depth: 0.1 }) }, 'events'],
    [{ events: [{ t: 'click', x: 2, y: 0 }] }, 'events[0]'],
    [{ events: [{ t: 'click', sel: 'has space' }] }, 'events[0].sel'],
    [{ events: [{ t: 'attn', section: 'a@b.com', ms: 1 }] }, 'events[0].section'],
    [{ events: [{ t: 'keypress', key: 'a' }] }, 'events[0].t'],
  ])('%j is a typed 400 naming %s', async (body, field) => {
    const { orgId } = await ownerWithOrg();
    await setToggle('analytics.heatmaps', 'on');
    const r = await heat(orgId, body) as Res<{ error?: { details?: { field?: string } }; details?: { field?: string } }>;
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.field ?? r.body.details?.field).toBe(field);
    expect(await __listHeatRowsForTests()).toEqual([]);
  });

  it('a page key loses its query and fragment', async () => {
    const { orgId } = await ownerWithOrg();
    await setToggle('analytics.heatmaps', 'on');
    await heat(orgId, { page: '/pricing?email=a@b.com#x', events: EVENTS });
    expect((await __listHeatRowsForTests())[0]!.pageKey).toBe('/pricing');
  });
});

describe('ADR 0951 P1 — bounds and k-anonymity', () => {
  const base = { tenantId: 't-heat', orgId: 'o-heat', pageKey: '/p', arm: '', device: 'desktop' as const, now: new Date() };

  it('valid section names that match Object prototype members retain finite attention totals', async () => {
    await recordHeat(base, [
      { t: 'attn', section: 'constructor', ms: 4000 }, { t: 'attn', section: 'toString', ms: 2000 },
      { t: 'attn', section: 'constructor', ms: 1000 },
    ]);
    const [row] = await __listHeatRowsForTests();
    if (!row) throw new Error('Heat row missing');
    expect(Object.getOwnPropertyDescriptor(row.attention, 'constructor')?.value).toEqual({ ms: 5000, views: 2 });
    expect(Object.getOwnPropertyDescriptor(row.attention, 'toString')?.value).toEqual({ ms: 2000, views: 1 });
  });

  it('simultaneous new pages cannot overfill the last org page slot', async () => {
    const input = { ...base, tenantId: 't-page-cap', orgId: 'o-page-cap' };
    for (let i = 0; i < MAX_PAGES_PER_ORG - 1; i++) {
      expect(await recordHeat({ ...input, pageKey: `/seed-${i}` }, [{ t: 'scroll', depth: 1 }])).toBe(true);
    }
    const accepted = await Promise.all(['/last-a', '/last-b', '/last-c'].map((pageKey) => recordHeat({ ...input, pageKey }, [{ t: 'scroll', depth: 1 }])));
    expect(accepted.filter(Boolean)).toHaveLength(1);
    expect(await listHeatPages(input.tenantId, input.orgId)).toHaveLength(MAX_PAGES_PER_ORG);
  });

  it('valid section names cannot bypass the section cap through Object prototype members', async () => {
    const events = Array.from({ length: MAX_SECTIONS_PER_ROW }, (_, i) => ({ t: 'attn' as const, section: `section-${i}`, ms: 1000 }));
    await recordHeat(base, [...events, { t: 'attn', section: 'constructor', ms: 4000 }, { t: 'attn', section: 'toString', ms: 2000 }]);
    const [row] = await __listHeatRowsForTests();
    if (!row) throw new Error('Heat row missing');
    expect(Object.keys(row.attention)).toHaveLength(MAX_SECTIONS_PER_ROW);
    expect(Object.hasOwn(row.attention, 'constructor')).toBe(false);
    expect(Object.hasOwn(row.attention, 'toString')).toBe(false);
  });

  it('expired page slots are reusable without aging an active page out', async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    for (let i = 0; i < MAX_PAGES_PER_ORG; i++) await recordHeat({ ...base, pageKey: `/expired-${i}`, now: old }, [{ t: 'scroll', depth: 1 }]);
    expect(await recordHeat({ ...base, pageKey: '/active' }, [{ t: 'scroll', depth: 1 }])).toBe(true);
    expect((await listHeatPages(base.tenantId, base.orgId)).map((p) => p.pageKey)).toEqual(['/active']);
  });

  it.each([MAX_PAGES_PER_ORG, MAX_PAGES_PER_ORG + 1])('legacy metadata for %i pages is retained and denies new admissions', async (count) => {
    const storage = __hostExtStorage();
    if (!storage) throw new Error('Heat storage missing');
    const at = new Date().toISOString();
    for (let i = 0; i < count; i++) {
      const pageKey = `/legacy-${i}`;
      const hash = createHash('sha256').update(pageKey).digest('hex').slice(0, 24);
      await storage.kvSet(`hostext:analytics:heat-page:${base.tenantId}:${base.orgId}:${hash}`, JSON.stringify({ tenantId: base.tenantId, orgId: base.orgId, pageKey, firstSeen: at, lastSeen: at }));
    }
    expect(await listHeatPages(base.tenantId, base.orgId)).toHaveLength(count);
    expect(await recordHeat({ ...base, pageKey: '/extra' }, [{ t: 'scroll', depth: 1 }])).toBe(false);
    expect(await recordHeat({ ...base, pageKey: '/legacy-0' }, [{ t: 'scroll', depth: 1 }])).toBe(true);
    expect(await listHeatPages(base.tenantId, base.orgId)).toHaveLength(count);
  });

  it('a row keeps at most 500 cells; the rest fold into `other`', async () => {
    const clicks = [];
    for (let i = 0; i < MAX_CELLS_PER_ROW + 20; i++) clicks.push({ t: 'click' as const, cell: `s:c${i}` });
    await recordHeat(base, clicks);
    const [row] = await __listHeatRowsForTests();
    expect(Object.keys(row!.clicks)).toHaveLength(MAX_CELLS_PER_ROW + 1);
    expect(row!.clicks[OTHER_CELL]).toBe(20);
  });

  it('an experiment arm below the view floor is suppressed and its cells are not returned', async () => {
    for (let i = 0; i < MIN_ARM_VIEWS - 1; i++) await recordHeat({ ...base, arm: 'exp/b' }, [{ t: 'scroll', depth: 1 }, { t: 'click', cell: 's:only-b' }]);
    const v = await readHeatmap({ ...base, device: 'all', days: 30, arm: 'exp/b' });
    expect(v.arms).toEqual([{ arm: 'exp/b', views: MIN_ARM_VIEWS - 1, suppressed: true }]);
    expect(v.clicks).toEqual([]);
    await recordHeat({ ...base, arm: 'exp/b' }, [{ t: 'scroll', depth: 1 }]);
    const v2 = await readHeatmap({ ...base, device: 'all', days: 30, arm: 'exp/b' });
    expect(v2.arms[0]!.suppressed).toBe(false);
    expect(v2.clicks[0]).toEqual({ cell: 's:only-b', count: MIN_ARM_VIEWS - 1 });
  });

  it('rows age out at 13 months on the kv lane; a recent row stays', async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    await recordHeat({ ...base, pageKey: '/old', now: old }, [{ t: 'scroll', depth: 1 }]);
    await recordHeat({ ...base, pageKey: '/new' }, [{ t: 'scroll', depth: 1 }]);
    await __runKvAgeOutOnce(__hostExtStorage()!);
    expect((await __listHeatRowsForTests()).map((r) => r.pageKey)).toEqual(['/new']);
  });

  it('scroll reach is the share of views reaching each 5% step', async () => {
    await recordHeat(base, [{ t: 'scroll', depth: 1 }, { t: 'scroll', depth: 0.5 }]);
    const v = await readHeatmap({ ...base, device: 'all', days: 7 });
    expect(v.views).toBe(2);
    expect(v.scrollReach[0]).toBe(1);
    expect(v.scrollReach[10]).toBe(1);
    expect(v.scrollReach[11]).toBe(0.5);
    expect(v.scrollReach[20]).toBe(0.5);
  });
});

describe('ADR 0951 P1 — the authed read', () => {
  it('lists pages and is member-only', async () => {
    const { owner, orgId } = await ownerWithOrg();
    await setToggle('analytics.heatmaps', 'on');
    await heat(orgId, { events: EVENTS });
    const pages = await owner.get<{ pages: Array<{ pageKey: string }> }>(`/host/openwop-app/analytics/orgs/${orgId}/heatmap/pages`);
    expect(pages.body.pages.map((p) => p.pageKey)).toEqual(['/pricing']);
    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: `heat-x-${Date.now()}@evil.test` });
    expect([403, 404]).toContain((await stranger.get(`/host/openwop-app/analytics/orgs/${orgId}/heatmap?page=%2Fpricing`)).status);
  });
});
