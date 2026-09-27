/**
 * Orgs workflow surface (ADR 0622 D2) — `ctx.features.orgs`, the host-side body
 * of the `feature.orgs.nodes` pack: `invite({ orgId?, email, role })`,
 * `listInvitations({ orgId? })` and `revokeInvitation({ orgId?, inviteId })`.
 * The pack nodes do ZERO auth; everything that decides is here, and it is the
 * SAME org-scoped predicate the HTTP invite routes use.
 *
 * AUTHORITY, in order, each a NAMED refusal (never a bare 403):
 *   1. an acting user MUST exist — `scope.actingUserId` (ADR 0024 §4) is absent
 *      on SYSTEM runs (schedule, inbound webhook, and an EVENT-STARTED run), so
 *      a system run is refused with an exit that says how to get one. This is
 *      not only RBAC: delivery brokers the ACTOR's own email connection
 *      (`connectionsService` matches `c.userId === actingUserId`), so without a
 *      human there is nobody's mailbox to send from.
 *   2. the acting user MUST be `active` per the ADR 0621 session authority
 *      (`resolveSessionSubject`) — a bearer-started run's `actingUserId` is a
 *      principalId, which resolves to null here and is refused; a run suspended
 *      at a gate before its actor was disabled must not invite on resume.
 *   3. `assertOrgScope(scope.tenantId, actingUserId, orgId, 'host:members:manage',
 *      { personalTenant })` — the ONE org-scoped predicate `orgs/routes.ts`
 *      `requireMemberManage` wraps (CLAUDE.md "route + tool share one predicate").
 *      `personalTenant` is derived from the actor's OWN row and ONLY when it has
 *      a personal shape (`isPersonalTenantId`), so the implicit-owner
 *      short-circuit can never fire for a SAML/deployment tenant (USERS-19).
 *      The act-as header is HTTP-only and never reaches this lane.
 *   4. `orgId` defaults to `scope.tenantId` — a workspace root has
 *      `orgId === tenantId` (`accessControlService.ts` workspaces) — and
 *      `assertOrgScope` still 404s when no root org row exists; a foreign org
 *      is a uniform 404, never an existence leak.
 *
 * THE ACCEPT LINK HAS NO `req` IN A RUN: the base URL is read from
 * `OPENWOP_PUBLIC_BASE_URL` (the `emailApprovalDelivery.ts` precedent) and the
 * surface REFUSES with a typed `no_public_base_url` when it is unset — never a
 * relative link, never a request-derived host.
 *
 * ONE composition owner: `invite` calls `invitationsService.createInvitationAndDeliver`
 * with `tokenEchoed: false` (the surface NEVER returns the token — a skipped
 * delivery is a zombie row and is rolled back with a typed 422) and
 * `origin: { runId, workflowId, chainId }` (ADR 0617 D1a — the dispatcher's
 * self-trigger / chain-lineage guard), threading `scope.runId` so the brokered
 * send stamps the REAL run's connection use. Outputs are ids-only; the surface
 * never returns `email` (a chain that needs the address holds it as its own
 * parameter — ADR 0622 open question 1, default no).
 *
 * REPLAY / FORK: `feature.orgs.nodes.invite` declares `role: "side-effect"`
 * (derived floor) AND carries an explicit `SIDE_EFFECTING_TYPE_PATTERNS` entry
 * (`executor/sideEffects.ts`), so a `:fork` is served the recorded outcome —
 * a re-executed mint would be a NEW `inviteId` that kills the previously
 * emailed link. Pinned by `test/orgs-node-replay.test.ts`.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { assertOrgScope } from '../../host/accessControlService.js';
import { isPersonalTenantId } from '../../host/requestSubject.js';
import { resolveSessionSubject } from '../../host/sessionAuthority.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import type { HostEventOrigin } from '../../host/hostEventDispatcher.js';
import { surfaceOptStr, surfaceStr as str, type FeatureSurface } from '../../host/featureSurfaces.js';
import { configuredPublicBaseUrl } from '../featureRoute.js';
import { getUser, type User } from '../users/usersService.js';
import {
  createInvitationAndDeliver,
  inviteErrorToHttp,
  invitationStatusOf,
  listInvitations,
  revokeInvitation,
  type InvitationStatus,
} from './invitationsService.js';

const MANAGE = 'host:members:manage' as const;

interface SurfaceInvitation {
  inviteId: string;
  role: string;
  status: InvitationStatus;
  expiresAt: string;
}

/** The deploy's public origin for the accept link, or `undefined` when unset. */
export function buildOrgsSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const actingUserId = scope.actingUserId;
  const origin: HostEventOrigin = {
    ...(scope.runId ? { runId: scope.runId } : {}),
    ...(scope.workflowId ? { workflowId: scope.workflowId } : {}),
    ...(scope.chainId ? { chainId: scope.chainId } : {}),
  };

  /** Steps 1–3: who is acting, are they live, do they hold the scope in THIS org. */
  const authorize = async (orgId: string): Promise<User> => {
    if (!actingUserId) {
      throw new OpenwopError(
        'forbidden_scope',
        'Inviting into a workspace from a workflow requires an acting user: this run carries no principal (a schedule, webhook or host-event-started run), so `host:members:manage` cannot be checked and there is no email connection to deliver from. '
        + 'Start the run from a human-initiated context (the run owner is stamped at creation and survives :fork).',
        403,
        { requiredScope: MANAGE, reason: 'no_acting_user' },
      );
    }
    // `actingUserId` is the RAW `req.userId ?? principalId` a run was started
    // under, so an unbound-OIDC (`oidc:<sub>`), API-key (`apikey:`) or bearer
    // (`bearer:`) principal can land here. Only a durable `user:<id>` has a row
    // the session authority can vouch for; refuse the other shapes by NAME
    // instead of reporting them as an erased human (the authority's `null`
    // used to be read that way — review nit, ADR 0622 § Implementation record).
    if (!actingUserId.startsWith('user:')) {
      throw new OpenwopError(
        'forbidden_scope',
        'Inviting into a workspace from a workflow requires a bound, durable acting user; this run was started under a principal that is not one (an API key, a raw bearer, or an unbound sign-in). Bind the sign-in first, then start the run.',
        403,
        { requiredScope: MANAGE, reason: 'acting_user_not_durable' },
      );
    }
    // ADR 0621 — the SAME authority the auth middleware consults per request.
    const live = await resolveSessionSubject(actingUserId);
    if (!live || live.status !== 'active') {
      throw new OpenwopError(
        'forbidden_scope',
        'The run\'s acting user is no longer active, so it cannot manage invitations.',
        403,
        { requiredScope: MANAGE, reason: live ? 'acting_user_disabled' : 'acting_user_erased' },
      );
    }
    const actor = await getUser(actingUserId);
    if (!actor) {
      throw new OpenwopError('forbidden_scope', 'The run\'s acting user no longer exists.', 403, { requiredScope: MANAGE, reason: 'acting_user_erased' });
    }
    // A `user:`-prefixed home tenant is single-human by construction; only that
    // shape may satisfy the implicit-owner short-circuit (USERS-19).
    const personalTenant = isPersonalTenantId(actor.tenantId) ? actor.tenantId : undefined;
    await assertOrgScope(tenantId, actingUserId, orgId, MANAGE, { ...(personalTenant ? { personalTenant } : {}) });
    return actor;
  };

  /** Step 4: the org — explicit, else the run's workspace root. */
  const resolveOrgId = (raw: unknown): string => surfaceOptStr(raw) ?? tenantId;

  return {
    invite: async (args) => {
      const orgId = resolveOrgId(args.orgId);
      const actor = await authorize(orgId);
      const baseUrl = configuredPublicBaseUrl();
      if (!baseUrl) {
        throw new OpenwopError(
          'capability_not_provided',
          'Inviting from a workflow needs the deployment\'s public origin for the accept link: set OPENWOP_PUBLIC_BASE_URL on the host. A run has no request to derive it from, and a relative link would be unusable.',
          501,
          { reason: 'no_public_base_url', env: 'OPENWOP_PUBLIC_BASE_URL' },
        );
      }
      const email = str(args.email).trim();
      if (!email) throw new OpenwopError('validation_error', '`email` is required.', 400, { field: 'email' });
      const out = await createInvitationAndDeliver({
        storage: hostExtStorage(),
        tenantId,
        orgId,
        email,
        role: surfaceOptStr(args.role) ?? 'viewer',
        actingUserId: actor.userId,
        createdBy: actor.userId,
        ...(actor.displayName || actor.email ? { createdByName: actor.displayName || actor.email } : {}),
        baseUrl,
        tokenEchoed: false,
        origin,
        ...(scope.runId ? { runId: scope.runId } : {}),
      }).catch(inviteErrorToHttp);
      return { inviteId: out.invite.inviteId, orgId: out.invite.orgId, delivery: out.delivery.outcome };
    },

    listInvitations: async (args) => {
      const orgId = resolveOrgId(args.orgId);
      await authorize(orgId);
      const rows = await listInvitations(tenantId, orgId).catch(inviteErrorToHttp);
      const invitations: SurfaceInvitation[] = rows.map((i) => ({ inviteId: i.inviteId, role: i.role, status: invitationStatusOf(i), expiresAt: i.expiresAt }));
      return { orgId, invitations, count: invitations.length };
    },

    revokeInvitation: async (args) => {
      const orgId = resolveOrgId(args.orgId);
      await authorize(orgId);
      const inviteId = str(args.inviteId);
      if (!inviteId) throw new OpenwopError('validation_error', '`inviteId` is required.', 400, { field: 'inviteId' });
      // ADR 0622 D1 — `revoked` is the admin ROUTE's event; the service
      // primitive (also the D5 rollback) fans out nothing, and neither does
      // this lane (one emit site per event).
      await revokeInvitation(tenantId, orgId, inviteId).catch(inviteErrorToHttp);
      return { inviteId, orgId, revoked: true };
    },
  };
}
