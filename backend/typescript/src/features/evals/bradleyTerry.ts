/**
 * Bradley–Terry strengths from pairwise outcomes (ADR 0986 D5), fitted by
 * Hunter's (2004) MM iteration, reported on the Elo scale.
 *
 * - A tie is half a win to each side.
 * - Every model also plays ONE virtual tie against a fixed reference of strength
 *   1 (rating 1500). That keeps an unbeaten model's strength finite, links a
 *   disconnected comparison graph through the reference, and shrinks a model
 *   with few matches toward 1500. The reference is never updated.
 * - Deterministic and order-independent: the result depends only on the multiset
 *   of outcomes. Models are iterated in sorted key order with a fixed tolerance
 *   and iteration cap, so floating-point evaluation order is fixed too.
 *
 * Rating = 1500 + 400·log10(p): a 400-point gap means 10:1 odds, the Elo
 * convention, so the numbers read like the familiar scale.
 */

export interface PairOutcome { a: string; b: string; /** 1 = a won, 0 = b won, 0.5 = tie */ scoreA: number }

export const BT_REFERENCE_RATING = 1500;
const TOLERANCE = 1e-9;
const MAX_ITERATIONS = 500;

export function bradleyTerry(outcomes: readonly PairOutcome[]): Map<string, number> {
  const models = [...new Set(outcomes.flatMap((o) => [o.a, o.b]))].sort();
  if (models.length === 0) return new Map();
  // wins[i] = total score; games[i][j] = number of games between i and j.
  const idx = new Map(models.map((m, i) => [m, i]));
  const n = models.length;
  const wins = new Array<number>(n).fill(0.5); // the virtual tie's half-win
  const games: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const o of outcomes) {
    const i = idx.get(o.a)!; const j = idx.get(o.b)!;
    wins[i]! += o.scoreA; wins[j]! += 1 - o.scoreA;
    games[i]![j]! += 1; games[j]![i]! += 1;
  }
  let p = new Array<number>(n).fill(1);
  for (let iter = 0; iter < MAX_ITERATIONS; iter += 1) {
    const next = new Array<number>(n);
    let delta = 0;
    for (let i = 0; i < n; i += 1) {
      // The virtual game against the reference (strength 1).
      let denom = 1 / (p[i]! + 1);
      for (let j = 0; j < n; j += 1) {
        const g = games[i]![j]!;
        if (g > 0) denom += g / (p[i]! + p[j]!);
      }
      next[i] = wins[i]! / denom;
      delta = Math.max(delta, Math.abs(Math.log(next[i]!) - Math.log(p[i]!)));
    }
    p = next;
    if (delta < TOLERANCE) break;
  }
  return new Map(models.map((m, i) => [m, BT_REFERENCE_RATING + 400 * Math.log10(p[i]!)]));
}
