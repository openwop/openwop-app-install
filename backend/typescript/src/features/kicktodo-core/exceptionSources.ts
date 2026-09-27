/**
 * ADR 0460 Phase 2 — the KickTodo APPROVALS exception source.
 *
 * The shared approvals queue is a host owner; this source projects the
 * KICKTODO-relevant pending approvals into the Exception Ledger. It READS the
 * queue (`listApprovals`, tenant-indexed) and never mutates it — the decision
 * still happens on the owning surface the row deep-links to.
 */

import { listApprovals, type PendingApproval } from '../../host/approvalService.js';
import {
  registerExceptionSource,
  type ExceptionRow,
  type ExceptionSeverity,
  type ExceptionOwner,
} from '../../host/exceptionProjection.js';

const SOURCE_KEY = 'kicktodo:approvals';

/** Only the KickTodo-owned approval kinds surface here (host approvals for other
 *  features have their own admin surfaces). */
const KICKTODO_APPROVAL_KINDS = new Set<NonNullable<PendingApproval['kind']>>([
  'challenge-publish',
  'community-profile',
  'community-review',
  'connect-seller',
  'kicktodo-plan-proposal',
]);

/** The OWNING surface each kind's decision is made on (the one safe deep-link). */
function approvalHref(kind: PendingApproval['kind']): string {
  switch (kind) {
    case 'community-profile':
    case 'community-review':
      return '/admin/kicktodo/safety';
    case 'connect-seller':
      return '/admin/kicktodo/commerce';
    default:
      // Publish + plan-proposal decisions are made in the chat Reviews rail (ADR 0458 P4).
      return '/chat';
  }
}

function approvalSeverity(kind: PendingApproval['kind']): ExceptionSeverity {
  // Community moderation is attention; a publish/onboarding decision blocks a
  // creator/seller flow → action-required.
  return kind === 'community-profile' || kind === 'community-review' ? 'attention' : 'action-required';
}

// ADR 0464 — a DSAR-anonymized subject field carries this sentinel; an owner chip
// naming '[erased]' is noise, so such rows fall through to the agent/system owner.
const ERASED_OWNER_SENTINEL = '[erased]';
const realRef = (ref: string | undefined): ref is string =>
  ref !== undefined && ref !== '' && ref !== ERASED_OWNER_SENTINEL && ref !== `user:${ERASED_OWNER_SENTINEL}`;

function approvalOwner(a: PendingApproval): ExceptionOwner {
  // Plan-proposal's decider is the participant (inverse separation-of-duties);
  // publication's owner is the submitter; otherwise the proposing agent.
  const participantRef = a.policy?.approverRefs?.[0];
  if (a.kind === 'kicktodo-plan-proposal' && realRef(participantRef)) {
    return { kind: 'user', ref: participantRef, label: 'participant' };
  }
  const submitterRef = a.challengePublish?.submittedBy;
  if (a.kind === 'challenge-publish' && realRef(submitterRef)) {
    return { kind: 'user', ref: submitterRef, label: 'submitter' };
  }
  if (a.rosterId) return { kind: 'agent', ref: a.rosterId, label: a.persona || a.rosterId };
  return { kind: 'system', ref: 'system', label: 'system' };
}

async function kicktodoApprovalsSource(tenantId: string): Promise<ExceptionRow[]> {
  if (!tenantId) return [];
  const pending = await listApprovals(tenantId, 'pending');
  return pending
    .filter((a) => a.kind !== undefined && KICKTODO_APPROVAL_KINDS.has(a.kind))
    .map((a) => ({
      id: `approval:${a.approvalId}`,
      source: SOURCE_KEY,
      severity: approvalSeverity(a.kind),
      label: a.proposal || `${a.kind ?? 'approval'} awaiting a decision`,
      owner: approvalOwner(a),
      action: { labelKey: 'exceptionActionReview', href: approvalHref(a.kind) },
      audit: { detectedAt: a.createdAt, tenantId },
    }));
}

export function registerKicktodoApprovalsExceptionSource(): void {
  registerExceptionSource(SOURCE_KEY, kicktodoApprovalsSource);
}
