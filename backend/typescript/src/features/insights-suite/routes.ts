/**
 * Insights & Drafting Agent Suite routes — host-extension under
 * /v1/host/openwop-app/insights-suite/*. GET + PUT of the suite CONFIG (which BUs,
 * the weekly cron + timezone, the plan source, the anniversary-trigger flag), which
 * `applyConfig` reconciles onto the RFC 0052 scheduler + the RFC 0099 trigger bridge.
 *
 * ADR 0599 §7 — this header used to read "READ-ONLY in P1 (the dashboard's read
 * model); writes happen through the agents' meta-workflows (P2)". Both halves were
 * false: the `PUT` handler 60 lines below contradicts the first, and ADR 0082 DELETED
 * the read model the second names — as the correction note at the foot of this file
 * already said. A reader going top-down was told the opposite of the truth, which is
 * this feature's recurring failure mode: a documented mechanism nobody re-grepped.
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

/**
 * ADR 0599 §7 (ISC-8) — refuse BEFORE resolving access when there is no acting
 * subject.
 *
 * `resolveEffectiveAccess` guards its whole member-resolution block on
 * `opts.memberId !== undefined || opts.subject !== undefined`. With `subject:
 * undefined` that is false regardless of `orgId`, and control falls through to a
 * branch that returns `roles:['owner']` with the FULL owner scope set — the file
 * documents this as a known trap ("the fail direction is open"). So both gates below
 * would pass unconditionally for a caller with no `req.userId` and no
 * `req.principal`.
 *
 * Stated as precisely as the audit did: this is LATENT, not a live bypass. In the
 * normal HTTP lane `authMiddleware` always populates `req.principal`, including its
 * anon fallback. But the safety of two authorization gates then rests entirely on an
 * invariant held in a different file, with no test asserting it here — and "another
 * module always sets this" is exactly the kind of claim this feature has already been
 * wrong about twice. One line makes it local and checkable.
 */
function requireActingSubject(req: Request): void {
  if (!actingUserOf(req)) {
    throw new OpenwopError('not_found', 'Not found', 404, { feature: TOGGLE_ID });
  }
}

/** Fail-closed read gate: toggle ON + `workspace:read` in the tenant-root org. A caller
 *  without the scope gets a uniform 404 (no existence leak), matching the other features. */
async function requireRead(req: Request): Promise<string> {
  await requireFeatureEnabled(req, TOGGLE_ID, LABEL);
  const tenant = tenantOf(req);
  requireActingSubject(req);
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
  requireActingSubject(req);
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
      // ADR 0599 §6 (ISC-6/ISWF-7) — VALIDATE EVERY FIELD BEFORE ANY WRITE.
      // The cron was validated here and the timezone was not, and the asymmetry
      // was strictly worse than the bug the cron guard was added to eliminate:
      // `applyConfig` persists FIRST and reconciles second, and an invalid IANA
      // zone reaches `Intl.DateTimeFormat` inside `computeNextFire`, which throws
      // an uncaught `RangeError` out of `registerJob`. Note the ordering that
      // makes it bite: `parseCron` runs first, so a VALID cron with a typo'd
      // timezone (`America/Chicgo`) is exactly the case that reaches the throw.
      // The caller got a 500 they read as a server fault, `GET /config` then
      // returned a cron and a timezone as if configured, and `listJobs` held
      // nothing. A refusal that persists is worse than the bug it replaced.
      if (body.scheduleTimezone !== undefined) {
        const tz = String(body.scheduleTimezone);
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: tz });
        } catch {
          throw new OpenwopError('invalid_request', `scheduleTimezone is not a valid IANA time zone: ${tz}`, 400, { field: 'scheduleTimezone' });
        }
      }
      // ADR 0599 §6 — refuse to ARM a schedule that provably cannot run. The
      // weekly-variance chain declares `projectId` REQUIRED and has no default
      // (a BigQuery project is tenant-specific), and the scheduled lane's only
      // source for it is `planSource.projectId`. Accepting a cron without one
      // writes a job whose every fire dies `invalid_config` at node 1, forever,
      // with no alert — this feature's original failure mode, re-created one
      // level up. `planSource` was read by nothing before ADR 0599.
      if (body.scheduleCron && !String(body.planSource?.projectId ?? '').trim()) {
        throw new OpenwopError(
          'invalid_request',
          'planSource.projectId is required to arm a weekly variance schedule — without it every scheduled run fails at its first node.',
          400,
          { field: 'planSource.projectId' },
        );
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
