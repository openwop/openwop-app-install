/**
 * Campaign Studio editor routes (host-extension, ADR 0310 Phase C) — a pure
 * call into the shared canvas-editor route factory, type-pinned to
 * `canvas.campaign` and gated by the `campaign-studio` toggle. No
 * catalog/templates (a multi-collection elements-trait type — the adders live
 * in the FE definition); no extra verbs; no share.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { registerCanvasEditorRoutes } from '../canvasEditorRoutes.js';
import { validateCampaignDoc } from './validateCampaignDoc.js';
import { authorizeOrgScope, requireString } from '../featureRoute.js';
import { canvasReadAllowed, canvasWriteAllowed, getCanvasForTenant, type CanvasRecordView } from '../../host/canvasSurface.js';
import { assertCampaignRef } from '../../host/campaignRefs.js';
import { getProject } from '../projects/projectsService.js';
import { OpenwopError } from '../../types.js';
import { clearPlanLink, getPlanLink, setPlanLink } from './planLinks.js';

const FEATURE = { toggleId: 'campaign-studio', label: 'Campaign Studio' };
const TYPE_ID = 'canvas.campaign';
const PLAN_BASE = '/host/openwop-app/campaign-studio/orgs/:orgId/canvases/:canvasId/campaign';

/** The plan canvas, type-pinned, readable (and writable when asked) by the
 *  caller, and — when project-owned — in the path org. Uniform 404 otherwise. */
async function loadPlan(tenantId: string, orgId: string, canvasId: string, subject: string, need: 'read' | 'write'): Promise<CanvasRecordView> {
  const notFound = new OpenwopError('not_found', 'Canvas not found.', 404, { canvasId });
  const canvas = await getCanvasForTenant(tenantId, canvasId);
  if (!canvas || canvas.canvasTypeId !== TYPE_ID) throw notFound;
  if (!(await canvasReadAllowed(tenantId, canvas, { subject }))) throw notFound;
  if (canvas.projectId) {
    // A project-owned plan belongs to that project's org: it may only plan a
    // campaign of the same client.
    const project = await getProject(tenantId, canvas.projectId);
    if (!project || project.orgId !== orgId) throw notFound;
  }
  if (need === 'write' && !(await canvasWriteAllowed(tenantId, canvas, { subject }))) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write on the canvas owner', 403, { requiredScope: 'workspace:write' });
  }
  return canvas;
}

export function registerCampaignStudioEditorRoutes(deps: RouteDeps): void {
  const { app } = deps;
  // ADR 0941 P2 — a plan's campaign link. One writer; a dangling campaign, or one
  // of another client org, is the uniform 404 (`assertCampaignRef`).
  app.get(PLAN_BASE, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:read');
      await loadPlan(tenantId, orgId, req.params.canvasId, user.userId, 'read');
      const link = await getPlanLink(tenantId, req.params.canvasId);
      res.json({ campaignId: link && link.orgId === orgId ? link.campaignId : null });
    } catch (err) { next(err); }
  });
  app.put(PLAN_BASE, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      const campaignId = requireString((req.body ?? {}).campaignId, 'campaignId');
      await loadPlan(tenantId, orgId, req.params.canvasId, user.userId, 'write');
      await assertCampaignRef(tenantId, orgId, campaignId);
      const link = await setPlanLink({ tenantId, canvasId: req.params.canvasId, campaignId, orgId, linkedAt: new Date().toISOString() });
      res.json({ campaignId: link.campaignId });
    } catch (err) { next(err); }
  });
  app.delete(PLAN_BASE, async (req, res, next) => {
    try {
      const { user, orgId, tenantId } = await authorizeOrgScope(req, FEATURE, 'workspace:write');
      await loadPlan(tenantId, orgId, req.params.canvasId, user.userId, 'write');
      res.json({ cleared: await clearPlanLink(tenantId, req.params.canvasId, orgId) });
    } catch (err) { next(err); }
  });

  registerCanvasEditorRoutes(deps, {
    basePath: '/host/openwop-app/campaign-studio',
    feature: { toggleId: 'campaign-studio', label: 'Campaign Studio' },
    canvasTypeId: 'canvas.campaign',
    // ADR 0359 Phase 5 — collab-capable (both toggles enforced at the socket).
    collab: true,
    // ADR 0359 Phase 6 — the doc↔Y shape (drift-pinned against the FE traits
    // in canvas/__tests__/collabTypes.test.ts + collab-authboundary registry test).
    collabShape: { collections: [{ key: 'channels' }, { key: 'funnel' }, { key: 'assets' }] },
    validate: validateCampaignDoc,
    // ADR 0314 — blank campaign: schema requires a name + ≥1 channel; the
    // channel matches the FE adder's defaults.
    blankState: (name) => ({ name, channels: [{ name: 'New channel', type: 'email' }] }),
  });
}
