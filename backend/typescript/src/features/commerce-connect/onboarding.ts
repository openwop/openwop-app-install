/**
 * Commerce Connect — seller Express onboarding + account-state sync (ADR 0385
 * Phase 1; CC-6 split). Stripe drives through billing's ONE client. Calls the
 * GEN-CC-1 fold guard (`stores.assertFoldEligibleTenant`) — one of FOUR lanes
 * that must; see the predicate's docblock for why this file used to claim the
 * property was structural when only two lanes enforced it.
 */
import { OpenwopError } from '../../types.js';
import { resolveSecret } from '../../byok/secretResolver.js';
import { STRIPE_KEY_REF } from '../billing/billingService.js';
import { createStripeConnectAccount, createStripeAccountLink, getStripeConnectAccount } from '../billing/stripeApi.js';
import { sellers, nowIso, requireStripeKey, assertFoldEligibleTenant, type SellerAccount } from './stores.js';
import { bindSellerAccount } from './stores.js';


// ── Seller reads ──────────────────────────────────────────────────────────────

export async function getSeller(tenantId: string): Promise<SellerAccount | null> {
  return sellers.get(tenantId);
}


// ── Onboarding ────────────────────────────────────────────────────────────────

export interface OnboardingStart { seller: SellerAccount; url: string; mode: 'live' | 'demo' }


/**
 * Start (or resume) Connect Express onboarding for the caller's tenant.
 * Live mode CAS-claims the seller row BEFORE the Stripe account creation (two
 * concurrent starts must not mint two Express accounts); the claim is released
 * on Stripe failure so a retry restarts cleanly. A retry with an account already
 * stored just mints a fresh single-use account link. Keyless = the honest demo
 * lane (deterministic `acct_demo_*` id, no Stripe call, `demo:` sentinel URL).
 */
export async function startOnboarding(
  tenantId: string,
  urls: { refreshUrl: string; returnUrl: string },
  input: { country?: string } = {},
): Promise<OnboardingStart> {
  // GEN-CC-1 — the SHARED fold guard (`stores.assertFoldEligibleTenant`).
  //
  // CORRECTED 2026-08-19 (MPL-1 / WF-MKT-13): this comment used to claim the
  // guard made an anon-seller orphan "impossible-by-construction". It did not.
  // The check lived HERE and in `importSellers` only — 2 of the 4 lanes that key
  // a durable row on the tenant — while `upsertPaidListing` and `createCheckout`
  // had none, so an anonymous session could publish an external-link listing
  // with an arbitrary payout URL and complete a real Stripe purchase. The claim
  // is true only now that all four lanes call the one predicate; the reasoning
  // for WHY lives with the predicate, not duplicated per call site.
  assertFoldEligibleTenant(tenantId, 'become a seller');
  const existing = await sellers.get(tenantId);

  // Resume: an account already exists (any state but a released claim) — never a second one.
  if (existing && existing.stripeAccountId) {
    if (existing.onboardingState === 'deauthorized') {
      throw new OpenwopError('validation_error', 'This seller account was deauthorized — contact the operator to re-onboard.', 409, { feature: 'commerce-connect' });
    }
    // Grade pass CC-1: SELF-HEAL the reverse index on resume — a crash between
    // the seller write and the index write would otherwise orphan the mapping
    // and silently drop every future webhook for this seller (incl. payouts).
    await bindSellerAccount(tenantId, existing.stripeAccountId); // ADR 0576 CAS
    if (existing.mode === 'demo') return { seller: existing, url: 'demo:connect-onboarding', mode: 'demo' };
    const key = await requireStripeKey();
    const link = await createStripeAccountLink(key, { accountId: existing.stripeAccountId, ...urls });
    return { seller: existing, url: link.url, mode: 'live' };
  }

  const key = await resolveSecret(STRIPE_KEY_REF);
  const now = nowIso();

  if (!key) {
    // Demo lane — honest, deterministic, no Stripe. CAS keeps it single too.
    const demo: SellerAccount = {
      tenantId, stripeAccountId: `acct_demo_${tenantId}`, onboardingState: 'pending',
      chargesEnabled: false, payoutsEnabled: false, region: input.country?.toUpperCase() ?? '',
      capabilities: [], mode: 'demo', createdAt: now, updatedAt: now,
    };
    await sellers.compareAndSwap(existing, demo);
    const seller = (await sellers.get(tenantId)) ?? demo;
    // CC-1: index write is idempotent and unconditional (CAS loser included) —
    // the mapping is derived from the stored row, so a re-put self-heals.
    await bindSellerAccount(tenantId, seller.stripeAccountId); // ADR 0576 CAS
    return { seller, url: 'demo:connect-onboarding', mode: 'demo' };
  }

  // Live lane — claim first (empty stripeAccountId marks the claim window).
  const claim: SellerAccount = {
    tenantId, stripeAccountId: '', onboardingState: 'pending',
    chargesEnabled: false, payoutsEnabled: false, region: input.country?.toUpperCase() ?? '',
    capabilities: [], mode: 'live', createdAt: now, updatedAt: now,
  };
  if (!(await sellers.compareAndSwap(existing, claim))) {
    throw new OpenwopError('validation_error', 'Seller onboarding is already in progress for this workspace — retry in a moment.', 409, { feature: 'commerce-connect' });
  }
  try {
    const acct = await createStripeConnectAccount(key, {
      ...(input.country ? { country: input.country } : {}),
      metadata: { tenantId },
    });
    const filled: SellerAccount = { ...claim, stripeAccountId: acct.accountId, region: acct.country || claim.region, updatedAt: nowIso() };
    await sellers.put(filled);
    await bindSellerAccount(tenantId, acct.accountId); // ADR 0576 CAS
    const link = await createStripeAccountLink(key, { accountId: acct.accountId, ...urls });
    return { seller: filled, url: link.url, mode: 'live' };
  } catch (err) {
    // Release the claim (only if it is still the unfilled claim) so a retry restarts.
    const current = await sellers.get(tenantId);
    if (current && current.stripeAccountId === '') await sellers.delete(tenantId).catch(() => undefined);
    throw err;
  }
}


/**
 * Sync the seller's account state from Stripe — called on return from hosted
 * onboarding (the webhook keeps state current thereafter; this bridges the gap
 * so the UI reflects reality immediately). Demo mode flips straight to enabled
 * (the showcase behavior; there is no Stripe to consult).
 */
export async function syncSellerFromStripe(tenantId: string): Promise<SellerAccount> {
  const seller = await sellers.get(tenantId);
  if (!seller || !seller.stripeAccountId) {
    throw new OpenwopError('not_found', 'No seller account to sync — start onboarding first.', 404, { feature: 'commerce-connect' });
  }
  if (seller.onboardingState === 'deauthorized') return seller;
  if (seller.mode === 'demo') {
    const next: SellerAccount = { ...seller, onboardingState: 'enabled', chargesEnabled: true, payoutsEnabled: true, capabilities: ['card_payments', 'transfers'], updatedAt: nowIso() };
    await sellers.put(next);
    return next;
  }
  const key = await requireStripeKey();
  const acct = await getStripeConnectAccount(key, seller.stripeAccountId);
  const next: SellerAccount = {
    ...seller,
    chargesEnabled: acct.chargesEnabled,
    payoutsEnabled: acct.payoutsEnabled,
    region: acct.country || seller.region,
    capabilities: acct.activeCapabilities,
    onboardingState: acct.chargesEnabled ? 'enabled' : acct.requirementsDisabledReason ? 'restricted' : 'pending',
    updatedAt: nowIso(),
  };
  await sellers.put(next);
  return next;
}
