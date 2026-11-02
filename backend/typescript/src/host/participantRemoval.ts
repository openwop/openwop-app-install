/**
 * ADR 0910 D12 — a live operator removes one PARTICIPANT from a declared default
 * workspace. The only member-removal lane the operator has: the members route
 * needs `host:members:manage`, which OQ1 keeps out of the D1 role.
 *
 * The route enforces the REQUEST guards (G1–G3); this module enforces everything
 * else at use time, so a second caller cannot skip it:
 *   - the target passes G6 (`assertOperatorTarget`);
 *   - the actor holds a LIVE activation and still holds the root membership
 *     (D5's predicate);
 *   - a 10–500 character reason;
 *   - the target is a participant (every role `viewer`), not the actor, and not
 *     a listed superadmin.
 *
 * REMOVAL MUST HOLD (ADR 0684 §7). Auto-join fires iff the join record is
 * absent, so the record is claimed (insert-if-absent) BEFORE the row goes: a
 * participant an operator added by hand has no record and would otherwise be
 * re-joined on their next sign-in. The audit row lands first: a failed append
 * removes nothing.
 */
import { appendAudit } from './auditChainService.js';
import { deleteMember, getMember, listMembers, relationshipRoles, type OrgMember } from './accessControlService.js';
import { assertOperatorTarget, operatorSelfApprovalActivation } from './operatorAccess.js';
import { claimJoin } from './workspaceJoinLedger.js';
import { isListedSuperadminTenant } from './superadmin.js';
import { getUser } from '../features/users/usersService.js';
import { createLogger } from '../observability/logger.js';
import { OpenwopError } from '../types.js';

const log = createLogger('host.participantRemoval');

export const REMOVAL_REASON_MIN = 10;
export const REMOVAL_REASON_MAX = 500;

export interface RemoveParticipantInput {
  workspaceId: string;
  /** The acting person (`req.userId`), verified by the route (G2). */
  actor: string;
  /** A member id, or an exact display name / email on a root member row. */
  member: unknown;
  reason: unknown;
  dryRun?: boolean;
}

export interface RemovedParticipant { memberId: string; displayName: string; removed: boolean }

const refuse = (code: string, message: string): OpenwopError => new OpenwopError('forbidden', message, 403, { code });

async function resolveTarget(workspaceId: string, query: string): Promise<OrgMember> {
  const byId = await getMember(query);
  if (byId && byId.tenantId === workspaceId && byId.orgId === workspaceId) return byId;
  // A cold, operator-initiated path; `deleteMember` reads the full roster too.
  const q = query.toLowerCase();
  const matches = (await listMembers(workspaceId, workspaceId))
    .filter((m) => m.displayName.toLowerCase() === q || m.email?.toLowerCase() === q);
  // One person can have several rows (ADR 0697 twins); they are one match.
  const people = new Map(matches.map((m) => [m.subject ?? m.memberId, m]));
  if (people.size === 0) throw new OpenwopError('not_found', 'No participant matches that.', 404);
  if (people.size > 1) {
    throw new OpenwopError('conflict', 'More than one participant matches; use their member id.', 409, { code: 'ambiguous', count: people.size });
  }
  return [...people.values()][0]!;
}

export async function removeParticipant(input: RemoveParticipantInput): Promise<RemovedParticipant> {
  await assertOperatorTarget(input.workspaceId);
  const activationId = await operatorSelfApprovalActivation(input.workspaceId, input.actor);
  if (!activationId) throw refuse('operator_activation_required', 'Removing a participant needs live operator access.');

  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (reason.length < REMOVAL_REASON_MIN || reason.length > REMOVAL_REASON_MAX) {
    throw new OpenwopError('validation_error', `A reason of ${REMOVAL_REASON_MIN}-${REMOVAL_REASON_MAX} characters is required.`, 400, { field: 'reason' });
  }
  const query = typeof input.member === 'string' ? input.member.trim() : '';
  if (!query) throw new OpenwopError('validation_error', 'Say who to remove.', 400, { field: 'member' });

  const target = await resolveTarget(input.workspaceId, query);
  if (target.subject === input.actor) throw refuse('cannot_remove_self', 'You cannot remove yourself.');
  const roles = await relationshipRoles(target.memberId);
  if (roles.some((r) => r !== 'viewer')) {
    throw refuse('not_a_participant', 'Only participants can be removed here; manage other members under Access.');
  }
  if (target.subject) {
    // Fail closed: a user read that throws refuses rather than guessing "not listed".
    const user = await getUser(target.subject);
    if (user && isListedSuperadminTenant(user.tenantId)) throw refuse('cannot_remove_superadmin', 'A listed superadmin cannot be removed here.');
  }

  if (input.dryRun === true) return { memberId: target.memberId, displayName: target.displayName, removed: false };

  await appendAudit(input.workspaceId, 'security.operator-participant-removed', {
    activationId, by: input.actor, memberId: target.memberId, ...(target.subject ? { memberSubject: target.subject } : {}), reason,
  });
  if (target.subject) await claimJoin({ subject: target.subject, workspaceId: input.workspaceId, orgId: input.workspaceId });
  const removed = await deleteMember(target.memberId, { actor: input.actor });
  log.info('operator_participant_removed', { workspaceId: input.workspaceId, activationId, removed });
  return { memberId: target.memberId, displayName: target.displayName, removed };
}
