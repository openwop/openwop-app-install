/**
 * Chat-widget admin routes (ADR 0127 Phase 1) — authed config CRUD, org-scoped.
 * `/v1/host/openwop-app/chat-widget/orgs/:orgId/widgets` (authorizeOrgScope write/
 * read, IDOR-404). The PUBLIC runtime gateway (`/widget/*`) is Phase 2.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope } from '../featureRoute.js';
import { OpenwopError } from '../../types.js';
import { deleteWidget, getWidget, listWidgets, patchWidget, provisionWidget, rotateWidgetToken } from './widgetService.js';


export function registerChatWidgetRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/chat-widget/orgs/:orgId/widgets';

  app.get(BASE, async (req, res, next) => {
    try { const { user, orgId } = await requireOrgScope(req, 'workspace:read'); res.json({ widgets: await listWidgets(user.tenantId, orgId) }); } catch (err) { next(err); }
  });
  app.post(BASE, async (req, res, next) => {
    try { const { user, orgId } = await requireOrgScope(req, 'workspace:write'); res.status(201).json({ widget: await provisionWidget(user.tenantId, orgId, user.userId, (req.body ?? {}) as Record<string, unknown>) }); } catch (err) { next(err); }
  });
  app.get(`${BASE}/:widgetId`, async (req, res, next) => {
    try { const { user, orgId } = await requireOrgScope(req, 'workspace:read'); const w = await getWidget(user.tenantId, orgId, req.params.widgetId); if (!w) throw new OpenwopError('not_found', 'Widget not found.', 404, {}); res.json({ widget: w }); } catch (err) { next(err); }
  });
  app.patch(`${BASE}/:widgetId`, async (req, res, next) => {
    try { const { user, orgId } = await requireOrgScope(req, 'workspace:write'); res.json({ widget: await patchWidget(user.tenantId, orgId, req.params.widgetId, (req.body ?? {}) as Record<string, unknown>) }); } catch (err) { next(err); }
  });
  app.post(`${BASE}/:widgetId/rotate-token`, async (req, res, next) => {
    try { const { user, orgId } = await requireOrgScope(req, 'workspace:write'); res.json({ widget: await rotateWidgetToken(user.tenantId, orgId, req.params.widgetId) }); } catch (err) { next(err); }
  });
  app.delete(`${BASE}/:widgetId`, async (req, res, next) => {
    try { const { user, orgId } = await requireOrgScope(req, 'workspace:write'); await deleteWidget(user.tenantId, orgId, req.params.widgetId); res.status(204).end(); } catch (err) { next(err); }
  });
}
