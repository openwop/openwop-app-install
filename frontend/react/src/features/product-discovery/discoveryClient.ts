/**
 * Discovery feature client (host-extension). Wraps /host/openwop-app/discovery/*.
 * 404s when the toggle is off. `listOrgs` hits the shared orgs route directly.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

const base = `${config.baseUrl}/host/openwop-app/discovery`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* ignore */ }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export interface Collection {
  collectionId: string; orgId: string; name: string; slug: string;
  type: 'manual' | 'dynamic'; productIds?: string[]; rule?: { categories?: string[]; tags?: string[]; minPrice?: number; maxPrice?: number };
  active: boolean; createdAt: string;
}
export interface MerchRule { ruleId: string; orgId: string; name: string; scope: string; actions: unknown[]; holdoutPct?: number; active: boolean }
export interface SearchProduct { productId: string; name: string; price: number; currency: string }
export interface Facet {
  key: string; label: string;
  values: { value: string; count: number }[];
  /** R2 PD2-9 — distinct values BEFORE the server's 30-value cap. */
  totalValues?: number;
}
/** R2 PD2-3 — the search response's honest shape. `total` is the MATCH count, not the
 *  page: the console used to read `products.length`, which is the server's 48-row cap,
 *  and render it as "of {{total}}" — so a 5,000-product catalog reported 48 matches. */
export interface SearchResponse {
  products: SearchProduct[];
  facets: Facet[];
  appliedRuleIds?: string[];
  /** REQUIRED (review B1): optional fields let the route silently stop sending these
   *  and the page fall back to `products.length` — which is the page cap, i.e. exactly
   *  the defect PD2-3 exists to fix. A missing field must break the build. */
  total: number;
  truncated: boolean;
  /** Operator console only — the public route does not send it. */
  hiddenByRules?: number;
}
export interface Org { orgId: string; name: string }

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await parse<{ orgs?: Org[] }>(res)).orgs ?? [];
}
export async function listCollections(orgId: string): Promise<Collection[]> {
  return (await parse<{ collections: Collection[] }>(await fetch(`${base}/orgs/${orgId}/collections`, fetchOpts({ headers: authedHeaders() })))).collections;
}
export async function createCollection(orgId: string, input: { name: string; type: 'manual' | 'dynamic'; productIds?: string[]; rule?: { categories?: string[] } }): Promise<Collection> {
  return (await parse<{ collection: Collection }>(await fetch(`${base}/orgs/${orgId}/collections`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) })))).collection;
}
export async function deleteCollection(orgId: string, collectionId: string): Promise<void> {
  await parse<{ ok: boolean }>(await fetch(`${base}/orgs/${orgId}/collections/${collectionId}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })));
}
export async function listRules(orgId: string): Promise<MerchRule[]> {
  return (await parse<{ rules: MerchRule[] }>(await fetch(`${base}/orgs/${orgId}/rules`, fetchOpts({ headers: authedHeaders() })))).rules;
}
export async function createRule(orgId: string, input: { name: string; scope: string; actions: unknown[]; holdoutPct?: number }): Promise<MerchRule> {
  return (await parse<{ rule: MerchRule }>(await fetch(`${base}/orgs/${orgId}/rules`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) })))).rule;
}
export async function deleteRule(orgId: string, ruleId: string): Promise<void> {
  await parse<{ ok: boolean }>(await fetch(`${base}/orgs/${orgId}/rules/${ruleId}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })));
}
export async function search(orgId: string, q: string): Promise<SearchResponse> {
  const qs = new URLSearchParams(q ? { q } : {});
  return parse(await fetch(`${base}/orgs/${orgId}/search?${qs.toString()}`, fetchOpts({ headers: authedHeaders() })));
}
