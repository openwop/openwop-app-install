/**
 * RFC 0151 §E — operator recovery authority for a HELD compensation plan.
 *
 * WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT.
 *
 * It is the ONE decision function for "may this actor act on this plan, and what
 * happens when they do". `routes/compensationSeam.ts` §21 `operator` calls it,
 * and ADR 0554 P3's Operations route will call the SAME function — the CLAUDE.md
 * rule that a route and its conformance seam share one access predicate, so a
 * seam can never be more permissive than production. §21 states the same
 * requirement from the other side: the host "MUST evaluate it through the same
 * RFC 0049 decision the production operator path uses".
 *
 * It is NOT a new role model and NOT a second audit sink. Authority is a boolean
 * the caller resolves (the seam from its presented `actor`, a real route from
 * the request principal), and the audit fact is the existing RFC 0049
 * `authorization.decided` RUN EVENT — the same type `host/anonymousActor.ts`
 * emits, with the same closed payload
 * (`{ principal, action, resource, allowed, reason }`,
 * `run-event-payloads.schema.json` `authorizationDecided`,
 * `additionalProperties: false`).
 *
 * ── THE TWO REFUSALS ARE DIFFERENT IN KIND ────────────────────────────────
 *
 * Cross-tenant is **404 `not_found`**, not 403. RFC 0132 §A.2: neutralize to the
 * actor's tenant, do not reveal that another tenant's plan exists — a 403 would
 * confirm the run id is real, which is the whole thing being withheld. It is
 * also NOT audited onto the plan's run: writing an audit record into a run the
 * actor must not know exists would leak through the audit trail the refusal just
 * protected, and would let an unauthenticated prober append to another tenant's
 * event log.
 *
 * Same-tenant-without-authority is **403 `forbidden` AND audited**. §21: "the
 * refusal MUST also be audited (`authorization.decided`, `reason:
 * authority-denied` on the plan)". Here the actor is already inside the tenant,
 * so the record leaks nothing they could not already see, and a refused override
 * attempt is precisely what an operator reviewing an incident needs.
 *
 * @see spec/v1/host-sample-test-seams.md §21 "Recovery extension"
 * @see docs/adr/0554-compensation-saga-and-operator-recovery-runtime.md
 */

import { getEventLog } from '../executor/eventLog.js';
import type { RunRecord } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { obligationsForRunTree, resolveObligation } from './compensationLedger.js';

const log = createLogger('host.compensationOperator');

/** §21's closed action set. */
export type CompensationOperatorAction = 'retry' | 'skip' | 'substitute' | 'terminate';

export const COMPENSATION_OPERATOR_ACTIONS: readonly CompensationOperatorAction[] = [
  'retry', 'skip', 'substitute', 'terminate',
];

/**
 * The actor, as the CALLER resolved it.
 *
 * `operator` means "holds operator authority IN `tenantId`" and nothing else —
 * §21 is explicit that it is not a superuser flag and carries no cross-tenant
 * reach. Keeping it a resolved boolean rather than a principal object is what
 * lets the seam and a real route share this function without the seam having to
 * fabricate a session.
 */
export interface CompensationOperatorActor {
  readonly tenantId: string;
  readonly principalId: string;
  readonly operator: boolean;
}

export type CompensationOperatorDecision =
  | { readonly allowed: true }
  /** RFC 0132 §A.2 — neutralized, never revealed, never audited on the plan. */
  | { readonly allowed: false; readonly status: 404; readonly code: 'not_found' }
  /** §E — refused and AUDITED. */
  | { readonly allowed: false; readonly status: 403; readonly code: 'forbidden' };

/**
 * Decide, and write the RFC 0049 audit fact for the arms that get one.
 *
 * Returns the decision rather than throwing so the caller owns the envelope
 * shape (the seam answers §21's codes; a P3 route answers its own), while the
 * DECISION and the AUDIT stay here where they cannot diverge between them.
 */
export async function decideCompensationOperatorAction(input: {
  readonly run: RunRecord;
  readonly actor: CompensationOperatorActor;
  readonly action: CompensationOperatorAction;
}): Promise<CompensationOperatorDecision> {
  const { run, actor, action } = input;

  if (actor.tenantId !== run.tenantId) {
    log.info('compensation_operator_cross_tenant_neutralized', {
      runId: run.runId, action, actorTenant: actor.tenantId,
    });
    return { allowed: false, status: 404, code: 'not_found' };
  }

  if (actor.operator !== true) {
    await auditDecision(run, actor, action, false, 'authority-denied');
    return { allowed: false, status: 403, code: 'forbidden' };
  }

  await auditDecision(run, actor, action, true, 'operator-authority');
  return { allowed: true };
}

/**
 * The RFC 0049 record, on the run's own event log.
 *
 * `resource` is the runId — §21 calls the plan the thing being acted on, and the
 * plan IS the run's obligation set, so the run id is the plan's name on the
 * wire. The payload carries only the four required keys plus `reason`; the
 * schema is `additionalProperties: false`, so a fifth would be rejected by any
 * peer validating the event, and there is nothing here worth the risk of
 * carrying an actor's free text.
 */
async function auditDecision(
  run: RunRecord,
  actor: CompensationOperatorActor,
  action: CompensationOperatorAction,
  allowed: boolean,
  reason: string,
): Promise<void> {
  try {
    await getEventLog().append({
      runId: run.runId,
      type: 'authorization.decided',
      payload: {
        principal: actor.principalId,
        action: `compensation:${action}`,
        resource: run.runId,
        allowed,
        reason,
      },
    });
  } catch (err) {
    // An audit-sink failure must not become an authorization oracle, and must
    // not turn a legitimate operator override into an error either. Log loudly;
    // the decision stands as made.
    log.error('compensation_operator_audit_failed', {
      runId: run.runId, allowed, error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Apply a NON-retry disposition to the held entries of a plan.
 *
 * `retry` is not here: resuming a plan needs the workflow definition and the
 * node registry, so it lives in `compensationRuntime.resumeUnwindForOperator`
 * with the rest of the executor-facing glue. The dispositions below only move
 * ledger rows, which is why they can live beside the decision.
 *
 * Both write a §D-closed reason where one exists: `operator-terminated` is in the
 * §D vocabulary; a skip's justification is NOT (there is no closed code for it),
 * so it lands on the row's host-local free-text `reason` — the same call the
 * module header of `compensationUnwind.ts` records for `paused`.
 */
export async function applyOperatorDisposition(input: {
  readonly run: RunRecord;
  readonly action: 'skip' | 'terminate';
  readonly justification?: string;
}): Promise<number> {
  const held = (await obligationsForRunTree(input.run.tenantId, input.run.runId)).filter(
    (o) => o.state === 'manual_intervention_required' || o.state === 'paused',
  );
  let moved = 0;
  for (const o of held) {
    await resolveObligation({
      tenantId: input.run.tenantId,
      inverseActionId: o.inverseActionId,
      to: 'failed',
      reason:
        input.action === 'terminate'
          ? 'operator terminated the inverse action'
          : `operator skipped: ${input.justification ?? '(no justification)'}`,
    });
    moved += 1;
  }
  return moved;
}
