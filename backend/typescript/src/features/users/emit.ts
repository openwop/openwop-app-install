/**
 * Users lifecycle side-channel (ADR 0617 D1 / ADR 0208 §1) — four ids-only
 * account-lifecycle host events, each emitted from exactly ONE site and ONLY on
 * a state TRANSITION:
 *
 *   host.users.user.provisioned   `usersService.createUser` (new row only; the
 *                                 demo seed passes `{ silent: true }`)
 *   host.users.user.deactivated   `usersService.setUserStatus(id, 'disabled', …)`
 *                                 iff the row was not already disabled
 *   host.users.user.reactivated   same site, `'active'`, iff not already active
 *   host.users.user.erased        the erase route, AFTER `deleteUser` succeeds
 *
 * PAYLOAD DISCIPLINE — the emitter's rule, not the dispatcher's. `stripPiiPayload`
 * only strips `email`/`phone`-shaped keys, so `userName` / `externalId` / a SAML
 * `NameID` would pass it. None of them is ever placed here: the payload is the
 * opaque `userId` (declared non-PII, `usersService.ts` `declarePiiFields`), the
 * `tenantId`, the auth `source` (`password`/`oidc`/`saml`/`scim`/`manual` — a
 * provenance enum, not a person field), and for a status change the explicit
 * `reason`. `test/users-lifecycle-host-events.test.ts` pins the literal key set.
 *
 * Fire-and-forget by contract (`emitHostEvent` never throws) — a fanout failure
 * can never fail the lifecycle write. Mirrors `forms/emit.ts`.
 *
 * ADR 0617 D1a — `origin` is stamped ONLY by the workflow surface
 * (`surface.ts`): the dispatcher skips a binding whose `workflowId` equals the
 * emitting run's workflow, so a human-started offboarding run whose
 * `deprovision-host` step disables the account cannot start a SECOND run of the
 * very chain that is executing (a self-trigger that would re-fire the chain's
 * ungated entry nodes).
 */
import { emitHostEvent, type HostEventOrigin } from '../../host/hostEventDispatcher.js';
import type { UserSource } from './usersService.js';

/** Who asked for the status change — an EXPLICIT argument on `setUserStatus`,
 *  never inferred from `user.source` (an admin can disable a SCIM-sourced row). */
export type LifecycleReason = 'admin' | 'scim' | 'workflow';

export const USER_PROVISIONED_EVENT = 'host.users.user.provisioned';
export const USER_DEACTIVATED_EVENT = 'host.users.user.deactivated';
export const USER_REACTIVATED_EVENT = 'host.users.user.reactivated';
export const USER_ERASED_EVENT = 'host.users.user.erased';

export function userProvisioned(input: { userId: string; tenantId: string; source: UserSource }): void {
  void emitHostEvent({
    type: USER_PROVISIONED_EVENT,
    tenantId: input.tenantId,
    payload: { userId: input.userId, tenantId: input.tenantId, source: input.source },
  });
}

export function userDeactivated(input: {
  userId: string;
  tenantId: string;
  source: UserSource;
  reason: LifecycleReason;
  origin?: HostEventOrigin;
}): void {
  void emitHostEvent({
    type: USER_DEACTIVATED_EVENT,
    tenantId: input.tenantId,
    payload: { userId: input.userId, tenantId: input.tenantId, source: input.source, reason: input.reason },
    ...(input.origin ? { origin: input.origin } : {}),
  });
}

export function userReactivated(input: {
  userId: string;
  tenantId: string;
  source: UserSource;
  reason: LifecycleReason;
  origin?: HostEventOrigin;
}): void {
  void emitHostEvent({
    type: USER_REACTIVATED_EVENT,
    tenantId: input.tenantId,
    payload: { userId: input.userId, tenantId: input.tenantId, source: input.source, reason: input.reason },
    ...(input.origin ? { origin: input.origin } : {}),
  });
}

/** Emitted ONLY after `deleteUser` succeeded — never on the `failed > 0`
 *  erasure throw (a "failed" `erased` event would be a false claim). */
export function userErased(input: { userId: string; tenantId: string; outcome: 'deleted' }): void {
  void emitHostEvent({
    type: USER_ERASED_EVENT,
    tenantId: input.tenantId,
    payload: { userId: input.userId, tenantId: input.tenantId, outcome: input.outcome },
  });
}
