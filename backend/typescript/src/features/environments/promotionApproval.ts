/**
 * Environment-promotion approval handler (ADR 0387 / H2) — the decide side of
 * the opt-in promotion gate, the ADR 0230 `strategy/activationApproval.ts`
 * pattern. When a tenant sets `requireApprovalForPromotion`, a promote/rollback
 * does NOT move the config pointer — it queues a `kind: 'environment-promotion'`
 * PendingApproval, resolved from the SAME reviews inbox every other proposal
 * uses (the per-kind branch in `host/approvalDecision.ts` dispatches here for
 * claim AND reject).
 *
 * Direction: feature → core only. Core owns the handler HOOK
 * (`registerEnvironmentPromotionApprovalHandler`); this feature registers at
 * boot. Authority: `host:members:manage` at TENANT scope (the environments
 * config-change bar) — enforced HERE because the generic approvals route is
 * tenant-scoped but does not apply the environments write bar itself.
 *
 * @see ../../host/approvalService.ts — the durable queue + the handler hook
 * @see ../../host/approvalDecision.ts — the single decision core
 * @see ../../../docs/adr/0387-environments-promotion-rollback.md
 */

import { OpenwopError } from '../../types.js';
import {
  getApproval,
  resolveApproval,
  reopenApproval,
  registerEnvironmentPromotionApprovalHandler,
  type PendingApproval,
} from '../../host/approvalService.js';
import { resolveEffectiveAccess, hasDistinctScopeHolder } from '../../host/accessControlService.js';
import { movePointer, recordRejectedPromotion, applyToLive, LIVE_APPLY_TARGET } from './environmentsService.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('environments.promotion');

/**
 * Resolve an environment-promotion approval: enforce tenant RBAC, flip the
 * approval (CAS), then apply the pointer move (`approve`) or park a rejected
 * ledger row (`reject`). Returns null when the approval is missing/cross-tenant
 * or not an environment promotion (the route maps that to 404). Throws
 * `forbidden_scope` (403) when the decider lacks `host:members:manage`.
 */
async function decideEnvironmentPromotion(
  tenantId: string,
  approvalId: string,
  outcome: 'approved' | 'rejected',
  opts: { decidedByUserId?: string; note?: string },
): Promise<{ approval: PendingApproval; changed: boolean } | null> {
  const approval = await getApproval(approvalId);
  if (!approval || approval.tenantId !== tenantId || approval.kind !== 'environment-promotion' || !approval.envPromotion) {
    return null;
  }

  const decidedBy = opts.decidedByUserId;
  if (!decidedBy) {
    throw new OpenwopError('forbidden_scope', 'A signed-in member is required to decide an approval.', 403, {});
  }
  const access = await resolveEffectiveAccess(tenantId, { subject: decidedBy });
  if (!access.scopes.includes('host:members:manage')) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: host:members:manage', 403, {
      requiredScope: 'host:members:manage',
    });
  }

  // ADR 0732 D2/D3 — separation of duties. An approval the PROPOSER can sign is
  // not an approval: before this, one admin could queue a prod promotion and
  // approve it, so `requireApprovalForPromotion` was on and gated nothing that
  // proposer could not clear alone (the ADR 0582 "gates that do not gate" shape).
  //
  // D3, the EXIT: four eyes are only meaningful when four eyes exist.
  // `createWorkspace` mints a SINGLE owner member, so a one-admin workspace is
  // the DEFAULT state — refusing unconditionally would brick promotion for every
  // new tenant that turns the gate on. So refuse only when a DISTINCT eligible
  // approver actually exists; otherwise proceed and record that it was
  // self-approved for want of a second approver.
  //
  // D5: rows minted before D1 carry no proposer. An absent proposer cannot be
  // compared, so those decide and log — a bounded fail-open for in-flight rows
  // only, never for new ones (both creation sites now pass `requestedBy`).
  const requestedBy = approval.envPromotion.requestedBy;
  if (!requestedBy) {
    log.warn('environment_promotion_proposer_unknown', {
      tenantId, approvalId, reason: 'pre-ADR-0732 row — self-approval cannot be detected',
    });
  } else if (requestedBy === decidedBy) {
    if (await hasDistinctScopeHolder(tenantId, 'host:members:manage', requestedBy)) {
      log.warn('environment_promotion_self_approval_denied', {
        tenantId, approvalId, reason: 'separation-of-duties',
      });
      throw new OpenwopError(
        'forbidden',
        'The member who proposed this promotion cannot approve it. Another member with host:members:manage must decide.',
        403,
        { reason: 'separation-of-duties', approvalId },
      );
    }
    log.warn('environment_promotion_self_approved_sole_admin', {
      tenantId, approvalId, reason: 'no other member holds host:members:manage',
    });
  }

  // CAS flip pending→resolved; `changed` gates the side effect so a losing
  // concurrent decide neither double-applies nor double-rejects. Resolve BEFORE
  // moving the pointer, then COMPENSATE (re-open) if the move can't happen — the
  // ADR 0066 HIGH-1 lesson: a failed decide never consumes the approval, and the
  // row never claims "approved" while the pointer stayed put.
  const lock = await resolveApproval(approvalId, {
    status: outcome,
    ...(opts.decidedByUserId ? { decidedBy: opts.decidedByUserId } : {}),
    ...(opts.note !== undefined ? { note: opts.note } : {}),
  });
  if (!lock) return null;
  if (!lock.changed) return { approval: lock.approval, changed: false };

  const { toEnv, fromEnv, snapshotHash } = approval.envPromotion;
  if (outcome === 'approved') {
    try {
      // Pass approvalId so the applied ledger row is stamped with it and the
      // gate is BYPASSED (no re-queue) on this authorized move. A `__live__`
      // target is a direct apply-to-live (Phase-3 review MEDIUM-1), not a
      // pointer move.
      if (toEnv === LIVE_APPLY_TARGET) {
        await applyToLive({ tenantId, snapshotHash, actor: decidedBy, approvalId });
      } else {
        await movePointer({ tenantId, fromEnvName: fromEnv, toEnvName: toEnv, snapshotHash, actor: decidedBy, approvalId });
      }
    } catch (err) {
      await reopenApproval(approvalId);
      throw err;
    }
  } else {
    // APPR-6 — mirror the approve path's compensation: the CAS already flipped
    // the approval to `rejected`, so a failure to park the rejected ledger row
    // would strand a consumed approval with no recorded decision. Re-open on
    // failure so a failed reject never lies about what happened.
    try {
      await recordRejectedPromotion({ tenantId, fromEnvName: fromEnv, toEnvName: toEnv, snapshotHash, actor: decidedBy, approvalId });
    } catch (err) {
      await reopenApproval(approvalId);
      throw err;
    }
  }
  return { approval: lock.approval, changed: true };
}

/** Register the environment-promotion decision handler on the core approvals
 *  hook (called from the environments feature at boot). */
export function registerEnvironmentPromotionGate(): void {
  registerEnvironmentPromotionApprovalHandler(decideEnvironmentPromotion);
}
