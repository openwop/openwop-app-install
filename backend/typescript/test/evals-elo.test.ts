/**
 * ADR 0123 Phase 2 — Elo (K=32) ratings.
 */
import { describe, it, expect } from 'vitest';
import { computeEloRatings, eloMatch, expectedScore, ELO_K, ELO_BASE } from '../src/features/evals/elo.js';

describe('Elo', () => {
  it('equal ratings expect 0.5', () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5);
  });

  it('a win raises A by K*(1-E); equal start → +16 at K=32', () => {
    const [a, b] = eloMatch(1500, 1500, 1, ELO_K);
    expect(a).toBeCloseTo(1516); // 1500 + 32*(1-0.5)
    expect(b).toBeCloseTo(1484);
  });

  it('uses K=32', () => {
    expect(ELO_K).toBe(32);
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

  it('skips neutral; is deterministic', () => {
    const a = computeEloRatings([{ model: 'm', rating: 'up' }, { model: 'm', rating: 'neutral' }]);
    const b = computeEloRatings([{ model: 'm', rating: 'up' }]);
    expect(a.get('m')).toBeCloseTo(b.get('m')!); // neutral didn't move it
    expect(computeEloRatings([{ model: 'm', rating: 'up' }])).toEqual(computeEloRatings([{ model: 'm', rating: 'up' }]));
  });
});
