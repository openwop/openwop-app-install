/**
 * Recommendations feature client (host-extension, non-normative). Wraps
 * /host/openwop-app/recommendations/*. 404s when the toggle is off.
 * `listOrgs` hits the shared orgs route directly (the csm/evals convention —
 * own read-only copy, no cross-feature client import).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const base = `${config.baseUrl}/host/openwop-app/recommendations`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const RECO_SLOTS = ['pdp', 'cart', 'checkout', 'post_purchase', 'category', 'home', 'oos_404'] as const;
export type RecoSlot = (typeof RECO_SLOTS)[number];
export const RECO_SOURCES = ['bought_together', 'cross_sell', 'upsell', 'similar', 'trending'] as const;
export type RecoSource = (typeof RECO_SOURCES)[number];

export interface Placement {
  placementId: string; orgId: string;
  slot: RecoSlot; source: RecoSource;
  segmentId?: string; holdoutPct?: number; active: boolean;
  createdAt: string; updatedAt: string;
}
export interface RecoProduct { productId: string; name: string; price: number; currency: string; type: string }
export interface Org { orgId: string; name: string }

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  const data = await parse<{ orgs?: Org[] }>(res);
  return data.orgs ?? [];
}

export async function listPlacements(orgId: string): Promise<Placement[]> {
  const res = await fetch(`${base}/orgs/${orgId}/placements`, fetchOpts({ headers: authedHeaders() }));
  return (await parse<{ placements: Placement[] }>(res)).placements;
}

export async function createPlacement(orgId: string, input: { slot: RecoSlot; source: RecoSource; segmentId?: string; holdoutPct?: number }): Promise<Placement> {
  const res = await fetch(`${base}/orgs/${orgId}/placements`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return (await parse<{ placement: Placement }>(res)).placement;
}

export async function updatePlacement(orgId: string, placementId: string, patch: { active?: boolean; source?: RecoSource; holdoutPct?: number; segmentId?: string }): Promise<Placement> {
  const res = await fetch(`${base}/orgs/${orgId}/placements/${placementId}`, fetchOpts({ method: 'PATCH', headers: jsonHeaders(), body: JSON.stringify(patch) }));
  return (await parse<{ placement: Placement }>(res)).placement;
}

export async function deletePlacement(orgId: string, placementId: string): Promise<void> {
  const res = await fetch(`${base}/orgs/${orgId}/placements/${placementId}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  await parse<{ ok: boolean }>(res);
}

/** Review MJ-3 — B3's whole finding is about the TOAST ("0 products" reads as nothing to
 *  do), so discarding `removed` here left the operator-facing half unfixed: a rebuild
 *  that deleted 200 stale rows still said "Affinity rebuilt (0 products)." */
export async function rebuildAffinity(orgId: string): Promise<{ rows: number; removed: number }> {
  const res = await fetch(`${base}/orgs/${orgId}/affinity/rebuild`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: '{}' }));
  const body = await parse<{ rows: number; removed?: number }>(res);
  return { rows: body.rows, removed: body.removed ?? 0 };
}

/**
 * REC-G2 — the resolver distinguishes three outcomes and the page used to
 * collapse them: NO placement matched the slot (bare `{ products: [] }` — no
 * `placementId`), a matched placement put the caller in the CONTROL holdout
 * (`variant: 'control'`), or a matched placement simply found no candidates
 * (`variant: 'treatment'`, empty products). "You never configured this slot" and
 * "it is configured and there is nothing to show" have completely different
 * fixes, so `placementId` is the field that tells them apart.
 */
export interface ResolvePreview {
  products: RecoProduct[];
  /** Present iff a placement matched the slot. */
  placementId?: string;
  source?: RecoSource;
  variant?: string;
  /** R2 REC2-B2 — a placement for this slot exists but targets a segment and this
   *  preview was anonymous. Prefer this over inferring it from the placements list:
   *  the resolver knows, the page was guessing. */
  segmentTargetedSkipped?: true;
  /** Review MJ-1 — evaluated against a real contact who is NOT in the segment. */
  segmentNotMatched?: true;
  /** R2 REC2-M1 — placements skipped because their segment no longer resolves. */
  unresolvedSegmentIds?: string[];
  /** R2 REC2-M2 — the placement declares a holdout that is NOT being enforced (no
   *  session identity to bucket on), so the table's percentage does not bite. */
  holdoutInert?: true;
  /** R3 M4 — newest computedAt among the affinity rows this resolve consumed. */
  affinityComputedAt?: string;
}

/** R2 REC2-B2 — `contactId` is the input that makes a SEGMENT-TARGETED placement
 *  reachable. The route accepted it and the agent tool exposed it; the console was the
 *  only surface that could not send it — so the resolver skipped every targeted
 *  placement, returned the bare `{ products: [] }` shape (no `placementId`), and the
 *  page told the operator the slot was UNCONFIGURED while that placement sat active in
 *  the table one card above. Round 1's fix was real and unreachable. */
export async function resolvePreview(orgId: string, params: { slot: RecoSlot; productId?: string; contactId?: string }): Promise<ResolvePreview> {
  const q = new URLSearchParams({
    slot: params.slot,
    ...(params.productId ? { productId: params.productId } : {}),
    ...(params.contactId ? { contactId: params.contactId } : {}),
  });
  const res = await fetch(`${base}/orgs/${orgId}/resolve?${q.toString()}`, fetchOpts({ headers: authedHeaders() }));
  return parse<ResolvePreview>(res);
}
