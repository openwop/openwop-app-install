/**
 * Gmail inbox → CRM activity sync — the opt-in CRUD (ADR 0252 P1).
 *
 * Surface under /v1/host/openwop-app/crm/gmail-sync:
 *   GET    ?orgId=            list the caller's syncs in that org
 *   POST                      opt in {orgId, connectionId, cadence}
 *   PATCH  /:syncId           {status?, cadence?}
 *   DELETE /:syncId           opt out (deletes the scheduler job + the row)
 *   POST   /:syncId/sync-now  start an immediate run (202)
 *
 * Every route is toggle-gated (`crm`) + org RBAC (`workspace:read`/`write` on
 * the sync's org, `authorizeOrgScope`/`requireOrgScope` — same gate
 * `orgRoutes.ts` uses). POST additionally enforces the ADR 0252 §6 IDOR guard:
 * `createGmailSync` refuses a `connectionId` that isn't the AUTHENTICATED
 * caller's own (403) — never client-supplied, always the resolved principal.
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, requireOrgScope, requireString, tenantOf } from '../featureRoute.js';
import { checkEntitlement } from '../../host/entitlementSeam.js';
import type { Scope } from '../../host/accessControlService.js';
import type { User } from '../users/usersService.js';
import {
  createGmailSync,
  listGmailSyncs,
  getGmailSync,
  updateGmailSync,
  deleteGmailSync,
  syncGmailNow,
  type GmailSync,
} from './gmailSyncService.js';

const TOGGLE_ID = 'crm';
const TOGGLE = { toggleId: TOGGLE_ID, label: 'CRM' };

/** ADR 0419 — the toggle gate + the plan/bundle entitlement (CRM is a sellable
 *  bundle feature), the ONE choke every authed Gmail-sync route funnels through.
 *  No-op until an operator narrows PLAN_FEATURES with billing on. */
async function requireCrmEntitled(req: Request): Promise<void> {
  await requireFeatureEnabled(req, TOGGLE.toggleId, TOGGLE.label);
  await checkEntitlement(req, TOGGLE_ID);
}
const BASE = '/v1/host/openwop-app/crm/gmail-sync';

/** Resolve a `:syncId` row THEN gate `scope` on its (discovered) org — the
 *  same "stage req.params.orgId, reuse the shared gate" pattern
 *  `routes.ts`'s `/contacts/:id/convert` uses for a body-supplied org. A
 *  missing/foreign-tenant row is a uniform 404 before the org gate ever runs
 *  (no existence leak); toggle state is checked first (backend authority). */
async function ownedSync(req: Request, syncId: string, scope: Scope): Promise<{ user: User; orgId: string; sync: GmailSync }> {
  await requireCrmEntitled(req);
  const sync = await getGmailSync(tenantOf(req), syncId);
  if (!sync) throw new OpenwopError('not_found', 'Gmail sync not found.', 404, { syncId });
  (req.params as Record<string, string>).orgId = sync.orgId;
  const ctx = await requireOrgScope(req, scope);
  // Owner-only: a Gmail sync binds ONE user's personal mailbox, so only that
  // user manages it — org-write alone must NOT let a co-worker pause/delete/
  // sync-now someone else's mailbox (ADR 0252 §6; GET already lists own only).
  if (sync.userId !== ctx.user.userId) {
    throw new OpenwopError('forbidden', 'This Gmail sync belongs to another user.', 403, { syncId });
  }
  return { user: ctx.user, orgId: ctx.orgId, sync };
}

export function registerGmailSyncRoutes(deps: RouteDeps): void {
  const { app, storage, hostSuite } = deps;

  // GET ?orgId= — list the caller's own syncs in that org (read scope).
  app.get(BASE, async (req, res, next) => {
    try {
      await requireCrmEntitled(req);
      const orgId = requireString(req.query.orgId, 'orgId');
      (req.params as Record<string, string>).orgId = orgId;
      const ctx = await requireOrgScope(req, 'workspace:read');
      const syncsList = await listGmailSyncs(ctx.tenantId, { orgId: ctx.orgId, userId: ctx.user.userId });
      res.json({ syncs: syncsList });
    } catch (err) { next(err); }
  });

  // POST — opt in. workspace:write on body.orgId; the bound connection MUST
  // be the caller's OWN (createGmailSync 403s otherwise — ADR 0252 §6).
  app.post(BASE, async (req, res, next) => {
    try {
      await requireCrmEntitled(req);
      const body = (req.body ?? {}) as { orgId?: unknown; connectionId?: unknown; cadence?: unknown };
      const orgId = requireString(body.orgId, 'orgId');
      (req.params as Record<string, string>).orgId = orgId;
      const ctx = await requireOrgScope(req, 'workspace:write');
      const connectionId = requireString(body.connectionId, 'connectionId');
      const sync = await createGmailSync({
        tenantId: ctx.tenantId,
        orgId: ctx.orgId,
        userId: ctx.user.userId, // the AUTHENTICATED caller — never body-supplied.
        connectionId,
        cadence: body.cadence,
      });
      res.status(201).json({ sync });
    } catch (err) { next(err); }
  });

  // PATCH /:syncId — pause/resume (status) and/or re-cadence.
  app.patch(`${BASE}/:syncId`, async (req, res, next) => {
    try {
      const { sync } = await ownedSync(req, req.params.syncId, 'workspace:write');
      const body = (req.body ?? {}) as { status?: unknown; cadence?: unknown };
      const updated = await updateGmailSync(sync.tenantId, sync.syncId, { status: body.status, cadence: body.cadence });
      res.json({ sync: updated });
    } catch (err) { next(err); }
  });

  // DELETE /:syncId — opt out.
  app.delete(`${BASE}/:syncId`, async (req, res, next) => {
    try {
      const { sync } = await ownedSync(req, req.params.syncId, 'workspace:write');
      await deleteGmailSync(sync.tenantId, sync.syncId);
      res.status(204).end();
    } catch (err) { next(err); }
  });

  // POST /:syncId/sync-now — start an immediate run.
  app.post(`${BASE}/:syncId/sync-now`, async (req, res, next) => {
    try {
      const { sync } = await ownedSync(req, req.params.syncId, 'workspace:write');
      const runId = await syncGmailNow({ storage, hostSuite }, sync.tenantId, sync.syncId);
      if (!runId) throw new OpenwopError('workflow_not_found', 'The gmail-sync workflow did not resolve.', 422, { syncId: sync.syncId });
      res.status(202).json({ runId });
    } catch (err) { next(err); }
  });
}
