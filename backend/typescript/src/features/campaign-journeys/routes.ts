/**
 * Campaign-journeys routes (ADR 0222) — visibility reads only: the enrollment
 * ledger (which contact ran which journey when) + an explicit re-enrollment
 * reset. The journeys themselves are workflow chains — run/monitored through
 * the existing run surfaces, never a parallel console.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { listEnrollments, resetEnrollment } from './journeyService.js';

const TOGGLE_ID = 'campaign-journeys';
const LABEL = 'Campaign Journeys';
const tenantOf = (req: Request): string => req.tenantId ?? 'default';

export function registerCampaignJourneysRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/v1/host/openwop-app/campaign-journeys';

  app.get(`${BASE}/enrollments`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const journeyId = typeof req.query.journeyId === 'string' && req.query.journeyId.length > 0 ? req.query.journeyId : undefined;
      res.json({ enrollments: await listEnrollments(tenantOf(req), journeyId) });
    } catch (err) { next(err); }
  });

  // Explicit re-enrollment (operator intent) — DELETE the guard row.
  app.delete(`${BASE}/enrollments`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const journeyId = requireString(body.journeyId, 'journeyId');
      const contactId = requireString(body.contactId, 'contactId');
      res.json({ reset: await resetEnrollment(tenantOf(req), journeyId, contactId) });
    } catch (err) { next(err); }
  });
}
