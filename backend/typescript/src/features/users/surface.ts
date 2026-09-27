/**
 * Users workflow surface (ADR 0617 D2) — `ctx.features.users`, the host-side
 * body of the `feature.users.nodes` pack: `deactivate({ userId })` and
 * `reactivate({ userId })`. The pack nodes do ZERO auth; everything that
 * decides is here, and it is the SAME predicate the HTTP admin routes use.
 *
 * AUTHORITY, in order, each a NAMED refusal (never a bare 403):
 *   1. an acting user MUST exist — `scope.actingUserId` (ADR 0024 §4) is absent
 *      on SYSTEM runs (schedule, inbound webhook, and an EVENT-STARTED run: the
 *      host-event dispatcher stamps no `actingUserId`), so a system run is
 *      refused with an exit that says how to get one. Fail-closed is the design,
 *      not a gap: on the SCIM-leaver lane the host account is ALREADY disabled
 *      at the identity write (ADR 0621), and this node is for the HUMAN-started
 *      lane (an HR admin running `people-hr.offboarding` for a non-SCIM account).
 *   2. the acting user MUST be `active` per the ADR 0621 session authority
 *      (`resolveSessionSubject`) — a run suspended at an approval gate before its
 *      actor was disabled must not execute this on resume (review SHOULD-10).
 *   3. `assertTenantScope(scope.tenantId, actingUserId, 'host:members:manage')`
 *      — the ONE predicate `users/routes.ts` disable/enable/delete call through
 *      `requireTenantScope` (CLAUDE.md "route + tool share one predicate").
 *      `personalTenant` is derived from the actor's OWN row and ONLY when it has
 *      a personal shape (`isPersonalTenantId` — `user:`/`anon:`), so the
 *      implicit-owner short-circuit can never fire for a SAML/deployment tenant
 *      (`USERS-19`). `wildcardOperator` is NEVER passed on this lane: a `*`
 *      operator's run fails closed like any non-member.
 *   4. the TARGET must belong to `scope.tenantId` (IDOR) — a foreign or unknown
 *      id is a uniform 404, never an existence leak;
 *   5. `deactivate` refuses the actor's OWN row (`409 self_lockout`, ADR 0621 D7).
 *
 * The status write is `setUserStatus(…, { reason: 'workflow', origin })` — the
 * ONE lifecycle owner, so the event is emitted there (transition-guarded) and
 * carries `origin: { runId, workflowId }` for the dispatcher's self-trigger
 * guard (ADR 0617 D1a). Outputs are ids-only.
 *
 * REPLAY / FORK: the protection is NOT here — both nodes declare
 * `role: "side-effect"` in the pack manifest (derived floor) AND carry an
 * explicit `SIDE_EFFECTING_TYPE_PATTERNS` entry (`executor/sideEffects.ts`), so
 * a `:fork` is served the recorded outcome and this function is never re-run
 * for it. Pinned by `test/users-node-replay.test.ts`.
 *
 * Cost, stated: `assertTenantScope` → `resolveSubjectScopesUnion` does three
 * full `list()`s per call (`accessControlService.ts`); the node lane pays it per
 * execution, exactly as the route does per request.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { assertTenantScope } from '../../host/accessControlService.js';
import { isPersonalTenantId } from '../../host/requestSubject.js';
import { resolveSessionSubject } from '../../host/sessionAuthority.js';
import type { HostEventOrigin } from '../../host/hostEventDispatcher.js';
import { surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { getUser, setUserStatus, type User, type UserStatus } from './usersService.js';

const MANAGE = 'host:members:manage' as const;

export function buildUsersSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const actingUserId = scope.actingUserId;
  const origin: HostEventOrigin = {
    ...(scope.runId ? { runId: scope.runId } : {}),
    ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
    // Review BLOCKER-1 — chain lineage: a sibling from-chain instance of the
    // same chain (another employee's offboarding) must not start either.
    ...(scope.chainId ? { chainId: scope.chainId } : {}),
  };

  /** Steps 1–3: who is acting, are they live, do they hold the scope HERE. */
  const authorize = async (): Promise<string> => {
    if (!actingUserId) {
      throw new OpenwopError(
        'forbidden_scope',
        'Changing an account status from a workflow requires an acting user: this run carries no principal (a schedule, webhook or host-event-started run), so `host:members:manage` cannot be checked. '
        + 'Start the run from a human-initiated context (the run owner is stamped at creation and survives :fork). On the SCIM-leaver lane the host account is already disabled at the identity write, so this step is for the human-started lane.',
        403,
        { requiredScope: MANAGE, reason: 'no_acting_user' },
      );
    }
    // ADR 0621 — the SAME authority the auth middleware consults per request.
    const live = await resolveSessionSubject(actingUserId);
    if (!live || live.status !== 'active') {
      throw new OpenwopError(
        'forbidden_scope',
        'The run\'s acting user is no longer active, so it cannot change another account\'s status.',
        403,
        { requiredScope: MANAGE, reason: live ? 'acting_user_disabled' : 'acting_user_erased' },
      );
    }
    const actor = await getUser(actingUserId);
    // A `user:`-prefixed home tenant is single-human by construction; only that
    // shape may satisfy the implicit-owner short-circuit (USERS-19).
    const personalTenant = actor && isPersonalTenantId(actor.tenantId) ? actor.tenantId : undefined;
    await assertTenantScope(tenantId, actingUserId, MANAGE, { ...(personalTenant ? { personalTenant } : {}) });
    return actingUserId;
  };

  /** Step 4: the target, tenant-guarded (uniform 404 on foreign/unknown). */
  const resolveTarget = async (raw: unknown): Promise<User> => {
    const userId = str(raw);
    if (!userId) throw new OpenwopError('validation_error', '`userId` is required.', 400, { field: 'userId' });
    const target = await getUser(userId);
    if (!target || target.tenantId !== tenantId) {
      throw new OpenwopError('not_found', 'User not found.', 404, { userId });
    }
    return target;
  };

  const transition = async (raw: unknown, status: UserStatus): Promise<{ userId: string; status: UserStatus }> => {
    const actor = await authorize();
    const target = await resolveTarget(raw);
    if (status === 'disabled' && target.userId === actor) {
      throw new OpenwopError('self_lockout', 'A workflow cannot disable the account of the user who started it. Ask another administrator.', 409, { action: 'deactivate', userId: target.userId });
    }
    const updated = await setUserStatus(target.userId, status, { reason: 'workflow', origin });
    if (!updated) throw new OpenwopError('not_found', 'User not found.', 404, { userId: target.userId });
    return { userId: updated.userId, status: updated.status };
  };

  return {
    deactivate: async (args) => transition(args.userId, 'disabled'),
    reactivate: async (args) => transition(args.userId, 'active'),
  };
}
