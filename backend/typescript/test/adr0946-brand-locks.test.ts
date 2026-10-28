/**
 * ADR 0946 P3 (D4) — brand creative locks enforced by construction in the ad
 * renderer.
 *
 * Exit criteria (witnesses): an over-scaled logo nudge is clamped; a
 * non-brand colour is refused.
 *
 * Sabotage: dropping the `maxScale` clamp reddens "an over-scaled logo nudge
 * is clamped"; dropping the background-colour check reddens both "a non-brand
 * colour is refused" cases; dropping `creativeLocksChanged` from the PATCH
 * gate reddens the governance case.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { applyBrandLocks } from '../src/features/creative-briefs/render/brandLocks.js';
import { getTemplate } from '../src/features/creative-briefs/render/templates.js';
import { sanitizeCreativeLocks } from '../src/features/brand/brandService.js';
import { creativeLocksChanged } from '../src/features/brand/routes.js';
import { checkBrandLocks } from '../src/host/contentRules/creative/brandLock.js';
import type { Brand, BrandCreativeLocks } from '../src/features/brand/types.js';
import type { AdLayoutTemplate } from '../src/features/creative-briefs/render/templates.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const TOKENS = { colors: { ink: '#111111', paper: '#ffffff', accent: '#3b5bdb', accentInk: '#ffffff' }, fontFamilies: { sans: 'Inter', serif: 'PT Serif' } };
const LOCKS: BrandCreativeLocks = {
  logo: { required: true, zones: [{ x: 0, y: 0, w: 40, h: 40 }], minPx: 40 },
  textColours: ['#ffffff', '#111111'],
  backgroundColours: ['#ffffff', '#111111', '#3b5bdb'],
  fonts: ['Inter'],
  overrideBounds: { maxScale: 1.05, maxOffsetPct: 2 },
};
const template = (): AdLayoutTemplate => {
  const t = getTemplate('meta.feed.1x1');
  if (!t) throw new Error('template missing');
  return t;
};
const TEXTS = new Set(['headline', 'cta'] as const);

describe('ADR 0946 P3 — applyBrandLocks', () => {
  it('an over-scaled logo nudge is clamped to the brand bounds', () => {
    const out = applyBrandLocks({ template: template(), tokens: TOKENS, locks: LOCKS, overrides: { logo: { scale: 1.25, dx: 500 } }, logoPresent: true, textLayerIds: TEXTS });
    expect(out.overrides?.logo?.scale).toBe(1.05);
    expect(out.overrides?.logo?.dx).toBe(21); // 2% of 1080 = 21.6, truncated so it never exceeds the bound
    expect(out.warnings.map((w) => [w.code, w.layerId])).toEqual([['brand-lock-clamped', 'logo']]);
    expect(out.lockFacts.nudges.logo).toEqual({ scale: 1.05, dxPct: 1.94, dyPct: 0 });
    // Without locks the renderer's own clamp still applies, and nothing changes here.
    const free = applyBrandLocks({ template: template(), tokens: TOKENS, locks: undefined, overrides: { logo: { scale: 1.25 } }, logoPresent: true, textLayerIds: TEXTS });
    expect(free.overrides).toEqual({ logo: { scale: 1.25 } });
    expect(free.warnings).toEqual([]);
  });

  it('a non-brand colour is refused (typed brand_lock_violation)', () => {
    const offBrand = { ...TOKENS, colors: { ...TOKENS.colors, accent: '#ff00ff' } };
    let err: unknown;
    try {
      applyBrandLocks({ template: template(), tokens: offBrand, locks: LOCKS, overrides: undefined, logoPresent: true, textLayerIds: TEXTS });
    } catch (e) { err = e; }
    expect(err).toMatchObject({ httpStatus: 400, details: { reason: 'brand_lock_violation', violations: [{ code: 'background_colour', detail: '#ff00ff' }] } });
  });

  it('refuses an unlisted font, a missing required logo, and a logo slot outside its zones', () => {
    const run = (locks: BrandCreativeLocks, logoPresent = true, tokens = TOKENS): string[] => {
      try { applyBrandLocks({ template: template(), tokens, locks, overrides: undefined, logoPresent, textLayerIds: TEXTS }); return []; }
      catch (e) { return ((e as { details: { violations: Array<{ code: string }> } }).details.violations).map((v) => v.code); }
    };
    expect(run(LOCKS)).toEqual([]);
    expect(run({ ...LOCKS, fonts: ['Helvetica'] })).toEqual(['font']);
    expect(run(LOCKS, false)).toEqual(['logo_missing']);
    expect(run({ ...LOCKS, logo: { required: true, zones: [{ x: 60, y: 60, w: 40, h: 40 }], minPx: 40 } })).toEqual(['logo_zone']);
    expect(run({ ...LOCKS, logo: { required: true, zones: [], minPx: 4000 } })).toEqual(['logo_size']);
  });

  it('reports lock facts the P2 brand-lock rule can re-check', () => {
    const out = applyBrandLocks({ template: template(), tokens: TOKENS, locks: undefined, overrides: undefined, logoPresent: true, textLayerIds: TEXTS });
    expect(out.lockFacts).toMatchObject({ logoPresent: true, fonts: ['inter'], disclaimerPresent: false });
    expect(out.lockFacts.textColours.length).toBeGreaterThan(0);
    expect(out.lockFacts.backgroundColours).toContain('#ffffff');
    expect(out.lockFacts.logoBox).toBeDefined();
  });

  it('one type end to end: a locked render\'s facts pass the P2 brand-lock pre-flight rule', () => {
    const out = applyBrandLocks({ template: template(), tokens: TOKENS, locks: LOCKS, overrides: { logo: { scale: 1.25 } }, logoPresent: true, textLayerIds: TEXTS });
    const member = { memberId: 'm1', conceptId: 'c1', channel: 'meta.feed', kind: 'image' as const, render: { textLayers: [], lockFacts: out.lockFacts } };
    expect(checkBrandLocks(member, LOCKS)).toEqual([]);
    // The rule still catches what the renderer would have clamped.
    const raw = { ...member, render: { textLayers: [], lockFacts: { ...out.lockFacts, nudges: { logo: { scale: 1.25 } } } } };
    expect(checkBrandLocks(raw, LOCKS).map((f) => f.ruleId)).toEqual(['brand-lock.override_bounds']);
  });

  it('sanitizes locks closed-world and detects a change on the sanitized image', () => {
    const s = sanitizeCreativeLocks({ textColours: ['#FFF', 'red', '#12345'], fonts: ['Inter', 'x;{}'], overrideBounds: { maxScale: 9, maxOffsetPct: -1 }, logo: { required: true, zones: [{ x: 0, y: 0, w: 120, h: 10 }, { x: 0, y: 0, w: 20, h: 20 }], minPx: 32 }, junk: 1 });
    expect(s).toEqual({ textColours: ['#fff'], backgroundColours: [], fonts: ['Inter'], overrideBounds: { maxScale: 1.25, maxOffsetPct: 10 }, logo: { required: true, zones: [{ x: 0, y: 0, w: 20, h: 20 }], minPx: 32 } });
    expect(sanitizeCreativeLocks(null)).toBeUndefined();
    const brand = { creativeLocks: s } as unknown as Brand;
    expect(creativeLocksChanged(brand, {})).toBe(false);
    expect(creativeLocksChanged(brand, { creativeLocks: { ...s } })).toBe(false);
    expect(creativeLocksChanged(brand, { creativeLocks: null })).toBe(true);
  });
});

describe('ADR 0946 P3 — routes', () => {
  let BASE = '';
  let server: http.Server;
  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    for (const id of ['users', 'creative-briefs', 'media', 'brand']) {
      const d = getToggleDefault(id);
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  interface Res { status: number; body: Record<string, unknown> & { details?: { reason?: string } } }
  const client = () => {
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', connection: 'close', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
      return { status: res.status, body: (await res.json().catch(() => ({}))) as Res['body'] };
    };
    return { call };
  };
  const CB = (orgId: string, s: string): string => `/host/openwop-app/creative-briefs/orgs/${encodeURIComponent(orgId)}${s}`;
  const owner = async () => {
    const c = client();
    const tenantId = `org:bl-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    expect((await c.call('POST', '/host/openwop-app/test/login', { email: `bl-${Date.now()}-${Math.random()}@t.test`, tenantId })).status).toBe(201);
    const org = await c.call('POST', '/host/openwop-app/orgs', { name: 'Acme' });
    return { c, orgId: org.body.orgId as string, tenantId };
  };
  const ROUTE_LOCKS = { textColours: ['#ffffff', '#111111'], backgroundColours: ['#ffffff', '#111111', '#3b5bdb'], fonts: ['Inter'], overrideBounds: { maxScale: 1.1, maxOffsetPct: 5 } };

  it('a brief palette colour outside the brand locks is refused at render; an on-brand render stores its lock facts', async () => {
    const { c, orgId } = await owner();
    const brand = await c.call('POST', '/host/openwop-app/brand/brands', { orgId, name: 'Acme', creativeLocks: ROUTE_LOCKS });
    expect(brand.status, JSON.stringify(brand.body)).toBe(201);
    const onBrand = await c.call('POST', CB(orgId, '/briefs'), { title: 'On brand', assetType: 'image', sceneDescription: 'S.', directions: [{ label: 'Headline' }] });
    const ok = await c.call('POST', CB(orgId, `/briefs/${String(onBrand.body.briefId)}/renders`), { templateId: 'meta.feed.1x1', directionIndex: 0, copy: { cta: 'Shop now' }, overrides: { logo: { scale: 1.25 } } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.overrides).toEqual({ logo: { scale: 1.1 } });
    expect(ok.body.lockFacts).toMatchObject({ fonts: ['inter'], logoPresent: false });

    const offBrand = await c.call('POST', CB(orgId, '/briefs'), { title: 'Off brand', assetType: 'image', sceneDescription: 'S.', brandPalette: ['#ff00ff'], directions: [{ label: 'Headline' }] });
    const refused = await c.call('POST', CB(orgId, `/briefs/${String(offBrand.body.briefId)}/renders`), { templateId: 'meta.feed.1x1', directionIndex: 0, copy: { cta: 'Shop now' } });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body.details?.reason).toBe('brand_lock_violation');
  });

  it('changing creative locks takes the governance bar (a non-admin editor is refused)', async () => {
    const { c, orgId, tenantId } = await owner();
    const brand = await c.call('POST', '/host/openwop-app/brand/brands', { orgId, name: 'Acme', creativeLocks: ROUTE_LOCKS });
    const brandId = String((brand.body.brand as { id: string }).id);
    // An editor in the same tenant, added to the org without admin rights.
    const ed = client();
    const login = await ed.call('POST', '/host/openwop-app/test/login', { email: `ed-${Date.now()}@t.test`, tenantId });
    const userId = String((login.body.user as { userId: string }).userId);
    expect((await c.call('POST', `/host/openwop-app/orgs/${orgId}/members`, { displayName: 'Ed', subject: userId, roles: ['editor'] })).status).toBeLessThan(300);
    const blocked = await ed.call('PATCH', `/host/openwop-app/brand/brands/${brandId}`, { creativeLocks: null });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(403);
    // A content edit by the same editor still goes through.
    expect((await ed.call('PATCH', `/host/openwop-app/brand/brands/${brandId}`, { description: 'New copy' })).status).toBe(200);
    // The owner (org admin) may change them, and the change lands in the guardrail audit trail.
    expect((await c.call('PATCH', `/host/openwop-app/brand/brands/${brandId}`, { creativeLocks: { ...ROUTE_LOCKS, fonts: ['Inter', 'PT Serif'] } })).status).toBe(200);
    const audit = await c.call('GET', `/host/openwop-app/brand/brands/${brandId}/audit`);
    const fields = ((audit.body.audit ?? []) as Array<{ changes: Array<{ field: string }> }>).flatMap((r) => r.changes.map((ch) => ch.field));
    expect(fields).toContain('creativeLocks');
  });
});
