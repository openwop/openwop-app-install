/**
 * ADR 0123 Phase 2 — Elo (K=32) model ratings from feedback.
 *
 * Each thumbs-up/down is a "match": the model plays a fixed per-tenant ANCHOR
 * (1500) — so a single model still moves on its own up/down record (up = win,
 * down = loss). Arena head-to-head (Phase 3) reuses `eloMatch` between two real
 * models. Standard Elo, K=32 (the Open-WebUI constant). Pure + deterministic.
 */

export const ELO_K = 32;
export const ELO_BASE = 1500;
export const ELO_ANCHOR = 1500;

/** Expected score of A against B (logistic, 400-point scale). */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/** One match: returns the updated [A, B] ratings. `scoreA` ∈ {1 win, 0 loss, 0.5 draw}. */
export function eloMatch(ratingA: number, ratingB: number, scoreA: number, k: number = ELO_K): [number, number] {
  const ea = expectedScore(ratingA, ratingB);
  const eb = 1 - ea;
  return [ratingA + k * (scoreA - ea), ratingB + k * ((1 - scoreA) - eb)];
}

export interface EloRow { model: string; rating: 'up' | 'down' | 'neutral' }

/** Per-model Elo from a feedback stream. Each up/down plays the FIXED anchor (the
 *  anchor does not accumulate — it's a stable reference), so a model's Elo reflects
 *  its up/down record. Neutral is skipped. Deterministic (input order is the match
 *  order). */
export function computeEloRatings(rows: readonly EloRow[], k: number = ELO_K): Map<string, number> {
  const elo = new Map<string, number>();
  for (const r of rows) {
    if (r.rating === 'neutral' || !r.model) continue;
    const cur = elo.get(r.model) ?? ELO_BASE;
    const scoreA = r.rating === 'up' ? 1 : 0;
    const [next] = eloMatch(cur, ELO_ANCHOR, scoreA, k); // anchor fixed → only the model moves
    elo.set(r.model, next);
  }
  return elo;
}
