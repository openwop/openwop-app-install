/**
 * ADR 0448 P2 — the hashed-at-rest re-key migration. Pins:
 *  - a legacy RAW-keyed link row is re-keyed to sha256 and keeps resolving by
 *    the same public URL token (continuity for pre-migration links — the ADR
 *    0402 booking/e-sign class);
 *  - idempotent by SHAPE (a second pass migrates nothing — no sentinel);
 *  - frame-view rows follow their link, and a crash-shaped duplicate keeps the
 *    larger count;
 *  - post-migration rows never carry the raw token.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { hashToken } from '../src/host/capabilityToken.js';

const T = 'ws:rekey';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('rekeySharingAtRest', () => {
  it('re-keys legacy rows, keeps public resolution working, and is idempotent by shape', async () => {
    const { rekeySharingAtRest, _frameViewCountForToken } = await import('../src/features/sharing/sharingService.js');
    const { createOrg } = await import('../src/host/accessControlService.js');
    const org = await createOrg({ tenantId: T, name: 'Rekey Org', createdBy: 'user:owner' });

    // Seed a LEGACY raw-keyed row exactly as pre-0448 code stored it.
    const raw = 'legacyRawToken_abc123';
    const legacy = new DurableCollection<Record<string, unknown>>('sharing:link', (l) => String(l.token), undefined, (l) => String(l.tenantId));
    await legacy.put({
      token: raw, tenantId: T, orgId: org.orgId, resourceType: 'prompt', resourceId: 'prm-1',
      createdBy: 'user:owner', createdAt: new Date().toISOString(), viewCount: 0, revoked: false,
    });
    const legacyFrames = new DurableCollection<Record<string, unknown>>('sharing:frameview', (v) => `${String(v.token)}:${String(v.frame)}`, undefined, (v) => String(v.tenantId));
    await legacyFrames.put({ token: raw, tenantId: T, frame: 0, count: 3 });
    // Crash-shaped duplicate: the NEW key already exists with a larger count.
    const newFrames = new DurableCollection<Record<string, unknown>>('sharing:frameview', (v) => `${String(v.tokenHash)}:${String(v.frame)}`, undefined, (v) => String(v.tenantId));
    await newFrames.put({ tokenHash: hashToken(raw), tenantId: T, frame: 1, count: 9 });
    await legacyFrames.put({ token: raw, tenantId: T, frame: 1, count: 2 });

    const first = await rekeySharingAtRest();
    expect(first.links).toBe(1);
    expect(first.frames).toBe(2);

    // The raw-keyed rows are gone; the hash-keyed rows exist without the raw.
    expect(await legacy.get(raw)).toBeNull();
    const rekeyed = await new DurableCollection<Record<string, unknown>>('sharing:link', (l) => String(l.tokenHash), undefined, (l) => String(l.tenantId)).get(hashToken(raw));
    expect(rekeyed?.tokenHash).toBe(hashToken(raw));
    expect(rekeyed?.token).toBeUndefined();

    // Frame counts followed; the crash-shaped duplicate kept the LARGER count.
    expect((await newFrames.get(`${hashToken(raw)}:0`))?.count).toBe(3);
    expect((await newFrames.get(`${hashToken(raw)}:1`))?.count).toBe(9);
    expect(await _frameViewCountForToken(raw)).toBe(2);

    // Idempotent: a second pass finds only new-shape rows and migrates nothing.
    const second = await rekeySharingAtRest();
    expect(second).toEqual({ links: 0, frames: 0 });
  });

  it('grade fix #1 — the at-rest tokenHash is NOT a public credential (a leaked hash double-hashes and misses); the raw token still resolves', async () => {
    // Assert at the resolve layer with a hand-seeded HASH-KEYED row: presenting
    // the stored hash as the public token must double-hash and MISS.
    const { resolveShared } = await import('../src/features/sharing/sharingService.js');
    const { createOrg } = await import('../src/host/accessControlService.js');
    const org = await createOrg({ tenantId: T, name: 'Hash Org', createdBy: 'user:owner' });
    const raw = 'shr_publicRawToken123';
    const store = new DurableCollection<Record<string, unknown>>('sharing:link', (l) => String(l.tokenHash), undefined, (l) => String(l.tenantId));
    await store.put({
      tokenHash: hashToken(raw), tenantId: T, orgId: org.orgId, resourceType: 'prompt', resourceId: 'prm-h',
      createdBy: 'user:owner', createdAt: new Date().toISOString(), viewCount: 0, revoked: false,
    });
    // The RAW reaches the row (throws only on the missing prompt resource)…
    // …while the LEAKED HASH must miss at the key layer with the same uniform 404.
    await expect(resolveShared(hashToken(raw))).rejects.toThrow(/not found/i);
    // DIFFERENTIAL proof the raw hits the row while the hash does not.
    //
    // This probe USED to be "the raw path bumps viewCount to 1, the hash path
    // leaves it at 1" — which only worked because the view was counted BEFORE
    // the resource load, i.e. because every hit on an orphaned link burned a
    // `maxViews` slot on a 404. SHARE-UX-1 fixed that ordering, so the old probe
    // now measures the defect's absence and reads as a regression. Replaced with
    // a differential that survives the fix: only a row HIT can produce the
    // resource-gone reason; a key MISS is the reason-less uniform 404.
    await expect(resolveShared(raw)).rejects.toMatchObject({
      httpStatus: 404, details: { reason: 'resource-gone' }, // reached the row, then the resolver
    });
    await expect(resolveShared(hashToken(raw))).rejects.toMatchObject({
      httpStatus: 404, message: 'Shared link not found.', // never reached the row
    });
    // …and SHARE-UX-1's own guarantee, pinned here because this is where the
    // orphan case is already set up: a dead link costs NO view.
    expect((await store.get(hashToken(raw)))?.viewCount).toBe(0);
  });

  it('grade fix #3 — a legacy link resolves via the LAZY on-read migration even before the boot pass runs', async () => {
    const { resolveShared } = await import('../src/features/sharing/sharingService.js');
    const { createOrg } = await import('../src/host/accessControlService.js');
    const org = await createOrg({ tenantId: T, name: 'Lazy Org', createdBy: 'user:owner' });
    const raw = 'legacyLazyToken_zzz9';
    const legacy = new DurableCollection<Record<string, unknown>>('sharing:link', (l) => String(l.token), undefined, (l) => String(l.tenantId));
    await legacy.put({
      token: raw, tenantId: T, orgId: org.orgId, resourceType: 'prompt', resourceId: 'prm-lazy',
      createdBy: 'user:owner', createdAt: new Date().toISOString(), viewCount: 0, revoked: false,
    });
    // No rekey pass has run for this row: the public resolve must find it via
    // the on-read fallback (it 404s only for resource reasons, never key-miss).
    await expect(resolveShared(raw)).rejects.toThrow(); // prompt resource absent -> resolver 404, NOT a key miss
    // The row was migrated in place by the read:
    expect(await legacy.get(raw)).toBeNull();
    const rekeyed = await new DurableCollection<Record<string, unknown>>('sharing:link', (l) => String(l.tokenHash), undefined, (l) => String(l.tenantId)).get(hashToken(raw));
    expect(rekeyed?.tokenHash).toBe(hashToken(raw));
  });
});
