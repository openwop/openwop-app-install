/**
 * ADR 0837 D3 / architect A2 (CRM2CD-5) — the per-tenant operation lock that the
 * CRM merge lock and the demo-seed lock share. The witness for the A2 cure: a
 * holder that outlived its TTL and had its lock stolen must NOT free the thief's
 * lock on release (the seed lock's blind `kvDelete` did, letting a third holder in),
 * and a released lock must be acquirable again (a `released` sentinel that is not
 * treated as free would wedge every later merge in that tenant).
 */
import { describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { withTenantOpLock } from '../src/host/tenantOpLock.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withTenantOpLock', () => {
  it('a second caller is refused while the first holds the lock, and admitted after it releases', async () => {
    const storage = await openStorage('memory://');
    let release!: () => void;
    const holding = withTenantOpLock(storage, 'lock:a', 60_000, () => new Promise<void>((r) => { release = r; }));
    await tick(5);
    expect(await withTenantOpLock(storage, 'lock:a', 60_000, async () => 'second')).toEqual({ held: false });
    release();
    expect(await holding).toEqual({ held: true, value: undefined });
    expect(await withTenantOpLock(storage, 'lock:a', 60_000, async () => 'third')).toEqual({ held: true, value: 'third' });
    expect(await withTenantOpLock(storage, 'lock:a', 60_000, async () => 'fourth')).toEqual({ held: true, value: 'fourth' });
  });

  it('a stale holder\'s release does not free the lock a later caller stole (no third holder)', async () => {
    const storage = await openStorage('memory://');
    let releaseX!: () => void;
    const TTL = 200; // one TTL per key — every acquirer judges staleness by it
    const x = withTenantOpLock(storage, 'lock:b', TTL, () => new Promise<void>((r) => { releaseX = r; }));
    await tick(TTL + 50); // X is now older than the TTL: the next caller steals it
    let releaseY!: () => void;
    const y = withTenantOpLock(storage, 'lock:b', TTL, () => new Promise<void>((r) => { releaseY = r; }));
    await tick(5);
    releaseX();
    expect(await x).toMatchObject({ held: true });
    // Y still holds it (well inside the TTL): X's release must have left Y's token in place.
    expect(await withTenantOpLock(storage, 'lock:b', TTL, async () => 'z')).toEqual({ held: false });
    releaseY();
    expect(await y).toMatchObject({ held: true });
    expect(await withTenantOpLock(storage, 'lock:b', TTL, async () => 'z')).toEqual({ held: true, value: 'z' });
  });

  it('releases on a throw', async () => {
    const storage = await openStorage('memory://');
    await expect(withTenantOpLock(storage, 'lock:c', 60_000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withTenantOpLock(storage, 'lock:c', 60_000, async () => 1)).toEqual({ held: true, value: 1 });
  });
});
