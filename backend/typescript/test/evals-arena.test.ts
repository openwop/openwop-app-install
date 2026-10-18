/**
 * ADR 0123 Phase 3 — model arena (head-to-head Elo capture) + EVC-2 ballot-stuffing bound.
 *
 * Guards `features/evals/arena.ts` `recordArenaMatch`: both models move, ties are scored
 * 0.5, ratings accumulate, identical models are refused, ratings are per-tenant, a replayed
 * matchId is a no-op, and one rater's verdicts on any single model are capped (either side,
 * any opponent) without capping other raters or disjoint models. Every case seeds its OWN
 * tenant, so each passes alone and under shuffle.
 *
 * Witnessed (wave 25 probes): a zero loser delta, no identical-model check, no idempotency,
 * a one-sided cap count, cap + 100, a per-rater (not per-model) cap, an all-raters cap, a
 * non-accumulating base, tie = 0.75, and a tenant-blind rating read each red their case.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { recordArenaMatch, getArenaRating } from '../src/features/evals/arena.js';

const T = 'arena-tenant';
const AT = '2026-01-01T00:00:00.000Z';
beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

describe('recordArenaMatch', () => {
  it('a win moves BOTH models head-to-head (winner up, loser down)', async () => {
    const r = await recordArenaMatch(T, { matchId: 'm1', modelA: 'alpha', modelB: 'beta', winner: 'A', raterSubject: 'user:1', createdAt: AT });
    expect(r.ratingA).toBeGreaterThan(1500);
    expect(r.ratingB).toBeLessThan(1500);
    expect(await getArenaRating(T, 'alpha')).toBeCloseTo(r.ratingA);
    expect(await getArenaRating(T, 'beta')).toBeCloseTo(r.ratingB);
  });

  it('a tie barely moves equal-rated models', async () => {
    const r = await recordArenaMatch(T, { matchId: 'm2', modelA: 'g1', modelB: 'g2', winner: 'tie', raterSubject: 'user:1', createdAt: AT });
    expect(r.ratingA).toBeCloseTo(1500);
    expect(r.ratingB).toBeCloseTo(1500);
  });

  it('accumulates across matches (alpha keeps winning → climbs)', async () => {
    const TA = 'arena-accumulate';
    await recordArenaMatch(TA, { matchId: 'acc-1', modelA: 'alpha', modelB: 'beta', winner: 'A', raterSubject: 'user:1', createdAt: AT });
    const before = await getArenaRating(TA, 'alpha');
    expect(before, 'precondition: the first win landed').toBeGreaterThan(1500);
    await recordArenaMatch(TA, { matchId: 'acc-2', modelA: 'alpha', modelB: 'beta', winner: 'A', raterSubject: 'user:1', createdAt: AT });
    expect(await getArenaRating(TA, 'alpha')).toBeGreaterThan(before);
  });

  it('rejects identical models', async () => {
    await expect(recordArenaMatch(T, { matchId: 'x', modelA: 'a', modelB: 'a', winner: 'A', raterSubject: 'u', createdAt: AT })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('tenant isolation — another tenant starts fresh', async () => {
    // The row must EXIST in one tenant, or "1500 elsewhere" proves nothing.
    await recordArenaMatch('arena-iso-a', { matchId: 'iso-1', modelA: 'alpha', modelB: 'beta', winner: 'A', raterSubject: 'user:1', createdAt: AT });
    expect(await getArenaRating('arena-iso-a', 'alpha'), 'precondition: the row exists in tenant a').toBeGreaterThan(1500);
    expect(await getArenaRating('arena-iso-b', 'alpha')).toBe(1500);
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
    const first = await recordArenaMatch(TE, { matchId: 'ev-dup', modelA: 'mx', modelB: 'my', winner: 'A', raterSubject: 'user:r1', createdAt: AT });
    const afterFirst = await getArenaRating(TE, 'mx');
    expect(afterFirst).toBeCloseTo(first.ratingA);
    expect(afterFirst).toBeGreaterThan(1500); // it DID move (positive control)
    // Replay the SAME matchId → no second delta.
    await recordArenaMatch(TE, { matchId: 'ev-dup', modelA: 'mx', modelB: 'my', winner: 'A', raterSubject: 'user:r1', createdAt: AT });
    expect(await getArenaRating(TE, 'mx')).toBeCloseTo(afterFirst); // unchanged — idempotent
  });

  it('opponent ROTATION does not evade the cap: 8 verdicts on model ca (distinct opponents each time), then the 9th on ca vs a BRAND-NEW opponent is REFUSED', async () => {
    const TC = 'arena-evc2-cap';
    // 8 verdicts by one rater all involving model `ca`, each against a DIFFERENT
    // opponent — the exact rotation a per-pair cap would wave through. All succeed.
    for (let i = 0; i < 8; i++) {
      await recordArenaMatch(TC, { matchId: `rot-${i}`, modelA: 'ca', modelB: `opp-${i}`, winner: 'A', raterSubject: 'user:stuffer', createdAt: AT });
    }
    // The 9th verdict involving `ca` — even against a never-before-seen opponent —
    // is REFUSED. This is the rotation-evasion witness: the cap counts every match
    // touching `ca`, not just repeats of one pair.
    await expect(recordArenaMatch(TC, { matchId: 'rot-9', modelA: 'ca', modelB: 'opp-fresh', winner: 'A', raterSubject: 'user:stuffer', createdAt: AT }))
      .rejects.toMatchObject({ code: 'rate_limited' });
    // …and it is refused with `ca` on the OTHER side too (either-side counting).
    await expect(recordArenaMatch(TC, { matchId: 'rot-10', modelA: 'opp-fresh2', modelB: 'ca', winner: 'B', raterSubject: 'user:stuffer', createdAt: AT }))
      .rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('the cap is per-(rater, model): a DIFFERENT rater on ca still counts, and the SAME rater on DISJOINT models still counts', async () => {
    // Own tenant + own stuffing, so this case cannot pass because it ran first.
    const TC = 'arena-evc2-cap-controls';
    for (let i = 0; i < 8; i++) {
      await recordArenaMatch(TC, { matchId: `ctl-rot-${i}`, modelA: 'ca', modelB: `opp-${i}`, winner: 'A', raterSubject: 'user:stuffer', createdAt: AT });
    }
    await expect(recordArenaMatch(TC, { matchId: 'ctl-rot-9', modelA: 'ca', modelB: 'opp-fresh', winner: 'A', raterSubject: 'user:stuffer', createdAt: AT }), 'precondition: the stuffer IS capped on ca')
      .rejects.toMatchObject({ code: 'rate_limited' });
    // A DIFFERENT rater voting on `ca` is unaffected (consensus is legitimate; the
    // cap bounds ONE rater's influence, not the model's total volume).
    expect((await recordArenaMatch(TC, { matchId: 'cap-honest', modelA: 'ca', modelB: 'opp-h', winner: 'A', raterSubject: 'user:honest', createdAt: AT })).match.matchId).toBe('cap-honest');
    // The SAME (capped-on-ca) rater on a DISJOINT model pair still counts — it is
    // NOT a global per-rater cap, only per model.
    expect((await recordArenaMatch(TC, { matchId: 'cap-disjoint', modelA: 'px', modelB: 'py', winner: 'A', raterSubject: 'user:stuffer', createdAt: AT })).match.matchId).toBe('cap-disjoint');
  });
});

/**
 * BLOCKED-ON-PRODUCT (wave 25, grade-code follow-up) — `arena.ts:35` keys the `matches`
 * ledger by `matchId` ALONE, so the EVC-2 idempotency lookup is tenant-blind: a matchId
 * already used in tenant X, submitted under tenant Y, returns X's `ArenaMatch` (X's
 * `raterSubject` included) and records nothing for Y. The route mints `randomUUID()`, so
 * reaching it needs a replayed/forged id from a non-route caller — latent, not live.
 * `it.fails` pins the CORRECT behaviour; it turns red (and must be flipped to `it`) once
 * the ledger is keyed `${tenantId}:${matchId}`.
 */
describe('EVC-2 idempotency is tenant-scoped (BLOCKED-ON-PRODUCT)', () => {
  it.fails('a matchId used in ANOTHER tenant is not replayed into this one', async () => {
    await recordArenaMatch('arena-mid-x', { matchId: 'shared-mid', modelA: 'alpha', modelB: 'beta', winner: 'A', raterSubject: 'user:x-rater', createdAt: AT });
    const r = await recordArenaMatch('arena-mid-y', { matchId: 'shared-mid', modelA: 'gamma', modelB: 'delta', winner: 'A', raterSubject: 'user:y-rater', createdAt: AT });
    expect(r.match.tenantId, 'tenant Y must get its OWN match, never tenant X\'s').toBe('arena-mid-y');
    expect(r.match.raterSubject).toBe('user:y-rater');
    expect(await getArenaRating('arena-mid-y', 'gamma'), 'and Y\'s verdict must land').toBeGreaterThan(1500);
  });
});
