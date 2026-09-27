/**
 * ADR 0554 P2 — the reverse-completion unwind: retries, the approval gate, and
 * dead-letter parking.
 *
 * P1 built the durable ledger (`host/compensationLedger.ts`) and stopped there,
 * deliberately: it recorded what was owed and had no consumer. This module is
 * the consumer. It claims obligations in RFC 0151 §A `reverse-completion`
 * order, invokes each declared inverse action with the §C retry-stable
 * identity, records the §D events, and leaves whatever it could not discharge
 * as durable rows an operator can read.
 *
 * ── BUILT TO RFC 0151 + `spec/v1/compensation.md`, NOT TO ADR 0554's SKETCH ──
 *
 * Two rules are easy to break by reading the ADR alone, and both are pinned by
 * tests:
 *
 *   1. `RunStatus` NEVER gains `compensating`. §D keeps the forward `status`
 *      untouched and adds a separate `compensationStatus` rollup. A run is
 *      routinely `status: failed` AND `compensationStatus: completed` — that is
 *      the SUCCESSFUL outcome of an unwind, not a contradiction. `RunStatus` is
 *      a closed union exported by the wire package, so widening it was never
 *      host-local work.
 *   2. The six `compensation.*` types are emitted as STRINGS against the run
 *      event log (`executor/eventLog.ts` takes `type: string`) and validated by
 *      the corpus's `run-event.schema.json`. The pinned SDK has no typed union
 *      for them and this phase does not wait for one.
 *
 * ── WHAT THIS PHASE DOES NOT DO, ON PURPOSE ────────────────────────────────
 *
 * It does NOT advertise `capabilities.compensation`, and it does NOT put
 * `compensationStatus` on `RunSnapshot`. `compensation.md` §D makes those two a
 * PAIR — "a host that does not advertise MUST omit the field; a host that
 * advertises MUST carry it" — so shipping either alone is a wire lie in one
 * direction or the other. They land together with the removal of the
 * `openwop-compensation` opt-out, in one commit, once the behavioural witness
 * has run under the active deployment profile.
 * `test/agrade-wire-blocked-residue.test.ts` fires if that pair is broken.
 *
 * ── THE PLAN IS THE LEDGER ─────────────────────────────────────────────────
 *
 * §C: "the host MUST persist a compensation plan before executing its first
 * inverse action", because the crash is exactly when resumption matters. Here
 * the plan is not a second document — it is the set of obligation rows, which
 * were already durable at forward-commit time. `compensation.requested` is
 * emitted when the plan is READ and frozen, strictly before the first
 * `compensation.started`; a crash between them resumes from the same rows and
 * re-derives the same order, because the ordinals are durable too.
 *
 * ── A SPEC INCONSISTENCY, RECORDED RATHER THAN PAPERED OVER ────────────────
 *
 * `compensation.md` §D says `compensation.paused` "carries a closed `reason`",
 * but the closed vocabulary is `retries-exhausted | approval-denied |
 * authority-denied | dead-lettered | operator-terminated` — every member is a
 * terminal or denial outcome, and NONE of them names the ordinary case: paused
 * because an approval is OPEN and no one has decided yet. `approval-denied`
 * would assert a decision that has not been made.
 *
 * The payload schema leaves `reason` OPTIONAL, so the honest emission is
 * `compensation.paused` with no `reason` while the approval is pending, and the
 * operator-legible detail on the LEDGER row's free-text `reason` — which is
 * host-local and therefore the right home for an open string that §D/§G forbid
 * on the wire. Reported upstream with this phase.
 */

import { createLogger } from '../observability/logger.js';
import {
  type CompensationObligation,
  type CompensationStatus,
  CompensationTransitionError,
  attachApproval,
  compensationStatusForRunTree,
  digestOf,
  obligationsForRunTree,
  resolveObligation,
} from './compensationLedger.js';
import { COMPENSATION_ORDERING_MODEL } from './compensationCapability.js';

const log = createLogger('host.compensationUnwind');

/**
 * RFC 0151 §A. The MANDATORY ordering model, and the only one this host
 * implements — `dependency-graph` is the optional second model and claiming it
 * without a DAG walk would be an advert we could not honour.
 *
 * MOVED to `host/compensationCapability.ts` (ADR 0554 wire flip) and re-exported
 * here. The advert at `capabilities.compensation.orderingModels` and the sort
 * this module performs are now the SAME value, so an advert claiming an ordering
 * the unwind does not run is not expressible.
 */
export { COMPENSATION_ORDERING_MODEL };

/**
 * The FALLBACK retry budget for ONE inverse action — used only when no policy
 * is attached.
 *
 * ── CORRECTED 2026-08-16: this constant is no longer the source ────────────
 *
 * It shipped as "ONE constant, in ONE place, because the eventual source of
 * truth is not the host: `schemas/compensation-policy.schema.json` … That
 * schema is being authored now and its attach point is undecided." The attach
 * point IS decided (`openwop#1009`): `settings.compensation` on
 * `WorkflowDefinition`, with a `retry` block of exactly this shape.
 *
 * So the precedence is now, strongest first:
 *
 *   1. the NODE's own §B `compensation.retry` — a node's bounds always win,
 *      because the policy "MUST NOT weaken a node's own declaration";
 *   2. the workflow's `settings.compensation.retry`;
 *   3. this constant.
 *
 * It stays because a workflow may carry node-level declarations with NO policy
 * — the policy key is optional and, on a host that does not advertise the
 * family, refused outright — and a host with no default at all would have to
 * invent one at failure time.
 */
export const COMPENSATION_DEFAULT_RETRY = { maxAttempts: 3, backoffMs: 1000 } as const;

/**
 * RFC 0151 §B — the workflow-level policy, carried at `settings.compensation`
 * (`compensation-policy.schema.json`). Mirrors the closed schema field for
 * field; nothing host-private may be added.
 *
 * Node declarations say WHAT the inverse action is; this says WHEN the host
 * starts an unwind and HOW it runs one. It is AUTHORED, never per-run: the
 * schema is explicit that there is no run-options overlay, "because a per-run
 * caller who could lower approval scope or drop a trigger would be authorizing
 * their own unwind".
 */
export interface CompensationPolicy {
  readonly triggers: readonly CompensationTrigger[];
  readonly profileVersion?: string;
  readonly orderingModel?: 'reverse-completion' | 'dependency-graph';
  readonly retry?: { maxAttempts?: number; backoffMs?: number };
  readonly timeoutMs?: number;
  readonly exhaustedDisposition?: 'record-outcome' | 'manual-intervention';
  readonly approvalScope?: 'declared' | 'all';
  readonly onParentCancel?: 'continue' | 'pause' | 'manual';
}

/** Which events start an unwind (closed). */
export type CompensationTrigger = 'node-failure' | 'run-cancel' | 'cap-breach' | 'operator-request';

export const COMPENSATION_TRIGGERS: readonly CompensationTrigger[] = [
  'node-failure', 'run-cancel', 'cap-breach', 'operator-request',
];

/**
 * The triggers this host actually INITIATES an unwind for.
 *
 * RFC 0151 erratum (SP-11a): a host MUST refuse at registration a policy naming
 * a trigger it does not fire. Same disposition as the `orderingModel` check —
 * accepting a workflow that names something unimplemented defers the failure to
 * the worst possible moment, except worse here, because nothing fails at all:
 * the author configures compensation on `run-cancel`, believes committed
 * effects unwind when a run is cancelled, and they silently never do. A loud
 * `validation_error` at authoring time beats a quiet false promise about money
 * discovered during an incident.
 *
 * As of H58d this is the FULL vocabulary — every trigger fires — so the guard
 * currently refuses nothing. That is deliberate: what is pinned is the
 * INVARIANT, not today's capability. The day a fifth trigger is added, or one
 * of these regresses, this is the difference between a registration error and
 * an author believing in an unwind that never happens.
 *
 * Narrowing this list is therefore a WIRE-VISIBLE act: it starts refusing
 * workflows that register today.
 */
export const FIRED_COMPENSATION_TRIGGERS: readonly CompensationTrigger[] = [
  // executor.ts `finalizeRun` (default), via `compensationTriggerFor`
  'node-failure',
  // host/runCancel.ts `cancelRunAndCascade`
  'run-cancel',
  // executor.ts: run-duration cap + node-executions cap
  'cap-breach',
  // features/operations recovery `start`, gated on the policy naming it
  'operator-request',
];

/**
 * The trigger set assumed when NO policy is attached.
 *
 * `node-failure` only, and stated rather than left implicit: with a policy, an
 * unlisted trigger means "no unwind, `compensationStatus: none`" — no generic
 * rollback is inferred from an undeclared trigger. Without a policy the host
 * must still answer the question, and the narrowest honest answer is the one
 * case P2 actually implements. Widening this is a behaviour change, not a
 * default tweak.
 */
export const COMPENSATION_FALLBACK_TRIGGERS: readonly CompensationTrigger[] = ['node-failure'];

/** Does this policy (or the no-policy fallback) start an unwind for `trigger`? */
export function policyAdmitsTrigger(
  policy: CompensationPolicy | undefined,
  trigger: CompensationTrigger,
): boolean {
  return (policy?.triggers ?? COMPENSATION_FALLBACK_TRIGGERS).includes(trigger);
}

/** RFC 0151 §B — the CLOSED node-level declaration of an inverse action.
 *  Mirrors `workflow-definition.schema.json` `WorkflowNode.compensation`
 *  exactly; the block admits no host-private fields, so nothing may be added
 *  here that the wire schema would reject. */
export interface CompensationDeclaration {
  readonly nodeTypeId: string;
  readonly inputMapping?: Record<string, unknown>;
  readonly retry?: { maxAttempts?: number; backoffMs?: number };
  readonly requiresApproval?: boolean;
  /** RFC 0151 §B (S36) — see {@link effectiveWaiveRequiresApproval}. Never read
   *  raw: absent does NOT mean `false`. */
  readonly waiveRequiresApproval?: boolean;
}

/** The §D closed reason vocabulary. */
export type CompensationReason =
  | 'retries-exhausted'
  | 'approval-denied'
  | 'authority-denied'
  | 'dead-lettered'
  | 'operator-terminated';

/** One §D event, content-free by construction. `reason` is omitted where no
 *  closed code honestly applies (see the module header). */
export interface CompensationEvent {
  readonly type:
    | 'compensation.requested'
    | 'compensation.started'
    | 'compensation.completed'
    | 'compensation.failed'
    | 'compensation.paused'
    | 'compensation.manual_intervention_required';
  readonly nodeId?: string;
  readonly payload: {
    readonly compensationId: string;
    readonly nodeId?: string;
    readonly effectId?: string;
    readonly attempt: number;
    readonly orderingModel: typeof COMPENSATION_ORDERING_MODEL;
    readonly reason?: CompensationReason;
  };
}

/** The outcome of invoking ONE inverse action. A typed union, never
 *  success-with-empty: a compensator that could not run is a distinct answer
 *  from one that ran and refused. */
export type InverseOutcome =
  | { readonly ok: true }
  /** The inverse ran and failed. Retryable — compensation is itself an effect
   *  (P0 finding 2), so a transient refund failure must not burn the plan. */
  | { readonly ok: false; readonly retryable: true; readonly detail: string }
  /** The inverse cannot run at all here (unresolvable node type, missing
   *  authority). No retry can fix it; an operator must. */
  | { readonly ok: false; readonly retryable: false; readonly detail: string };

/** The approval gate's answer for ONE obligation (RFC 0151 §E). */
export type ApprovalOutcome =
  | { readonly decision: 'approved' }
  | { readonly decision: 'denied'; readonly detail: string }
  /** Raised and open. The unwind stops here; the run's own
   *  `status: waiting-approval` + interrupt carry the wait, and the rollup does
   *  NOT move (`compensation.md` §D, the `running` row). */
  | { readonly decision: 'pending'; readonly approvalId: string };

/**
 * Which RFC 0151 trigger a terminal outcome unwinds under.
 *
 * Extracted so the mapping is VERIFIED BY EXECUTION rather than by reading the
 * call sites. The run-duration cap's unwind cannot be driven deterministically
 * from a test — every attempt raced the machine, and a timing-dependent test for
 * a timing bug is worse than none — so without this the claim "the duration cap
 * unwinds under `cap-breach`" rested on inspection, and would have stopped being
 * true the first time someone reordered an argument, with nothing going red.
 *
 * The clock is untestable here; the DECISION is not. This is the decision.
 */
export type TerminalCause =
  | 'node-failure'
  | 'run-duration-cap'
  | 'node-executions-cap'
  | 'run-cancel'
  /** The sweeper gave up after `MAX_REDISPATCH_AGE_MS`. */
  | 'dispatch-abandoned'
  /** Inline dispatch failed before the run could execute. */
  | 'dispatch-failed';

export function compensationTriggerFor(cause: TerminalCause): CompensationTrigger {
  switch (cause) {
    // Both caps are the SAME trigger, and that is the substance of the fix: the
    // node-executions cap previously unwound under `node-failure`, so a policy
    // naming `cap-breach` did not fire on the breach it named.
    case 'run-duration-cap':
    case 'node-executions-cap':
      return 'cap-breach';
    case 'run-cancel':
      return 'run-cancel';
    // An age ceiling is a cap, and this is the one terminal path whose cause is
    // literally "we waited too long" — the same family as the duration cap, and
    // the closed §B vocabulary offers nothing nearer.
    case 'dispatch-abandoned':
      return 'cap-breach';
    // A dispatch that never delivered the run is a host-side failure of the
    // run's work. Usually nothing is minted (the run never executed), so this
    // matters only for a RESUMED run that had already committed effects.
    case 'dispatch-failed':
    case 'node-failure':
      return 'node-failure';
  }
}

export interface UnwindDeps {
  /** Execute one declared inverse action. */
  invoke(step: {
    obligation: CompensationObligation;
    declaration: CompensationDeclaration;
    attempt: number;
  }): Promise<InverseOutcome>;
  /** Append one §D event to the run's durable log. */
  appendEvent(event: CompensationEvent): Promise<void>;
  /**
   * Stamp the plan's rows with the moment it was requested, so §D's rollup can
   * tell a requested plan from a merely minted one.
   *
   * REQUIRED, not optional. The first draft made it optional so that a
   * report-only caller need not supply it — and the unwind test harness then
   * silently omitted it, leaving a plan that demonstrably ran reporting `none`.
   * A dependency whose absence changes a WIRE-VISIBLE status without any signal
   * is the failure shape this codebase keeps finding; making it required turns
   * every omission into a compile error instead.
   */
  markPlanRequested(tenantId: string, rootRunId: string, at: string): Promise<void>;
  /** RFC 0051 approval for a `requiresApproval` inverse. Absent ⇒ the host
   *  wires no approval surface for compensation, and a gated obligation is
   *  recorded `manual_intervention_required` rather than silently executed. */
  requestApproval?(step: {
    obligation: CompensationObligation;
    declaration: CompensationDeclaration;
  }): Promise<ApprovalOutcome>;
  /** Back-off between attempts. Injected so tests do not sleep and so a replay
   *  can collapse it to zero (wall-clock is never a determinism input). */
  sleep?(ms: number): Promise<void>;
}

export interface UnwindInput {
  readonly tenantId: string;
  /** The ROOT run. Its whole sub-run tree unwinds depth-first. */
  readonly runId: string;
  /** The RFC 0151 §B declarations, keyed `"<runId>::<nodeId>"` so a sub-run's
   *  node cannot shadow a parent node of the same id. */
  readonly declarations: ReadonlyMap<string, CompensationDeclaration>;
  /**
   * RFC 0151 §F. A replay/branch fork MUST use recorded outcomes and MUST NOT
   * re-fire inverse effects — "a replay that re-executes inverse effects turns
   * a recovery into a second outage". When true the plan is read and reported
   * and NOTHING is invoked.
   */
  readonly replaying?: boolean;
  /** RFC 0151 §B — the workflow's `settings.compensation`, when it carries one.
   *  Absent ⇒ the documented no-policy fallbacks apply. */
  readonly policy?: CompensationPolicy;
  readonly deps: UnwindDeps;
}

/**
 * One plan entry as the §21 recovery extension reports it
 * (`host-sample-test-seams.md` §21, "`unwind` response gains `inverseActions`").
 *
 * Reported from the LEDGER, never reconstructed by the caller: `attempts` is the
 * row's own counter and `outcome` is a projection of its terminal state, so a
 * seam cannot report a retry count the host did not make. `downstreamKeys` is
 * deliberately NOT here — that is what the fake downstream RECEIVED, which only
 * the seam's own recorder can witness, and putting it here would let the host
 * assert its own idempotency key was honoured.
 */
export interface InverseActionReport {
  readonly ordinal: number;
  /** §C's opaque inverse-action identity — constant across retries. */
  readonly effectId: string;
  readonly nodeId?: string;
  readonly attempts: number;
  readonly outcome: 'completed' | 'failed' | 'skipped' | 'terminated' | 'held' | 'irreversible';
  /** The recorded input the inverse executed with (§B: recorded facts only). */
  readonly input?: Record<string, unknown>;
}

export interface UnwindResult {
  /** The §D rollup after the plan ran, folded from the ledger. */
  readonly status: CompensationStatus;
  /**
   * One entry per plan entry, in EXECUTION order — the §21 recovery-extension
   * projection. Present on every unwind, not only a seam-driven one: it is
   * derived from the ledger, so building it costs a fold rather than a query,
   * and a report that only existed under the seam would be a different code
   * path from the one production runs.
   */
  readonly inverseActions: readonly InverseActionReport[];
  /** The forward-completion ordinals in the order their inverse actions were
   *  EXECUTED — what happened, not what was scheduled
   *  (`host-sample-test-seams.md` §21 non-vacuity). Strictly descending under
   *  `reverse-completion`. */
  readonly compensatedOrder: number[];
  /** Inverse effects actually fired. `0` on a replay — the §F witness. */
  readonly firedInverseEffects: number;
  /** Obligations still owed when the plan stopped. This IS the "remaining
   *  obligation set" the run parks in the ADR 0532 dead-letter sink with; there
   *  is no second queue, because the rows are already durable. */
  readonly remaining: readonly CompensationObligation[];
}

/** The declaration key. Sub-run node ids are only unique within their run. */
export function declarationKey(runId: string, nodeId: string): string {
  return `${runId}::${nodeId}`;
}

/**
 * The retry budget for one inverse action: node, then policy, then constant.
 *
 * The node wins by rule, not by accident — the policy schema says it "MUST NOT
 * weaken a node's own declaration", and `retry` is one of the two fields where
 * that could happen. Resolved per FIELD rather than per BLOCK: a node that sets
 * only `maxAttempts` still inherits the policy's `backoffMs`, which is what an
 * author who wrote both means.
 */
export function retryBudgetFor(
  d: CompensationDeclaration,
  policy?: CompensationPolicy,
): { maxAttempts: number; backoffMs: number } {
  return {
    maxAttempts: Math.max(
      1,
      d.retry?.maxAttempts ?? policy?.retry?.maxAttempts ?? COMPENSATION_DEFAULT_RETRY.maxAttempts,
    ),
    backoffMs: Math.max(
      0,
      d.retry?.backoffMs ?? policy?.retry?.backoffMs ?? COMPENSATION_DEFAULT_RETRY.backoffMs,
    ),
  };
}

/** RFC 0151 §E `approvalScope` — ESCALATE-ONLY. `all` gates every inverse
 *  action; `declared` (the default, and the no-policy behaviour) gates only the
 *  nodes that asked. There is deliberately no `none`: a policy MUST NOT strip an
 *  approval a node declared for itself, so this function can only ever turn
 *  `false` into `true`. */
export function requiresApproval(d: CompensationDeclaration, policy?: CompensationPolicy): boolean {
  return d.requiresApproval === true || policy?.approvalScope === 'all';
}

/**
 * RFC 0151 §B (S36/S37) — does ABANDONING this inverse action need a second human?
 *
 * ── THE ONE PLACE THE COMPARISON LIVES ────────────────────────────────────
 *
 * §B left one thing ambiguous — it defined the DEFAULT as the effective
 * `requiresApproval` but never said whether an explicit value could LOWER it.
 * Raised as **S37** and DECIDED (A) ESCALATE-ONLY PARITY, merged as
 * **openwop#1064**:
 *
 *   §B  "Escalation is a floor. An explicit `waiveRequiresApproval: false` MUST
 *        NOT lower a value that policy escalation has raised: the effective
 *        value is `(declared ?? declared requiresApproval) OR
 *        (approvalScope === 'all')`."
 *
 * So the two halves settle differently, and BOTH halves are load-bearing:
 *
 *   - an explicit `false` STILL wins over the node's own `requiresApproval`
 *     (an author may say "sign-off to RUN the inverse, but declining is an ops
 *     call") — the reading that survived from (B);
 *   - an explicit `false` NEVER wins over WORKSPACE policy escalation, because a
 *     node-level declaration must not strip a control the workspace imposed.
 *     That is the half (B) got wrong.
 *
 * THE PARENTHESIZATION IS THE WHOLE RULE. `requiresApproval(d)` is called with
 * NO policy on purpose — it must yield the DECLARED node value, so the
 * escalation term stays a separate OR'd floor. Passing `policy` here instead
 * would fold escalation into the `??` default, where an explicit `false` would
 * shadow it — reinstating exactly the defect #1064 closed.
 */
export function effectiveWaiveRequiresApproval(
  d: CompensationDeclaration,
  policy?: CompensationPolicy,
): boolean {
  // S37 (A), openwop#1064. `requiresApproval(d)` — deliberately policy-less.
  return (d.waiveRequiresApproval ?? requiresApproval(d)) || policy?.approvalScope === 'all';
}

/**
 * Run the unwind for one run tree.
 *
 * Idempotent by construction: it only ever advances NON-terminal rows, and
 * `completed` is the ledger's one terminal state. So a second call after a
 * crash mid-unwind picks up exactly the obligations the first call did not
 * discharge, and a completed inverse is never re-fired — which for a
 * `forward-effect` shape is the difference between one refund and two.
 */
export async function unwindRun(input: UnwindInput): Promise<UnwindResult> {
  const { tenantId, runId, declarations, deps } = input;

  // ── Persist/freeze the plan BEFORE the first inverse action (§C) ─────────
  const all = await obligationsForRunTree(tenantId, runId);
  const plan = all.filter((o) => o.state !== 'completed');
  if (plan.length === 0) {
    return {
      status: await compensationStatusForRunTree(tenantId, runId),
      compensatedOrder: [],
      firedInverseEffects: 0,
      remaining: [],
      // Reported from EVERY row, not just the unfinished ones: a plan whose
      // entries all completed still has a report, and an empty array here would
      // read as "no plan" rather than "plan discharged".
      inverseActions: reportInverseActions(all, []),
    };
  }

  const head = plan[0]!;
  await deps.appendEvent({
    type: 'compensation.requested',
    ...(head.nodeId !== undefined ? { nodeId: head.nodeId } : {}),
    payload: eventPayload(head, 0),
  });
  // §D's rollup asks whether `compensation.requested` was recorded, and the rows
  // ARE the plan (§C) — so the fact has to live on them or the rollup cannot see
  // it. Stamped here, in the same step that emits the event and freezes the
  // plan, so the two cannot diverge. Idempotent on resume.
  await deps.markPlanRequested(input.tenantId, input.runId, new Date().toISOString());

  if (input.replaying === true) {
    // §F. The plan is REPORTED from recorded facts and nothing is invoked. No
    // `compensation.started` either: nothing started, and emitting it would put
    // the run at `running` in the fold for an unwind that will never move.
    log.info('compensation_unwind_replay_suppressed', { runId, obligations: plan.length });
    return {
      status: await compensationStatusForRunTree(tenantId, runId),
      compensatedOrder: [],
      firedInverseEffects: 0,
      remaining: plan,
      // §F's whole point, made observable: the replay reports the RECORDED plan
      // — same identities, same recorded inputs — having invoked nothing.
      inverseActions: reportInverseActions(all, []),
    };
  }

  const compensatedOrder: number[] = [];
  let fired = 0;
  let startedEmitted = false;

  for (const obligation of plan) {
    // RFC 0151 UQ4 (resolved 2026-08-16) — an `irreversibleEffect` node's entry
    // NEVER RUNS AND NEVER COMPLETES. It is left in the plan rather than skipped
    // out of it, which is the whole point: its presence is what caps the §D
    // rollup at `partial`, so a reader "can no longer infer a full unwind" from
    // a run that permanently could not have one. Invoking it would be worse than
    // pointless — there is no inverse to invoke.
    if (obligation.shape === 'irreversible') {
      log.info('compensation_entry_irreversible', {
        runId, nodeId: obligation.nodeId, ordinal: obligation.compensationOrdinal,
      });
      continue;
    }

    const declaration =
      obligation.nodeId !== undefined
        ? declarations.get(declarationKey(obligation.runId, obligation.nodeId))
        : undefined;

    if (!declaration) {
      // RFC 0151 §B requires `nodeTypeId` to resolve AT REGISTRATION so an
      // unwind never fails on a typo discovered during a failure. Reaching here
      // means the declaration vanished between registration and the unwind (a
      // redefined workflow, a dropped pack). No retry can fix that; an operator
      // must. No closed §D `reason` names it, so the wire event carries none and
      // the detail lands on the durable row.
      await markManual(
        tenantId,
        obligation,
        `no compensation declaration resolved for node '${obligation.nodeId ?? '<unknown>'}' at unwind time`,
        deps,
      );
      continue;
    }

    if (requiresApproval(declaration, input.policy)) {
      const gate = await gateOnApproval(tenantId, obligation, declaration, deps);
      if (gate === 'stop') break;
      if (gate === 'skip') continue;
    }

    // CLAIM. The ledger's state machine forbids `* -> started` from anything
    // already `started` or `completed`, so this doubles as the compare-and-swap
    // a concurrent second unwind loses: the loser skips the obligation instead
    // of firing a second inverse for it. That is the whole defence against a
    // duplicate delivery of the plan, and it is why the transition error is
    // caught here rather than allowed to abort the pass.
    if (!(await claimObligation(tenantId, obligation))) continue;

    if (!startedEmitted) {
      await deps.appendEvent({
        type: 'compensation.started',
        ...(obligation.nodeId !== undefined ? { nodeId: obligation.nodeId } : {}),
        payload: eventPayload(obligation, obligation.attempts),
      });
      startedEmitted = true;
    }

    const budget = retryBudgetFor(declaration, input.policy);
    let outcome: InverseOutcome = { ok: false, retryable: true, detail: 'not attempted' };
    let attempt = 0;
    for (attempt = 1; attempt <= budget.maxAttempts; attempt++) {
      // The identity handed to `invoke` is the obligation's — retry-stable by
      // §C, and deliberately NOT keyed on `attempt`. A compensator that keys its
      // own idempotency on `inverseActionId` therefore sees one logical
      // compensation across every retry.
      fired += 1;
      outcome = await deps.invoke({ obligation, declaration, attempt });
      if (outcome.ok) break;
      if (!outcome.retryable) break;
      if (attempt < budget.maxAttempts && budget.backoffMs > 0) {
        await (deps.sleep ?? defaultSleep)(budget.backoffMs * 2 ** (attempt - 1));
      }
    }

    if (outcome.ok) {
      // `attempt` is the attempt that SUCCEEDED, so it is the count made — the
      // number §21 reports and the number an operator reads to see how close the
      // retry budget came to exhausting.
      await resolveObligation({
        tenantId, inverseActionId: obligation.inverseActionId, to: 'completed', attempts: attempt,
      });
      compensatedOrder.push(obligation.compensationOrdinal);
      continue;
    }

    if (outcome.retryable) {
      // Retries exhausted — the one case the §D vocabulary names exactly.
      await resolveObligation({
        tenantId,
        inverseActionId: obligation.inverseActionId,
        to: 'failed',
        // The loop exits with `attempt` one past the budget, so the attempts
        // MADE is `attempt - 1` — the same number the reason string quotes.
        attempts: attempt - 1,
        reason: `retries exhausted after ${attempt - 1} attempt(s): ${outcome.detail}`,
      });
      await deps.appendEvent({
        type: 'compensation.failed',
        ...(obligation.nodeId !== undefined ? { nodeId: obligation.nodeId } : {}),
        payload: { ...eventPayload(obligation, attempt - 1), reason: 'retries-exhausted' },
      });
      continue;
    }

    await markManual(tenantId, obligation, outcome.detail, deps);
  }

  const finalRows = await obligationsForRunTree(tenantId, runId);
  const remaining = finalRows.filter((o) => o.state !== 'completed');
  const status = await compensationStatusForRunTree(tenantId, runId);

  if (remaining.length === 0) {
    await deps.appendEvent({
      type: 'compensation.completed',
      ...(head.nodeId !== undefined ? { nodeId: head.nodeId } : {}),
      payload: eventPayload(head, head.attempts),
    });
  } else {
    // RFC 0151 §E: "Exhausted compensation retries MUST route to RFC 0053
    // dead-letter handling". The sink is the ADR 0532 one the run already lands
    // in — `run.dead_lettered` from `executor.emitTerminalFailure`, the single
    // terminal choke. There is deliberately NO second queue: the remaining
    // obligation set is the ledger's own non-terminal rows, which are already
    // durable, already tenant-scoped, and already what an operator has to act
    // on. A parallel store would be one more thing to keep in sync with the
    // rows that are the truth.
    const first = remaining[0]!;
    await deps.appendEvent({
      type: 'compensation.failed',
      ...(first.nodeId !== undefined ? { nodeId: first.nodeId } : {}),
      payload: { ...eventPayload(first, first.attempts), reason: 'dead-lettered' },
    });
    log.warn('compensation_unwind_parked', {
      runId,
      status,
      remaining: remaining.length,
      compensated: compensatedOrder.length,
    });
  }

  return {
    status,
    compensatedOrder,
    firedInverseEffects: fired,
    remaining,
    // `compensatedOrder` is what actually EXECUTED, in the order it executed, so
    // it is the right ranking for a report §21 requires "in execution order".
    // Entries that never ran (irreversible, skipped, held) fall after it in
    // descending-ordinal order, which is the order they would have run in.
    inverseActions: reportInverseActions(finalRows, compensatedOrder),
  };
}

/**
 * Move one obligation to `started`, or report that someone else already has.
 *
 * `false` means the row was not claimable — it is already `started` by a
 * concurrent pass, or already `completed`. Both are "do not fire an inverse for
 * this", which is exactly the answer a duplicate delivery needs.
 *
 * IT TAKES BOTH HALVES, and this comment used to claim only one. It said "the
 * STATE MACHINE is what makes it safe rather than a lock" — which sounds right
 * and is false: the machine can only reject a write it SEES, and without the
 * per-obligation serialization inside `resolveObligation` the second pass reads
 * `requested` before the first writes `started`, so no illegal transition is
 * ever attempted and both passes fire. Measured, with the machine in place: two
 * refunds. So the machine rejects the duplicate and the lock is what guarantees
 * it gets to see one.
 *
 * Narrowing the catch to `CompensationTransitionError` is load-bearing for a
 * different reason: a storage failure must NOT read as "already claimed", or a
 * real outage would silently skip an inverse the operator believes ran.
 */
async function claimObligation(tenantId: string, o: CompensationObligation): Promise<boolean> {
  try {
    await resolveObligation({
      tenantId,
      inverseActionId: o.inverseActionId,
      to: 'started',
      reason: `claimed for ${COMPENSATION_ORDERING_MODEL} unwind at ordinal ${o.compensationOrdinal}`,
    });
    return true;
  } catch (err) {
    if (err instanceof CompensationTransitionError) return false;
    throw err;
  }
}

/** Decide the approval gate for one obligation.
 *  `go` — proceed; `skip` — this obligation is settled (denied or manual);
 *  `stop` — the plan pauses here and the run carries the wait. */
async function gateOnApproval(
  tenantId: string,
  obligation: CompensationObligation,
  declaration: CompensationDeclaration,
  deps: UnwindDeps,
): Promise<'go' | 'skip' | 'stop'> {
  if (!deps.requestApproval) {
    // Fail CLOSED. A `requiresApproval` inverse effect can itself be harmful
    // (RFC 0147 R9); executing it because the host wired no gate is exactly the
    // authority escalation §G's audit scope names.
    await markManual(
      tenantId,
      obligation,
      'inverse action requires approval and this host wired no compensation approval gate',
      deps,
    );
    return 'skip';
  }

  const gate = await deps.requestApproval({ obligation, declaration });
  if (gate.decision === 'approved') return 'go';

  if (gate.decision === 'denied') {
    await resolveObligation({
      tenantId,
      inverseActionId: obligation.inverseActionId,
      to: 'failed',
      reason: `approval denied: ${gate.detail}`,
    });
    await deps.appendEvent({
      type: 'compensation.failed',
      ...(obligation.nodeId !== undefined ? { nodeId: obligation.nodeId } : {}),
      payload: { ...eventPayload(obligation, obligation.attempts), reason: 'approval-denied' },
    });
    return 'skip';
  }

  // Pending. `paused` carries NO §D reason — see the module header: every closed
  // code asserts a decision, and none has been made.
  await attachApproval(tenantId, obligation.inverseActionId, gate.approvalId);
  await resolveObligation({
    tenantId,
    inverseActionId: obligation.inverseActionId,
    to: 'paused',
    reason: `awaiting approval ${gate.approvalId}`,
  });
  await deps.appendEvent({
    type: 'compensation.paused',
    ...(obligation.nodeId !== undefined ? { nodeId: obligation.nodeId } : {}),
    payload: eventPayload(obligation, obligation.attempts),
  });
  // STOP, not skip. `reverse-completion` exists because a later inverse can
  // depend on an earlier one having run; continuing past a paused obligation
  // would unwind out of order and could release a resource the paused inverse
  // still needs.
  return 'stop';
}

/**
 * Project the ledger's rows into the §21 `inverseActions[]` report.
 *
 * A projection of RECORDED state, not a running tally kept alongside the loop:
 * the two would drift the moment an unwind resumed after a crash, and the
 * resumed pass is exactly when an operator reads this.
 *
 * The `outcome` mapping is the §D state → §21 vocabulary translation, and the
 * two non-obvious rows are the ones worth stating:
 *
 *   - `manual_intervention_required` → `held`. §21 calls a plan awaiting
 *     authorized intervention "held"; the ledger calls the row's state
 *     `manual_intervention_required`. Same fact, two vocabularies.
 *   - `shape: 'irreversible'` → `irreversible`, and it OUTRANKS the state.
 *     RFC 0151 UQ4: such an entry "never runs, never completes", so reporting
 *     the state it happens to sit in would imply an attempt that never occurred.
 */
export function reportInverseActions(
  rows: readonly CompensationObligation[],
  executionOrder: readonly number[],
): InverseActionReport[] {
  const rank = new Map(executionOrder.map((ordinal, i) => [ordinal, i]));
  return [...rows]
    .sort((a, b) => {
      const ra = rank.get(a.compensationOrdinal) ?? Number.MAX_SAFE_INTEGER;
      const rb = rank.get(b.compensationOrdinal) ?? Number.MAX_SAFE_INTEGER;
      return ra - rb || b.compensationOrdinal - a.compensationOrdinal;
    })
    .map((o) => ({
      ordinal: o.compensationOrdinal,
      effectId: o.inverseActionId,
      ...(o.nodeId !== undefined ? { nodeId: o.nodeId } : {}),
      attempts: o.attempts,
      outcome: outcomeOf(o),
      ...(o.compensationInput !== undefined ? { input: o.compensationInput } : {}),
    }));
}

function outcomeOf(o: CompensationObligation): InverseActionReport['outcome'] {
  // UQ4 first: an irreversible entry is never invoked, so no state it carries
  // describes an attempt.
  if (o.shape === 'irreversible') return 'irreversible';
  switch (o.state) {
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'manual_intervention_required': return 'held';
    case 'paused': return 'held';
    // `requested` reached the end of a pass without being claimed — the unwind
    // STOPPED (a paused predecessor), so this one was skipped, not failed.
    case 'requested': return 'skipped';
    case 'started': return 'terminated';
  }
}

async function markManual(
  tenantId: string,
  obligation: CompensationObligation,
  detail: string,
  deps: UnwindDeps,
): Promise<void> {
  await resolveObligation({
    tenantId,
    inverseActionId: obligation.inverseActionId,
    to: 'manual_intervention_required',
    reason: detail,
  });
  await deps.appendEvent({
    type: 'compensation.manual_intervention_required',
    ...(obligation.nodeId !== undefined ? { nodeId: obligation.nodeId } : {}),
    payload: eventPayload(obligation, obligation.attempts),
  });
}

/**
 * §D/§G: opaque ids, attempt, ordering model, closed reasons — and NOTHING
 * else. These events land in the durable log, the least revocable place a
 * credential can reach, so the payload is built from the ledger row's ids and
 * digests rather than from anything the compensator returned.
 *
 * `effectId` is the forward effect's digest, not its content: it correlates two
 * events without carrying what was sent.
 */
function eventPayload(o: CompensationObligation, attempt: number): CompensationEvent['payload'] {
  return {
    compensationId: o.inverseActionId,
    ...(o.nodeId !== undefined ? { nodeId: o.nodeId } : {}),
    effectId: digestOf([o.forwardLogicalInvocationId, o.resultDigest]),
    attempt,
    orderingModel: COMPENSATION_ORDERING_MODEL,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
