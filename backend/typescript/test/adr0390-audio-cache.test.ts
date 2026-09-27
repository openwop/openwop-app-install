/**
 * ADR 0390 / PODCAST-1 — the byte-budgeted decode-once LRU + decode-concurrency
 * semaphore behind the public podcast audio route. Unit-level (the cache is a
 * self-contained module): a cache HIT serves ranges without re-decoding, the
 * total byte budget evicts LRU, and no more than the configured number of
 * decodes run at once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getOrDecodeAudio,
  __resetPodcastAudioCache,
  __podcastAudioCacheStats,
  type DecodedAudio,
} from '../src/features/podcasts/audioCache.js';

const TENANT = 't1';
const ENVS = [
  'OPENWOP_PODCAST_AUDIO_CACHE_BYTES',
  'OPENWOP_PODCAST_AUDIO_CACHE_ENTRY_MAX_BYTES',
  'OPENWOP_PODCAST_AUDIO_DECODE_CONCURRENCY',
];

beforeEach(() => {
  __resetPodcastAudioCache();
  for (const e of ENVS) delete process.env[e];
});
afterEach(() => {
  for (const e of ENVS) delete process.env[e];
});

/** A decode fn that counts calls per token and yields a `size`-byte buffer. */
function counterDecode(size: number, counter: { n: number }): () => Promise<DecodedAudio | null> {
  return async () => {
    counter.n += 1;
    return { buffer: Buffer.alloc(size, 1), contentType: 'audio/mpeg', tenantId: TENANT };
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('PODCAST-1 — decode-once LRU', () => {
  it('a cache hit serves without re-decoding (decode runs once for repeated ranges)', async () => {
    const counter = { n: 0 };
    const decode = counterDecode(512, counter);
    const a = await getOrDecodeAudio('tok', TENANT, decode);
    const b = await getOrDecodeAudio('tok', TENANT, decode);
    const c = await getOrDecodeAudio('tok', TENANT, decode);
    expect(counter.n).toBe(1);              // decoded once, served thrice
    expect(a?.buffer.length).toBe(512);
    expect(b?.buffer).toBe(a?.buffer);      // same underlying buffer (no re-alloc)
    expect(c?.buffer).toBe(a?.buffer);
    expect(__podcastAudioCacheStats().entries).toBe(1);
  });

  it('a foreign-tenant cache entry is not served (re-checks tenant on hit)', async () => {
    const counter = { n: 0 };
    await getOrDecodeAudio('tok', TENANT, counterDecode(64, counter));
    // Another tenant asking for the same token key decodes for ITS decode fn
    // (which would tenant-check and could return null in prod); here it returns
    // a different-tenant buffer to prove the hit-path tenant guard fired.
    const other = await getOrDecodeAudio('tok', 't2', async () => {
      counter.n += 1;
      return null; // prod decode tenant-checks → null → uniform 404
    });
    expect(other).toBeNull();
    expect(counter.n).toBe(2); // the t2 request did NOT serve t1's cached buffer
  });

  it('the total byte budget evicts least-recently-used entries', async () => {
    process.env.OPENWOP_PODCAST_AUDIO_CACHE_BYTES = '250'; // fits two 100-byte entries
    const ca = { n: 0 }; const cb = { n: 0 }; const cc = { n: 0 };
    await getOrDecodeAudio('A', TENANT, counterDecode(100, ca)); // resident 100 [A]
    await getOrDecodeAudio('B', TENANT, counterDecode(100, cb)); // resident 200 [A,B]
    await getOrDecodeAudio('C', TENANT, counterDecode(100, cc)); // 300>250 → evict A → [B,C]
    expect(__podcastAudioCacheStats().entries).toBe(2);
    expect(__podcastAudioCacheStats().residentBytes).toBeLessThanOrEqual(250);
    // C (newest) is still a hit; A (LRU) was evicted → its re-fetch decodes again.
    await getOrDecodeAudio('C', TENANT, counterDecode(100, cc));
    expect(cc.n).toBe(1); // C still cached — never re-decoded
    await getOrDecodeAudio('A', TENANT, counterDecode(100, ca));
    expect(ca.n).toBe(2); // A decoded twice (evicted between)
  });

  it('an entry larger than the per-entry cap is never cached (streams per request)', async () => {
    process.env.OPENWOP_PODCAST_AUDIO_CACHE_ENTRY_MAX_BYTES = '100';
    const counter = { n: 0 };
    await getOrDecodeAudio('big', TENANT, counterDecode(200, counter)); // 200 > 100 cap
    await getOrDecodeAudio('big', TENANT, counterDecode(200, counter));
    expect(counter.n).toBe(2);                              // decoded every time
    expect(__podcastAudioCacheStats().entries).toBe(0);     // never entered the cache
  });
});

describe('PODCAST-1 — decode-concurrency semaphore', () => {
  it('caps concurrent decodes at the configured limit; all requests still resolve', async () => {
    process.env.OPENWOP_PODCAST_AUDIO_DECODE_CONCURRENCY = '2';
    let active = 0; let peak = 0;
    const slowDecode = (): Promise<DecodedAudio | null> => (async () => {
      active += 1; peak = Math.max(peak, active);
      await sleep(25);
      active -= 1;
      return { buffer: Buffer.alloc(32, 1), contentType: 'audio/mpeg', tenantId: TENANT };
    })();
    // Six DISTINCT tokens → all cold-cache → all decode; the semaphore must keep
    // no more than 2 in flight at once.
    const tokens = ['a', 'b', 'c', 'd', 'e', 'f'];
    const results = await Promise.all(tokens.map((t) => getOrDecodeAudio(t, TENANT, () => slowDecode())));
    expect(results.every((r) => r?.buffer.length === 32)).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(0);
  });
});
