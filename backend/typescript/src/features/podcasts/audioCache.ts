/**
 * Byte-budgeted, decode-once LRU for the public podcast audio route (ADR 0390 /
 * PODCAST-1). Podcast clients issue MANY small Range + prefetch requests during
 * playback against a `public`-cached, higher-fan-out surface, and the in-memory
 * Media store forces a `Buffer.from(base64)` decode of the WHOLE episode (up to
 * the 256 MB mux cap) per request. Left unbounded, N concurrent listeners stack
 * N × up-to-256 MB transient buffers → OOM / GC-latency on a modest Cloud Run
 * instance.
 *
 * This bounds that two ways:
 *   1. a decode-once LRU keyed by the media token — a hit serves every Range
 *      from the already-decoded Buffer, skipping BOTH the base64 store load and
 *      the decode (the playback-hot path). Total budget +
 *      `OPENWOP_PODCAST_AUDIO_CACHE_BYTES` (default 128 MB), per-entry cap
 *      `OPENWOP_PODCAST_AUDIO_CACHE_ENTRY_MAX_BYTES` (default 64 MB): an entry
 *      larger than the per-entry cap is NEVER cached (it would evict everything
 *      and thrash) — it decodes per request as before, but always behind (2).
 *   2. a small counting semaphore (`OPENWOP_PODCAST_AUDIO_DECODE_CONCURRENCY`,
 *      default 4) around ANY full decode, so a burst of cold-cache listeners can
 *      never hold more than N transient decode buffers at once.
 *
 * This is the INTERIM bound. Moving episode audio to object storage and serving
 * the enclosure as a signed-URL redirect (so the app process never buffers the
 * bytes) remains the recorded endgame — an ADR-level media-architecture change,
 * out of scope here (ADR 0390 record).
 *
 * @see docs/adr/0390-podcast-public-distribution.md
 */

const MB = 1024 * 1024;

function envBytes(name: string, dflt: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : dflt;
}
function envInt(name: string, dflt: number, min: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= min ? Math.floor(raw) : dflt;
}

/** Total decoded-byte budget across all cached entries. */
const cacheBudgetBytes = (): number => envBytes('OPENWOP_PODCAST_AUDIO_CACHE_BYTES', 128 * MB);
/** Largest single decoded entry that is allowed INTO the cache (bigger streams per request). */
const entryMaxBytes = (): number => envBytes('OPENWOP_PODCAST_AUDIO_CACHE_ENTRY_MAX_BYTES', 64 * MB);
/** Max concurrent full decodes. */
const decodeConcurrency = (): number => envInt('OPENWOP_PODCAST_AUDIO_DECODE_CONCURRENCY', 4, 1);

export interface DecodedAudio {
  buffer: Buffer;
  contentType: string;
  /** The tenant the decoded bytes belong to (a cache hit re-checks this). */
  tenantId: string;
}

// ── LRU (Map insertion-order = recency; re-set on access bumps to newest) ──────
interface Entry { value: DecodedAudio; bytes: number }
const lru = new Map<string, Entry>();
let residentBytes = 0;

function lruGet(token: string): DecodedAudio | undefined {
  const e = lru.get(token);
  if (!e) return undefined;
  lru.delete(token);
  lru.set(token, e); // bump to most-recent
  return e.value;
}

function lruPut(token: string, value: DecodedAudio): void {
  const bytes = value.buffer.length;
  if (bytes > entryMaxBytes()) return; // too large — never cached (streams per request)
  const existing = lru.get(token);
  if (existing) { residentBytes -= existing.bytes; lru.delete(token); }
  const budget = cacheBudgetBytes();
  if (bytes > budget) return; // can't ever fit
  // Evict least-recently-used until the newcomer fits.
  while (residentBytes + bytes > budget && lru.size > 0) {
    const oldest = lru.keys().next().value;
    if (oldest === undefined) break;
    const victim = lru.get(oldest);
    if (victim) residentBytes -= victim.bytes;
    lru.delete(oldest);
  }
  lru.set(token, { value, bytes });
  residentBytes += bytes;
}

// ── decode-concurrency semaphore ──────────────────────────────────────────────
let active = 0;
const waiters: Array<() => void> = [];

function acquire(): Promise<void> {
  if (active < decodeConcurrency()) { active += 1; return Promise.resolve(); }
  // Queue; the resumer (release) hands us its slot without touching `active`.
  return new Promise<void>((resolve) => { waiters.push(resolve); });
}
function release(): void {
  const next = waiters.shift();
  if (next) next(); // pass the slot to the next waiter (active unchanged)
  else active -= 1; // no waiter — free the slot
}

/**
 * Serve one episode's decoded audio, decoding at most once per token and never
 * running more than the configured number of decodes at a time. `decode` does
 * the actual (tenant-checked) base64 resolution + `Buffer.from` — it is called
 * ONLY on a cold cache, behind the semaphore. Returns null iff `decode` does
 * (unknown / expired / foreign-tenant asset → uniform 404 at the caller).
 */
export async function getOrDecodeAudio(
  token: string,
  tenantId: string,
  decode: () => Promise<DecodedAudio | null>,
): Promise<DecodedAudio | null> {
  const hit = lruGet(token);
  if (hit && hit.tenantId === tenantId) return hit;

  await acquire();
  try {
    // Re-check under the semaphore: a concurrent waiter may have just filled it.
    const raced = lruGet(token);
    if (raced && raced.tenantId === tenantId) return raced;
    const decoded = await decode();
    if (!decoded) return null;
    lruPut(token, decoded);
    return decoded;
  } finally {
    release();
  }
}

/** Test-only: clear the LRU + reset the decode semaphore to a known state. */
export function __resetPodcastAudioCache(): void {
  lru.clear();
  residentBytes = 0;
  active = 0;
  waiters.length = 0;
}

/** Test-only introspection. */
export function __podcastAudioCacheStats(): { entries: number; residentBytes: number; activeDecodes: number } {
  return { entries: lru.size, residentBytes, activeDecodes: active };
}
