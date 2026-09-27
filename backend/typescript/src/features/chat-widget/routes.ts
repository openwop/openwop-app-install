/**
 * Chat-widget admin routes (ADR 0127 Phase 1) — authed config CRUD, org-scoped.
 * `/v1/host/openwop-app/chat-widget/orgs/:orgId/widgets` (authorizeOrgScope write/
 * read, IDOR-404). The PUBLIC runtime gateway (`/widget/*`) is Phase 2.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireOrgScope } from '../featureRoute.js';
import { OpenwopError } from '../../types.js';
import { buildToolCatalog } from '../../routes/agentAllowlists.js';
import { deleteWidget, getWidget, listWidgets, patchWidget, provisionWidget, rotateWidgetToken } from './widgetService.js';


export function registerChatWidgetRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/chat-widget/orgs/:orgId/widgets';

  // ADR 0469 Phase B — the WORKSPACE-SCOPED tool catalog that populates the anon
  // grant editor. Reuses the ONE catalog SSoT (`buildToolCatalog`) — NOT the
  // superadmin `/agents/:agentId` route (finding 3: the operator editor must not be
  // coupled to a superadmin surface). Read-only (`workspace:read`); the grant SAVE
  // stays `workspace:write` via the widget PATCH below.
  app.get('/v1/host/openwop-app/chat-widget/orgs/:orgId/tool-catalog', async (req, res, next) => {
    try { await requireOrgScope(req, 'workspace:read'); res.json({ tools: buildToolCatalog() }); } catch (err) { next(err); }
  });

  app.get(BASE, async (req, res, next) => {
    try { const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read'); res.json({ widgets: await listWidgets(tenantId, orgId) }); } catch (err) { next(err); }
  });
  app.post(BASE, async (req, res, next) => {
    try { const { user, orgId, tenantId } = await requireOrgScope(req, 'workspace:write'); res.status(201).json({ widget: await provisionWidget(tenantId, orgId, user.userId, (req.body ?? {}) as Record<string, unknown>) }); } catch (err) { next(err); }
  });
  app.get(`${BASE}/:widgetId`, async (req, res, next) => {
    try { const { orgId, tenantId } = await requireOrgScope(req, 'workspace:read'); const w = await getWidget(tenantId, orgId, req.params.widgetId); if (!w) throw new OpenwopError('not_found', 'Widget not found.', 404, {}); res.json({ widget: w }); } catch (err) { next(err); }
  });
  app.patch(`${BASE}/:widgetId`, async (req, res, next) => {
    try { const { orgId, tenantId } = await requireOrgScope(req, 'workspace:write'); res.json({ widget: await patchWidget(tenantId, orgId, req.params.widgetId, (req.body ?? {}) as Record<string, unknown>) }); } catch (err) { next(err); }
  });
  app.post(`${BASE}/:widgetId/rotate-token`, async (req, res, next) => {
    try { const { orgId, tenantId } = await requireOrgScope(req, 'workspace:write'); res.json({ widget: await rotateWidgetToken(tenantId, orgId, req.params.widgetId) }); } catch (err) { next(err); }
  });
  app.delete(`${BASE}/:widgetId`, async (req, res, next) => {
    try { const { orgId, tenantId } = await requireOrgScope(req, 'workspace:write'); await deleteWidget(tenantId, orgId, req.params.widgetId); res.status(204).end(); } catch (err) { next(err); }
  });
}
