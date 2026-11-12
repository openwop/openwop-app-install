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
import { requireFeatureEnabled, callerOwnerSpellings, callerSubjectSpellings } from '../featureRoute.js';
import { callerSubject, isAnonTenantId, personalTenantOf } from '../../host/requestSubject.js';
import { getConfig, applyConfig, isWeeklyScheduleArmed, type InsightsSuiteConfig } from './insightsSuiteService.js';
import { parseCron } from '../../host/cronSchedule.js';

const TOGGLE_ID = 'insights-suite';
const LABEL = 'Insights & Drafting Agent Suite';
const BASE = '/host/openwop-app/insights-suite';

const tenantOf = (req: Request): string => req.tenantId ?? 'default';
/** The shared helper (`host/requestSubject.ts`), not a local copy (ADR 1102 D4). */
const actingUserOf = callerSubject;

/** ADR 1102 D5 — the closed world a PUT may carry. The last three are what a GET
 *  returns, so a GET → edit → PUT round trip is accepted; they are ignored, and
 *  `principalUserId` is checked rather than taken (D4). */
const PUT_KEYS = new Set([
  'scheduleCron', 'scheduleTimezone', 'planSource', 'businessUnit', 'businessUnits',
  'anniversaryTriggerEnabled', 'takeOver', 'tenantId', 'principalUserId', 'updatedAt',
]);
/** A GCP project id (6-30 characters), or the legacy `domain:project` form. The
 *  settings panel holds the same rule (`InsightsSuitePanel.tsx`). */
const PROJECT_ID = /^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
/** Every refusal carries `field` and a closed `reason`, so the settings panel can
 *  show its own localized sentence instead of this developer-facing one. */
const fieldError = (field: string, message: string, reason: string): OpenwopError =>
  new OpenwopError('invalid_request', message, 400, { field, reason });

/** ADR 1102 D4 — the spellings the caller is matched by. `callerOwnerSpellings`
 *  adds the raw auth principal, which its own doc says is safe to compare ONLY
 *  against rows in the caller's personal tenant (the code-review pass): in a
 *  shared workspace two people from different IdPs can share a raw `sub`. */
export async function configPrincipalSpellings(req: Request, tenant: string): Promise<string[]> {
  return tenant === personalTenantOf(req) ? callerOwnerSpellings(req) : callerSubjectSpellings(req);
}

/** Parse the PUT body into the fields a save may set, refusing anything else. */
function parseConfigBody(raw: unknown): {
  scheduleCron?: string; scheduleTimezone?: string; planSource?: { projectId: string };
  businessUnit?: string; anniversaryTriggerEnabled?: boolean; takeOver: boolean; principalUserId?: string;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OpenwopError('invalid_request', 'The body must be a JSON object.', 400);
  const body = raw as Record<string, unknown>;
  for (const k of Object.keys(body)) {
    if (!PUT_KEYS.has(k)) throw fieldError(k, `Unknown field: ${k}.`, 'unknown_field');
  }
  const str = (k: string, max: number): string | undefined => {
    const v = body[k];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') throw fieldError(k, `${k} must be a string.`, 'not_string');
    const t = v.trim();
    if (t.length > max) throw fieldError(k, `${k} is longer than ${max} characters.`, 'too_long');
    return t || undefined;
  };
  const out: ReturnType<typeof parseConfigBody> = { takeOver: body.takeOver === true };
  const cron = str('scheduleCron', 120); if (cron) out.scheduleCron = cron;
  const tz = str('scheduleTimezone', 64); if (tz) out.scheduleTimezone = tz;
  const principal = str('principalUserId', 256); if (principal) out.principalUserId = principal;
  // ADR 1102 D5 (`INS91-10`) — ONE business unit, because the schedule could only
  // ever run one. The legacy list is accepted with at most one entry.
  const bu = str('businessUnit', 120);
  if (body.businessUnits !== undefined) {
    if (bu) throw fieldError('businessUnits', 'Send businessUnit or businessUnits, not both.', 'both_spellings');
    if (!Array.isArray(body.businessUnits)) throw fieldError('businessUnits', 'businessUnits must be an array.', 'not_array');
    if (body.businessUnits.length > 1) throw fieldError('businessUnits', 'The weekly variance analyses one business unit. Send businessUnit.', 'one_business_unit');
    const only = body.businessUnits[0];
    if (only !== undefined) {
      if (typeof only !== 'string' || only.trim().length > 120) throw fieldError('businessUnits', 'A business unit is a string of at most 120 characters.', 'too_long');
      if (only.trim()) out.businessUnit = only.trim();
    }
  } else if (bu) {
    out.businessUnit = bu;
  }
  // ADR 1102 D5 (`INS91-11`) — `planSource` was persisted verbatim: any object, any
  // size, and an object `projectId` passed the arm guard as "[object Object]".
  if (body.planSource !== undefined && body.planSource !== null) {
    const ps = body.planSource;
    if (typeof ps !== 'object' || Array.isArray(ps)) throw fieldError('planSource', 'planSource must be an object.', 'not_object');
    const p = ps as Record<string, unknown>;
    // `dataset` is refused, not silently dropped: it was stored and read by
    // nothing (the code-review pass). The dataset belongs in the chain's `sql`.
    for (const k of Object.keys(p)) {
      if (k !== 'projectId') throw fieldError(`planSource.${k}`, `Unknown field: planSource.${k}.`, 'unknown_field');
    }
    const v = p.projectId;
    if (v !== undefined && v !== null && v !== '') {
      if (typeof v !== 'string' || v.trim().length > 200) throw fieldError('planSource.projectId', 'planSource.projectId must be a string of at most 200 characters.', 'not_string');
      if (!PROJECT_ID.test(v.trim())) {
        throw fieldError('planSource.projectId', 'planSource.projectId is not a BigQuery project id (6-30 lowercase letters, digits or hyphens, starting with a letter).', 'invalid_project_id');
      }
      out.planSource = { projectId: v.trim() };
    }
  }
  if (body.anniversaryTriggerEnabled !== undefined) {
    if (typeof body.anniversaryTriggerEnabled !== 'boolean') throw fieldError('anniversaryTriggerEnabled', 'anniversaryTriggerEnabled must be true or false.', 'not_boolean');
    out.anniversaryTriggerEnabled = body.anniversaryTriggerEnabled;
  }
  return out;
}

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
      const config = await getConfig(tenant);
      // ADR 1102 D10 — what the settings panel needs to say who the suite runs as
      // and whether this caller may change it, computed with the same predicates
      // the PUT applies (so the panel never offers a save the door refuses).
      const access = await resolveEffectiveAccess(tenant, { subject: actingUserOf(req), orgId: tenant });
      const mine = await configPrincipalSpellings(req, tenant);
      res.json({
        config,
        runsAsYou: config ? mine.includes(config.principalUserId) : null,
        scheduleArmed: config ? await isWeeklyScheduleArmed(config) : false,
        canWrite: access.scopes.includes('workspace:write' as Scope) && !isAnonTenantId(personalTenantOf(req)) && !isAnonTenantId(tenant),
      });
    } catch (err) { next(err); }
  });

  // Config set/update — gated workspace:write. Reconciles the weekly-variance schedule
  // (RFC 0052) + the anniversary trigger (RFC 0099) onto the workflow engine; a cron
  // registers the deterministic job, absent cron removes it.
  app.put(`${BASE}/config`, async (req, res, next) => {
    try {
      const tenant = await requireWrite(req);
      // ADR 1102 D4 — a weekly job runs AS its principal, so its principal is never
      // an anonymous sandbox session (thrown away on sign-in). An API-key operator is
      // a legitimate writer here, as on the core scheduler's shared-workspace lane.
      if (isAnonTenantId(personalTenantOf(req)) || isAnonTenantId(tenant)) {
        throw new OpenwopError('unauthenticated', 'A signed-in account is required to schedule the weekly variance.', 401, {});
      }
      const body = parseConfigBody(req.body);
      // ADR 1102 D4 (`INS91-4`) — DERIVED, never supplied. This used to read
      // `body.principalUserId` verbatim, so any workspace writer could create a weekly
      // run owned by, and attributed to, any other user. The core scheduler forbids
      // exactly that; this route was a second door into the same job store.
      const caller = actingUserOf(req)!;
      const mine = await configPrincipalSpellings(req, tenant);
      const prior = await getConfig(tenant);
      // A GET → PUT round trip echoes the CURRENT principal; with `takeOver` that
      // echo is not a claim to be someone else (the code-review pass), so it is ignored.
      const echoesPrior = prior !== null && body.principalUserId === prior.principalUserId;
      if (body.principalUserId && !mine.includes(body.principalUserId) && !echoesPrior) {
        throw new OpenwopError('forbidden', 'The suite runs as the person who saves it. principalUserId cannot name someone else.', 403, { reason: 'forbidden_principal' });
      }
      // Take-over is explicit (architect M14): a second admin fixing a cron typo must
      // not silently move a colleague's schedule onto themselves.
      if (prior && !mine.includes(prior.principalUserId) && !body.takeOver) {
        throw new OpenwopError(
          'conflict',
          'This suite runs as someone else. Saving would make it run as you; send takeOver: true to do that.',
          409,
          { reason: 'principal_conflict', principalUserId: prior.principalUserId },
        );
      }
      // ADR 0081 P6 — validate the cron at the HTTP boundary (the scheduler's parser).
      if (body.scheduleCron && parseCron(body.scheduleCron) === null) {
        throw fieldError('scheduleCron', 'scheduleCron is not a valid 5-field cron expression.', 'invalid_cron');
      }
      // ADR 0599 §6 (ISC-6/ISWF-7) — VALIDATE EVERY FIELD BEFORE ANY WRITE: an
      // invalid IANA zone threw out of `registerJob` after the row was persisted.
      if (body.scheduleTimezone !== undefined) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: body.scheduleTimezone });
        } catch {
          throw fieldError('scheduleTimezone', `scheduleTimezone is not a valid IANA time zone: ${body.scheduleTimezone}`, 'invalid_timezone');
        }
      }
      // ADR 0599 §6 — refuse to ARM a schedule that provably cannot run: the chain
      // requires `projectId`, and the scheduled lane's only source is `planSource`.
      if (body.scheduleCron && !body.planSource?.projectId) {
        throw fieldError('planSource.projectId', 'planSource.projectId is required to arm a weekly variance schedule — without it every scheduled run fails at its first node.', 'project_required');
      }
      const config: InsightsSuiteConfig = {
        tenantId: tenant,
        principalUserId: caller,
        ...(body.businessUnit ? { businessUnit: body.businessUnit } : {}),
        ...(body.scheduleCron ? { scheduleCron: body.scheduleCron } : {}),
        ...(body.scheduleTimezone ? { scheduleTimezone: body.scheduleTimezone } : {}),
        ...(body.planSource ? { planSource: body.planSource } : {}),
        ...(body.anniversaryTriggerEnabled !== undefined ? { anniversaryTriggerEnabled: body.anniversaryTriggerEnabled } : {}),
        updatedAt: new Date().toISOString(),
      };
      res.json({ config: await applyConfig(config) });
    } catch (err) { next(err); }
  });
  // ADR 0082 — the result read routes (GET /variance, /variance/:id, /talent) were DELETED
  // with the parallel read model + dashboard. Insights are now the LIVE output of running the
  // built-in workflows, surfaced through the existing runs / artifacts / chat / notifications.
}
