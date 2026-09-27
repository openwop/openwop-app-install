/**
 * Small TTL'd, bounded LRU memo for the UNAUTHED public read surfaces (ADR 0384
 * SEO-2 + ADR 0391 BLOG-1). Two amplifiers ride these caches:
 *
 *   - `listPublishedWithSeo` (the sitemap / feed.rss / blog list / blog feed
 *     projection) does a `pages.list()` global scan + an SEO-store scan on EVERY
 *     anonymous hit — memoized per `(orgId, filter-kind)`;
 *   - the crawler prerender recomputes projection + render on every bot hit,
 *     fragmented per-UA by `Vary` so effectively uncached — memoized per
 *     `(orgId, slug, negotiated-locale)`.
 *
 * Posture (documented, matches ADR 0384's cache stance — correct-over-fresh with
 * a short TTL): TTL-only invalidation. A just-published edit becomes visible
 * within `ttlMs` — there is no write-through invalidation hook (the content is
 * published-gated and low-churn; the sitemap/feed/blog are crawler-facing, not
 * a live editor preview). Entry count is LRU-bounded so an unbounded filter/slug/
 * locale key space (a hostile client varying query params) can never grow the
 * map without bound. A TTL of 0 disables the cache (every get misses) — the
 * operator kill-switch.
 */

interface Slot<V> { value: V; expiresAt: number }

export class TtlLruCache<V> {
  private readonly map = new Map<string, Slot<V>>();

  /** @param ttlMs read fresh each set (env-driven; 0 disables). @param maxEntries LRU bound. */
  constructor(private readonly ttlMs: () => number, private readonly maxEntries = 500) {}

  get(key: string): V | undefined {
    const slot = this.map.get(key);
    if (!slot) return undefined;
    if (Date.now() >= slot.expiresAt) { this.map.delete(key); return undefined; }
    // LRU bump: re-insert so this key is the most-recently-used.
    this.map.delete(key);
    this.map.set(key, slot);
    return slot.value;
  }

  set(key: string, value: V): void {
    const ttl = this.ttlMs();
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + Math.max(0, ttl) });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void { this.map.clear(); }
  get size(): number { return this.map.size; }
}

/** `OPENWOP_PUBLIC_LIST_TTL_S` (default 60s) → ms, for the list/projection memo. */
export function publicListTtlMs(): number {
  const raw = Number(process.env.OPENWOP_PUBLIC_LIST_TTL_S);
  return (Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 60) * 1000;
}
