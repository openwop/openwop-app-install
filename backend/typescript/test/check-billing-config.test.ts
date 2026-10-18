/**
 * ADR 0820 §5 / §7 — `scripts/check-billing-config.mjs`, the operator's billing
 * preflight, run as the real entry point against crafted env:
 *   1. a ladder that references bundles (`bundle:<id>`) and sells a standalone
 *      bundle on its own is GREEN (positive control);
 *   2. a plan listing a standalone bundle's feature — literally or by `bundle:` — is
 *      an ERROR;
 *   3. an unpriced standalone bundle is locked-and-unbuyable under a `'*'` plan;
 *   4. an unknown `bundle:` reference, a malformed trial / cadence / grace value, and
 *      a key naming no real plan / bundle / price are ERRORs;
 *   5. ADR 0821 D7 — `OPENWOP_BILLING_TOKEN_PACK_DISPLAY` keys must be configured pack
 *      prices (ERROR otherwise), each entry an object of string `price`/`label`; a pack
 *      with no display `price` WARNs (the store lists it with no buy button).
 *   6. ADR 0890 — the checkout-option knobs: valid bare and keyed values are GREEN;
 *      a value the host ignores or a key naming nothing real is an ERROR; `managed` on
 *      a pre-dahlia API version and a no-trial `if_required` WARN.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'check-billing-config.mjs');
const bundles = (JSON.parse(readFileSync(join(ROOT, 'distributions', 'bundles.json'), 'utf8')) as { bundles: Record<string, { features: string[] }> }).bundles;
const unpriced = Object.keys(bundles).filter((b) => b !== 'crm' && b !== 'job-search');

/** A green ladder: free = every unpriced bundle by reference; pro adds crm by
 *  reference; job-search is priced and standalone; team/enterprise are '*'. */
function baseEnv(): Record<string, string> {
  return {
    OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify({
      free: unpriced.map((b) => `bundle:${b}`),
      pro: [...unpriced, 'crm'].map((b) => `bundle:${b}`),
    }),
    OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_crm: 'crm', price_crm_year: 'crm', price_job: 'job-search' }),
    OPENWOP_BILLING_BUNDLE_DISPLAY: JSON.stringify({ crm: { price: '$29' }, 'job-search': { price: '$19' } }),
    OPENWOP_BILLING_PLAN_PRICES: JSON.stringify({ price_pro: 'pro', price_pro_year: 'pro' }),
    OPENWOP_BILLING_STANDALONE_BUNDLES: JSON.stringify(['job-search']),
    OPENWOP_BILLING_TRIAL_DAYS: JSON.stringify({ 'plan:pro': 14, 'bundle:crm': 7 }),
    OPENWOP_BILLING_PAST_DUE_GRACE_DAYS: '7',
    OPENWOP_BILLING_BUNDLE_PRICE_CADENCE: JSON.stringify({ price_crm_year: 'year' }),
    OPENWOP_BILLING_PLAN_PRICE_CADENCE: JSON.stringify({ price_pro_year: 'year' }),
    OPENWOP_BILLING_TOKEN_PACK_PRICES: JSON.stringify({ price_pack_1k: 1_000_000, price_pack_5k: 5_000_000 }),
    OPENWOP_BILLING_TOKEN_PACK_DISPLAY: JSON.stringify({ price_pack_1k: { price: '$5' }, price_pack_5k: { price: '$20', label: 'Popular' } }),
  };
}
function run(env: Record<string, string>): { code: number | null; out: string } {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('OPENWOP_BILLING_')) clean[k] = v;
  const r = spawnSync(process.execPath, [SCRIPT], { env: { ...clean, ...env }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}
const withEnv = (patch: Record<string, string>) => run({ ...baseEnv(), ...patch });

describe('check-billing-config — ADR 0820 §5/§7', () => {
  it('POSITIVE CONTROL: a bundle-referencing ladder with a priced standalone bundle is green', () => {
    const r = run(baseEnv());
    expect(r.out).not.toContain('ERROR');
    expect(r.code).toBe(0);
    expect(r.out).toContain('standalone: job-search');
  });
  it('a plan listing a standalone feature literally is an ERROR', () => {
    const plans = JSON.parse(baseEnv().OPENWOP_BILLING_PLAN_FEATURES) as Record<string, string[]>;
    plans.pro.push('job-search');
    const r = withEnv({ OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify(plans) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ERROR plan 'pro' lists 'job-search' of standalone bundle 'job-search'/);
  });
  it('a plan listing a standalone bundle by reference is an ERROR', () => {
    const plans = JSON.parse(baseEnv().OPENWOP_BILLING_PLAN_FEATURES) as Record<string, string[]>;
    plans.free.push('bundle:job-search');
    const r = withEnv({ OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify(plans) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ERROR plan 'free' lists 'job-search' of standalone bundle/);
  });
  it('an UNPRICED standalone bundle is locked-and-unbuyable even under a "*" plan', () => {
    const r = withEnv({ OPENWOP_BILLING_BUNDLE_PRICES: JSON.stringify({ price_crm: 'crm' }) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/ERROR plan 'team': 'job-search' \(bundle 'job-search'\) is locked and has no price/);
  });
  it('an unknown bundle reference and an unknown standalone bundle are ERRORs', () => {
    const plans = JSON.parse(baseEnv().OPENWOP_BILLING_PLAN_FEATURES) as Record<string, string[]>;
    plans.pro.push('bundle:not-a-bundle');
    const r = withEnv({ OPENWOP_BILLING_PLAN_FEATURES: JSON.stringify(plans), OPENWOP_BILLING_STANDALONE_BUNDLES: JSON.stringify(['job-search', 'nope']) });
    expect(r.code).toBe(1);
    expect(r.out).toContain("references 'bundle:not-a-bundle', which is not a bundle");
    expect(r.out).toContain("STANDALONE_BUNDLES names 'nope'");
  });
  it('malformed trial / grace / cadence values and keys naming nothing real are ERRORs', () => {
    const r = withEnv({
      OPENWOP_BILLING_TRIAL_DAYS: JSON.stringify({ 'plan:gold': 14, 'bundle:crm': 0, 'crm': 7 }),
      OPENWOP_BILLING_PAST_DUE_GRACE_DAYS: 'seven',
      OPENWOP_BILLING_BUNDLE_PRICE_CADENCE: JSON.stringify({ price_crm_year: 'annual', price_missing: 'year' }),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("key 'plan:gold' names no paid plan tier");
    expect(r.out).toContain("TRIAL_DAYS['bundle:crm'] must be a whole number");
    expect(r.out).toContain("key 'crm' must start with");
    expect(r.out).toContain('PAST_DUE_GRACE_DAYS must be a whole number');
    expect(r.out).toContain("price_crm_year'] must be \"month\" or \"year\"");
    expect(r.out).toContain("names price 'price_missing', which is not in its price catalog");
  });
  it('two monthly prices for one bundle WARN (checkout sells only the first)', () => {
    const r = withEnv({ OPENWOP_BILLING_BUNDLE_PRICE_CADENCE: JSON.stringify({}) });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/WARN\s+bundle 'crm' has two monthly prices/);
  });
  it('ADR 0821 D7 — token-pack display keys must be configured pack prices; bad shapes are ERRORs', () => {
    const r = withEnv({
      OPENWOP_BILLING_TOKEN_PACK_DISPLAY: JSON.stringify({ price_pack_1k: { price: 5 }, price_not_a_pack: { price: '$9' }, price_pack_5k: 'twenty' }),
    });
    expect(r.code).toBe(1);
    expect(r.out).toContain("TOKEN_PACK_DISPLAY names price 'price_not_a_pack', which is not in OPENWOP_BILLING_TOKEN_PACK_PRICES");
    expect(r.out).toContain("TOKEN_PACK_DISPLAY['price_pack_1k'].price must be a string");
    expect(r.out).toContain("TOKEN_PACK_DISPLAY['price_pack_5k'] must be an object");
  });
  it('ADR 0821 D7 — a pack with no display price WARNs (listed, not buyable); no display env at all is fine', () => {
    const partial = withEnv({ OPENWOP_BILLING_TOKEN_PACK_DISPLAY: JSON.stringify({ price_pack_1k: { price: '$5' } }) });
    expect(partial.code).toBe(0);
    expect(partial.out).toMatch(/WARN\s+token pack 'price_pack_5k' has no OPENWOP_BILLING_TOKEN_PACK_DISPLAY price/);
    const env = baseEnv();
    delete (env as Record<string, string | undefined>).OPENWOP_BILLING_TOKEN_PACK_DISPLAY;
    const none = run(env);
    expect(none.code).toBe(0);
    expect(none.out).not.toContain('ERROR');
  });
  it('ADR 0890 — valid checkout options are green; bad values and keys are ERRORs', () => {
    const ok = withEnv({
      OPENWOP_BILLING_CHECKOUT_TAX: JSON.stringify({ '*': 'automatic', 'bundle:crm': 'managed', 'plan:pro': 'none' }),
      OPENWOP_BILLING_ALLOW_PROMOTION_CODES: 'true',
      OPENWOP_BILLING_TRIAL_CARD: JSON.stringify({ 'bundle:crm': 'if_required' }),
      OPENWOP_STRIPE_API_VERSION: '2026-04-22.dahlia',
    });
    expect(ok.code).toBe(0);
    expect(ok.out).not.toContain('ERROR');
    expect(ok.out).not.toContain('ADR 0890');
    const bad = withEnv({
      OPENWOP_BILLING_CHECKOUT_TAX: JSON.stringify({ 'bundle:crm': 'manged', 'bundle:nope': 'automatic', crm: 'none' }),
      OPENWOP_BILLING_ALLOW_PROMOTION_CODES: JSON.stringify({ 'plan:free': true, '*': 'yes' }),
      OPENWOP_BILLING_TRIAL_CARD: 'never',
    });
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("OPENWOP_BILLING_CHECKOUT_TAX['bundle:crm'] must be \"none\", \"automatic\" or \"managed\"");
    expect(bad.out).toContain("OPENWOP_BILLING_CHECKOUT_TAX key 'bundle:nope' names no bundle");
    expect(bad.out).toContain("OPENWOP_BILLING_CHECKOUT_TAX key 'crm' must be \"*\" or start with");
    expect(bad.out).toContain("OPENWOP_BILLING_ALLOW_PROMOTION_CODES key 'plan:free' names no paid plan tier");
    expect(bad.out).toContain("OPENWOP_BILLING_ALLOW_PROMOTION_CODES['*'] must be true or false");
    expect(bad.out).toContain("OPENWOP_BILLING_TRIAL_CARD['*'] must be \"required\" or \"if_required\"");
  });
  it('ADR 0890 — managed on the pinned clover version and a no-trial if_required WARN', () => {
    const r = withEnv({
      OPENWOP_BILLING_CHECKOUT_TAX: JSON.stringify({ 'bundle:crm': 'managed' }),
      OPENWOP_BILLING_TRIAL_CARD: JSON.stringify({ 'bundle:job-search': 'if_required' }),
      OPENWOP_STRIPE_API_VERSION: '2025-12-15.clover',
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/WARN\s+OPENWOP_BILLING_CHECKOUT_TAX is "managed" for bundle:crm but the Stripe API version is 2025-12-15\.clover/);
    expect(r.out).toMatch(/WARN\s+OPENWOP_BILLING_TRIAL_CARD key 'bundle:job-search' is "if_required" but has no OPENWOP_BILLING_TRIAL_DAYS entry/);
  });
});
