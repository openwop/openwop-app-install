/**
 * SEC-1 (docs/steward/CODEBASE-ASSESSMENT.md): the durable SAML replay cache backing
 * node-saml's validateInResponseTo. A minted AuthnRequest id must be
 * single-use (consumed on validate) and expire, so a captured SAMLResponse
 * can't be replayed — and it must live in shared Storage, not process memory,
 * so mint-on-instance-A / consume-on-instance-B works under scale-out.
 *
 * The consume itself is node-saml's: `validateInResponseTo` calls the cache's
 * `removeAsync` after a successful validate. This file pins the ADAPTER's half
 * (`host/auth/samlSso.ts createSamlReplayCache`) — that `removeAsync` really
 * deletes, that the 10-minute TTL holds in both directions, and the shared key.
 *
 * Sabotage witnessed red (8f grade-tests wave 2): `removeAsync` a no-op
 * (`8fw2g3-saml-remove`), the TTL check doubled (`-saml-ttl-check`), the TTL
 * shortened to one minute (`-saml-ttl-short-r2`; round 1 was vacuous, no leg
 * read inside the TTL), and the shared key prefix dropped (`-saml-prefix`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createSamlReplayCache } from '../src/host/auth/samlSso.js';

/** Minimal kv stand-in over a Map — structurally matches the `KvStore` subset
 *  createSamlReplayCache needs, so no cast is required. */
function fakeStorage(): { storage: { kvGet: (k: string) => Promise<string | null>; kvSet: (k: string, v: string) => Promise<void>; kvDelete: (k: string) => Promise<boolean> }; map: Map<string, string> } {
  const map = new Map<string, string>();
  const storage = {
    async kvGet(key: string) { return map.get(key) ?? null; },
    async kvSet(key: string, value: string) { map.set(key, value); },
    async kvDelete(key: string) { return map.delete(key); },
  };
  return { storage, map };
}

afterEach(() => { vi.useRealTimers(); });

describe('createSamlReplayCache', () => {
  it('round-trips a minted request id', async () => {
    const { storage } = fakeStorage();
    const cache = createSamlReplayCache(storage);
    await cache.saveAsync('req-1', '2026-01-01T00:00:00Z');
    expect(await cache.getAsync('req-1')).toBe('2026-01-01T00:00:00Z');
  });

  it('is single-use: removeAsync consumes the id (node-saml calls it on validate), so a replay no longer validates', async () => {
    const { storage } = fakeStorage();
    const cache = createSamlReplayCache(storage);
    await cache.saveAsync('req-2', 'v');
    expect(await cache.getAsync('req-2')).toBe('v');
    await cache.removeAsync('req-2');
    expect(await cache.getAsync('req-2')).toBeNull();
  });

  it('expires a stale request id after the TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { storage, map } = fakeStorage();
    const cache = createSamlReplayCache(storage);
    await cache.saveAsync('req-3', 'v');
    await cache.saveAsync('req-3b', 'w');
    // 9m59s later (inside the 10m TTL) → still valid. A shortened TTL reds here.
    vi.setSystemTime(new Date('2026-01-01T00:09:59Z'));
    expect(await cache.getAsync('req-3b')).toBe('w');
    // 11 minutes later (> 10m TTL) → expired, and the stale row is deleted.
    vi.setSystemTime(new Date('2026-01-01T00:11:00Z'));
    expect(await cache.getAsync('req-3')).toBeNull();
    expect(map.has('saml:reqid:req-3')).toBe(false);
  });

  it('persists in shared storage (mint + consume can cross instances)', async () => {
    const { storage, map } = fakeStorage();
    // Instance A mints.
    await createSamlReplayCache(storage).saveAsync('req-4', 'v');
    // A different cache object over the SAME storage (≈ another instance) reads it.
    const cacheB = createSamlReplayCache(storage);
    expect(await cacheB.getAsync('req-4')).toBe('v');
    expect([...map.keys()][0]).toContain('saml:reqid:req-4');
  });
});
