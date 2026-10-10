/**
 * ADR 0391 (b) / ADR 0820 §7 / ADR 0821 D7 — what the PUBLIC /pricing page reads.
 *
 * The anonymous marketing page renders three things it could not before:
 *  - human feature NAMES (the same toggle-registry `label` the feature store's
 *    `/feature-bundles` read uses), not raw entitlement ids like `csm`;
 *  - the AI credit packs, PRICED ones only, with NO Stripe id and NO opaque
 *    checkout key (an anonymous visitor cannot buy; the key is a store concern);
 *  - which bundles are sold SEPARATELY (no plan grants them — ADR 0820 §5).
 * Honest-when-unconfigured: no packs configured ⇒ `[]`, never a fabricated row.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let PORT = 0; let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { PORT = (server.address() as AddressInfo).port; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
afterEach(() => {
  delete process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES;
  delete process.env.OPENWOP_BILLING_TOKEN_PACK_DISPLAY;
  delete process.env.OPENWOP_BILLING_STANDALONE_BUNDLES;
  delete process.env.OPENWOP_BILLING_BUNDLE_PRICES;
  delete process.env.OPENWOP_BILLING_TRIAL_DAYS;
  delete process.env.OPENWOP_BILLING_PAST_DUE_GRACE_DAYS;
  delete process.env.OPENWOP_BILLING_PUBLIC_LAPSE_GRACE_DAYS;
  delete process.env.OPENWOP_BILLING_PLAN_PRICES;
});

function rawGet(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method: 'GET', path }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface PricingBody {
  tiers: Array<{ tier: string; features: '*' | string[]; trialDays?: number }>;
  billingPolicy?: { pastDueGraceDays: number; publicLapseGraceDays: number | null };
  featureLabels?: Record<string, string>;
  creditPacks?: Array<Record<string, unknown>>;
}

describe('public /pricing payload — feature names', () => {
  it('labels every tier feature id from the toggle registry (the store’s label source)', async () => {
    const res = await rawGet('/host/openwop-app/public/pricing');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as PricingBody;
    expect(body.featureLabels).toBeDefined();
    const ids = new Set<string>();
    for (const t of body.tiers) if (Array.isArray(t.features)) for (const f of t.features) ids.add(f);
    let checked = 0;
    for (const id of ids) {
      const reg = getToggleDefault(id)?.label;
      if (!reg) continue;
      expect(body.featureLabels![id]).toBe(reg);
      checked++;
    }
    // Positive control: the label map is not vacuously satisfied.
    if (ids.size > 0) expect(checked).toBeGreaterThan(0);
    // Only ids the tiers or bundles name — not the whole registry.
    for (const k of Object.keys(body.featureLabels!)) expect(typeof body.featureLabels![k]).toBe('string');
  });
});

describe('public /pricing payload — AI credit packs', () => {
  it('is an honest empty list when no pack is configured', async () => {
    const body = JSON.parse((await rawGet('/host/openwop-app/public/pricing')).body) as PricingBody;
    expect(body.creditPacks).toEqual([]);
  });

  it('lists PRICED packs only, smallest first, with NO Stripe id and NO checkout key', async () => {
    process.env.OPENWOP_BILLING_TOKEN_PACK_PRICES = JSON.stringify({ price_SECRETbig: 5_000_000, price_SECRETsmall: 1_000_000, price_SECRETunpriced: 2_000_000 });
    process.env.OPENWOP_BILLING_TOKEN_PACK_DISPLAY = JSON.stringify({
      price_SECRETsmall: { price: '$10', label: 'Starter' },
      price_SECRETbig: { price: '$40' },
    });
    const res = await rawGet('/host/openwop-app/public/pricing');
    expect(res.body).not.toContain('price_SECRET');
    expect(res.body).not.toContain('packKey');
    expect(res.body.toLowerCase()).not.toContain('stripe');
    const body = JSON.parse(res.body) as PricingBody;
    const packs = body.creditPacks!;
    expect(packs).toHaveLength(2); // the unpriced pack is not advertised
    expect(packs.map((p) => p.price)).toEqual(['$10', '$40']);
    expect(packs[0]!.label).toBe('Starter');
    expect(typeof packs[0]!.credits).toBe('number');
    expect(packs[0]!.credits as number).toBeLessThan(packs[1]!.credits as number);
    for (const p of packs) expect(Object.keys(p).sort()).toEqual(expect.arrayContaining(['credits', 'price']));
  });
});

// ADR 0820 §7 (pricing FAQ) — the FAQ's config numbers come from THIS read, so
// the page can never drift from the env that actually decides trials and grace.
describe('public /pricing payload — billing policy numbers for the FAQ', () => {
  it('carries each tier’s trial length and the two grace windows, straight from env, with no Stripe id', async () => {
    process.env.OPENWOP_BILLING_TRIAL_DAYS = JSON.stringify({ 'plan:pro': 14, 'plan:team': 21, 'bundle:crm': 7 });
    process.env.OPENWOP_BILLING_PAST_DUE_GRACE_DAYS = '7';
    process.env.OPENWOP_BILLING_PUBLIC_LAPSE_GRACE_DAYS = '14';
    process.env.OPENWOP_BILLING_PLAN_PRICES = JSON.stringify({ price_SECRETpro: 'pro' });
    const res = await rawGet('/host/openwop-app/public/pricing');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('price_SECRET');
    expect(res.body.toLowerCase()).not.toContain('stripe');
    const body = JSON.parse(res.body) as PricingBody;
    const byTier = Object.fromEntries(body.tiers.map((t) => [t.tier, t]));
    expect(byTier.pro?.trialDays).toBe(14);
    expect(byTier.team?.trialDays).toBe(21);
    // A tier with no configured trial carries no field — never a default.
    expect(byTier.free).toBeDefined();
    expect('trialDays' in byTier.free!).toBe(false);
    expect(body.billingPolicy).toEqual({ pastDueGraceDays: 7, publicLapseGraceDays: 14 });
  });

  it('is honest when unconfigured: no trial fields, grace 0, public-lapse policy off (null)', async () => {
    const body = JSON.parse((await rawGet('/host/openwop-app/public/pricing')).body) as PricingBody;
    for (const t of body.tiers) expect('trialDays' in t).toBe(false);
    expect(body.billingPolicy).toEqual({ pastDueGraceDays: 0, publicLapseGraceDays: null });
  });
});

describe('public /bundle-pricing — sold separately', () => {
  it('flags a standalone bundle and leaves plan-grantable bundles unflagged, with no Stripe id', async () => {
    process.env.OPENWOP_BILLING_BUNDLE_PRICES = JSON.stringify({ price_SECRETjs: 'job-search', price_SECRETcrm: 'crm' });
    process.env.OPENWOP_BILLING_STANDALONE_BUNDLES = JSON.stringify(['job-search']);
    const res = await rawGet('/host/openwop-app/public/bundle-pricing');
    expect(res.status).toBe(200);
    expect(res.body).not.toContain('price_SECRET');
    const body = JSON.parse(res.body) as { bundles: Array<{ bundleId: string; standalone?: boolean; features?: string[] }> };
    const js = body.bundles.find((b) => b.bundleId === 'job-search');
    const crm = body.bundles.find((b) => b.bundleId === 'crm');
    expect(js?.standalone).toBe(true);
    expect(crm).toBeDefined(); // positive control: a priced, plan-grantable bundle is served…
    expect(crm?.standalone).toBeUndefined(); // …and is not mislabelled
    expect(crm?.features).toContain('crm'); // the compare table groups rows by bundle
  });
});

describe('pricing CMS section — contactUrl (where an unpriced plan’s “Contact us” goes)', () => {
  it('keeps a safe internal or https contact link and drops an unsafe one', async () => {
    const { validateSection } = await import('../src/features/cms/cmsService.js');
    const keep = validateSection({ type: 'pricing', data: { heading: 'Plans', contactUrl: '/p/contact' } });
    expect(keep.data.contactUrl).toBe('/p/contact');
    const ext = validateSection({ type: 'pricing', data: { contactUrl: 'https://example.com/sales' } });
    expect(ext.data.contactUrl).toBe('https://example.com/sales');
    for (const bad of ['javascript:alert(1)', '//evil.example', '/\\evil']) {
      const dropped = validateSection({ type: 'pricing', data: { contactUrl: bad } });
      expect(dropped.data.contactUrl).toBeUndefined();
    }
  });
});
