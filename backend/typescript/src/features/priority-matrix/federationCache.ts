/**
 * Priority Matrix federation — process-local fan-out cache (ADR 0061 #3). The
 * federated portfolio fans out to every peer on each `GET /portfolio/federated`;
 * at enterprise scale many callers ⇒ many duplicate outbound peer calls + latency.
 * This is the standard mitigation: a short-TTL, single-flight (request-coalescing),
 * bounded, jittered in-memory cache around the PEER fetch only.
 *
 * Correctness, not just speed (the load-bearing rule): per ADR 0062 a peer's slice
 * depends on the resolved credential (a per-user bearer filters the peer to THAT
 * user's access). The cache key MUST therefore include the credential identity —
 * `coalesce()` is identity-agnostic; the CALLER builds a key that already carries
 * `(tenantId, peerId, topN, identity)`. See `cachedPeerFetch` in federationService.
 *
 * Process-local by design: a federated portfolio is a live, fail-soft read, so a
 * stale-by-≤TTL slice is acceptable and cross-instance coherence is NOT required
 * (no shared cache, no new infra). Nothing here is persisted or replayed.
 *
 * @see docs/adr/0061-priority-matrix-federated-portfolio.md
 */

interface CacheEntry<T> { value: T; expiresAt: number }

/** Bounded LRU store + in-flight single-flight map. A `Map` preserves insertion
 *  order, so eviction takes the front (least-recently-used) and a cache HIT re-inserts
 *  the entry at the back (touch-on-read) to keep recency true LRU, not FIFO. */
const store = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

/** Cap the number of distinct cache keys so a high-cardinality key space
 *  (many tenants × peers × users × topN) can't grow memory unbounded. */
const MAX_ENTRIES = 1_000;

/** ±20% jitter so entries created in the same burst don't all expire on the same
 *  tick and re-stampede the peers (spreads refresh load). */
function jittered(ttlMs: number): number {
  const spread = ttlMs * 0.2;
  return ttlMs - spread + Math.random() * (2 * spread);
}

function evictIfNeeded(): void {
  while (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/**
 * Return a cached value for `key` if fresh; otherwise run `fn` ONCE even under
 * concurrent callers (single-flight), caching the result for a jittered `ttlMs`.
 * `cacheIf` decides whether a settled value is worth storing (default: always) —
 * federation passes `r => r.ok` so a transient peer failure is never cached.
 * A rejected `fn` is propagated to every coalesced caller and never cached.
 */
export async function coalesce<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  cacheIf: (value: T) => boolean = () => true,
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    store.delete(key); store.set(key, hit); // touch-on-read → move to MRU end (true LRU)
    return hit.value as T;
  }

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const p = (async () => {
    try {
      const value = await fn();
      if (cacheIf(value)) {
        store.set(key, { value, expiresAt: Date.now() + jittered(ttlMs) });
        evictIfNeeded();
      }
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/**
 * Drop every cached entry whose key matches `predicate`. Used to bust the cache when
 * the inputs a key encodes change out-of-band — e.g. a peer credential is rotated, so
 * the same `identity` tier now authorizes a different slice and the ≤TTL stale-token
 * window must not serve the old one. (The caller owns the key format and builds the
 * predicate; the cache stays identity-agnostic.) An in-flight fetch that settles after
 * this call may re-populate — a sub-second race far inside the TTL, acceptable here.
 */
export function invalidateWhere(predicate: (key: string) => boolean): void {
  for (const key of [...store.keys()]) if (predicate(key)) store.delete(key);
}

/** Test-only: clear the cache + in-flight map. */
export function __resetFanoutCache(): void {
  store.clear();
  inflight.clear();
}

/** Test/diagnostics: current number of cached keys. */
export function __fanoutCacheSize(): number {
  return store.size;
}
