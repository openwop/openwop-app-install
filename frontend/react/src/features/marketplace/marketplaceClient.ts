/**
 * Marketplace feature client (host-extension, non-normative — ADR 0022). Wraps
 * /v1/host/openwop-app/marketplace/*. 404s when the `marketplace` toggle is off; the
 * install route additionally 403s for a non-superadmin caller (surfaced as a clear
 * message). Reviews are org-scoped (`/orgs/:orgId/listings/:packName/reviews`).
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface Listing {
  packName: string;
  version: string;
  title: string;
  description?: string;
  author?: string;
  category: string;
  integrity?: string;
  publicKeyRef?: string;
  installed: boolean;
  requiredBy?: string[];
}

export interface Review {
  reviewId: string;
  tenantId: string;
  orgId: string;
  packName: string;
  rating: number;
  body?: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RatingSummary {
  packName: string;
  count: number;
  average: number | null;
}

export interface Org { orgId: string; name: string }

const base = `${config.baseUrl}/v1/host/openwop-app/marketplace`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string })?.message ?? '';
    } catch {
      /* non-JSON */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listListings(): Promise<Listing[]> {
  const res = await fetch(`${base}/listings`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ listings: Listing[] }>(res, 'listListings')).listings;
}

export interface InstallResult {
  packName: string;
  version: string;
  installed: boolean;
  alreadyInstalled: boolean;
  reason?: string;
}

export async function installPack(input: { packName: string; version: string }): Promise<InstallResult> {
  const res = await fetch(`${base}/install`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  if (res.status === 403) {
    throw new Error('Installing a pack requires a superadmin. Ask an administrator to install it.');
  }
  return asJson<InstallResult>(res, 'installPack');
}

/** The caller's orgs — reviews are org-scoped. Reuses the orgs route. */
export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

export async function listReviews(orgId: string, packName: string): Promise<{ reviews: Review[]; summary: RatingSummary }> {
  const res = await fetch(
    `${base}/orgs/${encodeURIComponent(orgId)}/listings/${encodeURIComponent(packName)}/reviews`,
    fetchOpts({ headers: authedHeaders() }),
  );
  return asJson<{ reviews: Review[]; summary: RatingSummary }>(res, 'listReviews');
}

export async function postReview(orgId: string, packName: string, input: { rating: number; body?: string }): Promise<Review> {
  const res = await fetch(
    `${base}/orgs/${encodeURIComponent(orgId)}/listings/${encodeURIComponent(packName)}/reviews`,
    fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }),
  );
  return asJson<Review>(res, 'postReview');
}

export async function deleteReview(orgId: string, packName: string, reviewId: string): Promise<void> {
  const res = await fetch(
    `${base}/orgs/${encodeURIComponent(orgId)}/listings/${encodeURIComponent(packName)}/reviews/${encodeURIComponent(reviewId)}`,
    fetchOpts({ method: 'DELETE', headers: authedHeaders() }),
  );
  if (!res.ok && res.status !== 204) throw new Error(`deleteReview returned ${res.status}`);
}
