/**
 * Approval-delegation routes (ADR 0198) — host extension, non-normative.
 *
 * Self-service coverage: a signed-in user manages delegations FROM themselves
 * (create/revoke); everyone sees the delegations that involve them; a
 * superadmin may manage anyone's (the operator escape hatch). The records are
 * consumed by `approverResolution` (the single eligibility authority) — see
 * `host/approvalDelegations.ts` for the semantics and the anti-double-vote
 * identity rule.
 *
 *   GET    /v1/host/openwop-app/approval-delegations          — mine (from OR to me); ?all=1 superadmin
 *   POST   /v1/host/openwop-app/approval-delegations          — create (fromSubject = me; superadmin may set it)
 *   POST   /v1/host/openwop-app/approval-delegations/:id/revoke
 */

import type { Express, Request } from 'express';
import { OpenwopError } from '../types.js';
import { tenantOf } from '../host/requestSubject.js';
import { isSuperadmin } from '../host/superadmin.js';
import { createDelegation, revokeDelegation, listDelegations, getDelegation } from '../host/approvalDelegations.js';

function callerSubject(req: Request): string {
  const subject = req.userId ?? req.principal?.principalId;
  if (!subject) {
    throw new OpenwopError('forbidden', 'Managing approval delegations requires a signed-in user.', 403, {});
  }
  return subject;
}

export function registerApprovalDelegationRoutes(app: Express): void {
  app.get('/v1/host/openwop-app/approval-delegations', async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const me = callerSubject(req);
      const wantAll = req.query.all === '1' || req.query.all === 'true';
      if (wantAll && !isSuperadmin(req)) {
        throw new OpenwopError('forbidden', 'Listing all delegations is an operator action.', 403, {});
      }
      const delegations = await listDelegations(tenantId, wantAll ? {} : { subject: me });
      res.json({ delegations });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/approval-delegations', async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const me = callerSubject(req);
      const body = (req.body ?? {}) as { fromSubject?: unknown; toSubject?: unknown; startsAt?: unknown; endsAt?: unknown; reason?: unknown };
      // Self-service: you delegate YOUR OWN approvals. A superadmin may set
      // another fromSubject (the operator managing coverage for someone out).
      const fromSubject = typeof body.fromSubject === 'string' && body.fromSubject.trim() ? body.fromSubject.trim() : me;
      if (fromSubject !== me && !isSuperadmin(req)) {
        throw new OpenwopError('forbidden', 'You can only delegate your own approvals.', 403, {});
      }
      const created = await createDelegation({
        tenantId,
        fromSubject,
        toSubject: typeof body.toSubject === 'string' ? body.toSubject : '',
        startsAt: typeof body.startsAt === 'string' ? body.startsAt : '',
        endsAt: typeof body.endsAt === 'string' ? body.endsAt : '',
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        createdBy: me,
      });
      res.status(201).json({ delegation: created });
    } catch (err) {
      next(err);
    }
  });

  app.post('/v1/host/openwop-app/approval-delegations/:delegationId/revoke', async (req, res, next) => {
    try {
      const tenantId = tenantOf(req);
      const me = callerSubject(req);
      const delegationId = req.params.delegationId ?? '';
      const existing = await getDelegation(tenantId, delegationId);
      if (!existing) {
        throw new OpenwopError('not_found', 'Delegation not found.', 404, { delegationId });
      }
      if (existing.fromSubject !== me && !isSuperadmin(req)) {
        throw new OpenwopError('forbidden', 'Only the delegating approver (or an operator) can revoke this.', 403, { delegationId });
      }
      const revoked = await revokeDelegation(tenantId, delegationId, me);
      res.json({ delegation: revoked });
    } catch (err) {
      next(err);
    }
  });
}
