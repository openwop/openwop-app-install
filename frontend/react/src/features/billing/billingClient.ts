/**
 * Billing API client (ADR 0176). Reads the tenant's subscription, prepaid token balance,
 * and entitlements; opens checkout/portal. Under /host/openwop-app/billing/*.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';
import { ApiError } from '../../client/requestJson.js';
import { errorReasonOf } from '../../client/classifyHttpError.js';
import { writeErrorMessage } from '../../lib/writeAccess.js';

/** ADR 0786 D5 — the scope the server requires to buy, subscribe or open the
 *  Stripe billing portal (admin/owner; a solo user's own workspace always has it). */
export const BILLING_MANAGE_SCOPE = 'host:billing:manage';

export type PlanTier = 'free' | 'pro' | 'team' | 'enterprise';
/** `pastDueGraceEndsAt` (ADR 0820 §7) — present only while `past_due` inside an
 *  operator-configured grace window: when access ends unless payment succeeds. */
export interface Subscription { tenantId: string; planTier: PlanTier; status: string; stripeCustomerId?: string; currentPeriodEnd?: string; cancelAtPeriodEnd?: boolean; quantity?: number; pastDueGraceEndsAt?: string }
export interface TokenBalance { tenantId: string; purchasedTokensTotal: number; totalAvailable: number }
export interface Entitlements { plan: PlanTier; allowedFeatures: '*' | string[]; limits: Record<string, number> }
/** ADR 0821 — the billing page's AI credit meter. Every figure is in CREDITS,
 *  converted server-side; a leg is `null` when it does not exist on this host
 *  (no free allowance, no plan allowance), never a fabricated zero. */
export interface AiCreditMeter {
  freeDaily: { day: string; usedCredits: number; capCredits: number; scope: 'subject' | 'tenant' } | null;
  monthly: { month: string; usedCredits: number; allowanceCredits: number } | null;
  balanceCredits: number;
  windowDays: number;
  /** `label` is the feature's registered name, absent for surface ids with no toggle. */
  topFeatures: Array<{ featureId: string; label?: string; usedCredits: number; chargedCredits: number; calls: number }>;
  otherCredits: number;
}
export interface CheckoutSession { sessionId: string; url: string; mode: 'live' | 'demo' }

const root = `${config.baseUrl}/host/openwop-app/billing`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });
/** Throws an `ApiError` carrying the status and the parsed envelope, so a page can
 *  tell a refusal (403, and why) from an outage instead of printing transport text. */
async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => undefined) as { message?: unknown } | undefined;
    const said = typeof body?.message === 'string' && body.message ? body.message : undefined;
    throw new ApiError({ status: res.status, statusText: res.statusText, url: ctx, body, message: said ?? `${ctx} returned ${res.status}` });
  }
  return (await res.json()) as T;
}

type TFn = (key: string) => string;
/** The message for a failed billing write: an anonymous session is told to sign in
 *  (the server's `anonymous_session` refusal, ADR 0786 D5); everything else is the
 *  shared `writeErrorMessage` (403 → `common:error_forbidden`, an explained 4xx such
 *  as the 409 "already has a plan" → the server's own sentence). */
export function billingErrorMessage(t: TFn, err: unknown): string {
  if (errorReasonOf(err) === 'anonymous_session') return t('billing:signInToPurchase');
  return writeErrorMessage(t, err);
}

export async function getSubscription(): Promise<Subscription> {
  return asJson<Subscription>(await fetch(`${root}/subscription`, fetchOpts({ headers: authedHeaders() })), 'subscription');
}
export async function getBalance(): Promise<TokenBalance> {
  return asJson<TokenBalance>(await fetch(`${root}/balance`, fetchOpts({ headers: authedHeaders() })), 'balance');
}
export async function getEntitlements(): Promise<Entitlements> {
  return asJson<Entitlements>(await fetch(`${root}/entitlements`, fetchOpts({ headers: authedHeaders() })), 'entitlements');
}
/** ADR 0821 — admin-only (`host:billing:manage`); a member gets a 403. */
export async function getAiCredits(): Promise<AiCreditMeter> {
  return asJson<AiCreditMeter>(await fetch(`${root}/ai-credits`, fetchOpts({ headers: authedHeaders() })), 'ai credits');
}
export async function startCheckout(priceId: string): Promise<CheckoutSession> {
  return asJson<CheckoutSession>(await fetch(`${root}/checkout`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ priceId }) })), 'checkout');
}
export async function openPortal(): Promise<{ url: string; mode: string }> {
  return asJson<{ url: string; mode: string }>(await fetch(`${root}/portal`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'portal');
}
/** ADR 0419 — buy a paid feature bundle (the server resolves the configured price
 *  from the bundleId). Billing owns the money route, so the store calls it here.
 *  ADR 0820 §7 — `cadence` picks the monthly (default) or yearly price; the client
 *  still never names a price. */
export async function buyBundle(bundleId: string, cadence: 'month' | 'year' = 'month'): Promise<{ url: string; mode: 'live' | 'demo' }> {
  return asJson<{ url: string; mode: 'live' | 'demo' }>(await fetch(
    `${root}/bundles/${encodeURIComponent(bundleId)}/checkout`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: cadence === 'month' ? '{}' : JSON.stringify({ cadence }) }),
  ), 'bundle checkout');
}
/** ADR 0820 §7 — subscribe to a plan TIER at a cadence; the server resolves the
 *  configured price (`OPENWOP_BILLING_PLAN_PRICE_CADENCE`), so the client never
 *  names a price. A 404 means that tier is not for sale at that cadence. */
export async function buyPlan(plan: 'pro' | 'team' | 'enterprise', cadence: 'month' | 'year' = 'month'): Promise<CheckoutSession> {
  return asJson<CheckoutSession>(await fetch(`${root}/checkout`, fetchOpts({
    method: 'POST', headers: jsonHeaders(), body: JSON.stringify(cadence === 'month' ? { plan } : { plan, cadence }),
  })), 'plan checkout');
}
/** ADR 0821 D7 — one AI-credit pack as the store lists it. `packKey` is OPAQUE
 *  (never a Stripe price id); `priceDisplay.price` is the operator's display copy,
 *  absent when none is configured — the store then offers no buy button. */
export interface TokenPack { packKey: string; credits: number; tokens: number; priceDisplay?: { price?: string; label?: string } }
/** The configured credit packs, smallest first (`[]` when none). */
export async function getTokenPacks(): Promise<TokenPack[]> {
  return (await asJson<{ packs: TokenPack[] }>(await fetch(`${root}/token-packs`, fetchOpts({ headers: authedHeaders() })), 'credit packs')).packs;
}
/** ADR 0821 D7 — buy a credit pack by its opaque key; the server resolves the
 *  configured price, so the client never names one. Admin-only (`host:billing:manage`). */
export async function buyCreditPack(packKey: string): Promise<CheckoutSession> {
  return asJson<CheckoutSession>(await fetch(
    `${root}/token-packs/${encodeURIComponent(packKey)}/checkout`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }),
  ), 'credit pack checkout');
}

/** Strategy §8 — the operator's paywall → checkout → grant funnel (superadmin
 *  only; anyone else gets a 403). Mirrors the backend `FunnelReport`. A rate is
 *  `null` when its denominator is 0. */
export interface PaywallFunnelBundle {
  bundleId: string; impressions: number; clicks: number; refusals: number; refusedTenants: number;
  checkoutsStarted: number; checkoutsCompleted: number; activeGrants: number;
  grantsStarted: number; grantsEnded: number;
  clickThroughRate: number | null; checkoutCompletionRate: number | null;
}
export interface PaywallFunnel {
  days: number; since: string; until: string;
  features: Array<{ featureId: string; bundleId: string | null; impressions: number; clicks: number; refusals: number; refusedTenants: number }>;
  bundles: PaywallFunnelBundle[];
  checkouts: Array<{ product: string; kind: string; started: number; completed: number; demoStarted: number }>;
  plans: Array<{ tier: string; active: number; checkoutsStarted: number; checkoutsCompleted: number }>;
  totals: { impressions: number; clicks: number; refusals: number; checkoutsStarted: number; checkoutsCompleted: number; demoCheckouts: number; grantsStarted: number; grantsEnded: number };
}
export async function getPaywallFunnel(days: 7 | 30 | 90): Promise<PaywallFunnel> {
  return asJson<PaywallFunnel>(await fetch(`${root}/admin/funnel?days=${days}`, fetchOpts({ headers: authedHeaders() })), 'paywall funnel');
}
export interface PaywallFunnelWeekTotals {
  impressions: number; clicks: number; refusals: number; checkoutsStarted: number; checkoutsCompleted: number; grantsStarted: number; grantsEnded: number;
}
/** `GET …/admin/funnel/weekly` — the last 7 UTC days against the 7 before (superadmin). */
export interface PaywallFunnelWeekly {
  week: string;
  current: { since: string; until: string; totals: PaywallFunnelWeekTotals };
  previous: { since: string; until: string; totals: PaywallFunnelWeekTotals };
  change: Record<keyof PaywallFunnelWeekTotals, number | null>;
  bundles: Array<{ bundleId: string; grantsStarted: number; grantsEnded: number; previousGrantsStarted: number; previousGrantsEnded: number }>;
}
export async function getPaywallFunnelWeekly(): Promise<PaywallFunnelWeekly> {
  return asJson<PaywallFunnelWeekly>(await fetch(`${root}/admin/funnel/weekly`, fetchOpts({ headers: authedHeaders() })), 'paywall funnel weekly');
}
