/**
 * Product-embedding derived index (ADR 0275 / MERCH-C, PR 2 Part B) — semantic recall
 * over the SHARED `host.db.vector` surface, reusing the deterministic `embedText`
 * embedder (the `subjectMemory.ts` pattern; NO second vector store). A DERIVED cache:
 * rebuildable from the catalog (`iterateCatalog`), replay-irrelevant, non-authoritative.
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
import { embedText, effectiveEmbedDims } from '../../aiProviders/localEmbedding.js';
import { catalogSize, iterateCatalog, type Product } from '../commerce/commerceService.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('discovery.productEmbeddings');

/** ADR 1110 P3 — the largest catalog a search request may re-embed itself. A larger
 *  org is queued and re-embedded off the request path by `refreshQueuedEmbeddings`. */
let SYNC_REBUILD_MAX = 5000;
/** Test-only: lower the in-request rebuild limit. */
export function __setSyncRebuildMaxForTest(n: number | null): void { SYNC_REBUILD_MAX = n ?? 5000; }
const UPSERT_BATCH = 500;

/** Orgs whose embeddings went stale while too large to rebuild in a request. */
interface StaleRow { k: string; tenantId: string; orgId: string; at: string }
const staleQueue = new DurableCollection<StaleRow>('discovery:embedding-stale', (r) => r.k, undefined, undefined, undefined, undefined, { tenantKeyed: true, derived: true });

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
  if ((await catalogSize(tenantId, orgId)) > SYNC_REBUILD_MAX) {
    // ADR 1110 P3 — too large to re-embed inside a request: search with what is indexed
    // and queue the org; the background refresh rebuilds it.
    await staleQueue.put({ k: key, tenantId, orgId, at: new Date().toISOString() });
    freshUntil.set(key, new Date(Date.now() + TTL_MS).toISOString());
    return;
  }
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

/** Rebuild the embedding index for one org from its ACTIVE catalog (idempotent), one
 *  batch of products at a time (ADR 1110 P3), so a rebuild never holds the catalog. */
export async function rebuildProductEmbeddings(tenantId: string, orgId: string): Promise<number> {
  const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
  let batch: Product[] = [];
  let total = 0;
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await vector.upsert({
      namespace: namespaceOf(tenantId, orgId),
      items: batch.map((p) => ({ id: p.productId, vector: embedText(productText(p), effectiveEmbedDims()), metadata: { productId: p.productId } })),
    });
    total += batch.length;
    batch = [];
  };
  for await (const p of iterateCatalog(tenantId, orgId, UPSERT_BATCH)) {
    if (p.active === false) continue;
    batch.push(p);
    if (batch.length >= UPSERT_BATCH) await flush();
  }
  await flush();
  return total;
}

/** ADR 1110 P3 — re-embed up to `limit` queued orgs, oldest key first. Each row is
 *  claimed by deleting it first, so two instances never rebuild the same org at once; a
 *  failed rebuild puts it back. */
export async function refreshQueuedEmbeddings(limit = 1): Promise<number> {
  const page = await staleQueue.listByPrefixPage('', { limit });
  let done = 0;
  for (const row of page.items) {
    if (!(await staleQueue.compareAndDelete(row))) continue; // another instance claimed it
    try {
      await rebuildProductEmbeddings(row.tenantId, row.orgId);
      done += 1;
    } catch (err) {
      await staleQueue.put(row);
      log.warn('embedding_refresh_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  return done;
}

let refreshStarted = false;
/** ADR 1110 P3 — the background re-embed of large catalogs (the reservation-sweep shape:
 *  feature-owned, bounded, unref'd, idempotent start). One org per tick. */
export function startEmbeddingRefreshSweep(pollMs = 5 * 60 * 1000): { stop: () => void } | null {
  if (refreshStarted) return null;
  refreshStarted = true;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void refreshQueuedEmbeddings(1).catch((err: unknown) => log.warn('embedding_refresh_tick_failed', { error: err instanceof Error ? err.message : String(err) })).finally(() => { running = false; });
  }, pollMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => { clearInterval(timer); refreshStarted = false; } };
}

/** Semantic recall: product ids ranked by embedding cosine for a query, most-similar
 *  first. Tenant+org-namespaced. Empty query ⇒ no semantic contribution. Best-effort:
 *  a vector-store failure returns [] (searchProducts degrades to lexical-only). */
export async function queryProductEmbeddings(tenantId: string, orgId: string, q: string, topK = 48): Promise<string[]> {
  if (!q || !q.trim()) return [];
  try {
    const vector = buildHostSurfaceBundle({ tenantId }).db.vector;
    const res = await vector.query({ namespace: namespaceOf(tenantId, orgId), vector: embedText(q, effectiveEmbedDims()), topK });
    const matches = (res.matches ?? []) as Array<{ id?: unknown; metadata?: { productId?: unknown } }>;
    return matches.map((m) => String((m.metadata?.productId ?? m.id) ?? '')).filter(Boolean);
  } catch { return []; }
}
