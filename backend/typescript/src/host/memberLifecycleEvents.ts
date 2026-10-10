/**
 * Member lifecycle side-channel (ADR 0815 D5) — three ids-only host events plus
 * an audit line, only on a real TRANSITION. The `features/orgs/emit.ts` shape:
 * sync `void` verbs wrapping `void emitHostEvent(...)`, never throwing on the
 * caller's path.
 *
 *   host.orgs.member.added          POST …/members, only when a NEW row was
 *                                   written (ADR 0697 D1 converges on an existing
 *                                   root row; an invite acceptance already emits
 *                                   `host.orgs.invitation.accepted`)
 *   host.orgs.member.roles-changed  PATCH …/members/:id when the role SET changed,
 *                                   and both halves of transfer-ownership
 *   host.orgs.member.removed        EVERY `deleteMember` that removed a row — the
 *                                   admin route AND account deletion — via the
 *                                   `onMemberAuthorityLost` seam, after the removal
 *                                   is durable
 *
 * WHY. Adding, re-roling or removing a member left no trace a chain could bind
 * to or an operator could audit: `people-hr.offboarding` reacts to an IdP leaver
 * (`host.users.user.deactivated`) but not to an admin removing someone from ONE
 * workspace, and a grant of `owner` was invisible after the fact.
 *
 * PAYLOAD DISCIPLINE — ids and role ids only: `memberId`, `orgId`, `tenantId`,
 * the role ids, and the member's / ACTOR's subject ONLY when it is OPAQUE
 * (`user:<id>`, `oidc:<sub>` — the class `invitation.accepted` carries as
 * `userId`). A `saml:<NameID>` / `scim:<userName>` subject is very often an email
 * address, and an admin-typed subject is free text, so those are reduced to their
 * kind (`saml:(redacted)`). Never the display name or email. The audience is the
 * tenant's own subscribers, who can already list the members.
 */
import { emitHostEvent } from './hostEventDispatcher.js';
import { createLogger } from '../observability/logger.js';
import { onMemberAuthorityLost } from './accessControlService.js';

const log = createLogger('access.members');

export const MEMBER_ADDED_EVENT = 'host.orgs.member.added';
export const MEMBER_ROLES_CHANGED_EVENT = 'host.orgs.member.roles-changed';
export const MEMBER_REMOVED_EVENT = 'host.orgs.member.removed';

interface MemberRef { memberId: string; orgId: string; tenantId: string; subject?: string }

/** An opaque subject passes; anything else is reduced to its kind. */
export function opaqueSubject(s: string | undefined): string | undefined {
  if (!s) return undefined;
  if (/^(user|oidc):[A-Za-z0-9._-]+$/.test(s)) return s;
  const kind = /^([a-z]+):/.exec(s)?.[1];
  return kind ? `${kind}:(redacted)` : '(redacted)';
}

const ref = (m: MemberRef) => {
  const subject = opaqueSubject(m.subject);
  return { memberId: m.memberId, orgId: m.orgId, tenantId: m.tenantId, ...(subject ? { subject } : {}) };
};

function emit(type: string, line: string, m: MemberRef, body: Record<string, unknown>, actor: string | undefined): void {
  const a = opaqueSubject(actor);
  log.info(line, { ...ref(m), ...body, actor: a ?? 'unknown' });
  void emitHostEvent({ type, tenantId: m.tenantId, payload: { ...ref(m), ...body, ...(a ? { actor: a } : {}) } });
}

export function memberAdded(m: MemberRef & { roles: readonly string[] }, actor: string | undefined): void {
  emit(MEMBER_ADDED_EVENT, 'org_member_added', m, { roles: [...m.roles] }, actor);
}

/** No-op when the role SET did not change (a display-name PATCH, or a reordered
 *  list, is not a role change). */
export function memberRolesChanged(
  m: MemberRef,
  previousRoles: readonly string[],
  roles: readonly string[],
  actor: string | undefined,
): void {
  const a = new Set(previousRoles);
  const b = new Set(roles);
  if (a.size === b.size && [...a].every((r) => b.has(r))) return;
  emit(MEMBER_ROLES_CHANGED_EVENT, 'org_member_roles_changed', m, { previousRoles: [...previousRoles], roles: [...roles] }, actor);
}

/** Subscribe `removed` to the removal seam. Idempotent (the seam dedupes by id);
 *  called from `registerAccessControlRoutes`. */
export function registerMemberLifecycleEvents(): void {
  onMemberAuthorityLost('events.member-removed', async (lost) => {
    if (lost.reason !== 'removed') return 0;
    emit(MEMBER_REMOVED_EVENT, 'org_member_removed', {
      memberId: lost.memberIds[0]!, orgId: lost.orgId, tenantId: lost.tenantId, subject: lost.subject,
    }, { roles: [...lost.roles] }, lost.actor);
    return 1;
  });
}
