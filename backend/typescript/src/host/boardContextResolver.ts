/**
 * Board seam (ADR 0079 §Correction, Phase 5; extended by ADR 0588).
 *
 * Core declares the seam; a FEATURE (advisory-board) registers the resolvers
 * (feature→core only — core never imports a feature). Two resolvers live here:
 *
 *   - `BoardContextResolver` — turns a board's selected context refs into a
 *     compact, RBAC-filtered planning-context block for the advisors' system
 *     prompt. **Resolved PER CALLER, PER TURN** (`host/chatContext.ts`): the
 *     block is derived from strategies/projects whose readability differs per
 *     caller, so it can never be snapshotted once and replayed to everyone.
 *     See ADVB-1 — a persisted snapshot taken by a `workspace:write` curator
 *     used to ground a `workspace:read` co-member's turn with a `scope:'user'`
 *     strategy or a `private` project that reader cannot see.
 *   - `BoardCohortResolver` — the board's chat-callable cohort for a caller who
 *     may READ the board, or `null` when they may not. This is the board-read
 *     gate for core's `@@`-summon attach lane (WF-BOA-3), which previously
 *     stamped a caller-supplied `boardId` + speak-set with no board check at
 *     all — falsifying the precondition the context resolver documents.
 *
 * FAILURE SEMANTICS (WF-BOA-2). `resolveBoardContextResult` distinguishes the
 * two ways a resolve yields no block, because the callers need different
 * behaviour for each:
 *   - `{ block: null, failed: false }` — the board carries no resolvable
 *     context. An honest EMPTY: a snapshot writer may clear.
 *   - `{ block: null, failed: true }` — the resolver threw. The block is
 *     UNKNOWN, not empty. A snapshot writer MUST NOT clear (`undefined ⇒ keep`
 *     is the safe direction), and a composer MUST record the degradation.
 * Collapsing these into a bare `null` is exactly how a transient strategy-read
 * failure came to WIPE a boardroom's durable snapshot.
 *
 * Host-extension, non-normative.
 */

import { createLogger } from '../observability/logger.js';
import { OpenwopError } from '../types.js';

const log = createLogger('host.boardContextResolver');

/** (tenantId, boardId, convener) → a plain-text planning context block, or null.
 *  MAY instead return a `BoardContextValue` to report a PARTIAL resolve (M4). */
export type BoardContextResolver = (
  tenantId: string,
  boardId: string,
  convener: string | undefined,
) => Promise<string | null | BoardContextValue>;

/** (tenantId, boardId, caller) → the board's `agent:<id>` cohort refs when the
 *  caller may READ the board; `null` when they may not (or it is missing). */
export type BoardCohortResolver = (
  tenantId: string,
  boardId: string,
  caller: string | undefined,
) => Promise<string[] | null>;

/**
 * (tenantId, boardId) → a refusal MESSAGE when this board may not convene, or
 * `null` when it may (ADR 0588 D5 — the likeness gate).
 *
 * H1 (2026-08-20 review): the gate used to sit ONLY on the two room-OPEN lanes
 * (`POST …/boards/:id/chat` and the `@@` attach). Neither is on the TURN path,
 * so a boardroom OPENED before the acknowledgement was un-fabricated stayed one
 * sidebar click away, still seated, composing turns normally — which is exactly
 * the population `clearFabricatedLivingAcks` targets (they could open the room
 * *because* the seed fabricated the ack). The gate now also runs where the turn
 * is composed (`chatContext.ts`), which covers text chat AND realtime voice
 * through the ONE composition owner.
 *
 * Caller-NEUTRAL by design: it reports only the governance state of the board,
 * never anything readability-scoped, so it can be evaluated without a subject.
 */
export type BoardConveneGate = (tenantId: string, boardId: string) => Promise<string | null>;

/** The outcome of a board-context resolve — "empty" and "failed" kept apart. */
export interface BoardContextResolution {
  /** The composed block, or `null` when the board resolved to no context. */
  block: string | null;
  /** True when the resolver THREW — `block` is UNKNOWN, not empty. */
  failed: boolean;
  /**
   * M4 — how many of the board's configured context refs did NOT resolve for a
   * reason that is NOT authorization. `resolveStrategyEntriesByIds` /
   * `buildProjectContextBlock` DROP a missing or archived ref and return a
   * SHORTER list; they never throw. So the commonest real degradation — a board
   * pointing at four strategies, three of them archived — produced
   * `{ block: <one strategy>, failed: false }`: a silently truncated grounding
   * served as complete.
   *
   * AUTHZ drops are deliberately NOT counted. `degraded` is caller-neutral by
   * contract (ADR 0277 OQ-1); reporting "your co-member sees more than you"
   * would reintroduce ADVB-1's information leak in a new form.
   *
   * `0` for a resolver that does not report (the legacy `string | null` shape).
   */
  shortfall: number;
}

/**
 * The richer value a board-context resolver MAY return so a partial resolve is
 * reportable (M4). A bare `string | null` stays valid — it simply reports no
 * shortfall — which keeps every existing registration (and every test stub)
 * working unchanged.
 */
export interface BoardContextValue {
  block: string | null;
  /** Non-authz refs that did not resolve. See `BoardContextResolution.shortfall`. */
  shortfall: number;
}

let resolver: BoardContextResolver | null = null;
let cohortResolver: BoardCohortResolver | null = null;
let conveneGate: BoardConveneGate | null = null;

/** Register the board-context resolver (called once at boot by the feature). */
export function registerBoardContextResolver(fn: BoardContextResolver): void {
  resolver = fn;
}

/** Register the board-cohort/read-gate resolver (once at boot by the feature). */
export function registerBoardCohortResolver(fn: BoardCohortResolver): void {
  cohortResolver = fn;
}

/** Register the convene gate (once at boot by the feature). */
export function registerBoardConveneGate(fn: BoardConveneGate): void {
  conveneGate = fn;
}

/**
 * Test-only: drop registered board seams. **Every seam is named explicitly and
 * there is no default** (L4): this used to be `__resetBoardContextResolver()`
 * with no arguments, and it was silently widened to null the COHORT resolver
 * too. That resolver is registered ONCE at boot, so a test that only meant to
 * drop the context stub permanently fail-closed `POST /chat/sessions/:id/board`
 * to 404 for the rest of that vitest worker — an invisible cross-file coupling
 * under an unchanged name. Naming the seams makes that impossible to do by
 * accident and impossible to widen again without every call site changing.
 */
export function __resetBoardSeams(seams: { context?: boolean; cohort?: boolean; convene?: boolean }): void {
  if (seams.context) resolver = null;
  if (seams.cohort) cohortResolver = null;
  if (seams.convene) conveneGate = null;
}

/**
 * Resolve a board's context block, RBAC-filtered for `convener`, keeping
 * "no context" and "resolve failed" distinguishable. Never throws.
 */
export async function resolveBoardContextResult(
  tenantId: string,
  boardId: string,
  convener: string | undefined,
): Promise<BoardContextResolution> {
  if (!resolver) return { block: null, failed: false, shortfall: 0 };
  try {
    const out = await resolver(tenantId, boardId, convener);
    if (out === null || typeof out === 'string') return { block: out, failed: false, shortfall: 0 };
    return { block: out.block, failed: false, shortfall: out.shortfall };
  } catch (err) {
    log.warn('board_context_resolve_failed', { boardId, error: err instanceof Error ? err.message : String(err) });
    return { block: null, failed: true, shortfall: 0 };
  }
}

/**
 * The refusal message for a board that may not convene, or `null`.
 *
 * FAILURE POSTURE, stated rather than defaulted:
 *   - gate THREW ⇒ REFUSE with a generic message. This is a governance gate; a
 *     store hiccup must not become permission. (A board whose row cannot be read
 *     also has no context and no cohort, so nothing useful was going to compose.)
 *   - gate UNREGISTERED ⇒ allow. That is ABSENCE, not permission: the gate is
 *     registered unconditionally beside the context + cohort resolvers when the
 *     advisory-board feature mounts, so "unregistered" means no board feature is
 *     running, in which case no board exists for this `boardId` to gate and the
 *     board-context leg composes nothing either.
 */
export async function resolveBoardConveneRefusal(tenantId: string, boardId: string): Promise<string | null> {
  if (!conveneGate) return null;
  try {
    return await conveneGate(tenantId, boardId);
  } catch (err) {
    log.warn('board_convene_gate_failed', { boardId, error: err instanceof Error ? err.message : String(err) });
    return 'This board could not be checked for convening. Try again in a moment.';
  }
}

/**
 * The board's cohort refs for a caller who may read it, or `null`. Fail-CLOSED:
 * an unregistered resolver returns `null` (no board feature ⇒ no board attach),
 * which is what makes this usable as core's board-read gate.
 */
export async function resolveBoardCohortForCaller(
  tenantId: string,
  boardId: string,
  caller: string | undefined,
): Promise<string[] | null> {
  if (!cohortResolver) return null;
  try {
    return await cohortResolver(tenantId, boardId, caller);
  } catch (err) {
    // A TYPED refusal is an answer, not a failure: the likeness gate (ADR 0588
    // D5) throws 422 for a board that exists and is readable but may not yet
    // convene. Swallowing it into `null` would report "not found", which is a
    // gate whose exit the user cannot find. Only unexpected errors fail closed.
    if (err instanceof OpenwopError) throw err;
    log.warn('board_cohort_resolve_failed', { boardId, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}
