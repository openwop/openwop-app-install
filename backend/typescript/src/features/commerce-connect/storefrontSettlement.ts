/**
 * ADR 0877 D1 — the ONE answer to "may this tenant's storefront take live money,
 * and on whose Stripe account".
 *
 * Until ADR 0877 every signed-in tenant's storefront charged cards onto the
 * operator's PLATFORM account (ADR 0875's `liveStripeKeyFor` refused only `anon:`),
 * which made the operator merchant of record — disputes, chargebacks and manual
 * payouts — for businesses it does not run. The user decision (2026-10-12):
 *
 *  - `platform` — only the operator's own tenants: listed superadmin tenants and
 *    the explicit `OPENWOP_COMMERCE_PLATFORM_TENANTS` list (NEVER billing-exempt);
 *  - `connect`  — any other tenant, once its Commerce Connect seller account is
 *    live and chargeable: a destination charge to ITS account, the platform
 *    keeping the application fee;
 *  - `demo`     — everyone else: no charge, and a reason the owner UI renders.
 *
 * This is the CHARGE gate. It is deliberately NOT `liveStripeKeyFor`, which
 * answers a different question ("is this host live, so must a payment be
 * verified, and with which key is it refunded") and must stay non-null on a live
 * host — or UCP `/pay` would demo-settle an unverified AP2 mandate (ADR 0875 D4).
 */
import { resolveSecret } from '../../byok/secretResolver.js';
import { STRIPE_KEY_REF } from '../billing/billingService.js';
import type { StorefrontCharge } from '../billing/stripeApi.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { isListedSuperadminTenant } from '../../host/superadmin.js';
import { isNonRootWorkspaceOrg } from '../../host/accessControlService.js';
import { sellers, sellerRows, accountIndex, platformRegion, isFoldEligibleTenant, type SellerAccount } from './stores.js';
import { getStorefrontFeePct } from './orders.js';

export type DemoReason =
  | 'no_key' | 'anon'
  | 'connect_required' | 'connect_incomplete' | 'connect_disabled' | 'connect_region'
  // ADR 0948 D8 — a CLIENT org of an agency workspace needs its OWN seller; the
  // agency's Connect page cannot provide one, so the owner UI offers no link.
  | 'client_seller_required';

export type StorefrontSettlement =
  | { kind: 'platform'; charge: StorefrontCharge }
  | { kind: 'connect'; charge: StorefrontCharge; destinationAccountId: string; applicationFeePct: number }
  | { kind: 'demo'; reason: DemoReason };

/** What an order records about the lane it was opened on (ADR 0877 M5). Never
 *  a routing input for money — refunds read the destination from Stripe. */
export interface OrderSettlementStamp { kind: 'platform' | 'connect' | 'demo'; destinationAccountId?: string }

export const settlementStamp = (s: StorefrontSettlement): OrderSettlementStamp =>
  s.kind === 'connect' ? { kind: 'connect', destinationAccountId: s.destinationAccountId } : { kind: s.kind };

const listFromEnv = (raw: string | undefined): string[] | null => {
  const v = raw?.trim();
  if (!v) return null;
  if (v.startsWith('[')) {
    try {
      const parsed = JSON.parse(v) as unknown;
      return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string').map((s) => s.trim()).filter(Boolean) : [];
    } catch { return []; }
  }
  return v.split(',').map((s) => s.trim()).filter(Boolean);
};

/**
 * The tenants that may charge on the PLATFORM account. EXACT tenant-id match:
 * a superadmin listed as a person does not make a shared `ws:`/`org:` workspace
 * eligible (the store's tenant is its org's tenant). The dev-open toggle switch
 * is NOT consulted (`isListedSuperadminTenant`, never `isSuperadminTenant`).
 *
 * ADR 0877 Q3 (user decision 2026-10-12, FINAL) — EXPLICIT LISTS ONLY: the listed
 * superadmin tenants ∪ `OPENWOP_COMMERCE_PLATFORM_TENANTS`. The billing-exempt list
 * does NOT grant live checkout: it exists to lift plan limits, and lifting a limit
 * must never make the operator merchant of record. Exempt and conformance tenants
 * are demo unless listed. The return line below is the whole rule.
 */
export function isPlatformSettlementTenant(tenantId: string): boolean {
  if (!isFoldEligibleTenant(tenantId)) return false;
  return isListedSuperadminTenant(tenantId) || (listFromEnv(process.env.OPENWOP_COMMERCE_PLATFORM_TENANTS) ?? []).includes(tenantId);
}

/** Why a seller row cannot take a destination charge, or null when it can. */
function sellerNotReady(s: SellerAccount | null): DemoReason | null {
  if (!s || !s.stripeAccountId || s.mode !== 'live') return 'connect_required';
  if (s.onboardingState !== 'enabled' || !s.chargesEnabled) return 'connect_incomplete';
  if (!s.capabilities.includes('transfers') || !s.capabilities.includes('card_payments')) return 'connect_incomplete';
  if (!s.region || s.region.toUpperCase() !== platformRegion()) return 'connect_region';
  return null;
}

/**
 * ADR 0948 P0b — the account a seller row names may take a destination charge only
 * while its IMMUTABLE reverse binding (`accountIndex`, first-writer, ADR 0576 /
 * ce9a8986e) names exactly this seller: the tenant AND the org (absent = the
 * tenant's own). The binding is what attributes the account's webhooks; a row whose
 * account is bound elsewhere (a lost bind race, an import, a corrupt row) would send
 * a buyer's money to an account whose state events update someone else's row. Not
 * bound here ⇒ `connect_incomplete`, the no-charge direction. One point read.
 */
async function boundToThisSeller(stripeAccountId: string, tenantId: string, orgId: string | undefined): Promise<boolean> {
  const idx = await accountIndex.get(stripeAccountId);
  return !!idx && idx.stripeAccountId === stripeAccountId && idx.tenantId === tenantId && (idx.orgId ?? '') === (orgId ?? '');
}

/** The brand is minted HERE and nowhere else (pinned by the ADR 0877 ratchet). */
const mint = (key: string, connect?: { destinationAccountId: string; applicationFeePct: number }): StorefrontCharge =>
  ({ key, ...(connect ? { connect } : {}) }) as StorefrontCharge;

/**
 * `orgId` is the org whose storefront is charging. ADR 0948 D8 (David, 2026-10-19,
 * #5038): a CLIENT org of an agency workspace settles through its OWN Connect
 * seller (`clientSellers`, onboarded through the org-scoped routes, ADR 0948 P0b).
 * Until that seller can take a charge the org is `demo/client_seller_required` (or
 * the seller's own not-ready reason) — never the agency's tenant seller, never the
 * platform account. Before this, every client org's checkout paid the agency's.
 */
export async function resolveStorefrontSettlement(tenantId: string, orgId: string): Promise<StorefrontSettlement> {
  const key = await resolveSecret(STRIPE_KEY_REF);
  if (!key) return { kind: 'demo', reason: 'no_key' };
  // `anon:` first, so no allowlist entry can grant a session that the fold will strand.
  if (!isFoldEligibleTenant(tenantId)) return { kind: 'demo', reason: 'anon' };
  if (isNonRootWorkspaceOrg(tenantId, orgId)) {
    // ADR 0948 P0b — a client org settles ONLY through its own seller: never the
    // tenant's (the agency's) seller, never the platform account.
    const own = await sellerRows({ tenantId, orgId }).get();
    if (!own) return { kind: 'demo', reason: 'client_seller_required' };
    const ownNotReady = sellerNotReady(own);
    if (ownNotReady) return { kind: 'demo', reason: ownNotReady === 'connect_required' ? 'client_seller_required' : ownNotReady };
    const ownAssignment = await resolveOne('commerce-connect', { tenantId }).catch(() => null);
    if (!ownAssignment?.enabled) return { kind: 'demo', reason: 'connect_disabled' };
    if (!(await boundToThisSeller(own.stripeAccountId, tenantId, orgId))) return { kind: 'demo', reason: 'connect_incomplete' };
    // Architect call (ADR 0948 P0b): the storefront fee is the workspace's (the
    // agency operates the client's store on this host), on the client's account.
    const clientFeePct = await getStorefrontFeePct(tenantId);
    return {
      kind: 'connect', charge: mint(key, { destinationAccountId: own.stripeAccountId, applicationFeePct: clientFeePct }),
      destinationAccountId: own.stripeAccountId, applicationFeePct: clientFeePct,
    };
  }
  if (isPlatformSettlementTenant(tenantId)) return { kind: 'platform', charge: mint(key) };
  const seller = await sellers.get(tenantId);
  const notReady = sellerNotReady(seller);
  if (notReady) return { kind: 'demo', reason: notReady };
  // ADR 0877 D1 / L15 — toggle AND plan (`resolveOne`): a lapsed plan or a
  // switched-off feature falls to demo, the no-charge direction. Account-state
  // webhooks are not applied while the toggle is off, so a stale seller row must
  // never route money.
  const assignment = await resolveOne('commerce-connect', { tenantId }).catch(() => null);
  if (!assignment?.enabled) return { kind: 'demo', reason: 'connect_disabled' };
  const destinationAccountId = seller!.stripeAccountId;
  if (!(await boundToThisSeller(destinationAccountId, tenantId, undefined))) return { kind: 'demo', reason: 'connect_incomplete' };
  const applicationFeePct = await getStorefrontFeePct(tenantId); // Q1 — the storefront fee, never the pack fee
  return { kind: 'connect', charge: mint(key, { destinationAccountId, applicationFeePct }), destinationAccountId, applicationFeePct };
}

/** Test-only: a platform-lane charge for a unit test that drives a creator directly. */
export const __platformChargeForTest = (key: string): StorefrontCharge => mint(key);
