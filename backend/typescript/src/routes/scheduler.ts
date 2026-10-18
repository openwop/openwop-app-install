/**
 * Host-extension scheduler CRUD — `/v1/host/openwop-app/scheduler/jobs`.
 *
 * Namespace: host-extension under `/v1/host/openwop-app/*`; this is NOT part of
 * the normative OpenWOP wire contract (vendor-prefixed per
 * spec/v1/host-extensions.md). It exposes the durable host-side scheduled-job
 * store (host/schedulingService.ts) — which sits alongside the RFC 0052
 * `scheduling/tick` conformance seam — as a list/create/delete/enable/trigger
 * surface so the agent "Schedules" tab (and CLI tooling) can manage agent-owned
 * cron jobs.
 *
 * Routes:
 *   GET    /v1/host/openwop-app/scheduler/jobs[?rosterId=]     — list jobs (tenant-scoped; optional roster filter)
 *   POST   /v1/host/openwop-app/scheduler/jobs                 — register a job (optional roster/agent attribution)
 *   PATCH  /v1/host/openwop-app/scheduler/jobs/{jobId}         — enable/disable a job
 *   DELETE /v1/host/openwop-app/scheduler/jobs/{jobId}         — remove a job
 *   POST   /v1/host/openwop-app/scheduler/jobs/{jobId}/trigger — fire now (starts a real run)
 *
 * RFC 0052 semantics:
 *   - §B.2 fire-once-per-tick: a `/trigger` advances the deterministic clock
 *     one tick and fires the job exactly once.
 *   - §B.3 horizon: a `firstFireAtMs` beyond the advertised `maxFutureHorizon`
 *     is rejected with `schedule_horizon_exceeded` (400).
 *   - §B.4 missed-tick policy lives in the service's `missedWindow` /
 *     `singleTick` evaluator and is exercised by the conformance seam.
 *
 * The job store is now a read-through durable collection — jobs survive a
 * restart and a multi-instance deployment stays consistent (PRD §13).
 *
 * @see RFCS/0052-scheduling-and-time-based-triggers.md §B
 */

import { withPlanLapse } from '../host/schedulePlanLapse.js';
import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { OpenwopError } from '../types.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { Storage } from '../storage/storage.js';
import {
  registerJob,
  listJobs,
  listJobsByRoster,
  listJobsByUser,
  personalScheduleId,
  getJob,
  deleteJob,
  updateJob,
  markJobFired,
  noteManualTick,
  singleTick,
  currentTick,
  scheduleSubject,
  isErasedJob,
  JobErasedError,
  ActingMemberRemovedError,
  isPausedForRemovedMember,
  ScheduleCadenceError,
  MAX_FUTURE_HORIZON_ISO,
  type ScheduledJob,
} from '../host/schedulingService.js';
import { fireJob } from '../host/scheduleDaemon.js';
import { getRosterEntry } from '../host/rosterService.js';
import { callerSubject, personalTenantOf, isDurableCaller, isPersonalTenantId } from '../host/requestSubject.js';
import { resolveSubjectAccess, type AccessLevel } from '../host/subjectAccess.js';
import { scheduledJobReadable } from '../host/scheduledJobReadGates.js';
import { keyDeclarationPermits } from '../host/protocolAuthorization.js';
import { callerHoldsTenantScope, callerSubjectSpellings, requireTenantWrite } from '../features/featureRoute.js';
import { resolveCallerUser } from '../features/users/usersGuards.js';
import { CALLER_LINKAGE_KEYS } from '../host/runLinkage.js';

interface Deps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

function tenantOf(req: Request): string {
  return (req as { tenantId?: string }).tenantId ?? 'default';
}

/**
 * SECURITY (ADR 0024 D2 / ADR 0787 D3) — job metadata is carried verbatim onto
 * every schedule-fired run, where `actingUserId` keys per-user CREDENTIAL
 * resolution and the attribution blocks feed the activity index. They are
 * server-stamped trust surfaces, so a client body never sets them — on POST and,
 * since ADR 0787, on PATCH too (PATCH used to copy `metadata` verbatim, which let
 * anyone who could patch a job make it act as a colleague). `assistantLoop` is a
 * feature marker the assistant loops key their jobs on.
 */
// `disabledReason` — ADR 0815 D4: the member-removed pause marker is server-owned,
// so a client cannot clear it and then re-enable the job as the ex-member.
// ADR 0879 D7 — `orgScopeSubject` (the human a feature-created job fires for, e.g. a
// scheduled chat's creator) is host-written and becomes the run's narrowing subject.
// ADR 0902 D2 (architect A1) — plus the task-deck parent linkage: a job's metadata
// rides onto every run it fires (`scheduleDaemon.ts`), so a caller-set linkage
// would plant a card in another member's deck on each fire.
const RESERVED_JOB_METADATA_KEYS = new Set<string>(['actingUserId', 'heartbeat', 'schedule', 'kanban', 'approval', 'assistantLoop', 'disabledReason', 'orgScopeSubject', 'personalTenant', ...CALLER_LINKAGE_KEYS]);

function clientMetadata(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([k]) => !RESERVED_JOB_METADATA_KEYS.has(k)));
}

/** Who a job created or retargeted by this request acts as — the same
 *  derivation POST has always used. */
function actingUserOf(req: Request): string | undefined {
  return req.userId ?? req.principal?.principalId;
}

/**
 * ADR 0787 D4 — every spelling THIS request's person is known by: the canonical
 * `user:<id>`, the raw subject, AND the auth principal (`oidc:<sub>`). The last
 * one is what `callerSubjectSpellings` leaves out for a BOUND session, and it is
 * exactly the spelling a schedule created before the bind carries forever. All
 * three are the same person's own identity — never another person's row, so no
 * cross-tenant or cross-IdP alias can creep in — and they are only ever compared
 * against rows in
 * the caller's PERSONAL tenant (the home tenant that principal was minted in).
 * The one lookup — the caller's own User row — is guarded by that same rule.
 */
async function ownerSpellings(req: Request): Promise<string[]> {
  const out = new Set(await callerSubjectSpellings(req));
  if (req.principal?.auth?.kind !== 'subject') return [...out];
  if (req.principal.principalId) out.add(req.principal.principalId);
  // A BOUND cookie session presents `user:<id>` as its principal too, so the
  // legacy spelling lives only on the caller's own User row — and is added only
  // when that row's tenant IS the caller's personal tenant (the one place that
  // principal was minted under this person's own IdP; ADR 0780 D2 as corrected).
  try {
    const user = await resolveCallerUser(req);
    if (user.principalId && user.tenantId === personalTenantOf(req)) out.add(user.principalId);
  } catch {
    // No durable User row: the request's own spellings above are all there is.
  }
  return [...out];
}

/** Does this request's credential permit `workspace:write` at all? An `owk_` key
 *  that declared a narrower set can only ever REMOVE authority — applied on every
 *  arm, including the caller's own personal workspace (ADR 0787 D3). */
function credentialPermitsWrite(req: Request): boolean {
  const auth = req.principal?.auth;
  return !(auth?.kind === 'api-key' && !keyDeclarationPermits(auth.scopes, 'workspace:write'));
}

/**
 * ADR 0787 D3 — a job a FEATURE built for one workflow. Its `configurable`
 * (e.g. a platform credential ref), seeded `inputs`, owning `featureId` or
 * feature marker were stamped server-side for THAT workflow; retargeting it would
 * hand them to a workflow the patcher chose. Change such a job through its
 * feature.
 */
function isFeatureConfigured(job: ScheduledJob): boolean {
  const m = job.metadata ?? {};
  return job.configurable !== undefined || job.inputs !== undefined || job.featureId !== undefined
    || m.assistantLoop !== undefined || m.purpose !== undefined || m.tool !== undefined;
}

/**
 * ADR 0787 D3 (supersedes the ADR 0608 two-way gate) — the per-request job gate:
 * `none | read | write`, in order:
 *
 *  1. a subject resolver applies (a `project`, an advisory `board`): its level —
 *     ADR 0608 `CPC-1`, unchanged;
 *  2. a PERSONAL job the caller owns: the job lives in the caller's personal
 *     tenant AND its owner is one of the caller's spellings (ADR 0787 D4 —
 *     `oidc:<sub>` and `user:<id>` are one person, and both are THIS request's).
 *     Confined to the personal tenant: a user-owned job in a SHARED tenant
 *     (KickBot convene, session reminders) is judged by arm 3, never by
 *     ownership — ownership there would let a Viewer retarget a job carrying a
 *     platform credential;
 *  3. a job in the caller's active tenant: `write` iff the caller holds
 *     `workspace:write` there (`callerHoldsTenantScope` — both spellings, key
 *     narrowing, the operator principal), else `read`. This arm used to answer
 *     `true` for every member, so a Viewer could create, retarget, fire and
 *     delete any automation in the workspace;
 *  4. otherwise `none`.
 *
 * Created ONCE per request; memoizes the subject resolution per owner and the
 * caller's spellings + tenant scope, so a list of N jobs costs O(1) authority
 * reads, not N.
 */
type JobGate = (job: ScheduledJob) => Promise<AccessLevel>;

function jobGateFor(req: Request): JobGate {
  const caller = callerSubject(req);
  const activeTenant = tenantOf(req);
  const personal = personalTenantOf(req);
  const memo = new Map<string, Promise<AccessLevel | null>>();
  let spellings: Promise<string[]> | undefined;
  let activeWrite: Promise<boolean> | undefined;
  const acting = req.userId ?? req.principal?.principalId;
  return async (job) => {
    // ADR 0846 D1b — a feature-owned job the caller may not see is unreachable,
    // whatever the arms below would say. Narrowing only.
    if (!(await scheduledJobReadable(job, acting))) return 'none';
    const subject = scheduleSubject(job);
    if (subject) {
      const key = JSON.stringify([job.tenantId, subject.kind, subject.id]);
      let pending = memo.get(key);
      if (pending === undefined) {
        pending = resolveSubjectAccess(job.tenantId, subject, caller);
        memo.set(key, pending);
      }
      const level = await pending;
      if (level !== null) return level;
    }
    const owner = job.ownerUserId ?? (subject?.kind === 'user' ? subject.id : undefined);
    // `isPersonalTenantId` — under SAML the "personal" tenant is the ONE host-global
    // tenant every SAML user shares (USERS-19), and ownership there is no
    // authority at all (`SCTCD-3`).
    if (isPersonalTenantId(personal) && job.tenantId === personal && owner !== undefined && isDurableCaller(req)) {
      spellings ??= ownerSpellings(req);
      if ((await spellings).includes(owner)) return credentialPermitsWrite(req) ? 'write' : 'read';
    }
    if (job.tenantId === activeTenant) {
      activeWrite ??= callerHoldsTenantScope(req, activeTenant, 'workspace:write');
      return (await activeWrite) ? 'write' : 'read';
    }
    return 'none';
  };
}

/** Load a job and require `need` on it: uniform 404 when unreachable (no
 *  existence oracle), 403 `forbidden_scope` when readable but not writable. */
async function authorizeJob(req: Request, jobId: string, need: 'read' | 'write'): Promise<ScheduledJob> {
  const job = await getJob(jobId);
  const level = job ? await jobGateFor(req)(job) : 'none';
  if (!job || level === 'none') {
    throw new OpenwopError('not_found', `Scheduled job ${jobId} not found.`, 404, { jobId });
  }
  if (need === 'write' && level !== 'write') {
    throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
  }
  return job;
}

/** RFC 0052 §B.3 — the scheduling-specific refusal, rendered inline with the
 *  canonical `{ error, message }` shape (the code is not in the normative
 *  OpenwopErrorCode union). */
function horizonExceeded(res: Response, message: string): void {
  res.status(400).json({ error: 'schedule_horizon_exceeded', message, details: { maxFutureHorizon: MAX_FUTURE_HORIZON_ISO } });
}

export function registerSchedulerRoutes(app: Express, deps: Deps): void {
  app.get('/host/openwop-app/scheduler/jobs', async (req, res, next) => {
    try {
      // ADR 0025 — `?owner=me` lists the caller's OWN user-owned schedules from
      // their personal tenant (the profile "Schedules" tab), independent of the
      // active workspace. A non-durable (anon) caller simply has none. ADR 0787
      // D4 — under EITHER spelling of the caller: a schedule created while the
      // caller presented `oidc:<sub>` is still theirs once they present
      // `user:<id>`.
      if (req.query.owner === 'me') {
        const personal = personalTenantOf(req);
        if (!callerSubject(req) || !personal || !isDurableCaller(req)) {
          res.json({ jobs: [] });
          return;
        }
        const seen = new Map<string, ScheduledJob>();
        for (const spelling of await ownerSpellings(req)) {
          for (const job of await listJobsByUser(personal, spelling)) seen.set(job.jobId, job);
        }
        res.json({ jobs: await withPlanLapse([...seen.values()].sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))) });
        return;
      }
      const tenantId = tenantOf(req);
      const rosterId = typeof req.query.rosterId === 'string' ? req.query.rosterId : undefined;
      const jobs = rosterId ? await listJobsByRoster(tenantId, rosterId) : await listJobs(tenantId);
      // ADR 0608 (`CPC-1`) — the list is the READ door: the subject gate drops
      // what the caller cannot read (a `private` project's schedule).
      const gate = jobGateFor(req);
      const readable: ScheduledJob[] = [];
      for (const job of jobs) if ((await gate(job)) !== 'none') readable.push(job);
      // ADR 0820 §7 — `planLapsed` is computed per read (the job row holds no paused state).
      res.json({ jobs: await withPlanLapse(readable) });
    } catch (err) {
      next(err);
    }
  });

  app.post('/host/openwop-app/scheduler/jobs', async (req, res, next) => {
    try {
      const body = (req.body ?? {}) as {
        jobId?: unknown;
        cronExpr?: unknown;
        workflowId?: unknown;
        firstFireAtMs?: unknown;
        owner?: unknown;
        rosterId?: unknown;
        agentId?: unknown;
        enabled?: unknown;
        metadata?: unknown;
        timezone?: unknown;
      };
      // ADR 0025 — `owner: 'me'` creates a USER-owned schedule in the caller's
      // personal tenant (the profile "Schedules" tab). Durable-only; the owner is
      // derived from the caller's subject server-side (never client-supplied), so
      // a caller can only ever own its own schedules. Mutually exclusive with a
      // roster binding.
      const ownerMe = body.owner === 'me';
      let tenantId = tenantOf(req);
      let ownerUserId: string | undefined;
      if (ownerMe) {
        const subject = callerSubject(req);
        const personal = personalTenantOf(req);
        if (!subject || !personal || !isDurableCaller(req)) {
          throw new OpenwopError('unauthenticated', 'A durable signed-in account is required for a personal schedule.', 401, {});
        }
        // ADR 0787 D3 — the caller's own workspace needs no granted scope, but a
        // key that declared itself narrower than `workspace:write` stays narrow.
        if (!credentialPermitsWrite(req)) {
          throw new OpenwopError('forbidden_scope', 'Missing required scope: workspace:write', 403, { requiredScope: 'workspace:write' });
        }
        // `SCTCD-3` — a SAML session's "personal" tenant is host-global and shared;
        // creating a run-starting schedule there is a shared-workspace write.
        if (!isPersonalTenantId(personal)) await requireTenantWrite(req, personal);
        tenantId = personal;
        ownerUserId = subject;
      } else {
        // ADR 0787 D3 (`SCTWF-5`) — creating a schedule in a shared workspace is a
        // WRITE: it starts runs on the workspace's behalf, on a clock, forever.
        // This door had no scope check at all.
        await requireTenantWrite(req, tenantId);
      }
      if (typeof body.cronExpr !== 'string' || body.cronExpr.length === 0) {
        throw new OpenwopError(
          'validation_error',
          'Field `cronExpr` is required and MUST be a non-empty string.',
          400,
          { field: 'cronExpr' },
        );
      }
      if (body.timezone !== undefined && typeof body.timezone !== 'string') {
        throw new OpenwopError('validation_error', 'Field `timezone` MUST be a string.', 400, { field: 'timezone' });
      }
      // ADR 0025 — a user-owned schedule with no explicit jobId gets a
      // DETERMINISTIC id keyed on its content, so a double-submit from the
      // profile "Schedules" tab is idempotent (the scheduler POST has no
      // `Idempotency-Key`). If a job with that id already exists for this owner
      // (under either spelling — ADR 0787 D4), return it verbatim (200) — don't
      // re-register, which would reset its fire history.
      const explicitJobId = typeof body.jobId === 'string' && body.jobId.length > 0;
      const workflowId = typeof body.workflowId === 'string' ? body.workflowId : undefined;
      const jobId = explicitJobId
        ? (body.jobId as string)
        : ownerMe && ownerUserId
          ? personalScheduleId(tenantId, ownerUserId, workflowId, body.cronExpr)
          : randomUUID();
      if (ownerMe && ownerUserId && !explicitJobId) {
        const existing = await getJob(jobId);
        if (existing && existing.ownerUserId !== undefined && (await ownerSpellings(req)).includes(existing.ownerUserId)) {
          res.status(200).json(existing);
          return;
        }
      }

      // ADR 0787 (`SCTCD-2`) — an EXPLICIT id naming a job that already exists is a
      // REPLACE of that job, so it passes the same per-job gate PATCH does (a
      // workspace writer must not overwrite a private project's job) and the same
      // retarget guard (replacing a feature-configured job would drop its
      // `configurable`/`inputs`/`featureId` by the other door). A cross-tenant id
      // still answers `jobid_conflict` from the store, with no existence oracle.
      if (explicitJobId) {
        const prior = await getJob(jobId);
        if (prior && prior.tenantId === tenantId) {
          await authorizeJob(req, jobId, 'write');
          if (isFeatureConfigured(prior)) {
            throw new OpenwopError('conflict', 'This schedule is managed by its feature; change it there.', 409, { jobId });
          }
        }
      }

      // Optional RFCS/0086 roster binding — scope the schedule to a named
      // agent. The member must live in the caller's tenant (404→400 like the
      // Kanban board binding). When bound, the member's agentId is recorded
      // for attribution unless the caller passes one explicitly.
      let rosterId: string | undefined;
      let agentId = typeof body.agentId === 'string' ? body.agentId : undefined;
      if (ownerMe && body.rosterId !== undefined) {
        throw new OpenwopError('validation_error', 'A personal schedule (`owner: "me"`) cannot also bind a `rosterId`.', 400, { field: 'rosterId' });
      }
      if (!ownerMe && body.rosterId !== undefined) {
        if (typeof body.rosterId !== 'string') {
          throw new OpenwopError('validation_error', 'Field `rosterId` MUST be a string when present.', 400, {
            field: 'rosterId',
          });
        }
        const entry = await getRosterEntry(tenantId, body.rosterId);
        if (!entry) {
          throw new OpenwopError('validation_error', 'Field `rosterId` does not name a roster entry in this tenant.', 400, {
            field: 'rosterId',
          });
        }
        rosterId = entry.rosterId;
        agentId = agentId ?? entry.agentRef.agentId;
      }

      const input: Parameters<typeof registerJob>[0] = {
        jobId,
        tenantId,
        cronExpr: body.cronExpr,
      };
      if (workflowId !== undefined) input.workflowId = workflowId;
      if (typeof body.firstFireAtMs === 'number') input.firstFireAtMs = body.firstFireAtMs;
      if (rosterId !== undefined) input.rosterId = rosterId;
      if (ownerUserId !== undefined) input.ownerUserId = ownerUserId;
      if (agentId !== undefined) input.agentId = agentId;
      if (typeof body.enabled === 'boolean') input.enabled = body.enabled;
      if (body.metadata && typeof body.metadata === 'object') {
        input.metadata = clientMetadata(body.metadata as Record<string, unknown>);
      }
      const actingUserId = actingUserOf(req);
      if (actingUserId !== undefined) {
        input.metadata = { ...(input.metadata ?? {}), actingUserId };
      }
      if (typeof body.timezone === 'string') input.timezone = body.timezone;

      const result = await registerJob(input);
      if (!result.ok) {
        const { code, message } = result.error;
        // jobid_conflict (ADR 0379 P2) → 409, message deliberately unspecific (no
        // cross-tenant existence oracle). write_contention (ADR 0787 D2) → 409.
        if (code === 'jobid_conflict' || code === 'write_contention') {
          res.status(409).json({ error: code, message });
          return;
        }
        if (code === 'schedule_horizon_exceeded') {
          horizonExceeded(res, message);
          return;
        }
        // ADR 0787 D6 — an unparseable cadence or unknown zone is refused at
        // write, never stored inert (or thrown out of `Intl` as a 500).
        throw new OpenwopError('validation_error', message, 400, { field: code === 'invalid_timezone' ? 'timezone' : 'cronExpr' });
      }
      res.status(201).json(result.job);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/host/openwop-app/scheduler/jobs/:jobId', async (req, res, next) => {
    try {
      // A patch can re-point `workflowId`; it needs WRITE on the job.
      const job = await authorizeJob(req, req.params.jobId, 'write');
      const body = (req.body ?? {}) as {
        enabled?: unknown;
        cronExpr?: unknown;
        workflowId?: unknown;
        metadata?: unknown;
        timezone?: unknown;
      };
      const patch: Parameters<typeof updateJob>[1] = {};
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== 'boolean') {
          throw new OpenwopError('validation_error', 'Field `enabled` MUST be a boolean.', 400, { field: 'enabled' });
        }
        patch.enabled = body.enabled;
        // ADR 0815 D4 — resuming a job paused because its actor left the
        // workspace RE-OWNS it: the person resuming becomes its actor
        // (`updateJob` refuses otherwise). A key is a delegation, not an actor a
        // schedule can run as, so a key gets the typed 409.
        if (body.enabled === true && !job.enabled && isPausedForRemovedMember(job)) {
          const actor = actingUserOf(req);
          if (actor !== undefined && !actor.startsWith('apikey:')) patch.actingUserId = actor;
        }
      }
      if (body.cronExpr !== undefined) {
        if (typeof body.cronExpr !== 'string' || body.cronExpr.length === 0) {
          throw new OpenwopError('validation_error', 'Field `cronExpr` MUST be a non-empty string.', 400, { field: 'cronExpr' });
        }
        patch.cronExpr = body.cronExpr;
      }
      if (body.workflowId !== undefined) {
        if (typeof body.workflowId !== 'string') {
          throw new OpenwopError('validation_error', 'Field `workflowId` MUST be a string.', 400, { field: 'workflowId' });
        }
        if (body.workflowId !== job.workflowId) {
          // ADR 0787 D3 — a job a feature configured for ONE workflow is not
          // retargetable here; and a retarget makes the job act as whoever chose
          // the new workflow, never as a colleague who did not.
          if (isFeatureConfigured(job)) {
            throw new OpenwopError('conflict', 'This schedule is managed by its feature; change it there.', 409, { jobId: job.jobId });
          }
          patch.workflowId = body.workflowId;
          const actor = actingUserOf(req);
          if (actor !== undefined) patch.actingUserId = actor;
        }
      }
      if (body.timezone !== undefined) {
        if (typeof body.timezone !== 'string') {
          throw new OpenwopError('validation_error', 'Field `timezone` MUST be a string.', 400, { field: 'timezone' });
        }
        patch.timezone = body.timezone;
      }
      if (body.metadata !== undefined) {
        if (typeof body.metadata !== 'object' || body.metadata === null) {
          throw new OpenwopError('validation_error', 'Field `metadata` MUST be an object.', 400, { field: 'metadata' });
        }
        // ADR 0787 D3 — MERGED over the job's metadata with the reserved keys
        // stripped: a label edit keeps `actingUserId`, the feature markers and
        // feature keys (`tool` feeds the follow-up cap) it did not name.
        patch.mergeMetadata = clientMetadata(body.metadata as Record<string, unknown>);
      }
      if (Object.keys(patch).length === 0 && body.workflowId === undefined) {
        throw new OpenwopError('validation_error', 'Provide at least one editable field (enabled, cronExpr, workflowId, metadata, timezone).', 400, {});
      }
      try {
        const updated = await updateJob(req.params.jobId, patch);
        if (!updated) throw new OpenwopError('not_found', `Scheduled job ${req.params.jobId} not found.`, 404, { jobId: req.params.jobId });
        res.status(200).json(updated);
      } catch (err) {
        if (err instanceof ScheduleCadenceError && err.refusal.code === 'schedule_horizon_exceeded') {
          horizonExceeded(res, err.refusal.message);
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  app.delete('/host/openwop-app/scheduler/jobs/:jobId', async (req, res, next) => {
    try {
      // Destroying another team's automation needs WRITE.
      await authorizeJob(req, req.params.jobId, 'write');
      await deleteJob(req.params.jobId);
      res.status(200).json({ removed: true, jobId: req.params.jobId });
    } catch (err) {
      next(err);
    }
  });

  // Express 4 + path-to-regexp v6 dislikes a bare `:` inside a path segment,
  // so the action verb is matched via a regex-free trailing segment.
  app.post('/host/openwop-app/scheduler/jobs/:jobId/trigger', async (req, res, next) => {
    try {
      // A trigger STARTS A REAL RUN against the job's tenant; it needs WRITE.
      const job = await authorizeJob(req, req.params.jobId, 'write');
      // ADR 0815 D4 — "Run now" fires whatever `enabled` says, as the job's
      // `actingUserId`; a job paused because that member left must be re-owned
      // before it runs as anyone.
      if (isPausedForRemovedMember(job)) throw new ActingMemberRemovedError(job.jobId, Boolean(job.featureId));
      // §B.2 fire-once-per-tick: advance the deterministic clock once.
      const result = singleTick(req.params.jobId);
      const tick = currentTick();
      if (result.runsFired > 0 && job.workflowId) {
        // ADR 0787 D5 — "Run now" fires through the daemon's OWN recipe
        // (`fireJob`): the job's inputs, `configurable`, filtered metadata (so its
        // `actingUserId`) and owner scope, behind the owning-feature gate. It used
        // to build a bare run with none of those, so the button did not test what
        // the schedule does. It NEVER advances `nextFireAt` (it used to eat the
        // next scheduled slot). The clicker is attributed, not made the actor.
        if (isErasedJob(job)) throw new JobErasedError(job.jobId);
        const actor = typeof job.metadata?.actingUserId === 'string' ? job.metadata.actingUserId : undefined;
        const clicker = await ownerSpellings(req);
        const clickedBy = callerSubject(req);
        const outcome = await fireJob(deps, job, {
          trigger: 'manual',
          ...(clickedBy !== undefined ? { triggeredBy: clickedBy } : {}),
          // The autonomous-run budget is skipped ONLY for a human firing their own
          // job with their own credentials: a workspace writer must not be able
          // to fire a colleague's credentialed workflow without limit.
          // `SCTCD-5` — and ALWAYS for a job carrying server-stamped `configurable`
          // (a platform credential) or no actor at all: nobody's own credentials.
          applyBudget: job.configurable !== undefined || actor === undefined || !clicker.includes(actor),
        });
        await noteManualTick(req.params.jobId, tick);
        res.status(200).json({
          jobId: req.params.jobId,
          runsFired: result.runsFired,
          lastFiredTick: tick,
          ...('runId' in outcome ? { runId: outcome.runId } : { skipped: outcome.skipped }),
        });
        return;
      }
      // The unbound shape (no `workflowId` — the RFC 0052 tick-seam demo): the
      // fire IS the whole event, and there is no run to name.
      await markJobFired(req.params.jobId, tick);
      res.status(200).json({ jobId: req.params.jobId, runsFired: result.runsFired, lastFiredTick: tick });
    } catch (err) {
      next(err);
    }
  });
}
