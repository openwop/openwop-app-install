/**
 * ADR 0986 D3 — the chat-ratings leaderboard math (`features/evals/leaderboard.ts`,
 * pure): per-`provider/model` counts, the Wilson 95% lower bound as the ranking
 * score, the per-rater weight, and the deterministic tie order.
 *
 * Replaces the ADR 0123 Elo cases: the anchored Elo played votes in storage-key
 * order, so the same votes could rank differently (EV2-3). Sabotage witnesses:
 * dropping the per-rater scale, ranking by raw win rate, a missing `up` tiebreak,
 * and keying rows by model alone each red a case below.
 *
 * Every expected score is a LITERAL, worked out by hand from the Wilson formula
 * with z = 1.959963984540054 (never computed with `wilsonLowerBound` or derived from
 * `MAX_RATER_WEIGHT`, which would move with a sabotage of either). TST-MES-8.
 */
import { describe, it, expect } from 'vitest';
import { combineLeaderboard, wilsonLowerBound, MAX_RATER_WEIGHT, type RatedTurn } from '../src/features/evals/leaderboard.js';

const v = (model: string, rating: RatedTurn['rating'], rater = 'user:1', provider = 'openai'): RatedTurn => ({ provider, model, rating, rater });
const times = (n: number, model: string, rating: RatedTurn['rating'], rater: string): RatedTurn[] => Array.from({ length: n }, () => v(model, rating, rater));

describe('wilsonLowerBound', () => {
  it('is 0 with no decisive votes and below the raw rate otherwise', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, 5)).toBe(0);
    // The 95% bound, pinned: one lucky up is weak evidence; 95 of 100 is strong.
    expect(wilsonLowerBound(1, 1)).toBeCloseTo(0.206549, 6);
    expect(wilsonLowerBound(95, 100)).toBeCloseTo(0.888250, 6);
  });
});

describe('combineLeaderboard', () => {
  it('counts per provider/model, with win rate, raters and the confidence score', () => {
    const lb = combineLeaderboard([v('a', 'up'), v('a', 'up', 'user:2'), v('a', 'down'), v('a', 'neutral'), v('b', 'up'), v('b', 'down')]);
    const a = lb.find((m) => m.model === 'a')!;
    expect(a).toMatchObject({ key: 'openai/a', provider: 'openai', up: 2, down: 1, neutral: 1, total: 4, raters: 2 });
    expect(a.winRate).toBeCloseTo(2 / 3);
    expect(a.score).toBeCloseTo(0.207660, 6); // Wilson(2 of 3)
  });

  it('the same model through two providers is two rows', () => {
    const lb = combineLeaderboard([v('m', 'up', 'user:1', 'openai'), v('m', 'up', 'user:1', 'openrouter')]);
    expect(lb.map((r) => r.key).sort()).toEqual(['openai/m', 'openrouter/m']);
  });

  it('a long strong record outranks one lucky up; 0 of 5 ranks below an unrated model', () => {
    const steady = [...Array.from({ length: 9 }, (_, i) => v('steady', 'up', `user:${i}`)), v('steady', 'down', 'user:x')];
    const lb = combineLeaderboard([...steady, v('lucky', 'up'), ...Array.from({ length: 5 }, () => v('bad', 'down')), v('quiet', 'neutral')]);
    expect(lb.map((m) => m.model)).toEqual(['steady', 'lucky', 'quiet', 'bad']);
  });

  it('breaks an equal score by more ups, then fewer downs, then the key', () => {
    // `few` (10 ups, one rater) and `many` (20 ups, one rater, scaled to 10) score the same
    // Wilson(10 of 10); `few` is inserted first AND sorts first by key, so only the `up`
    // tiebreak puts `many` ahead. `zz`/`aa` tie on everything but the key; `zz` comes first in
    // the input, so only the key tiebreak orders them. (Fewer downs is `quiet` over `bad` above.)
    const lb = combineLeaderboard([...times(10, 'few', 'up', 'user:f'), ...times(20, 'many', 'up', 'user:m'), v('zz', 'neutral'), v('aa', 'neutral')]);
    expect(lb.map((m) => m.model)).toEqual(['many', 'few', 'aa', 'zz']);
    expect(lb[0]!.score).toBe(lb[1]!.score);
  });

  it('is a function of the votes, not of their order (EV2-3)', () => {
    const votes = [v('a', 'up'), v('a', 'down'), v('a', 'up', 'user:2'), v('b', 'down'), v('b', 'up')];
    expect(combineLeaderboard([...votes].reverse())).toEqual(combineLeaderboard(votes));
  });

  it('one rater weighs at most MAX_RATER_WEIGHT decisive votes in the score; the counts stay raw', () => {
    expect(MAX_RATER_WEIGHT).toBe(10); // ADR 0986 M5's cap, the literal the scores below assume
    const [row] = combineLeaderboard(times(50, 'stuffed', 'up', 'user:stuffer'));
    expect(row).toMatchObject({ up: 50, raters: 1 });
    expect(row!.score).toBeCloseTo(0.722467, 6); // Wilson(10 of 10): the cap is 10
    // The scale is PROPORTIONAL: 15 up / 5 down from one rater weighs 7.5 of 10.
    const [mixed] = combineLeaderboard([...times(15, 'mixed', 'up', 'user:m'), ...times(5, 'mixed', 'down', 'user:m')]);
    expect(mixed).toMatchObject({ up: 15, down: 5, raters: 1 });
    expect(mixed!.score).toBeCloseTo(0.442181, 6); // Wilson(7.5 of 10)
  });

  it('marks managed tiers and the scripted mock', () => {
    const lb = combineLeaderboard([
      { provider: 'openwop-free', model: 'openwop-free', managed: true, rating: 'up', rater: 'u' },
      v('mock-1', 'up', 'u', 'mock'),
      v('gpt', 'up', 'u', 'openai'),
    ]);
    const free = lb.find((r) => r.provider === 'openwop-free')!;
    const mock = lb.find((r) => r.provider === 'mock')!;
    const real = lb.find((r) => r.provider === 'openai')!;
    expect(free.managed).toBe(true);
    expect(free.simulated).toBeUndefined();
    expect(mock.simulated).toBe(true);
    expect(mock.managed).toBeUndefined();
    expect(real.managed).toBeUndefined();
    expect(real.simulated).toBeUndefined();
  });
});
