/**
 * Separation of duties for approval kinds (ADR 0905 D3, hoisted from
 * `features/cms/contentApproval.ts`, ADR 0859 D4 / ADR 0845 D5).
 *
 * The submitter may not approve their own submission while someone else can. A sole
 * approver is never locked out (a one-admin workspace is the default state). A row with
 * no recorded submitter is allowed and logged: refusing would count every approver as
 * "distinct" and strand the review. An identity that cannot be canonicalised (an
 * unresolvable delegated key) is treated as the submitter: fail closed.
 *
 * Kind-specific questions stay with the kind: whether the check applies at all (its
 * kind, its status, whether its gate is in force) and WHO else could approve. This
 * module owns only the identity comparison, so two kinds cannot drift on it.
 */
import { canonicalDecider } from './delegatedSubject.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.approvalSelfCheck');

export interface SelfApprovalQuestion {
  tenantId: string;
  approvalId: string;
  decidedBy: string;
  /** Everyone who submitted (and, for CMS, caused an actorless submit). */
  submitters: readonly string[];
  /** Is there an approver who is neither `decider` nor any of `exclude`? */
  otherApproverExists: (decider: string, exclude: string[]) => Promise<boolean>;
  /** Log prefix, e.g. `cms_review` / `email_review`. */
  logTag: string;
}

export async function selfApprovalBlockedCore(q: SelfApprovalQuestion): Promise<boolean> {
  if (q.submitters.length === 0) {
    log.warn(`${q.logTag}_unbound_submitter`, { tenantId: q.tenantId, approvalId: q.approvalId });
    return false;
  }
  const decider = await canonicalDecider(q.tenantId, q.decidedBy);
  const subs = await Promise.all(q.submitters.map((s) => canonicalDecider(q.tenantId, s)));
  const isSubmitter = decider === null || subs.some((s) => s === null || s === decider);
  if (!isSubmitter) return false;
  // "Someone else can approve" means someone who is neither the decider nor ANY
  // submitter (code grade CMSA2CD-3): two approvers who both submitted must not each be
  // refused for the other. Unresolvable submitters are excluded in their raw form.
  const others = q.submitters.map((s, i) => subs[i] ?? s);
  return q.otherApproverExists(decider ?? q.decidedBy, others);
}
