/**
 * Model arena (ADR 0123 Phase 3, rebuilt by ADR 0986 D4–D6).
 *
 * A verdict is TWO REAL RUNS the rater owns, which answered the same prompts —
 * never two model strings. The models are read from the host's per-turn
 * attribution rows (`host/turnAttribution.ts`), so a verdict cannot name a model
 * that did not answer, cannot cost nothing, and cannot be cast on another
 * member's runs. Each run pair counts once (deterministic match id + create-if-
 * absent CAS).
 *
 * Standings are NOT a running total: they are a Bradley–Terry fit over the
 * ledger (`bradleyTerry.ts`), so concurrent verdicts cannot lose updates and the
 * order matches were cast in cannot move a rating. The ADR 0700 per-model rating
 * rows (`evals:arena-rating`) are retired.
 *
 * @see docs/adr/0986-evals-attributed-leaderboard-and-bound-arena.md
 */
import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import type { Storage } from '../../storage/storage.js';
import { CONVERSATION_WORKFLOW_ID, type ConversationTurn } from '../../host/conversation.js';
import { loadTurns } from '../../host/exchange/loadTurns.js';
import { isNoContribution } from '../../host/exchange/contentParts.js';
import { getTurnAttribution, type ServedModel } from '../../host/turnAttribution.js';
import { conversationMessageId } from '../../host/conversationMessageId.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { bradleyTerry, type PairOutcome } from './bradleyTerry.js';

export type ArenaWinner = 'A' | 'B' | 'tie';

export interface ArenaMatch {
  matchId: string;
  tenantId: string;
  /** Model ids (display) — the attributed models, never client-supplied. */
  modelA: string;
  modelB: string;
  /** ADR 0986 — bound verdicts carry these; a pre-0986 row has none and is
   *  excluded from standings (it was two unverified strings). */
  providerA?: string;
  providerB?: string;
  managedA?: true;
  managedB?: true;
  runIdA?: string;
  runIdB?: string;
  winner: ArenaWinner;
  raterSubject: string;
  createdAt: string;
}

const matches = new DurableCollection<ArenaMatch>('evals:arena-match', (m) => m.matchId, undefined, (m) => m.tenantId);

/** EVC-2 — one rater's verdicts involving any single model are capped (either
 *  side, any opponent), so rotating the opponent cannot evade it. Each verdict
 *  now also needs real runs (ADR 0986): a pair counts once, though one run can
 *  appear in several pairs, so a fresh verdict costs at least ONE new dispatch.
 *  The count→check→write is not atomic across two DISTINCT concurrent pairs;
 *  that overshoot is bounded and accepted (ADR 0986 D4.5). */
export const MAX_RATER_MATCHES_PER_MODEL = 8;

export const keyOf = (s: { provider: string; model: string }): string => `${s.provider}/${s.model}`;

/** Canonical JSON (sorted keys) — so a text+image prompt never equals the text alone. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

const isRunPointer = (c: unknown): boolean =>
  !!c && typeof c === 'object' && !Array.isArray(c) && (c as { kind?: unknown }).kind === 'workflow_run';

/** The conversation id the run's gate opened under — read from its
 *  `conversation.opened` event, never recomputed (a fork's copied payloads carry
 *  the SOURCE's id). */
async function openedConversationId(storage: Storage, runId: string): Promise<string | null> {
  const events = await storage.listEvents(runId, { fromSeq: -1, limit: 200 });
  const opened = events.find((e) => e.type === 'conversation.opened');
  const id = (opened?.payload as { conversationId?: unknown } | undefined)?.conversationId;
  return typeof id === 'string' ? id : null;
}

interface VerifiedRun { prompts: string[]; served: ServedModel }

/** ADR 0986 D4.1–3 — the run is the caller's conversation run, and every model
 *  reply in it is attributed to ONE model by a row of THIS run. */
async function verifyArenaRun(storage: Storage, tenantId: string, runId: string, callerKeys: readonly string[]): Promise<VerifiedRun> {
  const notFound = (): OpenwopError => new OpenwopError('run_not_found', `run ${runId} not found`, 404, { runId });
  const run = await storage.getRun(runId);
  const actor = (run?.metadata as { actingUserId?: unknown } | undefined)?.actingUserId;
  if (!run || run.tenantId !== tenantId || run.workflowId !== CONVERSATION_WORKFLOW_ID
    || typeof actor !== 'string' || !callerKeys.includes(actor)) throw notFound();
  const conversationId = await openedConversationId(storage, runId);
  if (!conversationId) throw notFound();
  const turns: ConversationTurn[] = await loadTurns(storage, runId, conversationId);
  const prompts = turns.filter((t) => t.role === 'user').map((t) => canonical(t.content));
  const replies = turns.filter((t) => t.role === 'agent' && !isNoContribution(t.content) && !isRunPointer(t.content));
  if (prompts.length === 0 || replies.length === 0) {
    throw new OpenwopError('conflict', 'Both runs need at least one answered prompt.', 409, { reason: 'arena_unattributed', runId });
  }
  const keys = new Map<string, ServedModel>();
  const rows = await Promise.all(replies.map((t) => getTurnAttribution(tenantId, conversationMessageId(t.messageId))));
  for (const row of rows) {
    if (!row || row.runId !== runId) {
      throw new OpenwopError('conflict', 'A reply in this run has no record of which model answered it.', 409, { reason: 'arena_unattributed', runId });
    }
    keys.set(keyOf(row), { provider: row.provider, model: row.model, ...(row.managed ? { managed: true as const } : {}) });
  }
  if (keys.size !== 1) throw new OpenwopError('conflict', 'A run answered with more than one model.', 409, { reason: 'arena_mixed_models', runId });
  return { prompts, served: [...keys.values()][0]! };
}

/** The verdict's identity: one per (tenant, unordered run pair). The tenant is in
 *  the hash so a pair id can never collide across tenants (the pre-0986 ledger
 *  keyed by a bare id replayed tenant X's verdict into tenant Y). */
export function arenaMatchId(tenantId: string, runIdA: string, runIdB: string): string {
  const [lo, hi] = [runIdA, runIdB].sort();
  return `am_${createHash('sha256').update(`${tenantId}\u0000${lo}\u0000${hi}`).digest('hex').slice(0, 32)}`;
}

export interface RecordArenaInput {
  runIdA: string;
  runIdB: string;
  winner: ArenaWinner;
  raterSubject: string;
  /** Every key the run stamp may carry for this caller (`actingUserId`). */
  callerKeys: readonly string[];
  createdAt: string;
}

export interface ArenaResult { match: ArenaMatch; ratingA: number; ratingB: number; replayed?: true }

export async function recordArenaMatch(storage: Storage, tenantId: string, input: RecordArenaInput): Promise<ArenaResult> {
  if (input.runIdA === input.runIdB) {
    throw new OpenwopError('validation_error', 'An arena match needs two DIFFERENT runs.', 400, {});
  }
  const matchId = arenaMatchId(tenantId, input.runIdA, input.runIdB);
  const [a, b] = [await verifyArenaRun(storage, tenantId, input.runIdA, input.callerKeys), await verifyArenaRun(storage, tenantId, input.runIdB, input.callerKeys)];
  // Ownership is proven before a replay is answered, so a replay cannot be used to
  // read another member's verdict.
  const prior = await matches.get(matchId);
  if (prior) return replayFor(tenantId, prior, input.runIdA);
  if (a.prompts.length !== b.prompts.length || a.prompts.some((p, i) => p !== b.prompts[i])) {
    throw new OpenwopError('conflict', 'The two runs did not answer the same prompts.', 409, { reason: 'arena_prompt_mismatch' });
  }
  if (keyOf(a.served) === keyOf(b.served)) {
    throw new OpenwopError('conflict', 'Both runs were answered by the same model.', 409, { reason: 'arena_same_model', model: keyOf(a.served) });
  }
  const priorByRater = (await matches.listForTenantIndexed(tenantId)).filter((m) => m.raterSubject === input.raterSubject && m.runIdA);
  const involving = (k: string): number => priorByRater.filter((m) => matchKeys(m).includes(k)).length;
  const overCap = [keyOf(a.served), keyOf(b.served)].find((k) => involving(k) >= MAX_RATER_MATCHES_PER_MODEL);
  if (overCap) {
    throw new OpenwopError('rate_limited', 'Too many arena verdicts on this model from one rater.', 429, {
      reason: 'arena_rater_cap', model: overCap, limit: MAX_RATER_MATCHES_PER_MODEL,
    });
  }
  const match: ArenaMatch = {
    matchId, tenantId,
    modelA: a.served.model, modelB: b.served.model,
    providerA: a.served.provider, providerB: b.served.provider,
    ...(a.served.managed ? { managedA: true as const } : {}),
    ...(b.served.managed ? { managedB: true as const } : {}),
    runIdA: input.runIdA, runIdB: input.runIdB,
    winner: input.winner, raterSubject: input.raterSubject, createdAt: input.createdAt,
  };
  if (!(await matches.compareAndSwap(null, match))) {
    // A concurrent identical verdict won the create: answer with it.
    const won = await matches.get(matchId);
    if (won) return replayFor(tenantId, won, input.runIdA);
    throw new OpenwopError('conflict', 'This verdict is being recorded concurrently; retry.', 409, {});
  }
  return { ...ratingsFor(await arenaStandings(tenantId), match), match };
}

/** A repeat vote answers with the STORED verdict, oriented to the request: the
 *  client labels panes and the winner by position, so a pair re-submitted in the
 *  other order must come back with A and B (and the winner) swapped. */
async function replayFor(tenantId: string, stored: ArenaMatch, requestRunIdA: string): Promise<ArenaResult> {
  const { managedA, managedB, ...rest } = stored;
  const match: ArenaMatch = stored.runIdA === requestRunIdA ? stored : {
    ...rest,
    modelA: stored.modelB, modelB: stored.modelA,
    providerA: stored.providerB, providerB: stored.providerA,
    runIdA: stored.runIdB, runIdB: stored.runIdA,
    winner: stored.winner === 'A' ? 'B' : stored.winner === 'B' ? 'A' : 'tie',
    ...(managedB ? { managedA: true as const } : {}),
    ...(managedA ? { managedB: true as const } : {}),
  };
  return { ...ratingsFor(await arenaStandings(tenantId), match), match, replayed: true };
}

/** The two contestants' `provider/model` keys of a bound match. */
function matchKeys(m: ArenaMatch): [string, string] {
  return [`${m.providerA ?? ''}/${m.modelA}`, `${m.providerB ?? ''}/${m.modelB}`];
}

export interface ArenaStanding {
  key: string;
  provider: string;
  model: string;
  managed?: true;
  /** Bradley–Terry strength on the Elo scale (1500 = the fixed reference). */
  rating: number;
  wins: number;
  losses: number;
  ties: number;
  matches: number;
}

/** ADR 0986 D5 — standings fitted over the tenant's BOUND verdicts. */
export async function arenaStandings(tenantId: string): Promise<ArenaStanding[]> {
  const bound = (await matches.listForTenantIndexed(tenantId)).filter((m) => m.runIdA && m.runIdB && m.providerA && m.providerB);
  const meta = new Map<string, { provider: string; model: string; managed?: true; wins: number; losses: number; ties: number }>();
  const outcomes: PairOutcome[] = [];
  for (const m of bound) {
    const [ka, kb] = matchKeys(m);
    const ea = meta.get(ka) ?? { provider: m.providerA!, model: m.modelA, ...(m.managedA ? { managed: true as const } : {}), wins: 0, losses: 0, ties: 0 };
    const eb = meta.get(kb) ?? { provider: m.providerB!, model: m.modelB, ...(m.managedB ? { managed: true as const } : {}), wins: 0, losses: 0, ties: 0 };
    if (m.winner === 'A') { ea.wins += 1; eb.losses += 1; } else if (m.winner === 'B') { eb.wins += 1; ea.losses += 1; } else { ea.ties += 1; eb.ties += 1; }
    meta.set(ka, ea); meta.set(kb, eb);
    outcomes.push({ a: ka, b: kb, scoreA: m.winner === 'A' ? 1 : m.winner === 'B' ? 0 : 0.5 });
  }
  const ratings = bradleyTerry(outcomes);
  const out: ArenaStanding[] = [...meta.entries()].map(([key, e]) => ({
    key, provider: e.provider, model: e.model, ...(e.managed ? { managed: true as const } : {}),
    rating: ratings.get(key) ?? 1500, wins: e.wins, losses: e.losses, ties: e.ties, matches: e.wins + e.losses + e.ties,
  }));
  out.sort((x, y) => y.rating - x.rating || y.matches - x.matches || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return out;
}

function ratingsFor(standings: readonly ArenaStanding[], m: ArenaMatch): { ratingA: number; ratingB: number } {
  const [ka, kb] = matchKeys(m);
  return {
    ratingA: standings.find((s) => s.key === ka)?.rating ?? 1500,
    ratingB: standings.find((s) => s.key === kb)?.rating ?? 1500,
  };
}

/** A model's arena rating (`GET …/arena/rating`), from the same fit. `model`
 *  may be a bare model id or a `provider/model` key. */
export async function getArenaRating(tenantId: string, model: string): Promise<number> {
  const standings = await arenaStandings(tenantId);
  const exact = standings.find((s) => s.key === model);
  if (exact) return exact.rating;
  // A bare model id answers only when ONE provider serves it; otherwise the caller
  // must name the `provider/model` key rather than get whichever row sorts first.
  const bare = standings.filter((s) => s.model === model);
  if (bare.length > 1) {
    throw new OpenwopError('validation_error', `"${model}" is served by more than one provider; pass the provider/model key.`, 400, { keys: bare.map((s) => s.key) });
  }
  return bare[0]?.rating ?? 1500;
}

/** ADR 0986 D6 — DSAR: the rater is the only personal field of a verdict, so it
 *  is tombstoned and the verdict (workspace data about two models) is kept. */
export async function eraseArenaRaterSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  // Pre-0986 verdicts were written `user:${userId}` over an already-`user:` id.
  const forms = subjectKeyForms(subjectKey).forms;
  for (const m of await matches.listForTenantIndexed(tenantId)) {
    if (forms.has(m.raterSubject)) await matches.put({ ...m, raterSubject: 'erased' });
  }
}
