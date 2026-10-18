/**
 * ADR 0123 Phase 1 — model win-rate leaderboard math (`features/evals/leaderboard.ts`,
 * pure): per-model counts, win-rate = up / (up + down) (neutral excluded; 0 with no
 * decisive vote), ranked win-rate → decisive volume → model id, and the combined board
 * ranked by Elo FIRST — exercised with data where Elo and win-rate DISAGREE.
 *
 * Witnessed (wave 25 probes): neutral in the denominator, an unguarded 0/0, neutral not
 * counted, an inverted win-rate sort, a reversed volume/id tiebreak, no Elo sort, and a
 * dropped Elo attach each red a case. (The empty-input case was cut: no sabotage reds it,
 * and `evals-leaderboard-service.test.ts` › "a tenant with no feedback…" asserts `[]`
 * through the same `computeLeaderboard([])`.)
 */
import { describe, it, expect } from 'vitest';
import { computeLeaderboard, combineLeaderboard, type RatedTurn } from '../src/features/evals/leaderboard.js';

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
    const rows: RatedTurn[] = [
      { model: 'low', rating: 'down' },
      { model: 'high', rating: 'up' },
      { model: 'high', rating: 'up' },
      // three models tied at winRate 0.5: tie-big has MORE decisive votes (4 vs 2) …
      { model: 'tie-small', rating: 'up' }, { model: 'tie-small', rating: 'down' },
      { model: 'tie-big', rating: 'up' }, { model: 'tie-big', rating: 'down' },
      { model: 'tie-big', rating: 'up' }, { model: 'tie-big', rating: 'down' },
      // … and ab / aa tie tie-small on BOTH, so only the model id orders them.
      { model: 'ab', rating: 'up' }, { model: 'ab', rating: 'down' },
      { model: 'aa', rating: 'up' }, { model: 'aa', rating: 'down' },
    ];
    const lb = computeLeaderboard(rows);
    expect(lb.map((m) => m.model)).toEqual(['high', 'tie-big', 'aa', 'ab', 'tie-small', 'low']);
    // determinism: the ranking does not depend on input order
    expect(computeLeaderboard([...rows].reverse())).toEqual(lb);
  });

  it('neutral-only model has winRate 0 (no decisive votes)', () => {
    const lb = computeLeaderboard([{ model: 'x', rating: 'neutral' }]);
    expect(lb[0]).toMatchObject({ model: 'x', winRate: 0, neutral: 1, total: 1 });
  });
});

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

  it('Elo outranks win-rate when they disagree (a long strong record beats one lucky up)', () => {
    const steady: RatedTurn[] = [...Array.from({ length: 10 }, () => ({ model: 'steady', rating: 'up' as const })), { model: 'steady', rating: 'down' }];
    const lb = combineLeaderboard([...steady, { model: 'lucky', rating: 'up' }]);
    expect(lb.map((m) => m.model)).toEqual(['steady', 'lucky']);
    expect(lb[0]!.winRate, 'precondition: win-rate alone would rank lucky first').toBeLessThan(lb[1]!.winRate);
    expect(lb[0]!.elo).toBeGreaterThan(lb[1]!.elo);
  });
});
