/**
 * Rate-limited structured-log gate for hot public routes (ADR 0384/0390 grade
 * pass). Emits at most once per `windowMs` per KEY, carrying the count suppressed
 * since the last emit — so a bandwidth-heavy or crawler-hammered public route
 * stays observable (status/bytes/split visible) without one log line per request.
 *
 * Cardinality is the caller's responsibility: keys MUST come from a small fixed
 * set (e.g. `podcast_audio_206`, `prerender_doc_bot`), NEVER per-request values
 * (orgId/slug/UA) — the bucket map is bounded defensively but is only cheap when
 * the key space is small.
 */

interface Bucket { start: number; suppressed: number }
const buckets = new Map<string, Bucket>();

/** Whether to emit now for `key`, plus how many emits were suppressed in the
 *  window just closed (attach it as a field so the count isn't lost). */
export function throttleLog(key: string, windowMs = 10_000): { emit: boolean; suppressed: number } {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now - b.start >= windowMs) {
    const suppressed = b?.suppressed ?? 0;
    if (buckets.size > 2000) buckets.clear(); // paranoia bound (keys are a fixed set)
    buckets.set(key, { start: now, suppressed: 0 });
    return { emit: true, suppressed };
  }
  b.suppressed += 1;
  return { emit: false, suppressed: 0 };
}

