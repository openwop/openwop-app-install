/**
 * ADR 0958 P2, moved by ADR 1099 D2 — the COLLABORATOR's side of external
 * collaboration: "Shared with me", one granted resource, and invite acceptance.
 *
 * These routes belong to no one feature: a grant's kind decides which surface it
 * runs under (ADR 1099 D1), so they live in the host route table instead of in
 * campaign-ops, which keeps its agency panel and its intake routes. Behaviour is
 * unchanged for every kind registered before ADR 1099: the default surface is
 * campaign-ops' toggles plus an active client account.
 *
 * A signed-in person in THEIR OWN home tenant; every answer is derived from a
 * grant they are bound to (`checkGrantUse`), never from the session's tenant.
 */
import type { Express } from 'express';
import { OpenwopError } from '../types.js';
import { resolveCallerUser } from '../features/users/usersGuards.js';
import { purgeLinksForResource, resolveActiveResource } from '../features/sharing/sharingService.js';
import { getOrg } from '../host/accessControlService.js';
import {
  anySurfaceAdmits, bindCollaborator, checkGrantUse, getCollaborator, grantResourceKind, kindCollaborationOn, usableGrantsForUser, type GrantUse,
} from '../host/externalCollaborators.js';
import { startCollaboratorExpiryNotices } from '../host/externalCollaboratorExpiry.js';

/** What a collaborator sees of a usable grant: the grant kind's surface switch on
 *  the GRANT's tenant (ADR 1099 D1; for campaign-ops kinds, its two toggles), then
 *  the owning feature's projection. `null` = not presentable (read as 404). */
async function present(use: GrantUse): Promise<{ title: string; clientName?: string; body: Record<string, unknown> } | null> {
  if (!(await kindCollaborationOn(use.grant.resource.kind, use.tenantId))) return null;
  const kind = grantResourceKind(use.grant.resource.kind);
  const projected = kind ? await kind.project(use.tenantId, use.orgId, use.grant.resource.id) : null;
  if (!projected) return null;
  const org = await getOrg(use.orgId);
  return { title: projected.title, body: projected.body, ...(org && org.tenantId === use.tenantId ? { clientName: org.name } : {}) };
}

export function registerExternalCollaboratorRoutes(app: Express): void {
  startCollaboratorExpiryNotices();

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
      // ADR 1099 D1 — the invite has no grant kind yet, so it is accepted when ANY
      // collaboration surface takes this tenant and org. For campaign-ops (the
      // default surface) that is both its toggles AND an active client account,
      // exactly the two checks this route made before (ADR 0958 D7: an archived
      // client takes no new collaborator; the link is kept for after an un-archive).
      if (!(await anySurfaceAdmits(link.tenantId, link.orgId))) throw new OpenwopError('not_found', 'Invite not found.', 404, {});
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
}
