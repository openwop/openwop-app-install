/**
 * ADR 0123 Phase 2 — Elo (K=32) ratings (`features/evals/elo.ts`, pure). The leaderboard
 * and the arena both rank on these numbers, so the logistic's DIRECTION, the loser's
 * update, K, the up/down mapping and the neutral skip are each pinned — at UNEQUAL
 * ratings too, because at 1500/1500 a flipped sign or `eb = ea` is invisible.
 *
 * Witnessed (wave 25 probes): K=16, down scored as a win, neutral scored, a flipped
 * expectedScore sign, and `eb = ea` each red a case.
 */
import { describe, it, expect } from 'vitest';
import { computeEloRatings, eloMatch, expectedScore, ELO_K, ELO_BASE } from '../src/features/evals/elo.js';

describe('Elo', () => {
  it('equal ratings expect 0.5; the stronger side expects more, and the two sum to 1', () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5);
    expect(expectedScore(1600, 1400)).toBeCloseTo(0.7597, 3);
    expect(expectedScore(1600, 1400) + expectedScore(1400, 1600)).toBeCloseTo(1);
  });

  it('a win raises A by K*(1-E); equal start → +16 at K=32', () => {
    const [a, b] = eloMatch(1500, 1500, 1, ELO_K);
    expect(a).toBeCloseTo(1516); // 1500 + 32*(1-0.5)
    expect(b).toBeCloseTo(1484);
    expect(ELO_K).toBe(32);
  });

  it('an unequal match moves the favourite less and the underdog by the mirror amount', () => {
    const [hi, lo] = eloMatch(1600, 1400, 1); // favourite wins: 32 × (1 − 0.7597)
    expect(hi).toBeCloseTo(1607.69, 1);
    expect(lo).toBeCloseTo(1392.31, 1);
  });

  it('an up raises a model above base; a down lowers it (monotonic)', () => {
    const up = computeEloRatings([{ model: 'm', rating: 'up' }]).get('m')!;
    const down = computeEloRatings([{ model: 'm', rating: 'down' }]).get('m')!;
    expect(up).toBeGreaterThan(ELO_BASE);
    expect(down).toBeLessThan(ELO_BASE);
  });

  it('more ups → higher Elo (monotonic over a stream)', () => {
    const two = computeEloRatings([{ model: 'm', rating: 'up' }, { model: 'm', rating: 'up' }]).get('m')!;
    const one = computeEloRatings([{ model: 'm', rating: 'up' }]).get('m')!;
    expect(two).toBeGreaterThan(one);
  });

  it('skips neutral', () => {
    const a = computeEloRatings([{ model: 'm', rating: 'up' }, { model: 'm', rating: 'neutral' }]);
    const b = computeEloRatings([{ model: 'm', rating: 'up' }]);
    expect(a.get('m')).toBeCloseTo(b.get('m')!); // neutral didn't move it
  });
});
