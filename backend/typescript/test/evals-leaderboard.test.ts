/**
 * ADR 0986 D3 — the chat-ratings leaderboard math (`features/evals/leaderboard.ts`,
 * pure): per-`provider/model` counts, the Wilson 95% lower bound as the ranking
 * score, the per-rater weight, and the deterministic tie order.
 *
 * Replaces the ADR 0123 Elo cases: the anchored Elo played votes in storage-key
 * order, so the same votes could rank differently (EV2-3). Sabotage witnesses:
 * dropping the per-rater scale, ranking by raw win rate, a missing `up` tiebreak,
 * and keying rows by model alone each red a case below.
 */
import { describe, it, expect } from 'vitest';
import { combineLeaderboard, wilsonLowerBound, MAX_RATER_WEIGHT, type RatedTurn } from '../src/features/evals/leaderboard.js';

const v = (model: string, rating: RatedTurn['rating'], rater = 'user:1', provider = 'openai'): RatedTurn => ({ provider, model, rating, rater });

describe('wilsonLowerBound', () => {
  it('is 0 with no decisive votes and below the raw rate otherwise', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, 5)).toBe(0);
    expect(wilsonLowerBound(1, 1)).toBeLessThan(0.3); // one lucky up is weak evidence
    expect(wilsonLowerBound(95, 100)).toBeGreaterThan(0.88);
    expect(wilsonLowerBound(95, 100)).toBeLessThan(0.95);
  });
});

describe('combineLeaderboard', () => {
  it('counts per provider/model, with win rate, raters and the confidence score', () => {
    const lb = combineLeaderboard([v('a', 'up'), v('a', 'up', 'user:2'), v('a', 'down'), v('a', 'neutral'), v('b', 'up'), v('b', 'down')]);
    const a = lb.find((m) => m.model === 'a')!;
    expect(a).toMatchObject({ key: 'openai/a', provider: 'openai', up: 2, down: 1, neutral: 1, total: 4, raters: 2 });
    expect(a.winRate).toBeCloseTo(2 / 3);
    expect(a.score).toBeCloseTo(wilsonLowerBound(2, 3));
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

  it('is a function of the votes, not of their order (EV2-3)', () => {
    const votes = [v('a', 'up'), v('a', 'down'), v('a', 'up', 'user:2'), v('b', 'down'), v('b', 'up')];
    expect(combineLeaderboard([...votes].reverse())).toEqual(combineLeaderboard(votes));
  });

  it('one rater weighs at most MAX_RATER_WEIGHT decisive votes in the score; the counts stay raw', () => {
    const stuffer = Array.from({ length: 50 }, () => v('stuffed', 'up', 'user:stuffer'));
    const [row] = combineLeaderboard(stuffer);
    expect(row).toMatchObject({ up: 50, raters: 1 });
    expect(row!.score).toBeCloseTo(wilsonLowerBound(MAX_RATER_WEIGHT, MAX_RATER_WEIGHT));
  });

  it('marks managed tiers and the scripted mock', () => {
    const lb = combineLeaderboard([{ provider: 'openwop-free', model: 'openwop-free', managed: true, rating: 'up', rater: 'u' }, v('mock-1', 'up', 'u', 'mock')]);
    expect(lb.find((r) => r.provider === 'openwop-free')).toMatchObject({ managed: true });
    expect(lb.find((r) => r.provider === 'mock')).toMatchObject({ simulated: true });
  });
});
