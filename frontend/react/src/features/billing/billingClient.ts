/**
 * Billing API client (ADR 0176). Reads the tenant's subscription, prepaid token balance,
 * and entitlements; opens checkout/portal. Under /host/openwop-app/billing/*.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type PlanTier = 'free' | 'pro' | 'team' | 'enterprise';
export interface Subscription { tenantId: string; planTier: PlanTier; status: string; stripeCustomerId?: string; currentPeriodEnd?: string; quantity?: number }
export interface TokenBalance { tenantId: string; purchasedTokensTotal: number; totalAvailable: number }
export interface Entitlements { plan: PlanTier; allowedFeatures: '*' | string[]; limits: Record<string, number> }
export interface CheckoutSession { sessionId: string; url: string; mode: 'live' | 'demo' }

const root = `${config.baseUrl}/host/openwop-app/billing`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });
async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) { let d = ''; try { d = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* */ } throw new Error(d || `${ctx} returned ${res.status}`); }
  return (await res.json()) as T;
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
export async function startCheckout(priceId: string): Promise<CheckoutSession> {
  return asJson<CheckoutSession>(await fetch(`${root}/checkout`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ priceId }) })), 'checkout');
}
export async function openPortal(): Promise<{ url: string; mode: string }> {
  return asJson<{ url: string; mode: string }>(await fetch(`${root}/portal`, fetchOpts({ method: 'POST', headers: jsonHeaders() })), 'portal');
}
