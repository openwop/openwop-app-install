/**
 * Model leaderboard from chat ratings (ADR 0123 Phase 1, re-ranked by ADR 0986 D3).
 *
 * PURE + deterministic. Each input row is one rating of a turn whose answering
 * model the SERVER attributed (`host/turnAttribution.ts`); the feedback→model
 * join is the caller's job.
 *
 * Ranking: `score` = the Wilson 95% lower bound of up / (up + down) — a
 * function of the vote COUNTS only, so the order ratings are stored in cannot
 * move it (the old anchored Elo played votes in storage-key order). A model with
 * one lucky up ranks below a long strong record, and 0/5 ranks below unrated.
 *
 * Per-rater weight (ADR 0986 M5): one rater's decisive votes on one model weigh
 * at most `MAX_RATER_WEIGHT` in the score (scaled proportionally). The displayed
 * counts stay raw; `raters` says how many people the counts come from.
 */

export type Rating = 'up' | 'down' | 'neutral';

export interface RatedTurn {
  provider: string;
  model: string;
  /** A managed TIER, not a model (ADR 0986 H1). */
  managed?: boolean;
  rating: Rating;
  /** The rater's subject ref — for the per-rater weight + the `raters` count. */
  rater: string;
}

export interface ModelRating {
  /** `provider/model` — the row identity. */
  key: string;
  provider: string;
  model: string;
  managed?: true;
  /** The scripted mock provider — only possible where the mock is enabled. */
  simulated?: true;
  up: number;
  down: number;
  neutral: number;
  total: number;
  /** Distinct raters behind the counts. */
  raters: number;
  /** up / (up + down); 0 with no decisive vote. Display only. */
  winRate: number;
  /** Wilson 95% lower bound of the (rater-weighted) win rate; 0 with no decisive vote. */
  score: number;
}

export const MAX_RATER_WEIGHT = 10;
const Z95 = 1.959963984540054;

/** Wilson score interval lower bound for `wins` out of `n` (fractional n allowed). */
export function wilsonLowerBound(wins: number, n: number, z: number = Z95): number {
  if (!(n > 0)) return 0;
  const phat = wins / n;
  const z2 = z * z;
  const centre = phat + z2 / (2 * n);
  const margin = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n);
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

export function combineLeaderboard(rows: readonly RatedTurn[]): ModelRating[] {
  interface Acc { provider: string; model: string; managed: boolean; up: number; down: number; neutral: number; perRater: Map<string, { up: number; down: number }> }
  const byKey = new Map<string, Acc>();
  for (const r of rows) {
    if (!r.provider || !r.model) continue;
    const key = `${r.provider}/${r.model}`;
    const acc = byKey.get(key) ?? { provider: r.provider, model: r.model, managed: false, up: 0, down: 0, neutral: 0, perRater: new Map() };
    if (r.managed) acc.managed = true;
    const pr = acc.perRater.get(r.rater) ?? { up: 0, down: 0 };
    if (r.rating === 'up') { acc.up += 1; pr.up += 1; }
    else if (r.rating === 'down') { acc.down += 1; pr.down += 1; }
    else acc.neutral += 1;
    acc.perRater.set(r.rater, pr);
    byKey.set(key, acc);
  }
  const out: ModelRating[] = [];
  for (const [key, a] of byKey) {
    let wUp = 0; let wN = 0;
    for (const pr of [...a.perRater.values()]) {
      const n = pr.up + pr.down;
      if (n === 0) continue;
      const scale = Math.min(1, MAX_RATER_WEIGHT / n);
      wUp += pr.up * scale; wN += n * scale;
    }
    const decisive = a.up + a.down;
    out.push({
      key, provider: a.provider, model: a.model,
      ...(a.managed ? { managed: true as const } : {}),
      ...(a.provider === 'mock' ? { simulated: true as const } : {}),
      up: a.up, down: a.down, neutral: a.neutral, total: decisive + a.neutral,
      raters: a.perRater.size,
      winRate: decisive > 0 ? a.up / decisive : 0,
      score: wilsonLowerBound(wUp, wN),
    });
  }
  out.sort((x, y) =>
    y.score - x.score ||
    y.up - x.up ||
    x.down - y.down ||
    (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );
  return out;
}
