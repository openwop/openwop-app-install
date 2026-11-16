/**
 * ADR 0877 D2 (architect H4) — the storefront charge gate, enforced by CALL, not
 * by import (the org-seam #3036 lesson).
 *
 * Every Stripe call that opens money is pinned here per creator, to the files
 * allowed to make it. The three storefront creators take a `StorefrontCharge`,
 * which only `resolveStorefrontSettlement` can mint (the single `as
 * StorefrontCharge` cast lives in that module). So a fifth charge lane cannot be
 * added with a bare key: it either fails to compile or fails this test. *
 * Scope: the sanctioned-CALLER lists are first-party only, because an adopter's
 * `src/adopter/` tree (ADR 1031) pins its own callers in its own ratchet. The
 * mint and test-mint guards still cover EVERY file, adopter code included: an
 * adopter that casts a StorefrontCharge bypasses the gate whatever it calls.
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
const isAdopter = (rel: string): boolean => rel.split('\\').join('/').startsWith('adopter/');
// First-party callers only (see Scope above); `files` itself stays whole.
const callersOf = (fn: string): string[] =>
  files.filter((f) => !isAdopter(f.rel) && f.rel !== 'features/billing/stripeApi.ts' && new RegExp(`\\b${fn}\\(`).test(f.text)).map((f) => f.rel).sort();
// Shared by the guards and their witnesses, so a witness exercises the exact predicate.
const minters = (fs: { rel: string; text: string }[]): string[] =>
  fs.filter((f) => /[^`]\bas\s+(?:unknown\s+as\s+)?StorefrontCharge\b|<StorefrontCharge>/.test(f.text)).map((f) => f.rel);
const testMintImporters = (fs: { rel: string; text: string }[]): string[] =>
  fs.filter((f) => f.rel !== 'features/commerce-connect/storefrontSettlement.ts' && /__platformChargeForTest/.test(f.text)).map((f) => f.rel);

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
    expect(minters(files)).toEqual(['features/commerce-connect/storefrontSettlement.ts']);
  });

  it('the mint guards still see adopter code (witness: an adopter-path cast and test-mint import go red)', () => {
    const adopterCast = { rel: 'adopter/features/x/charge.ts', text: 'const c = key as StorefrontCharge;' };
    const adopterImport = { rel: 'adopter/features/x/charge.ts', text: "import { __platformChargeForTest } from '../../../features/commerce-connect/storefrontSettlement.js';" };
    expect(minters([...files, adopterCast])).toContain('adopter/features/x/charge.ts');
    expect(testMintImporters([...files, adopterImport])).toContain('adopter/features/x/charge.ts');
    // The guards read the WHOLE tree: nothing is filtered out of `files`.
    expect(files.length).toBe(walk(SRC).length);
    // ...and the caller lists alone are first-party: an adopter caller is the adopter's ratchet.
    expect(isAdopter('adopter/features/x/charge.ts')).toBe(true);
    expect(isAdopter('features/commerce/routes.ts')).toBe(false);
  });

  it('the test-only platform mint is imported by no production module (grade-code CC2CD-2)', () => {
    expect(testMintImporters(files)).toEqual([]);
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
