/**
 * Compensation obligation ledger (ADR 0554 P1) — the durable record of "this run
 * committed effect X, and therefore owes an inverse of X".
 *
 * ── BUILT TO RFC 0151, NOT TO ADR 0554's DECISION SECTION ──────────────────
 *
 * The ADR predates the RFC's resolution and its Decision text disagrees with
 * the accepted contract in three places. RFC 0151 wins; the ADR carries a
 * correction note. Recorded here because the divergence is easy to reintroduce
 * by reading the ADR alone:
 *
 *   ADR 0554 said                          RFC 0151 says
 *   ─────────────────────────────────────  ──────────────────────────────────
 *   "the executor enters `compensating`"   §D: the run KEEPS its execution
 *                                          state and adds a separate
 *                                          `compensationStatus`, explicitly
 *                                          "to avoid reinterpreting existing
 *                                          run-state enums"
 *   identity = forward identity + version  §C: (tenantId, runId,
 *                                          forwardLogicalInvocationId,
 *                                          compensationOrdinal, profileVersion)
 *   outcomes compensated/blocked/skipped   §D events: requested / started /
 *                                          completed / failed / paused /
 *                                          manual_intervention_required
 *
 * `RunStatus` is a CLOSED union exported by `@openwop/openwop` (the wire
 * package), so "enters `compensating`" was never host-local — it would have been
 * a wire change. §D's separate field is what makes this phase implementable at
 * all without an RFC of its own.
 *
 * ── NOT `host/obligationLedger.ts` ─────────────────────────────────────────
 *
 * That file is also called an obligation ledger and is a different machine
 * entirely: MONEY ("we owe a third party a cut of a paid source") — accrual /
 * reversal rows in integer minor units, payee grouping, CAS-claimed payout runs,
 * operator-attested confirmation (ADR 0445/0447). A compensation obligation has
 * no currency, no payee, and different terminal states. Reusing it would put
 * money semantics on the unwind path and build the parallel system ADR 0554
 * warns against. Disambiguate by module; never by the bare word "obligation".
 *
 * ── SCOPE: WHAT SHIPS AND WHAT DOES NOT ────────────────────────────────────
 *
 * SHIPS — the ledger and its state machine. Host-local durable state, no wire
 * surface, so it needs nothing that has not landed.
 *
 * DOES NOT SHIP, deliberately:
 *   - the §A `compensation` capability advertisement,
 *   - `compensationStatus` on the run's wire shape,
 *   - the six §D `compensation.*` run events.
 *
 * All three are wire, and RFC 0151's own header records that while the RFC text
 * is `Accepted`, "the entire compensation and partial-failure profile — schema,
 * prose, conformance, and host implementation" is CARRIED FORWARD. Measured: the
 * pinned `@openwop/openwop` has no `compensationStatus`, and the pinned
 * conformance `capabilities.schema.json` has no `compensation` slot.
 *
 * Note the root schema is `additionalProperties: true`, so an advert would NOT
 * be rejected — nothing would stop the lie. That makes ADR 0548 invariant 3 the
 * only guard here, which is precisely why the advert is withheld rather than
 * "tried to see if it validates". A tripwire in
 * `test/agrade-wire-blocked-residue.test.ts` fires when the shapes land.
 *
 * ── THE THREE P0 FINDINGS THIS MODEL HONOURS ───────────────────────────────
 *
 * 1. "Compensable" is not a boolean — `CompensationShape` has three real shapes
 *    plus `author-declared`. A `compensate: true` flag would let an author
 *    believe an email can be unsent.
 * 2. Compensation is ITSELF an effect that re-enters `assertEffectAllowed` and
 *    can fail, so `failed` is NON-terminal and carries an attempt count;
 *    partial-compensation is the normal case, not an edge.
 * 3. Two senders' compensability is unknowable to the host (`network-egress` via
 *    webhook and via the broker). `author-declared` exists so the ABSENCE of a
 *    declaration is representable rather than defaulted to "undoable".
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { recordCompensationObligation, recordCompensationResolved } from '../observability/metricSeams.js';
import { COMPENSATION_PROFILE_VERSION } from './compensationCapability.js';
import type { EffectKind } from './runEffectContext.js';

const log = createLogger('host.compensationLedger');

/**
 * RFC 0151 §A `profileVersion`. Part of the inverse-action identity, so a
 * profile change yields new ids rather than colliding with recorded ones.
 *
 * MOVED to `host/compensationCapability.ts` (ADR 0554 wire flip) and re-exported
 * here so every existing call site keeps reading the same value. The move is the
 * point: this constant is now BOTH what the ledger mints under and what
 * `capabilities.compensation.profileVersion` advertises, and a host that let
 * those two drift would tell a peer its recorded identities were minted under
 * ordering rules they were not.
 */
export { COMPENSATION_PROFILE_VERSION };

/**
 * How an effect can be undone. NOT a boolean (P0 finding 1).
 *
 * Load-bearing for the unwind: a `forward-effect` inverse can itself fail and
 * needs its own retry budget, whereas `host-withdrawable` is a local row flip.
 */
export type CompensationShape =
  /** Undone by a NEW forward effect that can itself fail (a refund is a payment). */
  | 'forward-effect'
  /** Host-owned state withdrawn locally (an in-app notification row). */
  | 'host-withdrawable'
  /** Cannot be undone (a delivered email, a pushed device notification). */
  | 'irreversible'
  /** The host cannot know; the workflow author must declare it (webhook/broker). */
  | 'author-declared';

/**
 * Per-obligation state, named after RFC 0151 §D's event vocabulary so the
 * events P2 emits are a direct projection rather than a translation table.
 */
export type CompensationState =
  | 'requested'
  | 'started'
  | 'completed'
  | 'failed'
  | 'paused'
  | 'manual_intervention_required';

/** RFC 0151 §D's RUN-level rollup. Separate from `RunStatus` by design. */
export type CompensationStatus =
  | 'none' | 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'manual';

export interface CompensationObligation {
  /** RFC 0151 §C identity — see `inverseActionId`. */
  readonly inverseActionId: string;
  readonly tenantId: string;
  readonly runId: string;
  /**
   * The ROOT run of the sub-run tree this effect committed in (ADR 0554 P2).
   * Absent on a row minted before P2 ⇒ the row's own `runId` is its root.
   *
   * P0 finding 3 requires the reverse unwind to be DEPTH-FIRST through
   * sub-runs. This field is how that ordering is MEASURED rather than
   * approximated: `compensationOrdinal` is allocated from one counter per ROOT
   * (`nextCompensationOrdinal`), and a sub-run executes synchronously inside
   * its parent node (`executor/subWorkflowDispatcher.ts` awaits `executeRun`),
   * so a single descending sort over the tree IS depth-first reverse order. The
   * alternative — per-run ordinals plus a rule for splicing a child's inverses
   * into the parent's sequence — would need a parent-node linkage the ledger
   * does not carry, and would be a guess wherever it was missing.
   */
  readonly rootRunId?: string;
  /**
   * The forward node that committed the effect (ADR 0554 P2). Opaque on the
   * wire; carried so the §D events can attribute an inverse action to a node
   * and so the compensator's declaration can be re-resolved from the workflow
   * definition on a crash-resume.
   */
  readonly nodeId?: string;
  /** The declared inverse action's node type (RFC 0151 §B `nodeTypeId`). */
  readonly compensationNodeTypeId?: string;
  /**
   * When the plan this row belongs to was REQUESTED (`compensation.requested`
   * emitted), if it ever was.
   *
   * The rows ARE the plan (§C: "the plan is not a second document"), which left
   * the rollup unable to tell two very different runs apart: one that minted
   * obligations and completed happily, and one whose unwind was requested and
   * has not started. Both are "every row is `requested`". §D says the first is
   * `none` — "No `compensation.requested` has been recorded for the run" — and
   * the second is `pending`, so without this stamp the fold reported `pending`
   * for every healthy run that ran a compensable node.
   */
  readonly planRequestedAt?: string;
  /**
   * RFC 0151 §B/§F — the input the inverse action executes with, RECORDED at
   * mint time from the node's declaration rather than re-read from the
   * definition at unwind time.
   *
   * §B: compensation inputs "MUST derive from recorded facts… prompt or model
   * regeneration MUST NOT construct a compensation input during replay". Storing
   * it here is what makes that true rather than aspirational: a workflow
   * redefined between the forward effect and the unwind would otherwise hand the
   * compensator a mapping the original effect never saw, and an inverse built
   * from a re-derived value is not the inverse of what was done.
   *
   * Absent on rows minted before the ADR 0554 wire flip ⇒ the declaration's
   * current `inputMapping` is the only thing available, which is the honest
   * degradation and is why this is optional rather than backfilled with a guess.
   */
  readonly compensationInput?: Record<string, unknown>;
  /** RFC 0151 §B `requiresApproval` — the inverse effect is gated behind the
   *  same RFC 0051 approval surface as a forward effect. */
  readonly requiresApproval?: boolean;
  /**
   * RFC 0151 §B (S36) — the EFFECTIVE `waiveRequiresApproval`, resolved at MINT
   * time (§B: "stamped onto the obligation at mint time exactly like
   * `requiresApproval`", so a mid-flight redefinition cannot change who had to
   * authorize) and therefore ALREADY post-policy-escalation. A reader treats it
   * as the answer, not as an input to one.
   *
   * ABSENT on any row minted before S36 ⇒ the gate falls back to
   * `requiresApproval`, which is precisely the pre-S36 behaviour. The honest
   * degradation, and the same shape as `compensationInput`'s "absent ⇒ …".
   */
  readonly waiveRequiresApproval?: boolean;
  /** The approval this obligation is waiting on, once one has been raised. */
  approvalId?: string;
  /** The forward effect's logical invocation id (§C), NOT its retry attempt. */
  readonly forwardLogicalInvocationId: string;
  /** Position in the unwind. `reverse-completion` runs these DESCENDING. */
  readonly compensationOrdinal: number;
  readonly profileVersion: string;
  readonly effectKind: EffectKind;
  readonly shape: CompensationShape;
  /** Digest of the forward effect's recorded result — pins WHAT is undone. */
  readonly resultDigest: string;
  /** Digest of the compensation contract — pins HOW, so a change is visible. */
  readonly contractDigest: string;
  /** Scopes the unwind must satisfy (RFC 0051 approval / RFC 0049). */
  readonly requiredScopes: readonly string[];
  state: CompensationState;
  /** Attempts so far. Retries reuse the id, so this is NOT part of identity. */
  attempts: number;
  /** Required for every state except `completed` — see the reason rule. */
  reason?: string;
  /**
   * ADR 0554 P3 — the principal who last STARTED or RETRIED this obligation's
   * inverse action, recorded so RFC 0151 §E separation of duties can exclude
   * them from approving a waive of the same obligation.
   *
   * It lives HERE and not on the approval row on purpose. `PendingApproval` is
   * operator-visible and sits closer to the wire; the ledger is this host's
   * recorded-facts store, and "who started this unwind" is a recorded fact
   * about the obligation, not a property of any one approval card.
   */
  startedBy?: string;
  /**
   * ADR 0554 P3 — the `auditChainService` sequence numbers of every
   * recovery-audit entry whose action ACTUALLY APPLIED to this row, ascending.
   *
   * This field is the WITNESS OF APPLICATION, and it is why an operator action
   * cannot be observable without its audit record. The recovery applier appends
   * the audit entry FIRST and feeds the returned seq into this write, so:
   *   - a state change with no audit record is structurally unreachable (the
   *     seq is a required input to the write);
   *   - a crash between the two leaves an audit entry whose seq is NOT in this
   *     list — over-recording, which the timeline read model renders explicitly
   *     as "recorded, not applied" rather than mistaking it for an applied act.
   *
   * A SET AND NOT A SINGLE "LATEST". A single seq forces the read model to guess
   * `applied = seq <= latest`, which reports an entry that crashed mid-apply as
   * applied the moment any LATER action succeeds — a false positive on exactly
   * the record an incident review is reading. Membership is exact; "roughly
   * right" is not a property an audit trail may have.
   *
   * Bounded by `MAX_RECOVERY_AUDIT_SEQS`: at the cap the applier REFUSES rather
   * than dropping the oldest, because a silently truncated list would make
   * `applied: false` mean either "never applied" or "we forgot", and those need
   * different responses from a human.
   *
   * Absent/empty ⇒ this state was reached by the EXECUTOR's own unwind, not by
   * an operator. That is the honest default, not a missing value.
   */
  recoveryAuditSeqs?: number[];
  /** ADR 0554 P3 — the approval a HIGH-RISK waive is parked behind. Distinct
   *  from `approvalId` (the unwind's own §B gate): approving the inverse and
   *  approving its abandonment are opposite decisions, and one field for both
   *  would let a decision on the first read as a decision on the second. */
  waiveApprovalId?: string;
  readonly committedAt: string;
  updatedAt: string;
}

/**
 * RFC 0151 §C: "Each inverse action receives a stable ID derived from
 * `(tenantId, runId, forwardLogicalInvocationId, compensationOrdinal,
 * profileVersion)` and MUST be retry-stable."
 *
 * Retry-stability is the whole point: a retried unwind addresses the SAME row
 * rather than minting a second obligation and compensating twice. The attempt
 * number is deliberately absent from the tuple.
 *
 * Hashed rather than concatenated because the components are caller-supplied and
 * could contain the separator; a delimiter collision would alias two distinct
 * obligations onto one id, which for a `forward-effect` shape means a refund
 * that silently never runs.
 */
export function inverseActionId(parts: {
  tenantId: string;
  runId: string;
  forwardLogicalInvocationId: string;
  compensationOrdinal: number;
  profileVersion?: string;
}): string {
  const tuple = JSON.stringify([
    parts.tenantId,
    parts.runId,
    parts.forwardLogicalInvocationId,
    parts.compensationOrdinal,
    parts.profileVersion ?? COMPENSATION_PROFILE_VERSION,
  ]);
  return `cmp_${createHash('sha256').update(tuple).digest('hex').slice(0, 32)}`;
}

/** Stable digest for result/contract pinning. */
export function digestOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 32);
}

/**
 * Legal transitions — a machine, so the illegal ones are enumerable and testable.
 *
 * `failed` is NOT terminal (P0 finding 2): compensation is itself an effect that
 * can fail, and a failed inverse must be retryable without minting a new
 * obligation. `completed` IS terminal — re-running a completed compensation is a
 * double-undo, which for `forward-effect` means a second refund.
 *
 * `paused` and `manual_intervention_required` return to `started`: both are
 * authorization/operator conditions, not facts about the effect. Once satisfied,
 * the inverse is owed exactly as before. RFC 0151 §E allows an operator to
 * "terminate as uncompensated", which is `failed` with a recorded justification —
 * not a separate skipped state.
 */
const LEGAL: Readonly<Record<CompensationState, readonly CompensationState[]>> = {
  requested: ['started', 'paused', 'manual_intervention_required', 'failed'],
  started: ['completed', 'failed', 'paused', 'manual_intervention_required'],
  failed: ['started', 'failed', 'paused', 'manual_intervention_required'],
  paused: ['started', 'failed', 'manual_intervention_required'],
  manual_intervention_required: ['started', 'failed', 'paused'],
  completed: [],
};

export function canTransition(from: CompensationState, to: CompensationState): boolean {
  return (LEGAL[from] ?? []).includes(to);
}

/** No further work is owed. Only `completed` is terminal — `failed` is retryable
 *  by design, and an operator "terminating as uncompensated" leaves it `failed`
 *  WITH a reason, which is a durable record rather than a silent close. */
export function isTerminal(s: CompensationState): boolean {
  return LEGAL[s].length === 0;
}

/** Thrown on an illegal transition — a BUG, not an unwind outcome, so it is a
 *  distinct type from an effect failure. */
export class CompensationTransitionError extends Error {
  constructor(readonly from: CompensationState, readonly to: CompensationState, readonly id: string) {
    super(`illegal compensation transition ${from} -> ${to} for ${id}`);
    this.name = 'CompensationTransitionError';
  }
}

/**
 * ADR 0554 P3 — thrown when a recovery action's `expectedState` no longer
 * matches the row. NOT a bug and NOT an effect failure: the caller's view of the
 * obligation is stale because someone else moved it first.
 *
 * Distinct from `CompensationTransitionError` on purpose. That one means "this
 * transition is not in the state machine" (a bug, 500-class); this one means
 * "the transition is fine, you are just not the winner" — which is a 409 the
 * losing operator can act on by re-reading the timeline.
 *
 * THE TABLE WOULD NOT HAVE CAUGHT THIS. `LEGAL.failed` includes `failed`, so two
 * operators waiving one obligation concurrently both perform a legal transition
 * and both would "win". Measured against the table above, not assumed.
 */
export class CompensationStaleViewError extends Error {
  constructor(readonly expected: CompensationState, readonly actual: CompensationState, readonly id: string) {
    super(`compensation obligation ${id} moved ${expected} -> ${actual} before this action could apply`);
    this.name = 'CompensationStaleViewError';
  }
}

const rows = new DurableCollection<CompensationObligation>(
  'compensation:obligation',
  (r) => `${r.tenantId}::${r.inverseActionId}`,
);

export interface RecordObligationInput {
  tenantId: string;
  runId: string;
  forwardLogicalInvocationId: string;
  compensationOrdinal: number;
  effectKind: EffectKind;
  shape: CompensationShape;
  resultDigest: string;
  contractDigest: string;
  requiredScopes?: readonly string[];
  profileVersion?: string;
  /** ADR 0554 P2 — the root of the sub-run tree. Defaults to `runId`. */
  rootRunId?: string;
  nodeId?: string;
  compensationNodeTypeId?: string;
  /** §B/§F — the recorded inverse input. See `CompensationObligation`. */
  compensationInput?: Record<string, unknown>;
  requiresApproval?: boolean;
  /** RFC 0151 §B (S36) — the EFFECTIVE value, already resolved by the caller. */
  waiveRequiresApproval?: boolean;
  now?: () => string;
}

/**
 * Durably record an obligation when a forward effect COMMITS.
 *
 * FIRST-WRITE-WINS on the inverse-action id, mirroring the money ledger's
 * accrual rule for the same reason: a replayed or re-dispatched run must not
 * mint a second obligation for one committed effect, or the unwind compensates
 * twice. The existing row is returned unchanged.
 *
 * Records `irreversible` shapes TOO. An obligation that cannot be discharged is
 * still a fact the operator needs — recording it and resolving it `failed` with
 * a reason is honest, whereas omitting it makes the ledger read fully
 * compensated when an email went out.
 */
export async function recordObligation(input: RecordObligationInput): Promise<CompensationObligation> {
  const id = inverseActionId({
    tenantId: input.tenantId,
    runId: input.runId,
    forwardLogicalInvocationId: input.forwardLogicalInvocationId,
    compensationOrdinal: input.compensationOrdinal,
    profileVersion: input.profileVersion,
  });
  const existing = await rows.get(`${input.tenantId}::${id}`);
  if (existing) return existing;

  const at = (input.now ?? (() => new Date().toISOString()))();
  const row: CompensationObligation = {
    inverseActionId: id,
    tenantId: input.tenantId,
    runId: input.runId,
    forwardLogicalInvocationId: input.forwardLogicalInvocationId,
    compensationOrdinal: input.compensationOrdinal,
    profileVersion: input.profileVersion ?? COMPENSATION_PROFILE_VERSION,
    rootRunId: input.rootRunId ?? input.runId,
    ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    ...(input.compensationNodeTypeId !== undefined
      ? { compensationNodeTypeId: input.compensationNodeTypeId }
      : {}),
    ...(input.compensationInput !== undefined ? { compensationInput: input.compensationInput } : {}),
    ...(input.requiresApproval !== undefined ? { requiresApproval: input.requiresApproval } : {}),
    ...(input.waiveRequiresApproval !== undefined ? { waiveRequiresApproval: input.waiveRequiresApproval } : {}),
    effectKind: input.effectKind,
    shape: input.shape,
    resultDigest: input.resultDigest,
    contractDigest: input.contractDigest,
    requiredScopes: input.requiredScopes ?? [],
    state: 'requested',
    attempts: 0,
    committedAt: at,
    updatedAt: at,
  };
  await rows.put(row);
  log.info('compensation_obligation_recorded', {
    runId: input.runId, effectKind: input.effectKind, shape: input.shape,
    compensationOrdinal: input.compensationOrdinal,
  });
  // ADR 0556 P1. Emitted AFTER the first-write-wins return above, so a replay
  // that re-reaches the same committed effect does not double-count an
  // obligation that was never minted twice — the counter has to agree with the
  // ledger or it is measuring the code path rather than the state.
  recordCompensationObligation(input.effectKind, input.shape);
  return row;
}

/**
 * Every obligation for a run in `reverse-completion` order — DESCENDING
 * `compensationOrdinal`, i.e. the reverse of how the effects committed.
 *
 * RFC 0151 §A: an advertising host MUST implement `reverse-completion`. This is
 * that ordering; `dependency-graph` is the optional model and is not implemented.
 */
export async function obligationsForRun(tenantId: string, runId: string): Promise<CompensationObligation[]> {
  const all = await rows.list();
  return all
    .filter((r) => r.tenantId === tenantId && r.runId === runId)
    .sort((a, b) => b.compensationOrdinal - a.compensationOrdinal);
}

/** A row's root run — its own `runId` when the row predates ADR 0554 P2. */
function rootOf(r: CompensationObligation): string {
  return r.rootRunId ?? r.runId;
}

/**
 * Every obligation in a run TREE, in `reverse-completion` order (ADR 0554 P2).
 *
 * This is the unwind plan. Because `compensationOrdinal` is allocated from ONE
 * counter per root (`nextCompensationOrdinal`) and a sub-run runs synchronously
 * inside its parent node, a single descending sort over the tree is already the
 * depth-first reverse order P0 finding 3 requires — a child's inverses fall
 * between the parent effects that bracketed it, because that is where its
 * ordinals were allocated.
 *
 * Ties break on `committedAt` descending. Two nodes completing concurrently can
 * read the same high-water ordinal; the identities still differ (different
 * `forwardLogicalInvocationId`), so nothing aliases — only the order between
 * that pair is unpinned, and the commit timestamp is the best remaining
 * evidence of which went last.
 */
export async function obligationsForRunTree(
  tenantId: string,
  rootRunId: string,
): Promise<CompensationObligation[]> {
  const all = await rows.list();
  return all
    .filter((r) => r.tenantId === tenantId && rootOf(r) === rootRunId)
    .sort((a, b) =>
      b.compensationOrdinal - a.compensationOrdinal ||
      (a.committedAt < b.committedAt ? 1 : a.committedAt > b.committedAt ? -1 : 0),
    );
}

/**
 * The next forward-completion ordinal for a run tree.
 *
 * Derived from the durable rows (high-water + 1) rather than from a
 * process-local counter, so a crash mid-run resumes the sequence instead of
 * restarting it — which would collide two effects onto one ordinal and make the
 * reverse order report an unwind that never happened in that sequence.
 */
export async function nextCompensationOrdinal(tenantId: string, rootRunId: string): Promise<number> {
  const list = await obligationsForRunTree(tenantId, rootRunId);
  return (list[0]?.compensationOrdinal ?? 0) + 1;
}

/**
 * What P2's unwind would take next, or `null` when nothing is owed.
 *
 * P1 REPORTS; it does not claim. The CAS claim belongs with the executor states
 * that consume it, and a claim seam with no consumer is a seam nothing exercises.
 */
export async function nextClaimable(tenantId: string, runId: string): Promise<CompensationObligation | null> {
  const list = await obligationsForRun(tenantId, runId);
  return list.find((r) => !isTerminal(r.state)) ?? null;
}

/** ONE obligation by its §C identity, tenant-scoped. `null` when the tenant does
 *  not own it — the key is tenant-prefixed, so a cross-tenant id reads as absent
 *  rather than as someone else's row (RFC 0132 §A.2 neutralization at the store,
 *  not just at the route). */
export async function getObligation(
  tenantId: string,
  inverseActionId: string,
): Promise<CompensationObligation | null> {
  return (await rows.get(`${tenantId}::${inverseActionId}`)) ?? null;
}

/**
 * ADR 0554 P3 — the suffix a WAIVE approval's `compensationId` carries.
 *
 * Lives on the ledger because the ledger owns `waiveApprovalId`, and because
 * both readers (`compensationRecovery` mints it, `compensationRuntime`'s
 * separation-of-duties check parses it) already import this module — so there is
 * ONE spelling and neither can drift from the other. A second literal here is
 * the "five copies of one authorization-relevant string" failure this codebase
 * already records for `x-openwop-act-as`.
 */
export const WAIVE_APPROVAL_SUFFIX = '#waive';

/**
 * ADR 0554 P4 — apply `mutate` to one obligation under a CROSS-INSTANCE CAS.
 *
 * WHY THIS EXISTS. Every write below used to be `rows.get()` then
 * `rows.put()` — a read-check-write serialised only by `withObligationLock`,
 * which is a `Map<string, Promise>` and therefore an IN-PROCESS mutex. Two
 * instances have two maps and contend for nothing, and the §E operator recovery
 * routes are plain HTTP served by ANY instance: two operators, or one retrying
 * against a different instance, both read `requested`, both pass
 * `expectedState`, and both write. `resolveObligationLocked`'s own comment
 * records what that costs — "two concurrent unwind passes each fired the
 * inverse" — and here the inverse is a refund.
 *
 * ADR 0554 said this needed "the conditional write" and scoped its concurrency
 * claim to one instance. The conditional write already existed:
 * `DurableCollection.compareAndSwap` (FEAT-1), backed by the storage
 * `kvCompareAndSwap` primitive and used by 94 files. Nothing needed inventing.
 *
 * THE RETRY IS MANDATORY, NOT DEFENSIVE. The swap compares the whole row's
 * serialized bytes, so an UNRELATED concurrent field write (an approval pointer)
 * also loses it. Re-reading inside the loop is what makes that a retry rather
 * than a spurious failure — and it is also what makes a genuine race fail
 * CORRECTLY, because `mutate` re-runs its preconditions against the fresh row
 * and the loser throws `CompensationStaleViewError` / `CompensationTransitionError`
 * instead of silently applying a second time.
 *
 * `expected` MUST be the object `get()` returned, not a copy: the comparison is
 * over serialized bytes, so a reconstructed object can fail to match a row it is
 * logically equal to.
 */
const CAS_ATTEMPTS = 8;

async function mutateObligationWithCas<T>(
  key: string,
  mutate: (row: CompensationObligation) => { next: CompensationObligation; result: T },
  onMissing: () => T,
): Promise<T> {
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const row = await rows.get(key);
    if (!row) return onMissing();
    const { next, result } = mutate(row);
    if (await rows.compareAndSwap(row, next)) return result;
  }
  // Bounded, and it FAILS rather than falling through to a plain put. A
  // last-writer-wins fallback here would reintroduce exactly the race this
  // function exists to close, at the moment contention is highest.
  throw new Error(`compensation obligation ${key} write contention — ${CAS_ATTEMPTS} CAS attempts lost`);
}

/** ADR 0554 P3 — park an obligation behind a WAIVE approval. Deliberately a
 *  separate pointer from `attachApproval`: that one records the gate on running
 *  the inverse, this one the gate on abandoning it. */
export async function attachWaiveApproval(
  tenantId: string,
  id: string,
  waiveApprovalId: string,
): Promise<void> {
  await mutateObligationWithCas(
    `${tenantId}::${id}`,
    (row) => ({ next: { ...row, waiveApprovalId }, result: undefined }),
    () => undefined,
  );
}

/** Record which RFC 0051 approval an obligation is waiting on (ADR 0554 P2).
 *  Not a state transition — the state is `paused`; this is the pointer an
 *  operator (and the resume path) follows back to the open interrupt. */
export async function attachApproval(
  tenantId: string,
  id: string,
  approvalId: string,
): Promise<void> {
  await mutateObligationWithCas(
    `${tenantId}::${id}`,
    (row) => ({ next: { ...row, approvalId }, result: undefined }),
    () => undefined,
  );
}

export interface ResolveInput {
  tenantId: string;
  inverseActionId: string;
  to: CompensationState;
  /** REQUIRED for every state except `completed` — see the reason rule. */
  reason?: string;
  /**
   * The TRUE number of inverse-action attempts made, when the caller knows it.
   *
   * The row's own counter increments once per TRANSITION, which is not the same
   * number: an inverse that failed twice and succeeded on the third try makes
   * THREE attempts but only two transitions (`requested→started`,
   * `started→completed`), and reporting `2` there would tell an operator the
   * retry budget was barely touched. `host-sample-test-seams.md` §21 asks for
   * "the attempts made", so the unwind — the only code that knows — passes it.
   *
   * Absent ⇒ the transition counter, which is the honest fallback for a caller
   * that genuinely made one attempt per transition.
   */
  attempts?: number;
  /**
   * ADR 0554 P3 — OPTIMISTIC-CONCURRENCY PRECONDITION. When present, the
   * transition applies only if the row's CURRENT state still equals this value;
   * otherwise it throws `CompensationStaleViewError` and NOTHING is written.
   *
   * WHY THIS EXISTS RATHER THAN LEANING ON `canTransition`. Two operators
   * waiving one obligation concurrently are only stopped by the transition
   * table if that table happens to forbid the resulting repeat — which makes a
   * concurrency guarantee depend on an unrelated table, and evaporates silently
   * the day someone widens it. The precondition is checked against the state the
   * OPERATOR SAW, so the loser of a race is rejected because their view is
   * stale, which is the true reason.
   *
   * Absent ⇒ no precondition. The executor's own unwind passes nothing here: it
   * is already serialized by the per-obligation lock and has no "view" to be
   * stale.
   */
  expectedState?: CompensationState;
  /** ADR 0554 P3 — see `CompensationObligation.startedBy`. */
  startedBy?: string;
  /** ADR 0554 P3 — see `CompensationObligation.recoveryAuditSeqs`. The recovery
   *  applier appends the audit entry first and passes its seq here, so the row
   *  cannot record an operator action the audit chain does not. APPENDED to the
   *  row's list, never replacing it. */
  recoveryAuditSeq?: number;
  /** ADR 0554 P3 — park this obligation behind a waive approval. */
  waiveApprovalId?: string;
  now?: () => string;
}

/**
 * Transition one obligation.
 *
 * THE REASON RULE. Every state except `completed` must carry a reason.
 * `failed`/`paused`/`manual_intervention_required` are what an operator reads
 * when deciding whether an unwind actually happened, and a bare state is exactly
 * the success-with-empty shape this codebase treats as a lie: it looks resolved
 * and says nothing about what was left undone. RFC 0151 §E requires recorded
 * justification for a skip and an audit for every override; this is where that
 * lands.
 *
 * `attempts` increments on every resolution, including failures, so P2's retry
 * budget derives from the durable row rather than process memory a restart loses.
 */
export async function resolveObligation(input: ResolveInput): Promise<CompensationObligation> {
  // Serialize per obligation (ADR 0554 P2). The transition below is a
  // read-check-write, and the durable store has no compare-and-swap, so two
  // concurrent unwind passes could each read `requested` before either wrote
  // `started` — and both would then fire the inverse. For a `forward-effect`
  // shape that is two refunds.
  //
  // MEASURED, not assumed: the ADR 0554 P2 duplicate-delivery fixture ran two
  // `unwindRun` calls concurrently and produced exactly that, with the state
  // machine's `started -> started` prohibition in place and looking like it was
  // doing the work. The machine rejects the SECOND WRITE it sees; without this
  // chain it never saw one.
  //
  // Same idiom and same limit as `approvalService.withApprovalLock`: one
  // winner within a process. A cross-INSTANCE race still needs the conditional
  // write a production adapter provides.
  return withObligationLock(`${input.tenantId}::${input.inverseActionId}`, () => resolveObligationLocked(input));
}

/**
 * ADR 0554 P3 — run `fn` inside THE SAME per-obligation critical section
 * `resolveObligation` uses.
 *
 * Exported for `host/compensationRecovery.ts`, which must hold ONE section
 * across three steps that are only correct together: read the row, append the
 * obligation-scoped audit entry (a read-then-append on the prev pointer), and
 * write the transition. Doing them under three separate acquisitions would let a
 * second operator interleave and FORK the audit slice — two entries claiming one
 * predecessor, for a history that is actually legitimate.
 *
 * NOT REENTRANT (the lock is a promise chain, so a nested acquisition of the
 * same key deadlocks). `fn` must therefore call
 * {@link resolveObligationWithinSection}, never `resolveObligation`. There is no
 * runtime guard for that; the two functions are named so the mistake is visible
 * at the call site.
 */
export function withObligationCriticalSection<T>(
  tenantId: string,
  inverseActionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withObligationLock(`${tenantId}::${inverseActionId}`, fn);
}

/** The lock-free transition, for a caller already inside
 *  {@link withObligationCriticalSection}. Identical semantics otherwise. */
export function resolveObligationWithinSection(input: ResolveInput): Promise<CompensationObligation> {
  return resolveObligationLocked(input);
}

const resolveChains = new Map<string, Promise<unknown>>();
function withObligationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prior = resolveChains.get(key) ?? Promise.resolve();
  const run = prior.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  resolveChains.set(key, tail);
  // Drop the entry once this is the last queued work for the key (bounds the map).
  void tail.then(() => {
    if (resolveChains.get(key) === tail) resolveChains.delete(key);
  });
  return run;
}

async function resolveObligationLocked(input: ResolveInput): Promise<CompensationObligation> {
  const key = `${input.tenantId}::${input.inverseActionId}`;
  // ADR 0554 P4 — the transition is now a CROSS-INSTANCE CAS. Every check below
  // runs INSIDE the retry, against the row the swap will be conditioned on, so a
  // losing concurrent operator re-reads and throws the typed stale-view /
  // illegal-transition error rather than applying a second inverse. The
  // in-process `withObligationLock` remains, but as an OPTIMISATION for the
  // common same-instance path — it is no longer the guarantee.
  return mutateObligationWithCas(
    key,
    (row) => {

      // ADR 0554 P3 — the stale-view precondition, checked FIRST and now inside
      // the CAS retry. It must precede every other check and every write: the
      // loser of a concurrent operator race has to fail here, before the recovery
      // applier has appended anything, or two audit entries would exist for one
      // applied action.
      if (input.expectedState !== undefined && row.state !== input.expectedState) {
        throw new CompensationStaleViewError(input.expectedState, row.state, input.inverseActionId);
      }

      if (!canTransition(row.state, input.to)) {
        throw new CompensationTransitionError(row.state, input.to, input.inverseActionId);
      }
      if (input.to !== 'completed' && !input.reason?.trim()) {
        throw new Error(`compensation state '${input.to}' requires a reason (${input.inverseActionId})`);
      }

      const at = (input.now ?? (() => new Date().toISOString()))();
      const next: CompensationObligation = {
    ...row,
    state: input.to,
    attempts: input.attempts ?? row.attempts + 1,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.startedBy !== undefined ? { startedBy: input.startedBy } : {}),
    ...(input.waiveApprovalId !== undefined ? { waiveApprovalId: input.waiveApprovalId } : {}),
    // APPENDED, never replaced — every applied recovery action stays witnessed.
    ...(input.recoveryAuditSeq !== undefined
      ? { recoveryAuditSeqs: [...(row.recoveryAuditSeqs ?? []), input.recoveryAuditSeq] }
      : {}),
        updatedAt: at,
      };
      return { next, result: { next, from: row.state, effectKind: row.effectKind, runId: row.runId } };
    },
    () => {
      throw new Error(`compensation obligation not found: ${input.inverseActionId}`);
    },
  ).then(({ next, from, effectKind, runId }) => {
    log.info('compensation_obligation_resolved', {
      runId, effectKind, from, to: input.to, attempts: next.attempts,
    });
    // ADR 0556 P1. After the transition is durable and legal: an illegal
    // transition throws above and is a BUG, not an unwind outcome, so counting it
    // as one would inflate the very number an operator uses to decide whether a
    // partial unwind needs a human.
    //
    // MOVED OUT of the mutate callback by ADR 0554 P4, and that placement is
    // load-bearing: the callback re-runs on every lost CAS, so emitting there
    // would count ATTEMPTS instead of transitions — the precise failure the
    // original comment warned about when this sat inside `withObligationLock`.
    // It now fires exactly once per SWAP THAT LANDED, which is the only event
    // that is a real transition.
    //
    // AND IT IS GUARDED, because it now runs AFTER a durable write. `addCount`
    // can throw — `specFor` on an unknown metric name, and an explicit throw on
    // a kind mismatch. Both are programmer errors rather than runtime
    // conditions, but the consequence here is out of proportion to the cause: an
    // exception at this point would reject a transition that has ALREADY
    // COMMITTED, and a caller that retries on it re-attempts an applied
    // transition, loses the CAS, and reports a conflict that never happened. A
    // failed metric must never turn a successful refund-reversal into a reported
    // failure. (The hazard predates this change — the emit sat after `rows.put`
    // before — but moving it into a continuation is what made it guardable.)
    try {
      recordCompensationResolved(effectKind, input.to);
    } catch (err) {
      log.warn('compensation_metric_emit_failed', {
        runId, effectKind, to: input.to, error: err instanceof Error ? err.message : String(err),
      });
    }
    return next;
  });
}

/**
 * RFC 0151 §D's run-level rollup, derived rather than stored — a second stored
 * copy would be one more thing to keep in sync with the rows that are the truth.
 *
 * `partial` is the honest middle: SOME inverses completed and others did not.
 * Collapsing it to `failed` would erase that a refund did go through; collapsing
 * it to `completed` would claim an unwind that half-happened.
 */
export async function compensationStatusForRun(tenantId: string, runId: string): Promise<CompensationStatus> {
  return foldCompensationStatus(await obligationsForRun(tenantId, runId));
}

/**
 * The same fold over a whole sub-run TREE (ADR 0554 P2) — what a run's snapshot
 * would report once the §A advert lands. A parent run whose child committed the
 * only compensable effect must not read `none`: the effect happened inside the
 * parent's execution and the operator is asking about the parent.
 */
export async function compensationStatusForRunTree(
  tenantId: string,
  rootRunId: string,
): Promise<CompensationStatus> {
  return foldCompensationStatus(await obligationsForRunTree(tenantId, rootRunId));
}

/**
 * The §D rollup for MANY runs in ONE pass — what `RunSnapshot.compensationStatus`
 * is projected from (ADR 0554 wire flip).
 *
 * WHY A BATCH FUNCTION AND NOT A LOOP. `obligationsForRunTree` does a full
 * `rows.list()` per call, so projecting a 200-run page one run at a time is 200
 * full-collection scans on a route that already had an O(tenant) scan incident
 * (the 2026-07-14 silent board: a per-run sibling scan blew the 30s statement
 * timeout and 500ed EVERY snapshot read). One scan, folded per run, keeps the
 * new wire field off that path entirely.
 *
 * WHY A ROW COUNTS FOR TWO RUNS. `compensationOrdinal` is allocated from one
 * counter per ROOT, so a sub-run's obligation carries the ROOT's `rootRunId`.
 * A fold keyed only on the root would report `none` for the sub-run's own
 * snapshot — a run that committed a compensable effect claiming it owed nothing.
 * A fold keyed only on `runId` would report `none` for a parent whose child
 * committed the only effect, which is the case `compensationStatusForRunTree`
 * exists to fix. So a row is bucketed under BOTH its root and its own run, and
 * each run reads the fold of what it is accountable for: a root sees its whole
 * tree, a sub-run sees its own rows. A root's own rows have `rootOf(r) ===
 * r.runId` and are bucketed once, not twice.
 *
 * A run with no rows folds to `none` — the §D value for "no compensation was
 * ever requested for that run", which an advertising host MUST still emit.
 */
export async function compensationStatusForRuns(
  tenantId: string,
  runIds: readonly string[],
): Promise<Map<string, CompensationStatus>> {
  const buckets = new Map<string, CompensationObligation[]>();
  for (const id of runIds) if (!buckets.has(id)) buckets.set(id, []);
  if (buckets.size === 0) return new Map();

  // `listByPrefix`, not `list()`. Row ids are `${tenantId}::${inverseActionId}`,
  // so a storage-level prefix scan is BOUNDED to this tenant's slice — which
  // matters because the advert puts this on `GET /v1/runs/{runId}`, the read
  // path whose O(tenant) sibling scan blew the 30s statement timeout and 500ed
  // every snapshot read on 2026-07-14. A `list()` here would grow with every
  // tenant's obligations forever.
  //
  // Deliberately NOT `listForTenantIndexed`: that reads marker rows, and a
  // missing marker is documented as "delayed, not lost" — acceptable for
  // retention, NOT for a status. A dropped obligation makes `completed` true by
  // omission, which is the one wrong answer that looks like the right one. The
  // `::` separator makes the prefix exact, so this is index-free AND complete.
  //
  // The in-memory tenant check below is REDUNDANT given that prefix, and is
  // labelled as such rather than counted as a guard: MEASURED — deleting it
  // alone leaves every test green, because the prefix already scopes. What the
  // tenant-scoping test actually catches is reverting to `list()` (both removed
  // ⇒ red), and what catches the prefix silently matching nothing is the row key
  // shape itself (changing `idOf` reds six ordering/adversary legs). It stays
  // because it costs nothing and states the invariant where a reader will look
  // for it — not because it is load-bearing.
  for (const r of await rows.listByPrefix(`${tenantId}::`)) {
    if (r.tenantId !== tenantId) continue;
    const root = rootOf(r);
    buckets.get(root)?.push(r);
    if (r.runId !== root) buckets.get(r.runId)?.push(r);
  }

  const out = new Map<string, CompensationStatus>();
  for (const [id, list] of buckets) out.set(id, foldCompensationStatus(list));
  return out;
}

/**
 * Stamp every row of a run tree with the moment its plan was requested.
 *
 * Called once, where `compensation.requested` is emitted — the point §C calls
 * "the plan is READ and frozen". Idempotent: a row that already carries a stamp
 * keeps its original one, so a crash-resume that re-reads the plan does not
 * rewrite history.
 */
export async function markPlanRequested(tenantId: string, rootRunId: string, at: string): Promise<void> {
  for (const row of await obligationsForRunTree(tenantId, rootRunId)) {
    if (row.planRequestedAt !== undefined) continue;
    await rows.put({ ...row, planRequestedAt: at });
  }
}

function foldCompensationStatus(list: readonly CompensationObligation[]): CompensationStatus {
  if (list.length === 0) return 'none';

  // §D, first row of the table: `none` = "No `compensation.requested` has been
  // recorded for the run."
  //
  // Obligations are minted when a forward effect COMMITS, not when an unwind is
  // triggered, so a perfectly healthy run that executed a node carrying a
  // `compensation` declaration owns a full set of `requested` rows and always
  // will. Reading row state alone, that is indistinguishable from a plan that
  // was requested and has not started — and the fold called both `pending`, so
  // every such run advertised an unwind "about to start" that would never come.
  // On the deployed origin, on an advertised capability.
  //
  // `planRequestedAt` is the fact §D actually asks about. Note this is NOT the
  // same as "the run failed": a run can fail with no trigger admitted by its
  // policy, and then nothing was requested and `none` is still the honest
  // answer. Conversely a requested plan that never starts stays `pending`,
  // which is what keeps a stranded unwind visible instead of hidden.
  // Guarded by "and nothing has moved", which matters twice.
  //
  // MIGRATION: rows minted before this field existed carry no stamp. A bare
  // `!stamped -> none` would have re-read every in-flight and completed unwind
  // in production as `none` — a plan that ran would report as one that never
  // started, which is a worse lie than the one being fixed. Any row past
  // `requested` is proof the plan was requested, stamp or not, so those fall
  // through to the state machine below and legacy rows need no backfill.
  //
  // It is also what the first draft got wrong here: the early return sat above
  // the state checks and turned eight existing tests red, including the
  // ADVERSARY crash-resume legs. The tests were right.
  const anyProgress = list.some((r) => r.state !== 'requested');
  if (!anyProgress && !list.some((r) => r.planRequestedAt !== undefined)) return 'none';

  const done = list.filter((r) => r.state === 'completed').length;
  // RFC 0151 UQ4 (resolved 2026-08-16) — an `irreversibleEffect` entry can never
  // complete, so a plan containing one can never reach `completed`. §D:
  // "A plan containing an `irreversible` entry (§B/§C) can never reach this
  // value", and `compensation.md` caps such a rollup at `partial`.
  //
  // The cap is checked BEFORE the all-completed test, not after, and that order
  // is the whole fix: an irreversible row sits in a non-`completed` state
  // forever, so `done === list.length` is unreachable while one exists — UNLESS
  // some future code marks it completed to tidy the plan up, at which point the
  // run would report a full unwind for an effect that by definition was never
  // undone. Checking first makes the lie unreachable rather than merely unlikely.
  const irreversible = list.filter((r) => r.shape === 'irreversible');
  if (irreversible.length > 0) {
    // `manual` still outranks the cap while unresolved: an operator is being
    // asked for something, and that is more urgent than the shape of the
    // ceiling.
    if (list.some((r) => r.state === 'manual_intervention_required')) return 'manual';
    if (list.some((r) => r.state === 'started')) return 'running';
    // `pending` is decided by the rows that CAN still move.
    //
    // An irreversible row is `requested` forever — the unwind never claims it,
    // because there is nothing to invoke — so a naive "every row is `requested`
    // ⇒ pending" reports `pending` for a plan that will never move again. That
    // is a run parked at "about to start" permanently, which is worse than
    // either honest terminal value: an operator waits for a transition that
    // cannot come. So the test asks only about the rows that have a next state.
    const movable = list.filter((r) => r.shape !== 'irreversible');
    if (movable.length > 0 && movable.every((r) => r.state === 'requested')) return 'pending';
    // Some completed and at least one never can: `partial` is the honest
    // ceiling. Nothing completed at all: `failed`, and the irreversible entry is
    // why it could not have been anything else.
    return done > 0 ? 'partial' : 'failed';
  }
  if (done === list.length) return 'completed';
  if (list.some((r) => r.state === 'manual_intervention_required')) return 'manual';
  if (list.some((r) => r.state === 'started')) return 'running';
  // Something finished but not everything — say so rather than rounding.
  if (done > 0) return 'partial';
  if (list.every((r) => r.state === 'requested')) return 'pending';
  if (list.some((r) => r.state === 'failed')) return 'failed';
  return 'pending';
}

/**
 * ADR 0464 — the store-level `SubjectEraser` for compensation obligations.
 *
 * REDACT, DO NOT DELETE. The row is an audit fact — "an inverse was owed for
 * this effect, and here is what happened to it" — and RFC 0151 §E requires every
 * override to be audited. Deleting the row on a DSAR would erase the evidence
 * that a refund was owed and, worse, make `compensationStatusForRun` report
 * `completed` for a run whose unwind never finished: removing an unresolved
 * obligation silently satisfies the "all done" condition.
 *
 * So the subject-bearing FIELD is cleared and the skeleton stays. The only such
 * field is `reason` — free text an operator writes ("refund for jane@…"),
 * which is exactly where subject data lands. Everything else is ids, digests,
 * ordinals and enums: `resultDigest`/`contractDigest` are one-way hashes, and
 * `forwardLogicalInvocationId` is a host-minted opaque id.
 *
 * Erasure is TENANT-SCOPED, matching how the ledger is keyed. There is no
 * per-subject attribution on an obligation — a run belongs to a tenant, not to a
 * user — so a subject erasure within a tenant clears the free-text field on that
 * tenant's rows rather than trying to guess which obligation was "theirs".
 * Guessing would either miss rows or destroy another subject's audit trail.
 */
export async function eraseCompensationSubject(tenantId: string, _subjectKey: string): Promise<number> {
  let redacted = 0;
  for (const r of await rows.list()) {
    if (r.tenantId !== tenantId || r.reason === undefined) continue;
    await rows.put({ ...r, reason: '[redacted: subject erasure]' });
    redacted += 1;
  }
  if (redacted > 0) log.info('compensation_obligations_redacted', { tenantId, redacted });
  return redacted;
}

/** ADR 0464 — called from `registerHostSubjectErasers()` (one explicit boot list). */
export function registerCompensationErasure(): void {
  registerSubjectEraser(async function eraseCompensation(tenantId, subjectKey) {
    await eraseCompensationSubject(tenantId, subjectKey);
  });
}

/** Test seam — drops every row. */
export async function _resetCompensationLedgerForTest(): Promise<void> {
  for (const r of await rows.list()) await rows.delete(`${r.tenantId}::${r.inverseActionId}`);
}
