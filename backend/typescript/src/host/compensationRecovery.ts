/**
 * ADR 0554 P3 — the ONE applier for an operator recovery action (RFC 0151 §E).
 *
 * `host/compensationOperator.ts` decides WHETHER an actor may act on a plan
 * (tenant binding + the RFC 0049 `authorization.decided` record). This module
 * decides WHAT HAPPENS when they do, and owns the three things that only work
 * when they are held together:
 *
 *   1. the ACTION -> SCOPE map (there is exactly one, here);
 *   2. the per-obligation critical section spanning read -> audit -> write;
 *   3. the audit-first ordering that makes an unaudited action unreachable.
 *
 * ── WHY THE SCOPE MAP LIVES HERE AND NOT IN THE ROUTE ─────────────────────
 *
 * The route enforces it, but if the route also DEFINED it, a second caller (the
 * §21 seam, a future admin CLI) would define its own and the two would drift —
 * the "five copies of one authorization-relevant string" failure
 * `accessControlService.ts` already records for `x-openwop-act-as`. The route
 * asks this module which scope an action needs and then requires exactly that.
 *
 * ── THE THREE PERMISSIONS, AND WHY `substitute` IS A WAIVE ────────────────
 *
 * `:start` and `:retry` run the inverse the workflow AUTHOR declared. `:waive`
 * is the AUTHORED-CONTRACT-OVERRIDE permission and covers every act that departs
 * from the §B declaration: `skip`/`terminate` (decline to undo) and `substitute`
 * (undo by other means). `substitute` runs an ARBITRARY registered `nodeTypeId`
 * under the obligation's §C identity — an effect the author never declared,
 * presenting the same downstream idempotency key — so it is strictly ≥ a waive
 * in authority. Filing it under `:retry` would have put that on the admin rung.
 *
 * ── ORDERING: AUDIT FIRST, AND THE ENTRY IS A REQUEST ─────────────────────
 *
 * Append the audit entry, then pass its seq into the ledger write as a REQUIRED
 * input. A state change with no audit record is then structurally unreachable.
 * The reverse — an entry whose action never landed — is over-recording, and the
 * payload says `requestedState` rather than `nextState` precisely so that a
 * crash in the window leaves a record of what was ASKED FOR, not a fabricated
 * outcome. The row's `recoveryAuditSeqs` witnesses which entries actually
 * applied; membership is exact, so `recorded, not applied` is a fact the read
 * model derives rather than a guess.
 *
 * ── WHAT IS AND IS NOT CLAIMED ABOUT CONCURRENCY ──────────────────────────
 *
 * WITHIN ONE INSTANCE, exactly one of two concurrent actions on an obligation
 * applies; the loser gets `version_conflict` (409). Across INSTANCES the ledger
 * still has no conditional write — the same limit `compensationLedger.ts` and
 * ADR 0554 P2 already state at the seam. Not narrowed, not widened.
 *
 * Note the state machine would NOT have caught the duplicate on its own:
 * `LEGAL.failed` includes `failed`, so two concurrent waives are both LEGAL
 * transitions. The precondition is checked against the state the OPERATOR SAW,
 * which is the true reason a loser must be refused.
 *
 * @see docs/adr/0554-compensation-saga-and-operator-recovery-runtime.md
 * @see host/compensationOperator.ts
 */

import type { Scope } from './accessControlService.js';
import {
  CompensationStaleViewError,
  attachWaiveApproval,
  getObligation,
  resolveObligationWithinSection,
  withObligationCriticalSection,
  WAIVE_APPROVAL_SUFFIX,
  type CompensationObligation,
  type CompensationState,
} from './compensationLedger.js';
import {
  appendRecoveryAudit,
  type CompensationRecoveryAction,
} from './compensationRecoveryAudit.js';
import { createCompensationApproval, getApproval } from './approvalService.js';
import { OpenwopError } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { recordCompensationRecovery } from '../observability/metricSeams.js';

const log = createLogger('host.compensationRecovery');

/**
 * THE ACTION -> SCOPE MAP. One copy, exhaustive over the action union, so adding
 * an action without deciding its permission is a COMPILE error rather than a
 * route that silently admits it under whatever scope happened to be checked.
 */
const ACTION_SCOPE: Readonly<Record<CompensationRecoveryAction, Scope>> = {
  start: 'host:compensation:start',
  retry: 'host:compensation:retry',
  skip: 'host:compensation:waive',
  terminate: 'host:compensation:waive',
  substitute: 'host:compensation:waive',
};

export function scopeForRecoveryAction(action: CompensationRecoveryAction): Scope {
  return ACTION_SCOPE[action];
}

/**
 * The actions that DEPART from the authored §B contract, and therefore require a
 * recorded justification. Derived from the scope map rather than re-listed, so
 * the two can never disagree about which acts are overrides.
 */
export function requiresJustification(action: CompensationRecoveryAction): boolean {
  return ACTION_SCOPE[action] === 'host:compensation:waive';
}

/**
 * The actions that ABANDON the inverse rather than attempt it. `substitute`
 * overrides the contract but still tries to undo, so it is NOT a waive for the
 * purposes of the approval gate — gating it there would demand human sign-off to
 * do MORE undoing, which inverts what the gate is for.
 */
function isWaive(action: CompensationRecoveryAction): boolean {
  return action === 'skip' || action === 'terminate';
}

/**
 * Is this obligation HIGH-RISK for the purposes of the waive approval gate?
 *
 * ONE recorded, AUTHORED fact: the §B `requiresApproval` declaration. If the
 * author said a human must sign off before this inverse RUNS, then declaring it
 * will never run needs at least as much authority.
 *
 * `effectKind === 'payment'` was CONSIDERED AND REJECTED. It is precisely the
 * host heuristic this ADR forbids elsewhere — P2's own rule is "WHICH FAILURES
 * QUALIFY is read from the policy, never a host heuristic", and "payments are
 * high-risk" is that same move with a different noun. The consequence is named
 * rather than hidden: a payment obligation declared `requiresApproval: false` is
 * waivable by an owner with scope + reason + audit and no approval. The
 * instrument for changing that is a §B field (`waiveRequiresApproval`), which is
 * an RFC 0151 revision in `../openwop` — recorded as the ask in the ADR, not
 * invented here.
 */
export function isHighRiskWaive(o: CompensationObligation, action: CompensationRecoveryAction): boolean {
  if (!isWaive(action)) return false;
  // RFC 0151 §B (S36) — the row carries the EFFECTIVE value, already resolved at
  // mint (post-policy-escalation), so it is the answer rather than an input.
  //
  // A row minted BEFORE S36 has no stamp; falling back to `requiresApproval` is
  // exactly the pre-S36 behaviour, which is the honest degradation — the
  // alternative (`?? false`) would silently UN-GATE every obligation already in
  // the ledger the moment this shipped.
  return o.waiveRequiresApproval ?? o.requiresApproval === true;
}

/** The state each action drives the obligation toward. */
function requestedStateFor(action: CompensationRecoveryAction): CompensationState {
  // `start`/`retry`/`substitute` re-enter the unwind, which moves the row to
  // `started` itself; the applier records that as the requested state so the
  // audit entry says what was asked for. `skip`/`terminate` resolve to `failed`
  // WITH a reason — RFC 0151 §E's "terminate as uncompensated", which P1 chose
  // over minting a separate skipped state.
  return isWaive(action) ? 'failed' : 'started';
}

export interface RecoveryActionInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly obligationId: string;
  readonly action: CompensationRecoveryAction;
  /** The acting principal — opaque (RFC 0048). */
  readonly actor: string;
  /** The state the operator SAW. Required: without it the loser of a concurrent
   *  race cannot be identified, and `LEGAL.failed -> failed` means the state
   *  machine will not identify it either. */
  readonly expectedState: CompensationState;
  /** Required for every override action (`requiresJustification`). */
  readonly reason?: string;
  /** Runs the actual unwind for the non-waive actions. Injected so this module
   *  stays free of the executor/registry graph the runtime carries, and so a
   *  test can count INVOCATIONS PER IDENTITY rather than trusting a row. */
  readonly resume?: () => Promise<void>;
}

export type RecoveryActionResult =
  | { readonly outcome: 'applied'; readonly state: CompensationState; readonly auditSeq: number }
  /** A high-risk waive is parked behind an approval and has NOT been applied. */
  | { readonly outcome: 'approval-pending'; readonly approvalId: string };

/**
 * Apply one recovery action.
 *
 * PRECONDITION: the caller has already run `decideCompensationOperatorAction`
 * (tenant binding + the `authorization.decided` record) and enforced
 * `scopeForRecoveryAction(action)`. This function does not re-derive authority —
 * one owner per question — but it DOES fail closed on everything it owns.
 */
export async function applyRecoveryAction(input: RecoveryActionInput): Promise<RecoveryActionResult> {
  const { tenantId, obligationId, action, actor } = input;

  if (requiresJustification(action) && !input.reason?.trim()) {
    recordCompensationRecovery(action, 'denied');
    throw new OpenwopError(
      'validation_error',
      `'${action}' overrides the authored compensation contract and requires a non-empty reason.`,
      400,
      { retriable: false, action },
    );
  }

  // ONE critical section across read -> audit -> write. See the module header:
  // splitting it lets a second operator fork the obligation's audit slice.
  return withObligationCriticalSection(tenantId, obligationId, async () => {
    const row = await getObligation(tenantId, obligationId);
    if (!row) {
      // Tenant-prefixed key ⇒ another tenant's obligation reads as absent. The
      // route answers 404 for both, so this never becomes an existence oracle.
      throw new OpenwopError('not_found', 'compensation obligation not found', 404, { retriable: false });
    }

    // ── THE OBLIGATION MUST BELONG TO THE RUN IT IS ACTED ON THROUGH ────────
    //
    // FOUND BY CODE REVIEW, after the first round of tests missed it.
    // `getObligation` keys on (tenant, obligationId) alone, so without this an
    // operator could name run B — the run the RFC 0049 `authorization.decided`
    // record is written against — while actually moving an obligation belonging
    // to run A. Same tenant, so not a tenant-isolation break; it is an
    // ATTRIBUTION break, and an audit trail that attributes an act to the wrong
    // run is worse than one that is merely thin.
    //
    // Checked against the run TREE and not `row.runId`, because a SUB-RUN's
    // obligation legitimately belongs to its ROOT's plan (ordinals come from one
    // counter per root, ADR 0554 P2) and an operator acts on the root. Comparing
    // `row.runId` alone would refuse every sub-run inverse — a correctness bug
    // dressed as a security fix.
    //
    // Answers 404, identical to an obligation that does not exist: which of the
    // two it was is not a fact the caller is entitled to.
    const inTree = row.runId === input.runId || row.rootRunId === input.runId;
    if (!inTree) {
      log.warn('compensation_recovery_obligation_run_mismatch', {
        namedRunId: input.runId, obligationRunId: row.runId, action,
      });
      throw new OpenwopError('not_found', 'compensation obligation not found', 404, { retriable: false });
    }

    // The stale-view precondition is ALSO enforced inside `resolveObligation`,
    // but it has to be checked HERE too and BEFORE the audit append: the loser
    // of a race must fail before it writes anything, or two audit entries would
    // exist for one applied action.
    if (row.state !== input.expectedState) {
      recordCompensationRecovery(action, 'conflict');
      throw new OpenwopError(
        'version_conflict',
        `This obligation moved to '${row.state}' since you loaded it; re-read the timeline and retry.`,
        409,
        { retriable: false, expectedState: input.expectedState, actualState: row.state },
      );
    }

    // ── the high-risk waive gate, composed onto the EXISTING approvals surface
    if (isHighRiskWaive(row, action)) {
      const parked = await gateHighRiskWaive(row, input);
      if (parked) return parked;
    }

    const requestedState = requestedStateFor(action);

    // ── AUDIT FIRST. The seq is a required input to the write below, so a state
    //    change the chain does not record is unreachable.
    const { seq } = await appendRecoveryAudit({
      tenantId,
      obligationId,
      runId: input.runId,
      action,
      actor,
      requiredScope: ACTION_SCOPE[action],
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      priorState: row.state,
      requestedState,
    });

    try {
      if (isWaive(action)) {
        const next = await resolveObligationWithinSection({
          tenantId,
          inverseActionId: obligationId,
          to: 'failed',
          expectedState: input.expectedState,
          reason: `operator ${action}: ${input.reason ?? ''}`.trim(),
          recoveryAuditSeq: seq,
        });
        recordCompensationRecovery(action, 'applied');
        return { outcome: 'applied' as const, state: next.state, auditSeq: seq };
      }

      // start / retry / substitute — the unwind itself moves the rows, so the
      // witness is stamped first and the resume runs after. A resume that throws
      // leaves the row witnessed at `started`, which is the truth: the action
      // was authorized, recorded and begun.
      const next = await resolveObligationWithinSection({
        tenantId,
        inverseActionId: obligationId,
        to: 'started',
        expectedState: input.expectedState,
        reason: `operator ${action}`,
        startedBy: actor,
        recoveryAuditSeq: seq,
      });
      if (input.resume) await input.resume();
      recordCompensationRecovery(action, 'applied');
      return { outcome: 'applied' as const, state: next.state, auditSeq: seq };
    } catch (err) {
      if (err instanceof CompensationStaleViewError) {
        recordCompensationRecovery(action, 'conflict');
        throw new OpenwopError(
          'version_conflict',
          `This obligation moved to '${err.actual}' since you loaded it; re-read the timeline and retry.`,
          409,
          { retriable: false, expectedState: err.expected, actualState: err.actual },
        );
      }
      throw err;
    }
  });
}

/**
 * RFC 0151 §E — park a high-risk waive behind the EXISTING approval gate.
 *
 * Re-entrant on the obligation's own waive approval: a second request reads the
 * open card rather than minting another. Without that, every retry of a parked
 * waive would raise a fresh approval and deciding one would leave the rest open.
 *
 * The approval's `compensationId` is suffixed `#waive` so it can never collide
 * with the UNWIND's own §B gate on the same obligation. They are opposite
 * decisions — run the inverse vs. abandon it — and a shared identity would let a
 * decision on one read as a decision on the other.
 */
async function gateHighRiskWaive(
  row: CompensationObligation,
  input: RecoveryActionInput,
): Promise<{ outcome: 'approval-pending'; approvalId: string } | null> {
  const existing = row.waiveApprovalId ? await getApproval(row.waiveApprovalId) : null;

  if (existing?.status === 'approved') return null; // proceed; SoD was enforced at decide time
  if (existing?.status === 'rejected') {
    recordCompensationRecovery(input.action, 'denied');
    throw new OpenwopError(
      'forbidden',
      `The waive of this obligation was rejected (approval ${existing.approvalId}).`,
      403,
      { retriable: false, approvalId: existing.approvalId },
    );
  }

  const approval = existing ?? (await createCompensationApproval({
    tenantId: row.tenantId,
    runId: input.runId,
    workflowId: '',
    compensationId: `${row.inverseActionId}${WAIVE_APPROVAL_SUFFIX}`,
    ...(row.nodeId !== undefined ? { nodeId: row.nodeId } : {}),
    compensationNodeTypeId: row.compensationNodeTypeId ?? '(none)',
    // The WAIVE REQUESTER. The SoD check excludes them AND `startedBy` — see
    // `registerCompensationApprovalEligibility`.
    requestedBy: input.actor,
    proposal:
      `Waive the inverse action for node '${row.nodeId ?? '(unknown)'}' of run ${input.runId}. ` +
      `The committed effect will remain in place and will NOT be undone. ` +
      `Reason given: ${input.reason ?? '(none)'}`,
  }));

  if (!existing) await attachWaiveApproval(row.tenantId, row.inverseActionId, approval.approvalId);

  log.info('compensation_waive_parked_for_approval', {
    runId: input.runId, approvalId: approval.approvalId, action: input.action,
  });
  recordCompensationRecovery(input.action, 'pending');
  return { outcome: 'approval-pending', approvalId: approval.approvalId };
}
