/**
 * Product-embedding derived index (ADR 0275 / MERCH-C, PR 2 Part B) — semantic recall
 * over the SHARED `host.db.vector` surface, reusing the deterministic `embedText`
 * embedder (the `subjectMemory.ts` pattern; NO second vector store). A DERIVED cache:
 * rebuildable from `listProducts`, replay-irrelevant, non-authoritative.
 *
 * Namespace = `commerce:product:${tenantId}:${orgId}` — query filters to it, so
 * cross-tenant recall is impossible at the vector layer (/architect finding 3, IDOR).
 *
 * Scale: `host.db.vector` default is O(n) brute-force cosine in-memory (bounded to small
 * catalogs); `host/vector/pgVectorVector.ts` is the scale engine (logged, ADR 0239 honesty).
 * A full rebuild upserts every ACTIVE product by id; deleted/deactivated products' stale
 * ids linger but are filtered at query time (searchProducts intersects with the live set).
 */
import { buildHostSurfaceBundle } from '../../host/inMemorySurfaces.js';
import { embedText, DEFAULT_EMBEDDING_DIMS } from '../../aiProviders/localEmbedding.js';
import { listProducts, type Product } from '../commerce/commerceService.js';

const namespaceOf = (tenantId: string, orgId: string): string => `commerce:product:${tenantId}:${orgId}`;
const productText = (p: Product): string => [p.name, p.description ?? '', ...(p.categories ?? []), ...(p.tags ?? [])].join(' ').trim();

// Lazy-rebuild TTL: the index is refreshed on demand at most once per TTL per org, and
// ONLY for orgs that actually run a semantic search (no daemon, no cross-tenant scan; the
// same bounded-staleness property the /architect review wanted from a daemon, but targeted).
const TTL_MS = 15 * 60 * 1000;
const freshUntil = new Map<string, string>(); // `${t}:${o}` → ISO deadline
const freshKey = (t: string, o: string): string => `${t}:${o}`;

// R2 PD2-5 — a FAILED rebuild backs off too. The stamp used to be set only on success,
// so a persistently broken vector store re-attempted a full catalog re-embed on every
// single request (no backoff, no circuit break) — the failure amplified the load that
// caused it, inside a public request.
const FAIL_TTL_MS = 60 * 1000;

/** Ensure the org's embedding index is fresh (rebuild if never built or past its TTL).
 *  Throws on a store failure — the CALLER decides whether semantic recall is optional
 *  (it is, in `searchProducts`), so the backoff lives here and the fallback there. */
export async function ensureProductEmbeddingsFresh(tenantId: string, orgId: string): Promise<void> {
  const key = freshKey(tenantId, orgId);
  const deadline = freshUntil.get(key);
  if (deadline && Date.parse(deadline) > Date.now()) return;
  try {
    await rebuildProductEmbeddings(tenantId, orgId);
    freshUntil.set(key, new Date(Date.now() + TTL_MS).toISOString());
  } catch (err) {
    freshUntil.set(key, new Date(Date.now() + FAIL_TTL_MS).toISOString());
    throw err;
  }
}
/** Force the next search to rebuild (the manual rebuild route + tests). */
export function invalidateProductEmbeddings(tenantId: string, orgId: string): void {
  freshUntil.delete(freshKey(tenantId, orgId));
}

/** Rebuild the embedding index for one org from its ACTIVE catalog (idempotent). */
export async function rebuildProductEmbeddings(tenantId: string, orgId: string): Promise<number> {
  const products = (await listProducts(tenantId, orgId)).filter((p) => p.active !== false);
  if (products.length === 0) return 0;
  const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
  await vector.upsert({
    namespace: namespaceOf(tenantId, orgId),
    items: products.map((p) => ({ id: p.productId, vector: embedText(productText(p), DEFAULT_EMBEDDING_DIMS), metadata: { productId: p.productId } })),
  });
  return products.length;
}

/** Semantic recall: product ids ranked by embedding cosine for a query, most-similar
 *  first. Tenant+org-namespaced. Empty query ⇒ no semantic contribution. Best-effort:
 *  a vector-store failure returns [] (searchProducts degrades to lexical-only). */
export async function queryProductEmbeddings(tenantId: string, orgId: string, q: string, topK = 48): Promise<string[]> {
  if (!q || !q.trim()) return [];
  try {
    const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
    const res = await vector.query({ namespace: namespaceOf(tenantId, orgId), vector: embedText(q, DEFAULT_EMBEDDING_DIMS), topK });
    const matches = (res.matches ?? []) as Array<{ id?: unknown; metadata?: { productId?: unknown } }>;
    return matches.map((m) => String((m.metadata?.productId ?? m.id) ?? '')).filter(Boolean);
  } catch { return []; }
}
