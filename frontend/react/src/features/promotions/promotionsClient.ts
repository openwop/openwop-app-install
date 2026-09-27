/**
 * Promotions feature client (host-extension). Wraps
 * /host/openwop-app/promotions/*. 404s when the toggle is off. `listOrgs` hits
 * the shared orgs route directly (the csm/evals convention).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const base = `${config.baseUrl}/host/openwop-app/promotions`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const PROMOTION_TYPES = ['cart_threshold', 'product_discount', 'loss_leader', 'tiered', 'bogo'] as const;
/** R2 PRO2-P1 — mirrors the backend `CURRENCIES` SSoT. A promotion carrying an AMOUNT
 *  (a spend threshold, a fixed reward, a loss budget) is denominated in one of these. */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY'] as const;
export type PromotionType = (typeof PROMOTION_TYPES)[number];
export const REWARD_KINDS = ['percentage', 'fixed'] as const;
export type RewardKind = (typeof REWARD_KINDS)[number];

export interface Promotion {
  promotionId: string; orgId: string; name: string;
  type: PromotionType;
  reward: { kind: RewardKind; value: number };
  scope?: { productIds?: string[]; categories?: string[]; all?: boolean };
  minSpend?: number;
  budget?: { maxDiscount?: number; maxQuantity?: number };
  segmentId?: string;
  /** R2 PRO2-P1 — the currency this promotion's amounts are in. */
  currency?: string;
  priority: number; stackable: boolean; active: boolean;
  createdAt: string; updatedAt: string;
}
export interface Org { orgId: string; name: string }

export interface PromotionDraft {
  name: string; type: PromotionType; reward: { kind: RewardKind; value: number };
  minSpend?: number; scope?: { all?: boolean; categories?: string[] };
  budget?: { maxDiscount?: number }; segmentId?: string; priority?: number; stackable?: boolean;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await parse<{ orgs?: Org[] }>(res)).orgs ?? [];
}
/** R3 P-5 — the derived burn per promotion (absent key = zero usage). */
export interface PromotionUsage { amount: number; quantity: number }
export async function listPromotions(orgId: string): Promise<{ promotions: Promotion[]; usage: Record<string, PromotionUsage> }> {
  const res = await fetch(`${base}/orgs/${orgId}/promotions`, fetchOpts({ headers: authedHeaders() }));
  const body = await parse<{ promotions: Promotion[]; usage?: Record<string, PromotionUsage> }>(res);
  return { promotions: body.promotions, usage: body.usage ?? {} };
}
export async function createPromotion(orgId: string, draft: PromotionDraft): Promise<Promotion> {
  const res = await fetch(`${base}/orgs/${orgId}/promotions`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(draft) }));
  return (await parse<{ promotion: Promotion }>(res)).promotion;
}
export async function updatePromotion(orgId: string, promotionId: string, patch: { active?: boolean }): Promise<Promotion> {
  const res = await fetch(`${base}/orgs/${orgId}/promotions/${promotionId}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return (await parse<{ promotion: Promotion }>(res)).promotion;
}
export async function deletePromotion(orgId: string, promotionId: string): Promise<void> {
  const res = await fetch(`${base}/orgs/${orgId}/promotions/${promotionId}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await parse<{ ok: boolean }>(res);
}
