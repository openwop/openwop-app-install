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

/**
 * EVC-2 — the arena WRITE must not be ballot-stuffable. Before this fix
 * `recordArenaMatch` had no idempotency (a replayed matchId re-applied the Elo
 * delta) and no cap (one rater's 40 self-wins drove a model +200). The cap is on
 * the (rater, MODEL) axis, NOT (rater, pair): a per-pair cap is evaded by ROTATING
 * the opponent string (adversarial review measured +307 via rotation, WORSE than
 * the +226 concentrated attack a per-pair cap would block). The rotation-evasion
 * case below is the load-bearing witness. Positive controls prove the cap doesn't
 * over-restrict legitimate consensus (distinct raters) or disjoint models.
 */
describe('EVC-2 — idempotency + per-model ballot-stuffing cap', () => {
  it('a replayed matchId is a no-op — the Elo delta applies exactly ONCE', async () => {
    const TE = 'arena-evc2-idem';
    const first = await recordArenaMatch(TE, { matchId: 'ev-dup', modelA: 'mx', modelB: 'my', winner: 'A', raterSubject: 'user:r1', createdAt: 'x' });
    const afterFirst = await getArenaRating(TE, 'mx');
    expect(afterFirst).toBeCloseTo(first.ratingA);
    expect(afterFirst).toBeGreaterThan(1500); // it DID move (positive control)
    // Replay the SAME matchId → no second delta.
    await recordArenaMatch(TE, { matchId: 'ev-dup', modelA: 'mx', modelB: 'my', winner: 'A', raterSubject: 'user:r1', createdAt: 'x' });
    expect(await getArenaRating(TE, 'mx')).toBeCloseTo(afterFirst); // unchanged — idempotent
  });

  it('opponent ROTATION does not evade the cap: 8 verdicts on model ca (distinct opponents each time), then the 9th on ca vs a BRAND-NEW opponent is REFUSED', async () => {
    const TC = 'arena-evc2-cap';
    // 8 verdicts by one rater all involving model `ca`, each against a DIFFERENT
    // opponent — the exact rotation a per-pair cap would wave through. All succeed.
    for (let i = 0; i < 8; i++) {
      await recordArenaMatch(TC, { matchId: `rot-${i}`, modelA: 'ca', modelB: `opp-${i}`, winner: 'A', raterSubject: 'user:stuffer', createdAt: 'x' });
    }
    // The 9th verdict involving `ca` — even against a never-before-seen opponent —
    // is REFUSED. This is the rotation-evasion witness: the cap counts every match
    // touching `ca`, not just repeats of one pair.
    await expect(recordArenaMatch(TC, { matchId: 'rot-9', modelA: 'ca', modelB: 'opp-fresh', winner: 'A', raterSubject: 'user:stuffer', createdAt: 'x' }))
      .rejects.toMatchObject({ code: 'rate_limited' });
    // …and it is refused with `ca` on the OTHER side too (either-side counting).
    await expect(recordArenaMatch(TC, { matchId: 'rot-10', modelA: 'opp-fresh2', modelB: 'ca', winner: 'B', raterSubject: 'user:stuffer', createdAt: 'x' }))
      .rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('the cap is per-(rater, model): a DIFFERENT rater on ca still counts, and the SAME rater on DISJOINT models still counts', async () => {
    const TC = 'arena-evc2-cap';
    // A DIFFERENT rater voting on `ca` is unaffected (consensus is legitimate; the
    // cap bounds ONE rater's influence, not the model's total volume).
    expect((await recordArenaMatch(TC, { matchId: 'cap-honest', modelA: 'ca', modelB: 'opp-h', winner: 'A', raterSubject: 'user:honest', createdAt: 'x' })).match.matchId).toBe('cap-honest');
    // The SAME (capped-on-ca) rater on a DISJOINT model pair still counts — it is
    // NOT a global per-rater cap, only per model.
    expect((await recordArenaMatch(TC, { matchId: 'cap-disjoint', modelA: 'px', modelB: 'py', winner: 'A', raterSubject: 'user:stuffer', createdAt: 'x' })).match.matchId).toBe('cap-disjoint');
  });
});
