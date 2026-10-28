/**
 * ADR 0837 D3 / architect A2 (CRM2CD-5) — the per-tenant operation lock that the
 * CRM merge lock and the demo-seed lock share. The witness for the A2 cure: a
 * holder that outlived its TTL and had its lock stolen must NOT free the thief's
 * lock on release (the seed lock's blind `kvDelete` did, letting a third holder in),
 * and a released lock must be acquirable again (a `released` sentinel that is not
 * treated as free would wedge every later merge in that tenant).
 *
 * TST-BWB-3 (grade-tests w62): no real-clock waits — staleness is reached by moving
 * `Date.now` past the TTL (restored in `finally`), and "the first caller holds it" is
 * awaited with a setImmediate drain (acquisition is a chain of awaited memory CAS calls).
 * Red when: a refused acquire still runs (`token === null` guard gone); the `released`
 * sentinel is not treated as free; a stale holder is never stolen from; release swaps
 * whatever value is there instead of its own token (the blind release — "no third
 * holder" reds); or release is skipped on a throw.
 */
import { describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { withTenantOpLock } from '../src/host/tenantOpLock.js';

/** Let every already-queued continuation run (the acquire chain settles inside this). */
const drain = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r)); };

describe('withTenantOpLock', () => {
  it('a second caller is refused while the first holds the lock, and admitted after it releases', async () => {
    const storage = await openStorage('memory://');
    let release!: () => void;
    const holding = withTenantOpLock(storage, 'lock:a', 60_000, () => new Promise<void>((r) => { release = r; }));
    await drain();
    expect(await withTenantOpLock(storage, 'lock:a', 60_000, async () => 'second')).toEqual({ held: false });
    release();
    expect(await holding).toEqual({ held: true, value: undefined });
    expect(await withTenantOpLock(storage, 'lock:a', 60_000, async () => 'third')).toEqual({ held: true, value: 'third' });
    expect(await withTenantOpLock(storage, 'lock:a', 60_000, async () => 'fourth')).toEqual({ held: true, value: 'fourth' });
  });

  it('a stale holder\'s release does not free the lock a later caller stole (no third holder)', async () => {
    const storage = await openStorage('memory://');
    const TTL = 200; // one TTL per key — every acquirer judges staleness by it
    const t0 = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      let releaseX!: () => void;
      const x = withTenantOpLock(storage, 'lock:b', TTL, () => new Promise<void>((r) => { releaseX = r; }));
      await drain();
      now.mockReturnValue(t0 + TTL + 50); // X is now older than the TTL: the next caller steals it
      let releaseY!: () => void;
      const y = withTenantOpLock(storage, 'lock:b', TTL, () => new Promise<void>((r) => { releaseY = r; }));
      await drain();
      releaseX();
      expect(await x).toMatchObject({ held: true });
      // Y still holds it (well inside the TTL): X's release must have left Y's token in place.
      expect(await withTenantOpLock(storage, 'lock:b', TTL, async () => 'z')).toEqual({ held: false });
      releaseY();
      expect(await y).toMatchObject({ held: true });
      expect(await withTenantOpLock(storage, 'lock:b', TTL, async () => 'z')).toEqual({ held: true, value: 'z' });
    } finally {
      now.mockRestore();
    }
  });

  it('releases on a throw', async () => {
    const storage = await openStorage('memory://');
    await expect(withTenantOpLock(storage, 'lock:c', 60_000, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await withTenantOpLock(storage, 'lock:c', 60_000, async () => 1)).toEqual({ held: true, value: 1 });
  });
});
