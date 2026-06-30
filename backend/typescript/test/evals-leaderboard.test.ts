/**
 * ADR 0123 Phase 1 — model win-rate leaderboard math.
 */
import { describe, it, expect } from 'vitest';
import { computeLeaderboard } from '../src/features/evals/leaderboard.js';

describe('computeLeaderboard', () => {
  it('computes per-model up/down/neutral + win-rate', () => {
    const rows = [
      { model: 'a', rating: 'up' as const },
      { model: 'a', rating: 'up' as const },
      { model: 'a', rating: 'down' as const },
      { model: 'a', rating: 'neutral' as const },
      { model: 'b', rating: 'up' as const },
      { model: 'b', rating: 'down' as const },
    ];
    const lb = computeLeaderboard(rows);
    const a = lb.find((m) => m.model === 'a')!;
    expect(a).toMatchObject({ up: 2, down: 1, neutral: 1, total: 4 });
    expect(a.winRate).toBeCloseTo(2 / 3);
    const b = lb.find((m) => m.model === 'b')!;
    expect(b.winRate).toBeCloseTo(0.5);
  });

  it('ranks by win-rate, then decisive volume, then model id (deterministic)', () => {
    const lb = computeLeaderboard([
      { model: 'low', rating: 'down' },
      { model: 'high', rating: 'up' },
      { model: 'high', rating: 'up' },
    ]);
    expect(lb[0]!.model).toBe('high');
    expect(lb[1]!.model).toBe('low');
    // determinism
    expect(computeLeaderboard([{ model: 'low', rating: 'down' }, { model: 'high', rating: 'up' }, { model: 'high', rating: 'up' }])).toEqual(lb);
  });

  it('neutral-only model has winRate 0 (no decisive votes)', () => {
    const lb = computeLeaderboard([{ model: 'x', rating: 'neutral' }]);
    expect(lb[0]).toMatchObject({ model: 'x', winRate: 0, neutral: 1, total: 1 });
  });

  it('handles an empty input', () => {
    expect(computeLeaderboard([])).toEqual([]);
  });
});

import { combineLeaderboard } from '../src/features/evals/leaderboard.js';
describe('combineLeaderboard (win-rate + Elo)', () => {
  it('carries both metrics and ranks by Elo', () => {
    const lb = combineLeaderboard([
      { model: 'good', rating: 'up' }, { model: 'good', rating: 'up' },
      { model: 'bad', rating: 'down' },
    ]);
    expect(lb[0]!.model).toBe('good');
    expect(lb[0]!.elo).toBeGreaterThan(1500);
    expect(lb[0]!.winRate).toBe(1);
    expect(lb.find((m) => m.model === 'bad')!.elo).toBeLessThan(1500);
  });
});
