/**
 * Strategy-activation approval handler (ADR 0230 §B3) — the decide side of the
 * interrupt-backed activation gate, the ADR 0066 `cms/contentApproval.ts`
 * pattern verbatim. When the `strategy-approval-gate` toggle is ON, a PATCH
 * moving a strategy `draft → active` queues a `kind: 'strategy-activation'`
 * PendingApproval instead of transitioning; a reviewer resolves it from the
 * SAME ApprovalsInbox every other proposal uses (the per-kind branch in
 * `host/approvalDecision.ts` dispatches here for claim AND reject).
 *
 * Direction: feature → core only. Core owns the handler HOOK
 * (`registerStrategyActivationApprovalHandler`); this feature registers at
 * boot. Authority: `host:members:manage` in the strategy's org (the
 * content-publish bar), enforced HERE — the generic approvals route is
 * tenant-scoped and cannot apply the org + role dimension + IDOR.
 *
 * @see ../../host/approvalService.ts — the durable queue + the handler hook
 * @see ../../host/approvalDecision.ts — the single decision core
 * @see ../../../docs/adr/0230-planning-governance-wiring.md
 */

import { OpenwopError } from '../../types.js';
import {
  createStrategyActivationApproval,
  getApproval,
  hasPendingApprovalForStrategy,
  resolveApproval,
  reopenApproval,
  registerStrategyActivationApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { getOrg, resolveEffectiveAccess } from '../../host/accessControlService.js';
import { getStrategy, updateStrategy } from './strategyService.js';
import { strategyMutated } from './emit.js';
import type { StrategyStatus } from './types.js';

export const STRATEGY_GATE_TOGGLE_ID = 'strategy-approval-gate';

/**
 * Resolve a strategy-activation approval: enforce org RBAC + IDOR, flip the
 * approval (CAS), then transition the strategy (`approve` → active; `reject`
 * leaves it draft). Returns null when the approval is missing/cross-tenant or
 * not a strategy activation (the route maps that to 404). Throws
 * `forbidden_scope` (403) when the decider lacks `host:members:manage` in the
 * strategy's org.
 */
async function decideStrategyActivation(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'strategy-activation') return null;

  const orgId = approval.orgId ?? '';
  const strategyId = approval.strategyId ?? '';
  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) {
    throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
  }

  // IDOR + org-role authority (the content-publish bar — the generic approvals
  // route is tenant-scoped and cannot apply this).
  const org = await getOrg(orgId);
  if (!org || org.tenantId !== tenantId) {
    // Uniform not-found: never leak a cross-tenant/org approval's existence.
    return null;
  }
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy, orgId });
  if (!access.scopes.includes('host:members:manage')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: host:members:manage', 403, {
      requiredScope: 'host:members:manage',
    });
  }

  // CAS flip pending→resolved; `changed` gates the transition so a losing
  // concurrent decide neither double-activates nor double-rejects. Resolve
  // BEFORE transitioning, then COMPENSATE (re-open) if the transition can't
  // happen — the ADR 0066 HIGH-1 lesson: a failed decide never consumes the
  // approval, and the row never claims "approved" while the strategy stayed
  // draft.
  // R2 review (second pass) — the deleted-strategy check must happen BEFORE the CAS.
  // My first correction reopened-then-rejected INSIDE the try, and the existing
  // compensation `catch` reopened it again on the way out, so the card came back pending:
  // the close was undone by the very handler that was supposed to make it stick. Reading
  // first means nothing has been consumed yet, so the close is a plain pending→rejected.
  if (outcome === 'approved' && !(await getStrategy(tenantId, strategyId))) {
    await resolveApproval(approvalId, { status: 'rejected', note: 'The strategy no longer exists.', ...(decidedBy ? { decidedBy } : {}) });
    throw new OpenwopError('conflict', 'This strategy no longer exists, so the activation cannot be applied. The review has been closed.', 409, { strategyId });
  }

  const lock = await resolveApproval(approvalId, {
    status: outcome,
    ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  if (outcome === 'approved') {
    try {
      const s = await getStrategy(tenantId, strategyId);
      if (!s) {
        // Deleted between the pre-CAS read and here — vanishingly narrow, and the
        // compensation is the right answer for it: nothing was applied, so hand the card
        // back rather than consuming it.
        await reopenApproval(approvalId);
        return null;
      }
      // R2 STR2-M4 — APPROVE WHAT YOU SEE. The card froze `status: draft` at queue time
      // and this `if` had no `else`: approving a strategy that had since been archived
      // consumed the approval, recorded `activation-approved` in the audit, returned
      // `changed: true` — and changed nothing. The inbox said Approved, the strategy said
      // archived, and nobody was told the two disagreed.
      //
      // ADR 0597 §3 — the check was `s.status !== 'draft'`, which was correct only
      // while the gate could ONLY be entered from `draft`. Widening the gate to fire
      // on the DESTINATION (`→ active` from paused/completed/archived too) without
      // widening this would have made every non-draft activation 409 at approve
      // time: the fix for the bypass would have broken the lane it opened. The
      // approval now records the status it was queued FROM and this compares
      // against that. Rows queued before this shipped carry no
      // `strategyFromStatus`; `draft` is what every one of them was queued from.
      //
      // CORRECTION 2026-08-22 (ADR 0597 §Correction 4) — this comment used to end
      // *"so 'approve what you see' holds for every origin state."* IT DID NOT,
      // and the sentence is what stopped anyone checking. This compare catches
      // only an edit that MOVES THE STATUS. Whether a protected-field edit moves
      // it is decided by `protectedEditRequiresReapproval`, which is FALSE for
      // `draft` (unapproved) and FALSE for the terminal states (auto-reverting
      // `archived → draft` would hand a plain `workspace:write` holder the
      // un-archive capability `requireConfigAuthority` reserves). So a protected
      // rewrite while a review was pending was invisible here from `draft`,
      // `completed` and `archived` alike, and the approver activated objectives
      // nobody had shown them. It held for `paused` alone, incidentally.
      //
      // What actually holds the guarantee is `closePendingStrategyActivationApprovals`
      // on the PATCH route: a protected edit WITHDRAWS the submission, so there is
      // no stale card for this compare to have to catch. This compare remains the
      // second line — it still catches a status move from any other lane.
      const queuedFrom = approval.strategyFromStatus ?? 'draft';
      if (s.status !== queuedFrom) {
        await reopenApproval(approvalId);
        throw new OpenwopError('conflict', `This strategy is no longer ${queuedFrom} (it is ${s.status}), so the activation cannot be applied. Re-submit it if you still want it active.`, 409, { strategyId, status: s.status, queuedFrom });
      }
      await updateStrategy(tenantId, strategyId, { status: 'active' }, decidedBy);
      strategyMutated({ entity: 'strategy', verb: 'activation-approved', tenantId, actor: decidedBy, strategyId, orgId });
    } catch (err) {
      await reopenApproval(approvalId);
      throw err;
    }
  } else {
    strategyMutated({ entity: 'strategy', verb: 'activation-rejected', tenantId, actor: decidedBy, strategyId, orgId });
  }
  return { approval: lock.approval, changed: true };
}

/** Register the strategy-activation decision handler on the core approvals
 *  hook (called from the strategy feature at boot). */
export function registerStrategyActivationGate(): void {
  registerStrategyActivationApprovalHandler(decideStrategyActivation);
}

/**
 * The SUBMIT-side gate composition: when the tenant's `strategy-approval-gate`
 * toggle is ON and no activation approval is already pending for the strategy,
 * queue one. Extracted so the PATCH route (and any future verb) share ONE
 * owner. Returns true when the gate intercepted (caller must NOT transition).
 */
export async function queueStrategyActivationIfGated(
  tenantId: string,
  strategy: { id: string; orgId: string; title: string; status: StrategyStatus },
  actor: string,
): Promise<boolean> {
  const gate = await resolveOne(STRATEGY_GATE_TOGGLE_ID, { tenantId });
  if (!gate?.enabled) return false;
  if (!(await hasPendingApprovalForStrategy(tenantId, strategy.id))) {
    await createStrategyActivationApproval({
      tenantId,
      orgId: strategy.orgId,
      strategyId: strategy.id,
      strategyTitle: strategy.title,
      // ADR 0597 §3 — the origin state, so the decide side can hold
      // "approve what you see" for an origin that is not `draft`.
      strategyFromStatus: strategy.status,
      proposal: `Activate strategy "${strategy.title}"`,
    });
    strategyMutated({ entity: 'strategy', verb: 'activation-queued', tenantId, actor, strategyId: strategy.id, orgId: strategy.orgId });
  }
  return true;
}

/** The gate's protected fields (architect Q4): editing any of these while the
 *  strategy sits in a non-terminal APPROVED state and the gate is ON
 *  auto-reverts it to draft (visible in the response + audit + event — never
 *  silent). Which states those are is `STATUS_GATE_POSTURE` below. */
export const PROTECTED_FIELDS = ['objectives', 'period', 'planningHorizon', 'accountableExecutive'] as const;

/**
 * ADR 0597 §3 — the gate expressed over the STATE SET, not over the transitions
 * someone enumerated.
 *
 * The gate shipped keyed on two hand-picked transitions: `draft → active`, and
 * a protected-field edit while `s.status === 'active'`. `paused` matched
 * NEITHER, so pause → edit protected fields → activate walked straight through
 * it in three ordinary PATCHes with no approval, no marker, no audit flag.
 * (`paused` appeared in zero strategy tests.) An earlier R2 review had already
 * fixed ONE instance of this same class — `body.status === undefined` "was the
 * wrong test" — and still scoped its cure to `s.status === 'active'`. Naming
 * `paused` in a third `||` would have been the same mistake a third time.
 *
 * So the posture is a TOTAL function of the status union: `Record<StrategyStatus, …>`
 * makes adding a status a COMPILE ERROR until someone decides its posture.
 *
 *  - `approved` — has this strategy's content been through the gate? Only
 *    `draft` has not; every other state is reached from an approved one.
 *  - `terminal` — is this a retired state? A protected-field edit must NOT
 *    resurrect `completed`/`archived` into `draft`: archiving is reserved to
 *    `requireConfigAuthority`, so auto-un-archiving on a plain
 *    `workspace:write` edit would hand a writer a capability the config gate
 *    withholds — a NEW escalation introduced by the fix for an old one.
 *    Reactivating a terminal strategy is still gated, because the activation
 *    rule keys on the DESTINATION (`→ active` from anything that is not
 *    already active), which is the half that actually closes the bypass.
 */
export const STATUS_GATE_POSTURE = {
  draft: { approved: false, terminal: false },
  active: { approved: true, terminal: false },
  paused: { approved: true, terminal: false },
  completed: { approved: true, terminal: true },
  archived: { approved: true, terminal: true },
} as const satisfies Record<StrategyStatus, { approved: boolean; terminal: boolean }>;

/** Does a PATCH landing on `next` need an activation approval? Keyed on the
 *  DESTINATION: every state that is not already `active` must pass the gate to
 *  become active. `next` is caller-supplied and unvalidated here on purpose —
 *  `updateStrategy` is the validator; this only asks "is it `active`?". */
export function requiresActivationApproval(current: StrategyStatus, next: string): boolean {
  return next === 'active' && current !== 'active';
}

/** Does editing a protected field while in `current` require re-approval
 *  (⇒ auto-revert to draft)? */
export function protectedEditRequiresReapproval(current: StrategyStatus): boolean {
  const posture = STATUS_GATE_POSTURE[current];
  return posture.approved && !posture.terminal;
}

export async function strategyGateEnabled(tenantId: string): Promise<boolean> {
  const gate = await resolveOne(STRATEGY_GATE_TOGGLE_ID, { tenantId });
  return Boolean(gate?.enabled);
}
