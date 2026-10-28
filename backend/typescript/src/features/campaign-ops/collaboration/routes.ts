/**
 * ADR 0958 P0 — external collaborators, the campaign-ops side.
 *
 * AGENCY routes (`/campaign-ops/clients/:orgId/collaborators*`): invite a vendor,
 * freelancer or client stakeholder, grant and revoke. They need
 * `host:members:manage` on the client org (ADR 0958 matrix row 8, through the
 * campaign-ops `authorizeClient`) and the sub-toggle `campaign-ops.external-collab`
 * AND-gated with `campaign-ops` (ADR 0941 D5).
 *
 * ACCEPT (`/collab/invites/accept`): a signed-in caller in ANY tenant, never a
 * member of the agency. The invite is a single-use `collab_invite` sharing link
 * (ADR 0448 D3: one home for links). The caller's own home `User` must hold the
 * invite email, IdP-verified (`emailProvenance: 'idp'` EXACTLY, stricter than
 * `isEmailVouched`, which also takes `'admin'`: here the vouching admin would be
 * the vendor's own). Binding is the host CAS; the link is purged after it.
 * Every refusal is the same 404, except the two the person can fix (sign in;
 * use the invited, verified address), which name the remedy.
 *
 * @see docs/adr/0958-vendor-and-guest-collaboration.md
 */
import type { Request } from 'express';
import { startCollaboratorExpiryNotices } from './expiryNotices.js';
import { OpenwopError } from '../../../types.js';
import type { RouteDeps } from '../../../routes/registerAllRoutes.js';
import { requireFeatureEnabled } from '../../featureRoute.js';
import { resolveCallerUser } from '../../users/usersGuards.js';
import { resolveOne } from '../../../host/featureToggles/service.js';
import { createLink, purgeLinksForResource, resolveActiveResource } from '../../sharing/sharingService.js';
import {
  bindCollaborator, checkGrantUse, createCollaborator, getCollaborator, grantAccess, grantResourceKind, listCollaborationAudit, listCollaborators, listGrantableResources, listGrants,
  revokeGrant, setCollaboratorStatus, usableGrantsForUser, type ExternalCollaborator, type GrantUse,
} from '../../../host/externalCollaborators.js';
import { getOrg } from '../../../host/accessControlService.js';
import { authorizeClient } from '../routes.js';
import { getClient } from '../clientService.js';
import { assertCollaboratorMaySuspend, getApprover, revokeApprover } from '../portal.js';
import { registerIntakeRoutes } from './intakeRoutes.js';

export const EXTERNAL_COLLAB_TOGGLE = 'campaign-ops.external-collab';
const LABEL = 'External collaborators';
const BASE = '/host/openwop-app/campaign-ops/clients/:orgId/collaborators';
const INVITE_DAYS = 7;
/** The system actor that mints invites (the sign_request precedent). */
const INVITE_ACTOR = 'system:campaign-ops-collab';

/** The agency view of a collaborator. The email stays: the agency typed it. */
const view = (c: ExternalCollaborator): Omit<ExternalCollaborator, 'tenantId' | 'boundUserId'> & { accepted: boolean } => {
  const { tenantId: _t, boundUserId, ...rest } = c;
  return { ...rest, accepted: Boolean(boundUserId) };
};

async function agency(req: Request): Promise<{ tenantId: string; userId: string; orgId: string }> {
  await requireFeatureEnabled(req, EXTERNAL_COLLAB_TOGGLE, LABEL);
  const { tenantId, userId } = await authorizeClient(req, 'host:members:manage');
  return { tenantId, userId, orgId: req.params.orgId };
}

/** Both toggles, on the tenant that OWNS the invite (never the caller's). */
export async function collabEnabledFor(tenantId: string): Promise<boolean> {
  try {
    const [parent, sub] = await Promise.all([resolveOne('campaign-ops', { tenantId }), resolveOne(EXTERNAL_COLLAB_TOGGLE, { tenantId })]);
    return Boolean(parent?.enabled && sub?.enabled);
  } catch {
    return false;
  }
}

/** What a collaborator sees of a usable grant: both toggles on the GRANT's tenant,
 *  then the owning feature's projection. `null` = not presentable (read as 404). */
async function present(use: GrantUse): Promise<{ title: string; clientName?: string; body: Record<string, unknown> } | null> {
  if (!(await collabEnabledFor(use.tenantId))) return null;
  const kind = grantResourceKind(use.grant.resource.kind);
  const projected = kind ? await kind.project(use.tenantId, use.orgId, use.grant.resource.id) : null;
  if (!projected) return null;
  const org = await getOrg(use.orgId);
  return { title: projected.title, body: projected.body, ...(org && org.tenantId === use.tenantId ? { clientName: org.name } : {}) };
}

export function registerCollaborationRoutes(deps: RouteDeps): void {
  const { app } = deps;
  startCollaboratorExpiryNotices(collabEnabledFor);

  app.get(BASE, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await agency(req);
      const rows = await listCollaborators(tenantId, orgId);
      const allGrants = await listGrants(tenantId, orgId);
      res.json({ collaborators: rows.map((c) => ({ ...view(c), grants: allGrants.filter((g) => g.collaboratorId === c.collaboratorId) })) });
    } catch (err) { next(err); }
  });

  /**
   * ADR 0958 D7 / P5 — the audit review: every collaboration event the
   * tenant's hash chain holds for this client, newest first (bounded; the
   * governance export has the whole chain). The chain holds ids only; names and
   * what a grant was for are joined here from the LIVE rows, so an erased
   * person reads as removed (`collaborator: null`).
   */
  app.get(`${BASE}/audit`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await agency(req);
      const [{ events, truncated }, people, allGrants] = await Promise.all([
        listCollaborationAudit(tenantId, orgId), listCollaborators(tenantId, orgId), listGrants(tenantId, orgId),
      ]);
      const byId = new Map(people.map((c) => [c.collaboratorId, { displayName: c.displayName, kind: c.kind }]));
      const grantKind = new Map(allGrants.map((g) => [g.grantId, g.resource.kind]));
      res.json({
        truncated,
        events: events.map((e) => ({
          ...e,
          collaborator: e.collaboratorId ? (byId.get(e.collaboratorId) ?? null) : null,
          ...(e.grantId && !e.resource && grantKind.has(e.grantId) ? { resourceKind: grantKind.get(e.grantId) } : {}),
        })),
      });
    } catch (err) { next(err); }
  });

  /** ADR 0958 matrix row 10 — what may be granted in this client (the panel's picker). */
  app.get(`${BASE}/grantable`, async (req, res, next) => {
    try {
      const { tenantId, orgId } = await agency(req);
      res.json({ kinds: await listGrantableResources(tenantId, orgId) });
    } catch (err) { next(err); }
  });

  /** Invite. Returns the single-use invite token ONCE; only its hash is stored. */
  app.post(BASE, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await agency(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const c = await createCollaborator({ tenantId, orgId, kind: body.kind, email: body.email, displayName: body.displayName, company: body.company, createdBy: userId });
      const link = await createLink(tenantId, orgId, INVITE_ACTOR, { resourceType: 'collab_invite', resourceId: c.collaboratorId, expiresInDays: INVITE_DAYS }, { lane: 'visitor', why: 'the single-use invite an external collaborator accepts' });
      res.status(201).json({ collaborator: view(c), invite: { token: link.token, expiresAt: link.expiresAt } });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/:collaboratorId/grants`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await agency(req);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const grant = await grantAccess({ tenantId, orgId, collaboratorId: req.params.collaboratorId, resource: body.resource, actions: body.actions, expiresInDays: body.expiresInDays, createdBy: userId });
      res.status(201).json({ grant });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:collaboratorId/grants/:grantId`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await agency(req);
      const grants = await listGrants(tenantId, orgId, req.params.collaboratorId);
      if (!grants.some((g) => g.grantId === req.params.grantId)) throw new OpenwopError('not_found', 'Grant not found.', 404, {});
      res.json({ grant: await revokeGrant(tenantId, orgId, req.params.grantId, userId) });
    } catch (err) { next(err); }
  });

  /** Suspend, reactivate or revoke. Revoking also revokes every grant and kills
   *  an unaccepted invite at once (no waiting for it to expire). */
  app.post(`${BASE}/:collaboratorId/status`, async (req, res, next) => {
    try {
      const { tenantId, orgId, userId } = await agency(req);
      const status = (req.body ?? {}).status;
      if (status !== 'active' && status !== 'suspended' && status !== 'revoked') {
        throw new OpenwopError('validation_error', "`status` must be 'active', 'suspended' or 'revoked'.", 400, { field: 'status' });
      }
      // A portal approver is the same record (ADR 0958 P1): revoking it goes through
      // the portal, which keeps a `client`-policy client's last approver and drops
      // its links; suspending it is held to the same last-approver rule.
      const approver = await getApprover(tenantId, orgId, req.params.collaboratorId);
      if (approver && status !== 'active') {
        const client = await getClient(tenantId, orgId);
        if (!client) throw new OpenwopError('not_found', 'Not found.', 404, {});
        if (status === 'revoked') {
          await revokeApprover(tenantId, client, approver.approverId, userId);
          const c = await getCollaborator(tenantId, orgId, approver.approverId);
          if (!c) throw new OpenwopError('not_found', 'Not found.', 404, {});
          res.json({ collaborator: view(c) });
          return;
        }
        await assertCollaboratorMaySuspend(tenantId, client, approver.approverId);
      }
      const c = await setCollaboratorStatus(tenantId, orgId, req.params.collaboratorId, status, userId);
      if (status === 'revoked') await purgeLinksForResource(tenantId, 'collab_invite', c.collaboratorId);
      res.json({ collaborator: view(c) });
    } catch (err) { next(err); }
  });

  // ── The collaborator's side (ADR 0958 P2). A signed-in person in THEIR OWN home
  // tenant; every answer is derived from a grant they are bound to, so nothing here
  // reads the caller's session tenant, and nothing names the agency's ids. ──

  /** "Shared with me": every grant usable right now, across agencies. */
  app.get('/host/openwop-app/collab/shared', async (req, res, next) => {
    try {
      // ADR 0887 S4 — freshness IS the revocation mechanism: never cached.
      res.set('Cache-Control', 'no-store');
      const user = await resolveCallerUser(req);
      const items: Array<Record<string, unknown>> = [];
      for (const use of await usableGrantsForUser(user.userId)) {
        const shown = await present(use);
        if (shown) items.push({ grantId: use.grant.grantId, resourceKind: use.grant.resource.kind, title: shown.title, clientName: shown.clientName, actions: use.grant.actions, expiresAt: use.grant.expiresAt });
      }
      res.json({ items });
    } catch (err) { next(err); }
  });

  /** One granted resource, through the one per-use check. Uniform 404 otherwise. */
  app.get('/host/openwop-app/collab/grants/:grantId', async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store'); // ADR 0887 S4
      const user = await resolveCallerUser(req);
      let use: GrantUse;
      try {
        use = await checkGrantUse({ grantId: req.params.grantId, via: { userId: user.userId }, action: 'view' });
      } catch {
        throw new OpenwopError('not_found', 'Not found.', 404, {});
      }
      const shown = await present(use);
      if (!shown) throw new OpenwopError('not_found', 'Not found.', 404, {});
      res.json({
        grant: { grantId: use.grant.grantId, resourceKind: use.grant.resource.kind, actions: use.grant.actions, expiresAt: use.grant.expiresAt },
        title: shown.title, clientName: shown.clientName, resource: shown.body,
      });
    } catch (err) { next(err); }
  });

  /** ADR 0958 D2 — accept while signed in to your own account. */
  app.post('/host/openwop-app/collab/invites/accept', async (req, res, next) => {
    try {
      const token = typeof (req.body ?? {}).token === 'string' ? (req.body as { token: string }).token : '';
      if (!token) throw new OpenwopError('validation_error', '`token` is required.', 400, { field: 'token' });
      // Signed in first: an anonymous caller is told to sign in, not "not found".
      const user = await resolveCallerUser(req);
      const link = await resolveActiveResource(token, 'collab_invite');
      if (!(await collabEnabledFor(link.tenantId))) throw new OpenwopError('not_found', 'Invite not found.', 404, {});
      // ADR 0958 D7 — an archived client takes no new collaborator. Otherwise an
      // invite accepted during the archive would bind as `active`, and
      // un-archiving would bring its grants back with no member decision (the
      // class of the D2 MEDIUM). The link is kept: after an un-archive the
      // invitee can accept, which is the ordinary flow.
      if ((await getClient(link.tenantId, link.orgId))?.status !== 'active') throw new OpenwopError('not_found', 'Invite not found.', 404, {});
      const c = await getCollaborator(link.tenantId, link.orgId, link.resourceId);
      if (!c || c.status !== 'invited') throw new OpenwopError('not_found', 'Invite not found.', 404, {});
      const email = (user.email ?? '').trim().toLowerCase();
      if (email !== c.email || user.emailProvenance !== 'idp') {
        throw new OpenwopError('forbidden', 'This invite was sent to a different email address. Sign in with the account that receives that address, through your identity provider, so the address is verified.', 403, { reason: 'invite_email_mismatch' });
      }
      const bound = await bindCollaborator(link.tenantId, link.orgId, c.collaboratorId, user.userId);
      // Single use: the link dies once the binding holds. A failure above leaves it
      // usable for a corrected retry.
      await purgeLinksForResource(link.tenantId, 'collab_invite', c.collaboratorId);
      res.json({ collaborator: { collaboratorId: bound.collaboratorId, kind: bound.kind, displayName: bound.displayName, status: bound.status } });
    } catch (err) { next(err); }
  });

  // ADR 0958 P3 — vendor asset intake (both sides).
  registerIntakeRoutes(deps, collabEnabledFor, EXTERNAL_COLLAB_TOGGLE);

}
