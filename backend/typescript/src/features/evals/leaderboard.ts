/**
 * ADR 0123 Phase 1 — model win-rate leaderboard from MessageFeedback.
 *
 * Turns the already-captured-but-unused `MessageFeedback` signal (ADR 0071) into a
 * per-model quality ranking. `computeLeaderboard` is PURE + deterministic — it
 * aggregates `(model, rating)` rows into per-model up/down counts + a win-rate,
 * ranked. The feedback→model JOIN (a rated message's producing model, via the
 * recorded `provider.usage`) is the caller's job; this keeps the math unit-testable
 * and free of the store/run-event coupling.
 */

import { computeEloRatings, ELO_BASE } from './elo.js';

export type Rating = 'up' | 'down' | 'neutral';

export interface RatedTurn {
  /** The producing model id (e.g. 'gpt-x', 'claude-y'). */
  model: string;
  rating: Rating;
}

export interface ModelRating {
  model: string;
  up: number;
  down: number;
  neutral: number;
  total: number;
  /** up / (up + down). Neutral ratings don't count toward the win-rate (they're
   *  engagement, not a signal). 0 when there are no up/down votes. */
  winRate: number;
}

/** Aggregate rated turns into a per-model leaderboard, ranked by win-rate then
 *  by decisive-vote volume (up+down) then model id — fully deterministic. */
export function computeLeaderboard(rows: readonly RatedTurn[]): ModelRating[] {
  const byModel = new Map<string, { up: number; down: number; neutral: number }>();
  for (const r of rows) {
    if (!r.model) continue;
    const m = byModel.get(r.model) ?? { up: 0, down: 0, neutral: 0 };
    if (r.rating === 'up') m.up++;
    else if (r.rating === 'down') m.down++;
    else m.neutral++;
    byModel.set(r.model, m);
  }
  const out: ModelRating[] = [];
  for (const [model, c] of byModel) {
    const decisive = c.up + c.down;
    out.push({ model, up: c.up, down: c.down, neutral: c.neutral, total: c.up + c.down + c.neutral, winRate: decisive > 0 ? c.up / decisive : 0 });
  }
  out.sort((a, b) =>
    b.winRate - a.winRate ||
    (b.up + b.down) - (a.up + a.down) ||
    (a.model < b.model ? -1 : 1),
  );
  return out;
}

/** A leaderboard row carrying BOTH the win-rate aggregate (Phase 1) and the Elo
 *  rating (Phase 2). */
export interface EvalModelRating extends ModelRating { elo: number }

/** Combine win-rate + Elo into one ranking, sorted by Elo (the headline metric)
 *  then win-rate then decisive volume then model id (deterministic). The
 *  feedback→model JOIN is the caller's job (the rated turns it passes). */
export function combineLeaderboard(rows: readonly RatedTurn[]): EvalModelRating[] {
  const elo = computeEloRatings(rows.map((r) => ({ model: r.model, rating: r.rating })));
  const combined: EvalModelRating[] = computeLeaderboard(rows).map((m) => ({ ...m, elo: elo.get(m.model) ?? ELO_BASE }));
  combined.sort((a, b) =>
    b.elo - a.elo ||
    b.winRate - a.winRate ||
    (b.up + b.down) - (a.up + a.down) ||
    (a.model < b.model ? -1 : 1),
  );
  return combined;
}
