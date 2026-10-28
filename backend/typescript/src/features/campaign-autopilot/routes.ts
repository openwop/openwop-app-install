/**
 * Campaign autopilot routes (ADR 0961) — host extension under
 * /v1/host/openwop-app/campaign-autopilot/*.
 *
 * Gating, fail-closed: the `campaign-autopilot` toggle AND its parent
 * `campaign-orchestration` (both 404 when off), then the campaign's org by the
 * SAME predicate the campaign routes use (`loadCampaignScoped`: a read miss is a
 * uniform 404; launch needs `workspace:write`).
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { requireFeatureEnabled, tenantOf } from '../featureRoute.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { loadCampaignScoped } from '../campaign-orchestration/routes.js';
import { AUTOPILOT_TOGGLE } from './ids.js';
import { runPreflight } from './preflight.js';
import { launchAutopilot } from './launch.js';

const BASE = '/host/openwop-app/campaign-autopilot';

async function requireAutopilot(req: Request): Promise<void> {
  await requireFeatureEnabled(req, 'campaign-orchestration', 'Campaign Studio');
  await requireFeatureEnabled(req, AUTOPILOT_TOGGLE, 'Campaign autopilot');
}

export function registerCampaignAutopilotRoutes(deps: RouteDeps): void {
  const { app } = deps;

  app.get(`${BASE}/campaigns/:campaignId/preflight`, async (req, res, next) => {
    try {
      await requireAutopilot(req);
      const campaign = await loadCampaignScoped(req, 'workspace:read');
      // Whether THIS caller may launch, by the same scope the launch route
      // requires, so the UI can say so before a click. Advisory: launch re-checks.
      const subject = req.userId ?? req.principal?.principalId;
      const canLaunch = subject
        ? (await resolveEffectiveAccess(tenantOf(req), { subject, orgId: campaign.orgId })).scopes.includes('workspace:write')
        : false;
      res.json({ preflight: await runPreflight(tenantOf(req), campaign), canLaunch });
    } catch (err) { next(err); }
  });

  app.post(`${BASE}/campaigns/:campaignId/launch`, async (req, res, next) => {
    try {
      await requireAutopilot(req);
      // A person first: the org predicate answers OWNER for a missing subject.
      const actingUserId = req.userId ?? req.principal?.principalId;
      if (!actingUserId) throw new OpenwopError('unauthenticated', 'Sign in to launch a campaign.', 401, {});
      const campaign = await loadCampaignScoped(req, 'workspace:write');
      const out = await launchAutopilot({ storage: deps.storage, hostSuite: deps.hostSuite }, { tenantId: tenantOf(req), campaign, actingUserId });
      res.status(out.reused ? 200 : 201).json(out);
    } catch (err) { next(err); }
  });
}
