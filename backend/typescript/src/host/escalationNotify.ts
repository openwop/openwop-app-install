/**
 * Agent escalation notifications (ADR 0101 Phase 2).
 *
 * When the heartbeat queues a proposal for human review, the agent's
 * `agentProfile.escalation.contacts` get an ADDRESSED in-app notification
 * (ADR 0050 `recipientUserId`) so a person is actually told the agent needs
 * sign-off — until now the proposal sat in the inbox with nobody pinged.
 *
 * Mirrors `kanbanAssignmentNotify` (the addressed-notification pattern): each
 * contact ref is canonicalized to a userId via the shared approver resolver, so
 * "who is escalated to" can't drift from the identity model. Best-effort: a
 * notification failure (or an uninstalled emitter in tests) must never abort the
 * proposal. Fires once per proposal — the heartbeat's `hasPendingApprovalForCard`
 * guard means a re-scan doesn't re-propose, so it doesn't re-notify. Escalation
 * is a heartbeat-time side effect OUTSIDE any run payload, so run replay/fork
 * never re-fires it.
 */

import { getNotificationEmitter } from '../notifications/emitter.js';
import { canonicalReviewerUserId } from './approverResolution.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.agent.escalation');

const ESCALATION_TYPE = 'agent.escalation';

/** Notify an agent's escalation contacts that a proposal needs review.
 *  Best-effort; resolves + de-dupes recipients; never throws to the caller. */
export async function emitEscalationNotifications(args: {
  tenantId: string;
  rosterId: string;
  persona: string;
  contacts: readonly string[];
  cardTitle: string;
  approvalId: string;
}): Promise<void> {
  const contacts = args.contacts.map((c) => c.trim()).filter((c) => c.length > 0);
  if (contacts.length === 0) return;

  // Canonicalize each contact ref (email/subject → bound userId; a bare userId
  // maps to itself). De-dupe so one person isn't pinged twice for one proposal.
  const recipients = new Set<string>();
  for (const c of contacts) {
    try {
      recipients.add(await canonicalReviewerUserId(args.tenantId, c));
    } catch {
      // An unresolvable contact is skipped, never blocks the others.
    }
  }

  for (const recipientUserId of recipients) {
    try {
      await getNotificationEmitter().emit({
        tenantId: args.tenantId,
        recipientUserId,
        type: ESCALATION_TYPE,
        priority: 'high',
        title: `${args.persona} needs your review`,
        message: `${args.persona} queued “${args.cardTitle}” for approval.`,
        actionUrl: '/inbox',
        metadata: { kind: ESCALATION_TYPE, rosterId: args.rosterId, approvalId: args.approvalId },
      });
    } catch (err) {
      // Emitter may be uninstalled (some tests) — escalation never blocks the proposal.
      log.debug('escalation_notify_emit_failed', {
        rosterId: args.rosterId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
