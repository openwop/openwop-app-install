/**
 * UCP-buyer (agentic procurement) client — purchases an agent made on your behalf
 * over the Universal Commerce Protocol (ADR 0258). Self-contained per ADR 0001 (no
 * cross-import of the commerce/seller packages); mirrors the commerce client's shape.
 *
 * R2 UCP-P2-B4 — this was READ-ONLY, and that stranded every approved purchase.
 * Approving a commerce-spend row only flips the approval's status; completion needs
 * a second `checkout` call that existed in the API and in NO surface: the chat tool
 * refuses on purpose and tells the human to finish it "from the Purchases page", and
 * that page had no such control. The two write calls the governed path needs
 * (`placeApprovedPurchase`, `trackPurchase`) are exported here so the sentence the
 * agent tells the user is true.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Org { orgId: string; name: string }

export interface Ap2IntentMandate { kind: 'ap2.intent'; intent: string; maxAmountMinor: number; currency: string; createdAt: string }
export interface Ap2CartLine { externalProductId: string; name: string; quantity: number; unitPriceMinor: number }
export interface Ap2CartMandate { kind: 'ap2.cart'; merchantUrl: string; lines: Ap2CartLine[]; totalMinor: number; currency: string; createdAt: string }
export interface Ap2PaymentMandate { kind: 'ap2.payment'; totalMinor: number; currency: string; approvalId: string; warnings: string[]; createdAt: string }

export type UcpPurchaseStatus = 'draft' | 'awaiting_approval' | 'placing' | 'placed' | 'unknown' | 'failed' | 'canceled';

export interface UcpPurchase {
  purchaseId: string;
  merchantUrl?: string;
  merchantServerId?: string;
  intentMandate: Ap2IntentMandate;
  cartMandate: Ap2CartMandate;
  paymentMandate?: Ap2PaymentMandate;
  approvalId?: string;
  extOrderId?: string;
  extStatus?: string;
  /** R2 UCP-P2-B2 — what the MERCHANT confirmed it charged, and whether we could
   *  check it at all. `'unavailable'` means UNRECONCILED — never render our own
   *  figure as though the merchant had confirmed it. */
  confirmedTotalMinor?: number;
  confirmedCurrency?: string;
  reconciliation?: 'matched' | 'unavailable';
  /** R2 (review M-5) — the sign-off's state, projected onto the purchase so the page
   *  can offer the placement button ONLY where it can succeed. */
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  status: UcpPurchaseStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export class UcpBuyerApiError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = 'UcpBuyerApiError';
  }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let env: { error?: string; message?: string } = {};
    try { env = (await res.json()) as typeof env; } catch { /* non-JSON */ }
    throw new UcpBuyerApiError(env.message || `${ctx} returned ${res.status}`, env.error ?? 'unknown', res.status);
  }
  return (await res.json()) as T;
}

const root = `${config.baseUrl}/host/openwop-app`;
const buyerBase = (orgId: string): string => `${root}/commerce/orgs/${encodeURIComponent(orgId)}/ucp-buyer`;
const get = async <T>(url: string, ctx: string): Promise<T> => asJson<T>(await fetch(url, fetchOpts({ headers: authedHeaders() })), ctx);

export const listOrgs = async (): Promise<Org[]> => (await get<{ orgs: Org[] }>(`${root}/orgs`, 'listOrgs')).orgs;
export const listPurchases = async (orgId: string): Promise<UcpPurchase[]> => (await get<{ purchases: UcpPurchase[] }>(`${buyerBase(orgId)}/purchases`, 'listPurchases')).purchases;
export const getPurchase = (orgId: string, purchaseId: string): Promise<UcpPurchase> => get<UcpPurchase>(`${buyerBase(orgId)}/purchases/${encodeURIComponent(purchaseId)}`, 'getPurchase');

const post = async <T>(url: string, ctx: string): Promise<T> =>
  asJson<T>(await fetch(url, fetchOpts({ method: 'POST', headers: authedHeaders() })), ctx);

/** R2 UCP-P2-B4 — complete an APPROVED purchase (the governed placement step). The
 *  service re-checks the cap and the sign-off, so this button can never bypass a
 *  gate; it only supplies the second call the flow always required. */
export const placeApprovedPurchase = (orgId: string, purchaseId: string): Promise<UcpPurchase> =>
  post<UcpPurchase>(`${buyerBase(orgId)}/purchases/${encodeURIComponent(purchaseId)}/checkout`, 'placeApprovedPurchase');

/** Ask the merchant for the order's current status (read-only at the merchant). */
export const trackPurchase = (orgId: string, purchaseId: string): Promise<UcpPurchase> =>
  post<UcpPurchase>(`${buyerBase(orgId)}/purchases/${encodeURIComponent(purchaseId)}/track`, 'trackPurchase');

export const merchantLabel = (p: UcpPurchase): string => p.merchantUrl ?? (p.merchantServerId ? `mcp:${p.merchantServerId}` : '—');
