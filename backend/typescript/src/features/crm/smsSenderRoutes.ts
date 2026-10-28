/**
 * ADR 0955 D3 — admin routes for the SMS sender bindings (`smsSenders.ts`): which client a
 * Twilio number sends for. Binding a number decides whose STOP it records and whose
 * suppression its sends are checked against, so it needs `host:members:manage` on that
 * client (or on the workspace root for an unscoped number). Listing needs it on the root.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, requireString, tenantOf } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { assertOrgScope } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import { getSmsSender, listSmsSenders, removeSmsSender, setSmsSender } from './smsSenders.js';

const BASE = '/host/openwop-app/crm/sms-senders';

async function manage(req: Request, orgId: string | undefined): Promise<string> {
  const tenantId = tenantOf(req);
  const user = await resolveCallerUser(req);
  await assertOrgScope(tenantId, user.userId, orgId || tenantId, 'host:members:manage');
  return user.userId;
}

export function registerSmsSenderRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(BASE, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'crm', 'CRM');
      await manage(req, undefined);
      res.json({ senders: await listSmsSenders(tenantOf(req)) });
    } catch (err) { next(err); }
  });

  app.put(BASE, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'crm', 'CRM');
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = typeof body.orgId === 'string' && body.orgId ? body.orgId : undefined;
      const actor = await manage(req, orgId);
      const sender = await setSmsSender({ tenantId: tenantOf(req), number: requireString(body.number, 'number'), connectionId: requireString(body.connectionId, 'connectionId'), ...(orgId ? { orgId } : {}), boundBy: actor });
      res.json({ sender });
    } catch (err) { next(err); }
  });

  app.delete(`${BASE}/:number`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, 'crm', 'CRM');
      const row = await getSmsSender(tenantOf(req), req.params.number);
      if (!row) throw new OpenwopError('not_found', 'No such sender.', 404, {});
      await manage(req, row.orgId);
      res.json({ removed: await removeSmsSender(tenantOf(req), row.number) });
    } catch (err) { next(err); }
  });
}
