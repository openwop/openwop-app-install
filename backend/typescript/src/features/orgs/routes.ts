/**
 * Org invitations routes (host-extension, best-effort — ADR 0004, reconciled).
 *
 * Surface — these paths are ADDITIVE to the `accessControl` org surface, NOT a
 * duplicate of it. Management routes are toggle-gated on the CALLER's `orgs`
 * toggle + signed-in; preview/accept gate on the INVITE's tenant inside the
 * service (R2 F6 + ORGINV-1 — the recipient's own tenant may not have the
 * feature enabled under a per-tenant rollout):
 *   POST   /v1/host/openwop-app/orgs/:orgId/invites          invite { email, role }   [host:members:manage]
 *   GET    /v1/host/openwop-app/orgs/:orgId/invites          list pending invites     [host:members:manage]
 *   DELETE /v1/host/openwop-app/orgs/:orgId/invites/:id      revoke                   [host:members:manage]
 *   GET    /v1/host/openwop-app/orgs/invitations/preview     preview ?token=           (unauthenticated)
 *   POST   /v1/host/openwop-app/orgs/invitations/accept      accept { token }
 *   POST   /v1/host/openwop-app/orgs/invitations/decline     decline { token }        (ADR 0564 / ADR 0622 D4)
 *
 * LIFECYCLE EVENTS (ADR 0622 D1): `created` / `accepted` / `declined` are the
 * SERVICE's (one site each); `revoked` is emitted HERE, by the admin revoke
 * route only — `revokeInvitation` doubles as the D5 rollback primitive.
 *
 * Orgs / members / roles themselves live in `accessControl` (the single owner).
 * AUTHORIZATION delegates to accessControl's RFC 0049 scope model
 * (`resolveEffectiveAccess`) — there is NO parallel membership tier. The
 * accepting IDENTITY comes from the users feature (`resolveCallerUser`, ADR 0003)
 * so the new member binds to the stable `User.userId` subject.
 */

import type { Request, Response } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { createLogger } from '../../observability/logger.js';
import { tenantOf, requireFeatureEnabled, publicBaseUrl } from '../featureRoute.js';
import { assertOrgScope, resolveEffectiveAccess, ACT_AS_HEADER } from '../../host/accessControlService.js';
import { callerSubject, personalTenantOf } from '../../host/requestSubject.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import type { User } from '../users/usersService.js';
import { invitationRevoked } from './emit.js';
import {
  acceptInvitation,
  createInvitationAndDeliver,
  declineInvitation,
  inviteErrorToHttp as asHttp,
  listInvitations,
  previewInvitation,
  revokeInvitation,
  type OrgInvitation,
} from './invitationsService.js';

const log = createLogger('features.orgs');
const TOGGLE_ID = 'orgs';
/** R2 review F2 — read at CALL time (a module-frozen const made the prod
 *  branch untestable: vitest could never exercise the refusal path). */
const exposeTokens = (): boolean => process.env.NODE_ENV !== 'production';
/** accessControl's act-as header — honor it so a reduced-scope simulated member
 *  can't manage invites just because the real principal is the tenant owner. */

async function requireEnabled(req: Request): Promise<void> {
  await requireFeatureEnabled(req, TOGGLE_ID, 'Orgs');
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new OpenwopError('validation_error', `Field \`${field}\` is required and MUST be a non-empty string.`, 400, { field });
  }
  return value;
}

/**
 * Delegate management authorization to accessControl's RFC 0049 scopes — the
 * SAME `host:members:manage` gate accessControl's own member routes use.
 *
 * ADR 0622 D2 — a THIN WRAPPER over the ONE org-scoped predicate
 * `assertOrgScope` (which the workflow surface `features/orgs/surface.ts` also
 * calls, so the route and the node share a decision that cannot drift). The two
 * request-level facts are threaded explicitly: the caller's PERSONAL tenant
 * (the implicit-owner short-circuit, shape-guarded inside the predicate —
 * USERS-19) and the act-as header, which stays HTTP-only HERE: a reduced-scope
 * simulated member can't manage invites just because the real principal is
 * the tenant owner (the 2026-07 vuln-scan H2 lesson — never a bare `{}`, which
 * `resolveEffectiveAccess` resolves to FULL OWNER scopes).
 */
async function requireMemberManage(req: Request): Promise<void> {
  const orgId = req.params.orgId;
  const actingMember = req.header(ACT_AS_HEADER)?.trim();
  if (actingMember) {
    // Simulated member: authority is THAT membership's, never the real
    // principal's and never the personal-owner short-circuit.
    const access = await resolveEffectiveAccess(tenantOf(req), { memberId: actingMember, orgId });
    if (!access.scopes.includes('host:members:manage')) {
      throw new OpenwopError('forbidden_scope', 'Missing required scope: host:members:manage', 403, { requiredScope: 'host:members:manage', actingAs: actingMember });
    }
    return;
  }
  const subject = callerSubject(req);
  if (!subject) throw new OpenwopError('forbidden_scope', 'Missing required scope: host:members:manage', 403, { requiredScope: 'host:members:manage' });
  await assertOrgScope(tenantOf(req), subject, orgId, 'host:members:manage', {
    ...(personalTenantOf(req) ? { personalTenant: personalTenantOf(req) } : {}),
  });
}

/** ORGINV-4 — the management wire shape. Projects OUT `tokenHash` (the at-rest
 *  representation must never reach a client, even hashed) and marks expiry
 *  server-side so a dead invite can't list as "pending" for up to 30 days
 *  (rows linger for the kvAgeOut audit buffer). */
function toClientInvite(inv: OrgInvitation): Omit<OrgInvitation, 'tokenHash'> & { expired: boolean } {
  const { tokenHash: _omit, ...pub } = inv;
  return { ...pub, expired: Date.parse(inv.expiresAt) < Date.now() };
}

export function registerOrgsRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const h = (fn: (req: Request, res: Response, user: User) => Promise<void>) => async (req: Request, res: Response, next: (e?: unknown) => void) => {
    try {
      await requireEnabled(req);
      const user = await resolveCallerUser(req);
      await fn(req, res, user);
    } catch (err) {
      next(err);
    }
  };

  app.post('/v1/host/openwop-app/orgs/:orgId/invites', h(async (req, res, user) => {
    await requireMemberManage(req);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tenantId = tenantOf(req);
    // ADR 0622 D5 — ONE composition owner for the route AND the workflow
    // surface: no-sender precheck BEFORE any mint (R2 review F3 / ORGINV-7),
    // mint without replace, deliver, then supersede the prior invite only once
    // the new one is reachable — or roll the new row back and leave the prior
    // invite untouched (the 422 says so). Non-prod token echo stays a ROUTE
    // concern: with `tokenEchoed` a skipped delivery is still a usable invite
    // (copy-link UX); the service never returns the token on the surface lane.
    const { invite, token, delivery } = await createInvitationAndDeliver({
      storage: deps.storage,
      tenantId,
      orgId: req.params.orgId,
      email: requireString(body.email, 'email'),
      role: body.role ?? 'viewer',
      actingUserId: user.userId,
      // R2 IN-SP-11 — capture the inviter at mint so the preview + email can
      // name them (display name preferred; the service suppresses email-shaped
      // names from the public preview).
      createdBy: user.userId,
      ...(user.displayName || user.email ? { createdByName: user.displayName || user.email } : {}),
      baseUrl: publicBaseUrl(req),
      tokenEchoed: exposeTokens(),
    }).catch(asHttp);
    // ORGINV-6 — audit the mint like accept/delivery already are: ids only
    // (the recipient email stays out of the log line), actor attributed.
    log.info('org_invite_created', { orgId: req.params.orgId, inviteId: invite.inviteId, role: invite.role, delivery: delivery.outcome, actor: req.userId ?? user.userId ?? 'unknown' });
    res.status(201).json({ invite: toClientInvite(invite), delivery: delivery.outcome, ...(exposeTokens() ? { token } : {}) });
  }));

  app.get('/v1/host/openwop-app/orgs/:orgId/invites', h(async (req, res, _user) => {
    await requireMemberManage(req);
    const rows = await listInvitations(tenantOf(req), req.params.orgId).catch(asHttp);
    res.json({ invites: rows.map(toClientInvite) });
  }));

  app.delete('/v1/host/openwop-app/orgs/:orgId/invites/:inviteId', h(async (req, res, user) => {
    await requireMemberManage(req);
    await revokeInvitation(tenantOf(req), req.params.orgId, req.params.inviteId).catch(asHttp);
    // ORGINV-6 — revoke is a security-relevant action (it kills a live link);
    // audit it like accept already is. Ids only, actor attributed.
    log.info('org_invite_revoked', { orgId: req.params.orgId, inviteId: req.params.inviteId, actor: req.userId ?? user.userId ?? 'unknown' });
    // ADR 0622 D1 — the ONE `revoked` emit site: the row existed (the service
    // threw 404 otherwise) and this is the admin's business decision, not the
    // D5 rollback or a replace-at-mint row death.
    invitationRevoked({ inviteId: req.params.inviteId, orgId: req.params.orgId, tenantId: tenantOf(req) });
    res.status(204).end();
  }));

  // Accept is NOT scope-gated — any signed-in user may accept an invite issued
  // to THEIR email (the email-ownership check is the gate). Path is unambiguous
  // (not `/orgs/:orgId`) so it can't collide with accessControl's org routes.
  // PREVIEW is unauthenticated by design: the token IS the credential, and a
  // recipient must be able to see what they're being invited to BEFORE deciding
  // whether to sign in at all. It is strictly non-mutating — it never redeems
  // the single use (UX_UPGRADE-invitations IN-G1).
  app.get('/v1/host/openwop-app/orgs/invitations/preview', async (req, res, next) => {
    try {
      // R2 IN-SP-12 (reshaped by review F6) — the toggle gate lives in the
      // SERVICE now, resolved against the INVITE's tenant: gating here on the
      // anonymous caller's tenant would 404 valid invites under per-tenant
      // rollouts, and the page would then claim the invite was revoked.
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      if (!token) throw new OpenwopError('validation_error', '`token` is required.', 400, { field: 'token' });
      res.json(await previewInvitation(token).catch(asHttp));
    } catch (err) { next(err); }
  });

  // ORGINV-1 (the R2 F6 defect class, now closed for ACCEPT too) — registered
  // OUTSIDE `h`, like preview: `h`'s `requireEnabled` gates on the CALLER's
  // tenant (`toggleSubjectOf(req)`), and under a per-tenant `orgs` rollout an
  // invited outsider's home tenant typically has the toggle OFF — so the core
  // flow broke: preview succeeded (service-gated since F6), accept 404'd
  // "Orgs is not enabled for this tenant." The REAL gate lives in the service,
  // resolved against the INVITE's tenant (`invitationsService.ts`, R2 F6).
  // Sign-in stays required — `resolveCallerUser` refuses anonymous callers —
  // because the accepting identity is what the new member binds to.
  app.post('/v1/host/openwop-app/orgs/invitations/accept', async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      // R2 IN-SP-3 — accept is idempotent for an existing member; the flag lets
      // the page say "you're already a member" instead of minting a duplicate
      // row. Member fields stay top-level (backward compatible).
      const { member, alreadyMember } = await acceptInvitation(requireString(body.token, 'token'), user).catch(asHttp);
      log.info('org_invite_accepted', { orgId: member.orgId, memberId: member.memberId, alreadyMember });
      res.status(alreadyMember ? 200 : 201).json({ ...member, alreadyMember });
    } catch (err) { next(err); }
  });

  // ADR 0564 / ADR 0622 D4 — DECLINE. Registered OUTSIDE `h` like accept (the
  // ORGINV-1 class: the gate is the INVITE tenant's toggle, inside the service),
  // same gate chain (expiry, email ownership + provenance, signed-in — a
  // recipient without an account must sign up to decline; the page's terminal
  // copy says so). A deliberate POST after a confirm step, never a GET a link
  // scanner could trip. Idempotent: declining a declined invite is the same
  // 200; the service's CAS makes the decline-vs-accept race yield exactly one
  // outcome.
  app.post('/v1/host/openwop-app/orgs/invitations/decline', async (req, res, next) => {
    try {
      const user = await resolveCallerUser(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const out = await declineInvitation(requireString(body.token, 'token'), user).catch(asHttp);
      res.status(200).json(out);
    } catch (err) { next(err); }
  });
}
