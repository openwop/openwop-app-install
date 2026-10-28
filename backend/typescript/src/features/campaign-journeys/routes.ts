/**
 * Campaign-journeys routes (ADR 0222) — visibility reads only: the enrollment
 * ledger (which contact ran which journey when) + an explicit re-enrollment
 * reset. The journeys themselves are workflow chains — run/monitored through
 * the existing run surfaces, never a parallel console.
 *
 * ADR 0955 D1 (J9, architect H3) — once a workspace has clients, both routes name the
 * client (`orgId`) and need that client's scope: `workspace:read` to list, `workspace:write`
 * to reset. A workspace with no client keeps the original toggle-only behaviour.
 */
import type { Request } from 'express';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { requireFeatureEnabled, requireString } from '../featureRoute.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { assertOrgScope, type Scope } from '../../host/accessControlService.js';
import { OpenwopError } from '../../types.js';
import { listEnrollments, resetEnrollment, resolveEnrollmentOrg } from './journeyService.js';
import { getSendPolicy, setSendPolicy } from './sendPolicy.js';

const TOGGLE_ID = 'campaign-journeys';
const LABEL = 'Campaign Journeys';
const tenantOf = (req: Request): string => req.tenantId ?? 'default';

/**
 * The client an HTTP request names. Stricter than the run lane: a route caller who names an
 * org that is neither a client nor the workspace root gets 404, never the workspace's own
 * rows (the run lane maps such an org to the workspace only for pre-0955 chains).
 */
async function namedClient(tenantId: string, raw: unknown): Promise<string> {
  const named = typeof raw === 'string' ? raw.trim() : '';
  const orgId = await resolveEnrollmentOrg(tenantId, named || undefined);
  if (named && !orgId && named !== tenantId) throw new OpenwopError('not_found', 'Client not found.', 404, { orgId: named });
  return orgId;
}

/** The client a request is for, scope-checked. `''` only in a workspace with no client. */
async function clientOf(req: Request, raw: unknown, scope: Scope): Promise<string> {
  const tenantId = tenantOf(req);
  const orgId = await namedClient(tenantId, raw);
  if (orgId) await assertOrgScope(tenantId, (await resolveCallerUser(req)).userId, orgId, scope);
  return orgId;
}

export function registerCampaignJourneysRoutes(deps: RouteDeps): void {
  const { app } = deps;
  const BASE = '/host/openwop-app/campaign-journeys';

  app.get(`${BASE}/enrollments`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = await clientOf(req, req.query.orgId, 'workspace:read');
      const journeyId = typeof req.query.journeyId === 'string' && req.query.journeyId.length > 0 ? req.query.journeyId : undefined;
      res.json({ enrollments: await listEnrollments(tenantOf(req), journeyId, orgId || undefined) });
    } catch (err) { next(err); }
  });

  // ADR 0955 D4 — a client's send windows. Changing when a client may text its customers is
  // an admin act on that client (`host:members:manage`; the workspace root for `''`).
  const manageSendPolicy = async (req: Request, raw: unknown): Promise<string> => {
    const tenantId = tenantOf(req);
    const orgId = await namedClient(tenantId, raw);
    await assertOrgScope(tenantId, (await resolveCallerUser(req)).userId, orgId || tenantId, 'host:members:manage');
    return orgId;
  };
  app.get(`${BASE}/send-policy`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const orgId = await manageSendPolicy(req, req.query.orgId);
      res.json({ policy: await getSendPolicy(tenantOf(req), orgId) });
    } catch (err) { next(err); }
  });
  app.put(`${BASE}/send-policy`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = await manageSendPolicy(req, body.orgId);
      const actor = (await resolveCallerUser(req)).userId;
      res.json({ policy: await setSendPolicy({ tenantId: tenantOf(req), orgId, defaultTimezone: body.defaultTimezone, windows: body.windows, updatedBy: actor }) });
    } catch (err) { next(err); }
  });

  // Explicit re-enrollment (operator intent) — DELETE the guard row.
  app.delete(`${BASE}/enrollments`, async (req, res, next) => {
    try {
      await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const orgId = await clientOf(req, body.orgId, 'workspace:write');
      const journeyId = requireString(body.journeyId, 'journeyId');
      const contactId = requireString(body.contactId, 'contactId');
      res.json({ reset: await resetEnrollment(tenantOf(req), journeyId, contactId, orgId) });
    } catch (err) { next(err); }
  });
}
