/**
 * ADR 0123 Phase 3 — model arena (head-to-head capture + Elo).
 *
 * A session-bound rater picks a winner between two models' responses to ONE prompt.
 * That is a TRUE head-to-head match (vs the thumbs path's fixed-anchor match): both
 * models move via the standard `eloMatch` (K=32, the Phase-2 primitive). The two
 * live dispatches are normal runs on the existing path (the route's job); this owns
 * the capture + the rating math + the persisted `ArenaMatch` ledger. Pure-ish:
 * deterministic given the stored prior ratings.
 *
 * @see docs/adr/0123-eval-feedback-leaderboard.md
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { eloMatch, ELO_BASE } from './elo.js';

export interface ArenaMatch {
  matchId: string;
  tenantId: string;
  modelA: string;
  modelB: string;
  winner: 'A' | 'B' | 'tie';
  raterSubject: string;
  createdAt: string;
}

/** Per-(tenant, model) arena Elo — distinct from the thumbs leaderboard cache. */
interface ArenaRating { tenantId: string; model: string; elo: number; matches: number }

const matches = new DurableCollection<ArenaMatch>('evals:arena-match', (m) => m.matchId);
const ratings = new DurableCollection<ArenaRating>('evals:arena-rating', (r) => `${r.tenantId}:${r.model}`);

async function ratingOf(tenantId: string, model: string): Promise<ArenaRating> {
  return (await ratings.get(`${tenantId}:${model}`)) ?? { tenantId, model, elo: ELO_BASE, matches: 0 };
}

export async function recordArenaMatch(
  tenantId: string,
  input: { matchId: string; modelA: string; modelB: string; winner: 'A' | 'B' | 'tie'; raterSubject: string; createdAt: string },
): Promise<{ match: ArenaMatch; ratingA: number; ratingB: number }> {
  if (!input.modelA || !input.modelB || input.modelA === input.modelB) {
    throw new OpenwopError('validation_error', 'An arena match needs two DISTINCT models.', 400, {});
  }
  if (!['A', 'B', 'tie'].includes(input.winner)) {
    throw new OpenwopError('validation_error', '`winner` MUST be A | B | tie.', 400, { field: 'winner' });
  }
  const a = await ratingOf(tenantId, input.modelA);
  const b = await ratingOf(tenantId, input.modelB);
  const scoreA = input.winner === 'A' ? 1 : input.winner === 'B' ? 0 : 0.5;
  const [nextA, nextB] = eloMatch(a.elo, b.elo, scoreA); // true head-to-head, K=32
  await ratings.put({ ...a, elo: nextA, matches: a.matches + 1 });
  await ratings.put({ ...b, elo: nextB, matches: b.matches + 1 });
  const match: ArenaMatch = { matchId: input.matchId, tenantId, modelA: input.modelA, modelB: input.modelB, winner: input.winner, raterSubject: input.raterSubject, createdAt: input.createdAt };
  await matches.put(match);
  return { match, ratingA: nextA, ratingB: nextB };
}

export async function getArenaRating(tenantId: string, model: string): Promise<number> {
  return (await ratingOf(tenantId, model)).elo;
}
