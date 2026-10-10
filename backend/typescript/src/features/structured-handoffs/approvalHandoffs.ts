/**
 * ADR 0854 D1 — "Ask someone else to decide": hand ONE pending review (a run's
 * approval gate, or an inbox approval) to another person, with a note.
 *
 * A HANDOFF NEVER GRANTS AUTHORITY. Both ends are checked through the review
 * projection — the same reads the inbox uses to say who may decide:
 *   - the caller must be able to decide it now (`canDecide !== false`) and hold
 *     `approvals:respond`;
 *   - the target must be able to SEE the review as themselves, hold
 *     `approvals:respond`, and not be ruled out by its approver list
 *     (`canDecide !== false` when computed for them).
 * The decide routes are unchanged: they re-check everything at decision time,
 * so even a stale handoff cannot let anyone decide who could not already.
 *
 * Effects: the handoff (with an ADR 0829 note, `producedBy:'human'`) is stored
 * per review — one active, a new one replaces it; the target gets an inbox
 * notification carrying the note's intent. The handing person stays eligible.
 * DSAR: the note is the handing person's free text and is erased with them.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { ERASED, subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import { requireProtocolScope } from '../../host/protocolAuthorization.js';
import { getReview, type ReviewAuthCtx } from '../../host/reviewProjection.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { normalizeHandoffRecord, type HandoffRecordV1 } from '../../host/handoff/handoffRecord.js';
import { callerHoldsTenantScope } from '../featureRoute.js';
import { reviewerOf } from '../../routes/interrupts.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('feature.structured-handoffs.approvals');

export interface ApprovalHandoff { key: string; tenantId: string; reviewId: string; to: string; by: string; at: string; note: HandoffRecordV1 }
const rows = new DurableCollection<ApprovalHandoff>('structured-handoffs:approval-handoffs', (h) => h.key, undefined, (h) => h.tenantId);
const keyOf = (tenantId: string, reviewId: string): string => `${tenantId}:${reviewId}`;

export async function getApprovalHandoff(tenantId: string, reviewId: string): Promise<ApprovalHandoff | null> {
  const h = await rows.get(keyOf(tenantId, reviewId));
  return h && h.tenantId === tenantId ? h : null;
}

const tenantOf = (req: Request): string => (req as { tenantId?: string }).tenantId ?? 'default';
const callerOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** Could `userId` decide this review, as far as the inbox can tell? */
async function targetMayDecide(storage: RouteDeps['storage'], tenantId: string, reviewId: string, userId: string): Promise<boolean> {
  const access = await resolveEffectiveAccess(tenantId, { subject: userId }).catch(() => null);
  const holdsRespond = !!access?.scopes.includes('approvals:respond');
  if (!holdsRespond) return false;
  const ctx: ReviewAuthCtx = { tenantId, subjectRef: userId, decider: { holdsRespond, reviewerRef: userId } };
  const review = await getReview(storage, ctx, reviewId).catch(() => null);
  return !!review && review.status === 'pending' && review.canDecide !== false;
}

export function registerApprovalHandoffRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const reviewAs = async (req: Request, reviewId: string) => {
    const tenantId = tenantOf(req);
    const reviewer = await reviewerOf(req);
    const holdsRespond = await callerHoldsTenantScope(req, tenantId, 'approvals:respond');
    const me = callerOf(req);
    const ctx: ReviewAuthCtx = { tenantId, ...(me ? { subjectRef: me } : {}), decider: { holdsRespond, ...('subjectRef' in reviewer ? { reviewerRef: reviewer.subjectRef } : {}) } };
    return { review: await getReview(deps.storage, ctx, reviewId), holdsRespond, me };
  };

  app.get('/host/openwop-app/reviews/:reviewId/handoff', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'runs:read');
      const { review } = await reviewAs(req, req.params.reviewId ?? '');
      if (!review) throw new OpenwopError('not_found', 'Review not found.', 404, {});
      res.json({ handoff: await getApprovalHandoff(tenantOf(req), review.reviewId) });
    } catch (err) { next(err); }
  });

  app.post('/host/openwop-app/reviews/:reviewId/handoff', async (req, res, next) => {
    try {
      await requireProtocolScope(req, 'approvals:respond');
      const tenantId = tenantOf(req);
      const { review, holdsRespond, me } = await reviewAs(req, req.params.reviewId ?? '');
      if (!review) throw new OpenwopError('not_found', 'Review not found.', 404, {});
      if (review.status !== 'pending') throw new OpenwopError('conflict', 'This review is already decided.', 409, { status: review.status });
      if (!me || !holdsRespond || review.canDecide === false) {
        throw new OpenwopError('forbidden', 'Only someone who can decide this review can hand it off.', 403, {});
      }
      const body = (req.body ?? {}) as { to?: unknown; handoff?: unknown };
      const to = typeof body.to === 'string' ? body.to.trim() : '';
      if (!to || to === me) throw new OpenwopError('validation_error', 'Choose someone else to hand this to.', 422, { field: 'to' });
      const note = normalizeHandoffRecord(body.handoff, 'human');
      if (!note) throw new OpenwopError('validation_error', 'A handoff note needs an `intent`.', 400, { field: 'handoff.intent' });
      if (!(await targetMayDecide(deps.storage, tenantId, review.reviewId, to))) {
        // Never grants authority: an ineligible target is refused, named, not silently accepted.
        throw new OpenwopError('validation_error', 'That person is not an approver for this request.', 422, { field: 'to' });
      }
      const h: ApprovalHandoff = { key: keyOf(tenantId, review.reviewId), tenantId, reviewId: review.reviewId, to, by: me, at: new Date().toISOString(), note };
      await rows.put(h);
      try {
        await getNotificationEmitter().emit({
          tenantId, recipientUserId: to, type: 'openwop-app.workflow.approval-needed', priority: 'normal',
          title: 'Handed to you to decide', message: note.intent,
          actionUrl: `/inbox?review=${encodeURIComponent(review.reviewId)}`,
          metadata: { kind: 'review.handoff', reviewId: review.reviewId },
        });
      } catch (err) {
        log.debug('approval_handoff_notify_failed', { error: err instanceof Error ? err.message : String(err) });
      }
      res.status(201).json({ handoff: h });
    } catch (err) { next(err); }
  });
}

/** DSAR: the handing person's note text and identity; the target's identity. */
export async function eraseApprovalHandoffSubject(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const h of await rows.listForTenantIndexed(tenantId)) {
    if (h.tenantId !== tenantId) continue;
    const byThem = forms.has(h.by);
    const toThem = forms.has(h.to);
    if (!byThem && !toThem) continue;
    await rows.put({
      ...h,
      ...(byThem ? { by: ERASED, note: { ...h.note, intent: ERASED, decisions: [], openQuestions: [], tried: [] } } : {}),
      ...(toThem ? { to: ERASED } : {}),
    });
  }
}
export function registerApprovalHandoffErasure(): void { registerSubjectEraser(eraseApprovalHandoffSubject); }
