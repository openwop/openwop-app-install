/**
 * Org-invitation lifecycle side-channel (ADR 0622 D1 / ADR 0208 §1) — four
 * ids-only host events, each emitted from exactly ONE site and ONLY on a state
 * TRANSITION. The `features/users/emit.ts` shape (sync `void` verbs wrapping
 * `void emitHostEvent(...)`, never throwing on the caller's path):
 *
 *   host.orgs.invitation.created    `invitationsService.createInvitationAndDeliver`
 *                                   — the ONE composition owner (route AND the
 *                                   workflow surface), AFTER the delivery
 *                                   decision and the supersede step. A mint that
 *                                   was rolled back (prod undeliverable) never
 *                                   emits.
 *   host.orgs.invitation.accepted   `invitationsService.acceptInvitation`, ONE
 *                                   site after the claim + member-create
 *                                   try/catch — never on the restore-on-failure
 *                                   path, and the `alreadyMember` branch is the
 *                                   SAME site (a flag, not a second event).
 *   host.orgs.invitation.revoked    the revoke ROUTE only — `revokeInvitation`
 *                                   is also the D5 rollback primitive and must
 *                                   not fan out.
 *   host.orgs.invitation.declined   `invitationsService.declineInvitation` on the
 *                                   CAS-won pending→declined transition only; an
 *                                   idempotent re-decline emits nothing.
 *
 * PAYLOAD DISCIPLINE — the emitter's rule, not the dispatcher's. The recipient
 * EMAIL and the TOKEN are never placed here (nor the token hash): the payload is
 * the opaque `inviteId`, `orgId`, `tenantId`, the role granted, the delivery
 * outcome, and (accepted) the resulting `memberId` / `userId`. `stripPiiPayload`
 * would strip an `email` key, but the rule is enforced HERE and pinned by
 * `test/orgs-lifecycle-host-events.test.ts` (literal key sets).
 *
 * ADR 0617 D1a — `origin` is stamped ONLY by the workflow surface
 * (`surface.ts`) so the dispatcher's self-trigger / chain-lineage guard can
 * refuse to restart the very chain (or a sibling instance) whose `invite-host`
 * step emitted `created`.
 */
import { emitHostEvent, type HostEventOrigin } from '../../host/hostEventDispatcher.js';
import type { InvitableRole } from './invitationsService.js';

export const INVITATION_CREATED_EVENT = 'host.orgs.invitation.created';
export const INVITATION_ACCEPTED_EVENT = 'host.orgs.invitation.accepted';
export const INVITATION_REVOKED_EVENT = 'host.orgs.invitation.revoked';
export const INVITATION_DECLINED_EVENT = 'host.orgs.invitation.declined';

/** The prior row's status when a mint superseded an earlier (org, email) invite —
 *  a declined row re-invited is the inviter's explicit, visible choice (ADR 0564). */
export type SupersededStatus = 'pending' | 'declined';

export function invitationCreated(input: {
  inviteId: string;
  orgId: string;
  tenantId: string;
  role: InvitableRole;
  delivery: 'sent' | 'skipped';
  superseded: boolean;
  previousStatus?: SupersededStatus;
  origin?: HostEventOrigin;
}): void {
  void emitHostEvent({
    type: INVITATION_CREATED_EVENT,
    tenantId: input.tenantId,
    payload: {
      inviteId: input.inviteId,
      orgId: input.orgId,
      tenantId: input.tenantId,
      role: input.role,
      delivery: input.delivery,
      superseded: input.superseded,
      ...(input.previousStatus ? { previousStatus: input.previousStatus } : {}),
    },
    ...(input.origin ? { origin: input.origin } : {}),
  });
}

export function invitationAccepted(input: {
  inviteId: string;
  orgId: string;
  tenantId: string;
  memberId: string;
  userId: string;
  role: InvitableRole;
  alreadyMember: boolean;
}): void {
  void emitHostEvent({
    type: INVITATION_ACCEPTED_EVENT,
    tenantId: input.tenantId,
    payload: {
      inviteId: input.inviteId,
      orgId: input.orgId,
      tenantId: input.tenantId,
      memberId: input.memberId,
      userId: input.userId,
      role: input.role,
      alreadyMember: input.alreadyMember,
    },
  });
}

/** Emitted ONLY by the admin revoke route (the row existed) — never by the
 *  rollback / replace-at-mint deletes, which are row deaths, not business events. */
export function invitationRevoked(input: { inviteId: string; orgId: string; tenantId: string }): void {
  void emitHostEvent({
    type: INVITATION_REVOKED_EVENT,
    tenantId: input.tenantId,
    payload: { inviteId: input.inviteId, orgId: input.orgId, tenantId: input.tenantId },
  });
}

export function invitationDeclined(input: { inviteId: string; orgId: string; tenantId: string }): void {
  void emitHostEvent({
    type: INVITATION_DECLINED_EVENT,
    tenantId: input.tenantId,
    payload: { inviteId: input.inviteId, orgId: input.orgId, tenantId: input.tenantId },
  });
}
