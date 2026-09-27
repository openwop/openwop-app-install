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
import { createLogger } from '../../observability/logger.js';
import { OpenwopError } from '../../types.js';
import { eloMatch, ELO_BASE } from './elo.js';

const log = createLogger('evals.arena');

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

// `tenantOf` is set so the ballot-stuffing count uses the BOUNDED per-tenant indexed
// scan (`listForTenantIndexed`) rather than a full cross-tenant `list()`.
const matches = new DurableCollection<ArenaMatch>('evals:arena-match', (m) => m.matchId, undefined, (m) => m.tenantId);
const ratings = new DurableCollection<ArenaRating>('evals:arena-rating', (r) => `${r.tenantId}:${r.model}`);

/** EVC-2 — ballot-stuffing bound, keyed on the (rater, MODEL) axis, NOT (rater,pair).
 *  The threat is inflating a TARGET MODEL's Elo, and model ids are arbitrary strings
 *  (no catalog gate yet), so a per-PAIR cap is evaded by ROTATING the opponent string
 *  (X vs junk-1, X vs junk-2 ...), which pays MORE per verdict than a concentrated
 *  attack (adversarial review measured +307 via rotation vs +226 concentrated).
 *  Capping per (rater, model) counts EVERY match a rater submits involving model X
 *  (either side), so opponent rotation cannot evade it: one rater's total influence on
 *  any single model is bounded (~+120 at this cap, below the graded +200 bar).
 *  Legitimate consensus (many DISTINCT raters, each session-bound + editor+) is
 *  unaffected. Policy default: tune via review; not a wire value. FURTHER hardening
 *  carried open (EVC-3): validate model ids against the real catalog + bind a match to
 *  real dispatched run ids. */
const MAX_RATER_MATCHES_PER_MODEL = 8;

async function ratingOf(tenantId: string, model: string): Promise<ArenaRating> {
  return (await ratings.get(`${tenantId}:${model}`)) ?? { tenantId, model, elo: ELO_BASE, matches: 0 };
}

/** Matches `host/workflowBudgets.ts` — enough to absorb a realistic burst of verdicts
 *  without spinning when one model is genuinely hot. */
const RATING_CAS_ATTEMPTS = 8;

/** EVC-7 (ADR 0700 D1) — apply ONE rating row's delta under compare-and-swap.
 *
 *  This used to be a plain `ratings.put({...a, elo: nextA, matches: a.matches + 1})`
 *  beside a second one for the opponent — a read-modify-write with no CAS. MEASURED on
 *  the in-memory backend, single process: eight identical verdicts (eight distinct
 *  raters, A wins each time) leave alpha at **1516** concurrently against **1594.95**
 *  sequentially. Base is 1500, so the truth is +94.95 and the store reported +16 —
 *  exactly ONE verdict. Seven of eight vanished, and `GET …/arena/rating/:model`
 *  served that as fact.
 *
 *  A DELTA, not a target value, is what makes the retry correct: `compareAndSwap`
 *  compares the WHOLE row by value, so the loop must RE-READ and re-apply rather than
 *  re-propose a `next` computed from a stale snapshot.
 *
 *  WHAT THIS DOES NOT GIVE (ADR 0700 D1b): Elo is zero-sum across a pair, and two
 *  independent per-row loops do NOT make the pair atomic — concurrent updates to the
 *  same pair can compute A's gain and B's loss against slightly different snapshots.
 *  No verdict is LOST, which is the defect being fixed; exact pairwise conservation is
 *  not claimed here, was not provided before either, and would need a different design
 *  (one row per pair, or a per-tenant serialisation point). */
async function applyRatingDelta(tenantId: string, model: string, delta: number): Promise<number> {
  for (let attempt = 0; attempt < RATING_CAS_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise((res) => setTimeout(res, Math.random() * 25));
    const existing = (await ratings.get(`${tenantId}:${model}`)) ?? null;
    const base: ArenaRating = existing ?? { tenantId, model, elo: ELO_BASE, matches: 0 };
    const next: ArenaRating = { ...base, elo: base.elo + delta, matches: base.matches + 1 };
    if (await ratings.compareAndSwap(existing, next)) return next.elo;
  }
  // Do NOT return a value that was never persisted — that is success-with-wrong-data on
  // a surface whose only job is to report a number. The caller is a route, so a typed
  // refusal is visible; a silently wrong rating is not.
  log.warn('arena_rating_contention', { model, attempts: RATING_CAS_ATTEMPTS });
  throw new OpenwopError('conflict', 'This model\'s rating is being updated concurrently; retry.', 409, { model });
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
  // EVC-2 (idempotency) — a REPLAYED matchId is a no-op, never a second Elo delta.
  // The `matchId` is server-minted per request, so this guards the service/replay
  // lane (a retried dispatch, a fork) rather than a client-forgeable key.
  const existing = await matches.get(input.matchId);
  if (existing) {
    return { match: existing, ratingA: await getArenaRating(tenantId, existing.modelA), ratingB: await getArenaRating(tenantId, existing.modelB) };
  }
  // EVC-2 (ballot-stuffing) — bound one rater's influence on any SINGLE model. Count
  // every prior match by this rater that involves modelA or modelB (either side);
  // refuse if either model is already at the cap. Keying on the model (not the pair)
  // is what defeats opponent-string rotation. `listForTenantIndexed` is the bounded
  // per-tenant scan (the `tenantOf` on the collection above enables it).
  const priorByRater = (await matches.listForTenantIndexed(tenantId)).filter(
    (m) => m.raterSubject === input.raterSubject,
  );
  const involving = (model: string): number =>
    priorByRater.filter((m) => m.modelA === model || m.modelB === model).length;
  const overCap = [input.modelA, input.modelB].find((model) => involving(model) >= MAX_RATER_MATCHES_PER_MODEL);
  if (overCap) {
    throw new OpenwopError('rate_limited', 'Too many arena verdicts on this model from one rater.', 429, {
      model: overCap, limit: MAX_RATER_MATCHES_PER_MODEL,
    });
  }
  const a = await ratingOf(tenantId, input.modelA);
  const b = await ratingOf(tenantId, input.modelB);
  const scoreA = input.winner === 'A' ? 1 : input.winner === 'B' ? 0 : 0.5;
  const [nextA, nextB] = eloMatch(a.elo, b.elo, scoreA); // true head-to-head, K=32
  const nextA_ = await applyRatingDelta(tenantId, input.modelA, nextA - a.elo);
  const nextB_ = await applyRatingDelta(tenantId, input.modelB, nextB - b.elo);
  const match: ArenaMatch = { matchId: input.matchId, tenantId, modelA: input.modelA, modelB: input.modelB, winner: input.winner, raterSubject: input.raterSubject, createdAt: input.createdAt };
  await matches.put(match);
  return { match, ratingA: nextA_, ratingB: nextB_ };
}

export async function getArenaRating(tenantId: string, model: string): Promise<number> {
  return (await ratingOf(tenantId, model)).elo;
}
