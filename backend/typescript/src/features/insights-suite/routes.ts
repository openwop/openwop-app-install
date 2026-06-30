/**
 * Insights & Drafting Agent Suite routes (ADR 0078 Phase 1) — host-extension under
 * /v1/host/openwop-app/insights-suite/*. READ-ONLY in P1 (the dashboard's read model);
 * writes happen through the agents' meta-workflows (P2).
 *
 * Gating, fail-closed (ADR 0006), mirroring priority-matrix:
 *   1. toggle `insights-suite` ON for the caller (requireFeatureEnabled).
 *   2. RBAC — reads need `workspace:read` in the tenant-root org. (We reuse the
 *      existing protocol scope, NOT a new `insights-suite:view` scope — adding to
 *      RFC 0049 PROTOCOL_SCOPES would be a wire change; see ADR 0078 §Phase-1 correction.)
 *   3. Tenant isolation — every read filters by the caller's tenant (IDOR-guarded in
 *      the service).
 *
 * @see docs/adr/0078-insights-drafting-agent-suite.md
 */

import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { resolveEffectiveAccess, type Scope } from '../../host/accessControlService.js';
import { requireFeatureEnabled } from '../featureRoute.js';
import { getConfig, applyConfig, type InsightsSuiteConfig } from './insightsSuiteService.js';
import { parseCron } from '../../host/cronSchedule.js';

const TOGGLE_ID = 'insights-suite';
const LABEL = 'Insights & Drafting Agent Suite';
const BASE = '/v1/host/openwop-app/insights-suite';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
const actingUserOf = (req: Request): string | undefined => req.userId ?? req.principal?.principalId;

/** Fail-closed read gate: toggle ON + `workspace:read` in the tenant-root org. A caller
 *  without the scope gets a uniform 404 (no existence leak), matching the other features. */
async function requireRead(req: Request): Promise<string> {
  await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
  const tenant = tenantOf(req);
  const access = await resolveEffectiveAccess(tenant, { subject: actingUserOf(req), orgId: tenant });
  if (!access.scopes.includes('workspace:read' as Scope)) {
    throw new OpenwopError('not_found', 'Not found', 404);
  }
  return tenant;
}

/** Write gate: toggle ON + `workspace:write` in the tenant-root org (403 on miss). */
async function requireWrite(req: Request): Promise<string> {
  await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
  const tenant = tenantOf(req);
  const access = await resolveEffectiveAccess(tenant, { subject: actingUserOf(req), orgId: tenant });
  if (!access.scopes.includes('workspace:write' as Scope)) {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
  }
  return tenant;
}

export function registerInsightsSuiteRoutes(deps: RouteDeps): void {
  const app = deps.app;

  app.get(`${BASE}/config`, async (req, res, next) => {
    try {
      const tenant = await requireRead(req);
      res.json({ config: await getConfig(tenant) });
    } catch (err) { next(err); }
  });

  // Config set/update — gated workspace:write. Reconciles the weekly-variance schedule
  // (RFC 0052) + the anniversary trigger (RFC 0099) onto the workflow engine; a cron
  // registers the deterministic job, absent cron removes it.
  app.put(`${BASE}/config`, async (req, res, next) => {
    try {
      const tenant = await requireWrite(req);
      const body = (req.body ?? {}) as Partial<InsightsSuiteConfig>;
      const principalUserId = String(body.principalUserId ?? '').trim();
      if (!principalUserId) throw new OpenwopError('invalid_request', 'principalUserId is required.', 400);
      // ADR 0081 P6 — validate the cron at the HTTP boundary (reuse the scheduler's
      // single parser, host/cronSchedule). Without this a malformed cron persists a
      // silently never-firing job (ADR 0078 P2 review LOW).
      if (body.scheduleCron && parseCron(String(body.scheduleCron)) === null) {
        throw new OpenwopError('invalid_request', 'scheduleCron is not a valid 5-field cron expression.', 400, { field: 'scheduleCron' });
      }
      const config: InsightsSuiteConfig = {
        tenantId: tenant,
        principalUserId,
        businessUnits: Array.isArray(body.businessUnits) ? body.businessUnits.map(String) : [],
        ...(body.scheduleCron ? { scheduleCron: String(body.scheduleCron) } : {}),
        ...(body.scheduleTimezone ? { scheduleTimezone: String(body.scheduleTimezone) } : {}),
        ...(body.planSource ? { planSource: body.planSource } : {}),
        ...(body.anniversaryTriggerEnabled !== undefined ? { anniversaryTriggerEnabled: Boolean(body.anniversaryTriggerEnabled) } : {}),
        updatedAt: new Date().toISOString(),
      };
      res.json({ config: await applyConfig(config) });
    } catch (err) { next(err); }
  });
  // ADR 0082 — the result read routes (GET /variance, /variance/:id, /talent) were DELETED
  // with the parallel read model + dashboard. Insights are now the LIVE output of running the
  // built-in workflows, surfaced through the existing runs / artifacts / chat / notifications.
}
