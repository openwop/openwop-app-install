/**
 * ADR 0123 Phase 3 — model arena (head-to-head Elo capture).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { recordArenaMatch, getArenaRating } from '../src/features/evals/arena.js';

const T = 'arena-tenant';
beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('recordArenaMatch', () => {
  it('a win moves BOTH models head-to-head (winner up, loser down)', async () => {
    const r = await recordArenaMatch(T, { matchId: 'm1', modelA: 'alpha', modelB: 'beta', winner: 'A', raterSubject: 'user:1', createdAt: '2026-01-01T00:00:00Z' });
    expect(r.ratingA).toBeGreaterThan(1500);
    expect(r.ratingB).toBeLessThan(1500);
    expect(await getArenaRating(T, 'alpha')).toBeCloseTo(r.ratingA);
    expect(await getArenaRating(T, 'beta')).toBeCloseTo(r.ratingB);
  });

  it('a tie barely moves equal-rated models', async () => {
    const r = await recordArenaMatch(T, { matchId: 'm2', modelA: 'g1', modelB: 'g2', winner: 'tie', raterSubject: 'user:1', createdAt: 'x' });
    expect(r.ratingA).toBeCloseTo(1500);
    expect(r.ratingB).toBeCloseTo(1500);
  });

  it('accumulates across matches (alpha keeps winning → climbs)', async () => {
    const before = await getArenaRating(T, 'alpha');
    await recordArenaMatch(T, { matchId: 'm3', modelA: 'alpha', modelB: 'beta', winner: 'A', raterSubject: 'user:1', createdAt: 'x' });
    expect(await getArenaRating(T, 'alpha')).toBeGreaterThan(before);
  });

  it('rejects identical models', async () => {
    await expect(recordArenaMatch(T, { matchId: 'x', modelA: 'a', modelB: 'a', winner: 'A', raterSubject: 'u', createdAt: 'x' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('tenant isolation — another tenant starts fresh', async () => {
    expect(await getArenaRating('other-tenant', 'alpha')).toBe(1500);
  });
});
