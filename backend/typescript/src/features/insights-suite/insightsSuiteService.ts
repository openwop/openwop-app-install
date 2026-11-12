/**
 * Insights & Drafting — config + workflow-reconciliation service (ADR 0082).
 *
 * ADR 0082 DELETED the parallel result read model (the `VarianceReport`/`TalentSnapshot`
 * collections + their dashboard). Insights are now the LIVE output of running the built-in
 * meta-workflows, surfaced through the existing runs / artifacts / chat / notification
 * surfaces. What remains here is legitimate FEATURE CONFIG (which BUs, the schedule, the
 * anniversary-trigger toggle) and the seam that RECONCILES that config onto the workflow
 * engine: a cron → a deterministic scheduled job (RFC 0052), the anniversary toggle → a
 * deterministic trigger subscription (RFC 0099). This is engine integration, not a store.
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { createLogger } from '../../observability/logger.js';
import { registerJob, deleteJob, getJob, listJobs, validateCadence, type ScheduledJob } from '../../host/schedulingService.js';
import { deleteSubscription, listSubscriptions, setSubscriptionState } from '../../host/triggerBridgeService.js';
import { subjectKeyForms } from '../../host/subjectErasureRedaction.js';
import type { SubjectEraseReport } from '../../host/subjectErasure.js';
import { legacyPrincipalOf } from '../users/usersService.js';
import { WEEKLY_VARIANCE_ID } from './metaWorkflows.js';
import { OpenwopError } from '../../types.js';

/** The toggle this feature's schedules + trigger subscriptions are gated on. */
const TOGGLE_ID = 'insights-suite';

const log = createLogger('features.insights-suite');

// ADR 0077 — talent/succession data is confidential-pii: `subjectId` identifies the assessed
// person (the talent-score node + talent workflow process it). Declare it so the field is
// masked in logs + classifies confidential-pii, even though the result is now a run output
// (not a persisted read-model row). The 9-box numbers are generic field names — not added to
// the global PII union to avoid over-masking.
// No eraser or purger for THIS entity: nothing persists a talent snapshot (it is a run
// output). The declaration exists purely for log masking of that output (grade-data RI-3
// audit, 2026-07-06).
//
// ADR 1102 D8 (`INS91-8` / `INS91-15`) — CORRECTED. This note used to go on to say the
// feature's only durable row, `insights:config`, carried "no declared PII, so there is no
// store for a DSAR … to reach". The subject-erasure census overrode that: the row is keyed
// to a PERSON (`principalUserId`), and so are the job and the subscription it arms. They
// are erased by `eraseInsightsSuiteSubject` below.
declarePiiFields('insights.talentSnapshot', ['subjectId']);

export interface InsightsSuiteConfig {
  tenantId: string;
  /** The person the suite runs as (ADR 1102 D4): derived from the caller who saved
   *  it, never supplied. Their weekly job carries it as `ownerUserId` AND as
   *  `metadata.actingUserId`, so a scheduled run uses their own connections. */
  principalUserId: string;
  /** The one business unit the weekly variance analyses (ADR 1102 D5). */
  businessUnit?: string;
  /** LEGACY stored shape (pre ADR 1102): a list of which only `[0]` was ever
   *  read. Read on load as `businessUnit`'s fallback; never written. */
  businessUnits?: string[];
  /** Cron + IANA tz for the weekly variance run (consumed by the RFC 0052 scheduler). */
  scheduleCron?: string;
  scheduleTimezone?: string;
  /** The BigQuery project the weekly financials query runs in. (ADR 1102 D5: a
   *  `dataset` field used to sit here and was read by nothing; the dataset lives
   *  in the chain's `sql`.) */
  planSource?: { projectId?: string };
  /** ADR 0081 P4 — the work-anniversary trigger. ADR 1102 D6: only `false` can be
   *  saved today, because the trigger lane cannot supply the chain's required
   *  params (`ISWF-6b`). `true` is refused by `applyConfig`. */
  anniversaryTriggerEnabled?: boolean;
  updatedAt: string;
}

const configs = new DurableCollection<InsightsSuiteConfig>('insights:config', (c) => c.tenantId);

/** A stored row in today's shape: the legacy `businessUnits[0]` becomes
 *  `businessUnit`, which is what the schedule always actually ran. */
function normalizeStored(c: InsightsSuiteConfig): InsightsSuiteConfig {
  const { businessUnits, planSource, ...rest } = c;
  const bu = rest.businessUnit ?? businessUnits?.[0];
  return {
    ...rest,
    ...(bu ? { businessUnit: bu } : {}),
    ...(planSource?.projectId ? { planSource: { projectId: planSource.projectId } } : {}),
  };
}

export async function getConfig(tenantId: string): Promise<InsightsSuiteConfig | null> {
  const c = await configs.get(tenantId);
  return c ? normalizeStored(c) : null;
}

/**
 * REMOVED (ADR 0599 §6) — the exported `putConfig`.
 *
 * It wrote the config row and returned, bypassing reconciliation entirely, and it had
 * ZERO callers repo-wide. It sat one letter from `applyConfig`, public, with a near
 * identical signature and return type: the next contributor adding a config-write path
 * picks the one that sounds like a setter, the row persists with a cron, no job is ever
 * registered, and the tenant sees a saved schedule that never fires — silently
 * reintroducing the exact bug ADR 0081 P6 fixed. A seam with no reader and a footgun
 * name is worse than no seam.
 */

/** The deterministic scheduled-job id for a tenant's weekly variance run (RFC 0052).
 *  Stable across re-saves AND cron changes (it must NOT include the cron — otherwise a
 *  changed/removed cron would orphan the prior job instead of replacing/deleting it). */
export function weeklyScheduleJobId(config: InsightsSuiteConfig): string {
  return `insights-weekly:${config.tenantId}:${config.principalUserId}`;
}

/** The deterministic work-anniversary trigger-subscription id for a tenant (ADR 0081 P4).
 *  Stable across re-saves AND the enabled flag (so reconciliation replaces/pauses the same
 *  subscription instead of orphaning a prior one — mirrors `weeklyScheduleJobId`). */
export function anniversaryTriggerSubscriptionId(config: InsightsSuiteConfig): string {
  return `insights-anniversary:${config.tenantId}:${config.principalUserId}`;
}

/** ADR 1102 D4 — the id prefix only this feature mints. Reserved through the
 *  fire gate (`feature.ts`), so the generic scheduler route can neither mint,
 *  squat, retarget, re-enable nor re-own a job under it. */
export const WEEKLY_JOB_PREFIX = 'insights-weekly:';
const weeklyPrefixFor = (tenantId: string): string => `${WEEKLY_JOB_PREFIX}${tenantId}:`;
const anniversaryPrefixFor = (tenantId: string): string => `insights-anniversary:${tenantId}:`;

/** The fire gate's `owns`: both markers are server-written. */
export function ownsInsightsWeeklyJob(job: ScheduledJob): boolean {
  return job.jobId.startsWith(WEEKLY_JOB_PREFIX) && job.featureId === TOGGLE_ID;
}

/**
 * ADR 1102 D5 (`INS91-5`) — leave exactly the intended job and subscription.
 *
 * The ids embed the principal, and the config row is one per tenant, so a save by a
 * different person used to arm their ids and never touch the previous person's: the
 * old job fired weekly, invisible to `GET /config`. This reconcile is STATELESS. It
 * lists the tenant's rows by prefix and removes every one but the intended id. It
 * never diffs against the stored row, so a save that fails part-way heals on the
 * retry (the architect pass's B1: a diff read after `configs.put` saw no difference on
 * the retry, which made the orphan permanent). Failures are thrown, never swallowed.
 */
async function reconcileTenantRows(tenantId: string, keepJobId: string | null, currentSubId: string): Promise<void> {
  for (const job of await listJobs(tenantId)) {
    if (job.jobId.startsWith(weeklyPrefixFor(tenantId)) && job.jobId !== keepJobId) await deleteJob(job.jobId);
  }
  for (const sub of await listSubscriptions(tenantId)) {
    if (!sub.subscriptionId.startsWith(anniversaryPrefixFor(tenantId))) continue;
    // The current principal's row is PAUSED (its delivery history is the record of
    // what it did); another principal's is DELETED, along with the raw id it carries.
    if (sub.subscriptionId === currentSubId) await setSubscriptionState(sub.subscriptionId, 'paused');
    else await deleteSubscription(sub.subscriptionId);
  }
}

/**
 * Persist the suite config AND reconcile it onto the engine:
 *   - schedule: a cron (re)registers the deterministic job that fires
 *     `openwop-app.insights.weekly-variance` AS the principal; absent cron removes it.
 *   - anniversary trigger: ADR 1102 D6 — refused while the lane cannot run; any
 *     existing subscription is paused.
 *   - every other `insights-*` row this tenant holds is removed (D5).
 * Idempotent on re-save, and self-healing on a retry after a part-way failure.
 */
export async function applyConfig(config: InsightsSuiteConfig): Promise<InsightsSuiteConfig> {
  // ADR 1102 D6 (`INS91-6`) — refuse to ARM a trigger that provably cannot run, the
  // ADR 0599 §6 rule this file applied to the cron and never to its sibling lane.
  // The anniversary chain requires `subjectId`, `workdayBaseUrl` and `recipient`; the
  // trigger lane seeds declared defaults only (`triggerIngestionService.ts`,
  // ADR 0677 `ISWF-6a`), and mapping the event into the bag is `ISWF-6b`, still
  // deferred. A trigger-started run also has no acting user, so its `self`
  // notification refuses. Here, the one choke point every writer passes, so no
  // arming path survives (ADR 0582). Validated BEFORE any write.
  if (config.anniversaryTriggerEnabled === true) {
    throw new OpenwopError(
      'invalid_request',
      'The work-anniversary trigger cannot be armed yet: a trigger event cannot supply the person, the Workday base URL or the recipient the recognition chain requires, so every fire would fail at its first node. Run the "Work-anniversary recognition draft" workflow from the chat or the builder instead.',
      400,
      { field: 'anniversaryTriggerEnabled', reason: 'trigger_lane_unrunnable' },
    );
  }
  // Never write the legacy list (D5); a caller still holding it gets its `[0]`.
  const stored = normalizeStored(config);
  const jobId = weeklyScheduleJobId(stored);
  const intendedSchedule = Boolean(stored.scheduleCron && stored.principalUserId);
  // What this id held before this save, so a failure after arming can put it back.
  let priorJob: ScheduledJob | null = null;
  // ADR 0599 §Correction 6 — VALIDATE BEFORE ANY WRITE. A job under this id held by
  // another workspace is the one refusal `registerJob` can produce here. ADR 1102 D4
  // reserves the prefix, so the generic scheduler route can no longer mint one; this
  // stays for a row squatted before the reservation. Its exit is clearing the cron.
  if (intendedSchedule) {
    // The code-review pass (ADR 1102): a cron that PARSES but never fires
    // (`0 0 31 2 *`) passed the route's parse check, was persisted, and was then
    // refused by `registerJob`'s own cadence check: the persisted-refusal shape
    // again. The same judgement, made here before anything is written.
    const cadence = validateCadence(stored.scheduleCron!, stored.scheduleTimezone);
    if (cadence) {
      throw new OpenwopError('invalid_request', cadence.message, 400, {
        field: cadence.code === 'invalid_timezone' ? 'scheduleTimezone' : 'scheduleCron', reason: cadence.code,
      });
    }
    const prior = await getJob(jobId);
    priorJob = prior;
    if (prior && prior.tenantId !== stored.tenantId) {
      throw new OpenwopError(
        'invalid_request',
        'The weekly variance schedule could not be armed: its schedule id is held by another workspace. '
        + 'An operator has to remove that schedule before this one can be saved.',
        400,
        { field: 'scheduleCron', reason: 'jobid_conflict' },
      );
    }
  }
  // Arm FIRST, persist second (the code-review pass): a refusal `registerJob` can
  // still produce (a write-contention loss) then leaves the stored row as it was,
  // instead of a row advertising a schedule that is not armed.
  let scheduleArmed = false;
  if (intendedSchedule) {
    const res = await registerJob({
      jobId,
      tenantId: stored.tenantId,
      cronExpr: stored.scheduleCron!,
      workflowId: WEEKLY_VARIANCE_ID,
      ownerUserId: stored.principalUserId,
      // ADR 1102 D4 (architect B4) — "runs as" made TRUE. `ownerUserId` reaches the
      // run as attribution only; `actingUserId` is what the Connections resolver keys
      // the person's own credentials off, and what `jobActors` lists for the removal
      // and erasure cascade. The shared-workspace scheduler lane stamps the same key
      // (`routes/scheduler.ts`).
      metadata: { actingUserId: stored.principalUserId },
      enabled: true,
      // ADR 0599 §6 — the owning feature, resolved per tenant at FIRE time.
      featureId: TOGGLE_ID,
      // ADR 0599 §6 (ISWF-5) — the values the weekly-variance chain needs, forwarded
      // by `scheduleDaemon` into `seedRunVariables`.
      inputs: {
        ...(stored.planSource?.projectId ? { projectId: stored.planSource.projectId } : {}),
        ...(stored.businessUnit ? { businessUnit: stored.businessUnit } : {}),
      },
      ...(stored.scheduleTimezone ? { timezone: stored.scheduleTimezone } : {}),
    });
    // ADR 0599 §6 (ISC-7) — `registerJob` reports failure BY VALUE; never dropped.
    // The race backstop behind the pre-flight above.
    if (!res.ok) {
      throw new OpenwopError('invalid_request', `The weekly variance schedule was refused: ${res.error.message}`, 400, {
        field: 'scheduleCron', reason: res.error.code,
      });
    }
    scheduleArmed = true;
  }
  try {
    await configs.put(stored);
  } catch (err) {
    // The round-2 code re-grade: arming first means a failed ROW write would leave
    // a job the stored row does not describe (on a take-over, a SECOND weekly run
    // nobody can see). Put this id back, then fail loudly.
    if (scheduleArmed) await restoreJob(jobId, priorJob, stored.tenantId);
    throw err;
  }
  // Not rolled back (the round-3 code re-grade): once the row is written, the row
  // and the armed job agree, and undoing the job would leave a saved schedule with
  // nothing behind it. A failure here leaves only leftovers this same reconcile
  // removes on the next save, so it is thrown for the caller to retry.
  await reconcileTenantRows(stored.tenantId, intendedSchedule ? jobId : null, anniversaryTriggerSubscriptionId(stored));
  // INS-1: suite-level reconciliation telemetry — one structured line per config apply.
  log.info('insights_suite_reconciled', {
    tenantId: stored.tenantId,
    hasBusinessUnit: stored.businessUnit !== undefined,
    scheduleArmed, ...(scheduleArmed ? { jobId, cron: stored.scheduleCron } : {}),
    // ADR 1102 D6 — never armed (refused above); kept on the line so a dashboard
    // reading it sees a definite false, not an absent field.
    anniversaryArmed: false,
  });
  return stored;
}

/**
 * Return `jobId` to what this save replaced: absent, or its prior cadence, inputs,
 * owner, metadata and `enabled` (so a removed-member pause survives). Its run
 * history (`lastRunAt`, skip counters, `nextFireAt`) is not restored; the forward
 * save had already reset it. Never throws: a failed restore is logged, because the
 * caller is already failing with the original error.
 */
async function restoreJob(jobId: string, prior: ScheduledJob | null, tenantId: string): Promise<void> {
  const fail = (error: string): void => log.error('insights_suite_rollback_failed', { tenantId, jobId, error });
  try {
    if (!prior) { await deleteJob(jobId); return; }
    const res = await registerJob({
      jobId: prior.jobId,
      tenantId: prior.tenantId,
      cronExpr: prior.cronExpr,
      ...(prior.workflowId !== undefined ? { workflowId: prior.workflowId } : {}),
      ...(prior.ownerUserId !== undefined ? { ownerUserId: prior.ownerUserId } : {}),
      ...(prior.metadata !== undefined ? { metadata: prior.metadata } : {}),
      ...(prior.featureId !== undefined ? { featureId: prior.featureId } : {}),
      ...(prior.inputs !== undefined ? { inputs: prior.inputs } : {}),
      ...(prior.timezone !== undefined ? { timezone: prior.timezone } : {}),
      enabled: prior.enabled,
    });
    // `registerJob` refuses BY VALUE (ISC-7): a dropped result here is a silent
    // failed restore (the round-3 code re-grade).
    if (!res.ok) fail(`${res.error.code}: ${res.error.message}`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * ADR 1102 D8 (`INS91-8`) — DSAR. The suite is scoped to a PERSON (whose schedule,
 * whose connections), so erasing that person erases the suite: every weekly job and
 * anniversary subscription this tenant holds (the subscription id carries the raw
 * principal, and `deleteSubscription` takes its delivery rows with it), then the
 * config row. Delete, not re-point: handing a person's schedule to someone else is a
 * decision only a human makes, and re-saving recreates it as the saver.
 *
 * Matches the forms the scheduler eraser matches, including the home-tenant legacy
 * principal alias. Idempotent; a key that matches nothing touches nothing.
 *
 * Keyed off the ROW: a weekly job acting as the subject under a row that names
 * someone else (reachable only if a rollback above failed) is not reached here.
 * The host scheduler eraser reaches it, by its owner and `actingUserId`.
 */
export async function eraseInsightsSuiteSubject(tenantId: string, subjectKey: string): Promise<SubjectEraseReport> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const c = await configs.get(tenantId);
  if (!c) return { rowsTouched: 0 };
  const forms = new Set(subjectKeyForms(subjectKey).forms);
  const legacy = await legacyPrincipalOf(tenantId, subjectKey);
  if (legacy && !('ambiguous' in legacy)) forms.add(legacy.principalId);
  if (!forms.has(c.principalUserId)) return { rowsTouched: 0 };
  let rowsTouched = 0;
  for (const job of await listJobs(tenantId)) {
    if (job.jobId.startsWith(weeklyPrefixFor(tenantId)) && await deleteJob(job.jobId)) rowsTouched++;
  }
  for (const sub of await listSubscriptions(tenantId)) {
    if (sub.subscriptionId.startsWith(anniversaryPrefixFor(tenantId)) && await deleteSubscription(sub.subscriptionId)) rowsTouched++;
  }
  await configs.delete(tenantId);
  rowsTouched++;
  return { rowsTouched };
}

/**
 * REMOVED (ADR 0599 §6) — `teardownAllSchedules` + its `registerToggleStatusListener`.
 *
 * INS-3 protected the schedules by hard-deleting every tenant's job when the GLOBAL
 * toggle status flipped to `off`. It was backwards in BOTH directions at once, and a
 * single fix closes both because the two are one defect wearing two faces.
 *
 *  - **Too wide.** `configs` is constructed with no `tenantOf`, so `configs.list()` is a
 *    repo-GLOBAL scan. An operator staging a rollback with
 *    `{status:'off', tenantOverrides:{'t-vip':{status:'on'}}}` — deliberately keeping
 *    `t-vip` live — had `t-vip`'s job DELETED and its subscription paused. `resolveConfig`
 *    still reported `t-vip` enabled, its config route still worked, `GET /config` still
 *    returned its cron, and nothing would ever fire again. Recovery was manual BY DESIGN
 *    ("re-enabling the toggle does NOT auto-resurrect"), and no route, UI or log said so.
 *  - **Too narrow.** The seam fires ONLY on a change to the global `status` field, so the
 *    three narrowings that are not a global `→ off` fired nothing: `on → beta`,
 *    a narrowed `betaCohort`, and `tenantOverrides[t] = {status:'off'}` — the only
 *    per-tenant disable that exists. Those tenants' crons kept firing and their webhooks
 *    kept accepting events, for a feature explicitly off for them.
 *  - It could not report failure either: every `deleteJob` was `.catch(() => undefined)`
 *    and the function returned `all.length`, so total failure and total success produced
 *    an identical return value, log line and test assertion.
 *
 * The replacement is `ScheduledJob.featureId` / `TriggerSubscription.featureId` resolved
 * against the toggle for THAT job's tenant at fire/ingest time (`scheduleDaemon.ts`,
 * `triggerIngestionService.ts`). A listener gates the CREATION lane; the gate belongs on
 * the USE lane. It is per-tenant, correct under every narrowing, non-destructive (the row
 * survives, so re-enabling resumes with no re-save), and it cannot silently half-succeed.
 */

/** ADR 1102 D10 — is the saved weekly schedule actually armed? The generic
 *  scheduler may still PAUSE a reserved job (`enabled:false`), and the panel
 *  must not report a paused schedule as running. */
export async function isWeeklyScheduleArmed(config: InsightsSuiteConfig): Promise<boolean> {
  if (!config.scheduleCron) return false;
  const job = await getJob(weeklyScheduleJobId(config));
  return job !== null && job.tenantId === config.tenantId && job.enabled === true;
}

/** Test-only — clear the config collection. */
export async function __resetInsightsSuiteStore(): Promise<void> {
  await configs.__clear();
}
