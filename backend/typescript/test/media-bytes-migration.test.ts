/**
 * ADR 0083 review #2 — byte-store namespace rename + legacy migration.
 *
 * The host media byte-store moved off the `media:asset` collection (which it shared with
 * `mediaService.assets`) to `media:bytes`. Existing rows under the legacy `media:asset`
 * prefix are read-fallback'd AND migrated-on-read by `resolveMediaAsset` (zero-downtime,
 * self-healing) — no big-bang migration that could orphan a served URL.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { storeMediaAsset, resolveMediaAsset, deleteMediaAsset } from '../src/host/inMemorySurfaces.js';

interface ByteRow { token: string; tenantId: string; contentBase64: string; contentType: string; bytes: number; expiresAtMs: number }
const legacy = () => new DurableCollection<ByteRow>('media:asset', (e) => e.token);   // pre-#2 location
const bytesNew = () => new DurableCollection<ByteRow>('media:bytes', (e) => e.token); // post-#2 location
const future = (): number => Date.now() + 3_600_000;

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('ADR 0083 #2 — byte-store rename + legacy migration', () => {
  it('new assets store under media:bytes, NOT the overlapping media:asset prefix', async () => {
    const r = await storeMediaAsset('tA', { contentBase64: 'AAAABBBBCCCC', contentType: 'image/png' });
    expect(await bytesNew().get(r.token)).not.toBeNull();
    expect(await legacy().get(r.token)).toBeNull();
    expect((await resolveMediaAsset(r.token))?.tenantId).toBe('tA');
  });

  it('a legacy media:asset byte row still resolves AND migrates to media:bytes on read', async () => {
    const token = 'legacy-token-xyz';
    await legacy().put({ token, tenantId: 'tA', contentBase64: 'BBBB', contentType: 'image/png', bytes: 3, expiresAtMs: future() });
    const e = await resolveMediaAsset(token);
    expect(e?.tenantId).toBe('tA');               // served from the legacy location
    expect(await bytesNew().get(token)).not.toBeNull(); // migrated to the new location
    expect(await legacy().get(token)).toBeNull();       // legacy row drained
  });

  it('deleteMediaAsset frees a legacy row (both locations)', async () => {
    const token = 'leg2';
    await legacy().put({ token, tenantId: 'tA', contentBase64: 'CCCC', contentType: 'image/png', bytes: 3, expiresAtMs: future() });
    expect(await deleteMediaAsset('tA', token)).toBe(true);
    expect(await resolveMediaAsset(token)).toBeNull();
  });

  it('a foreign tenant cannot delete a legacy row', async () => {
    const token = 'leg3';
    await legacy().put({ token, tenantId: 'tA', contentBase64: 'DDDD', contentType: 'image/png', bytes: 3, expiresAtMs: future() });
    expect(await deleteMediaAsset('tOther', token)).toBe(false);
  });

  it('an EXPIRED legacy row returns null and is purged from both locations (not migrated)', async () => {
    const token = 'leg-expired';
    await legacy().put({ token, tenantId: 'tA', contentBase64: 'EEEE', contentType: 'image/png', bytes: 3, expiresAtMs: Date.now() - 1000 });
    expect(await resolveMediaAsset(token)).toBeNull();
    expect(await legacy().get(token)).toBeNull();   // purged from legacy
    expect(await bytesNew().get(token)).toBeNull();  // never migrated an expired row
  });
});
