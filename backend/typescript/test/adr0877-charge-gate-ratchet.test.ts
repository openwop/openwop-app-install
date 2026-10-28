/**
 * ADR 0877 D2 (architect H4) — the storefront charge gate, enforced by CALL, not
 * by import (the org-seam #3036 lesson).
 *
 * Every Stripe call that opens money is pinned here per creator, to the files
 * allowed to make it. The three storefront creators take a `StorefrontCharge`,
 * which only `resolveStorefrontSettlement` can mint (the single `as
 * StorefrontCharge` cast lives in that module). So a fifth charge lane cannot be
 * added with a bare key: it either fails to compile or fails this test. *
 * Tracker TST-BFC-8. Red when: a StorefrontCharge is cast outside the
 * resolver; a creator is called from an unsanctioned file; subscriptions.ts
 * resolves a key for a new subscription.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : p.endsWith('.ts') ? [p] : [];
  });
}
const files = walk(SRC).map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, 'utf8') }));
const callersOf = (fn: string): string[] =>
  files.filter((f) => f.rel !== 'features/billing/stripeApi.ts' && new RegExp(`\\b${fn}\\(`).test(f.text)).map((f) => f.rel).sort();

describe('ADR 0877 — every money-opening Stripe call is pinned by creator', () => {
  it.each([
    // The three storefront creators: a tenant's sale. Must ride the charge gate.
    ['createStripeOrderCheckoutSession', ['features/commerce/routes.ts']],
    ['createStripeOffSessionPaymentIntent', ['features/commerce/routes.ts']],
    ['createStripeSubscription', ['features/commerce/subscriptions.ts']],
    // The operator selling its OWN plans: the platform is the merchant by definition.
    ['createStripeCheckoutSession', ['features/billing/billingService.ts']],
    // The pack marketplace: already a destination charge to the seller (ADR 0385).
    ['createStripeConnectCheckoutSession', ['features/commerce-connect/orders.ts']],
  ])('%s is called only from its sanctioned file(s)', (fn, allowed) => {
    expect(callersOf(fn)).toEqual(allowed);
  });

  it('a StorefrontCharge is minted only by the settlement resolver', () => {
    // Any cast shape: `x as StorefrontCharge`, `x as unknown as StorefrontCharge`,
    // `<StorefrontCharge>x`. A backticked mention in prose is not a cast.
    const minting = files.filter((f) => /[^`]\bas\s+(?:unknown\s+as\s+)?StorefrontCharge\b|<StorefrontCharge>/.test(f.text)).map((f) => f.rel);
    expect(minting).toEqual(['features/commerce-connect/storefrontSettlement.ts']);
  });

  it('the test-only platform mint is imported by no production module (grade-code CC2CD-2)', () => {
    const importers = files.filter((f) => f.rel !== 'features/commerce-connect/storefrontSettlement.ts' && /__platformChargeForTest/.test(f.text)).map((f) => f.rel);
    expect(importers).toEqual([]);
  });

  it('every storefront charge-opening file asks the resolver', () => {
    for (const rel of ['features/commerce/routes.ts']) {
      const text = files.find((f) => f.rel === rel)!.text;
      expect(text, rel).toMatch(/resolveStorefrontSettlement\(/);
    }
    // subscriptions.ts receives the charge from the route; it never resolves a key for a NEW subscription.
    const subs = files.find((f) => f.rel === 'features/commerce/subscriptions.ts')!.text;
    expect(subs).not.toMatch(/createStripeSubscription\([^)]*resolveSecret/);
  });
});
