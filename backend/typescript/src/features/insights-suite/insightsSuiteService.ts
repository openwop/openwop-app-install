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
import { registerJob, deleteJob, getJob } from '../../host/schedulingService.js';
import { registerSubscription, setSubscriptionState } from '../../host/triggerBridgeService.js';
import { WEEKLY_VARIANCE_ID, ANNIVERSARY_DRAFT_ID } from './metaWorkflows.js';
import { OpenwopError } from '../../types.js';

/** The toggle this feature's schedules + trigger subscriptions are gated on. */
const TOGGLE_ID = 'insights-suite';

const log = createLogger('features.insights-suite');

// ADR 0077 — talent/succession data is confidential-pii: `subjectId` identifies the assessed
// person (the talent-score node + talent workflow process it). Declare it so the field is
// masked in logs + classifies confidential-pii, even though the result is now a run output
// (not a persisted read-model row). The 9-box numbers are generic field names — not added to
// the global PII union to avoid over-masking.
// DELIBERATELY no `registerSubjectEraser`/`registerRetentionPurger` for this entity: nothing
// persists it — the only durable row in this feature is `insights:config` below (opaque
// RFC 0048 `principalUserId`, no declared PII), so there is no store for a DSAR or a
// retention sweep to reach. The declaration exists purely for log masking of the run output
// (grade-data RI-3 audit, 2026-07-06).
declarePiiFields('insights.talentSnapshot', ['subjectId']);

export interface InsightsSuiteConfig {
  tenantId: string;
  /** The user the suite is scoped to (opaque principal id, RFC 0048 — not PII). */
  principalUserId: string;
  /** Business units in scope for variance analysis. */
  businessUnits: string[];
  /** Cron + IANA tz for the weekly variance run (consumed by the RFC 0052 scheduler). */
  scheduleCron?: string;
  scheduleTimezone?: string;
  /** Binding to the data source (e.g. a BigQuery projectId/dataset). */
  planSource?: { projectId?: string; dataset?: string };
  /** ADR 0081 P4 — when true, a work-anniversary event (e.g. from Workday) ingested at the
   *  trigger endpoint starts the `anniversary-draft` meta-workflow. Off by default. */
  anniversaryTriggerEnabled?: boolean;
  updatedAt: string;
}

const configs = new DurableCollection<InsightsSuiteConfig>('insights:config', (c) => c.tenantId);

export async function getConfig(tenantId: string): Promise<InsightsSuiteConfig | null> {
  return configs.get(tenantId);
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

/**
 * Persist the suite config AND reconcile its weekly-variance schedule (RFC 0052) + its
 * work-anniversary trigger subscription (RFC 0099):
 *   - schedule: a cron (re)registers the deterministic job that fires
 *     `openwop-app.insights.weekly-variance`; absent cron removes it.
 *   - anniversary trigger: when enabled, (re)register a deterministic webhook subscription
 *     that starts `openwop-app.insights.anniversary-draft` for an ingested anniversary event,
 *     and ensure it is `active` (registerSubscription is idempotent and won't reactivate a
 *     previously-paused row on its own); when disabled, pause it. There is no
 *     `deleteSubscription` — pausing makes ingest a no-op (the run never starts) and preserves
 *     delivery history (ADR 0081 P4 / architect C1). Re-enable revives delivery but does NOT
 *     clear the dedup window, so an identical `externalDeliveryId` replayed within retention
 *     still dedups (effectively-once).
 * Idempotent on re-save.
 */
export async function applyConfig(config: InsightsSuiteConfig): Promise<InsightsSuiteConfig> {
  const jobId = weeklyScheduleJobId(config);
  const intendedSchedule = Boolean(config.scheduleCron && config.principalUserId);
  // ADR 0599 §Correction 6 — VALIDATE BEFORE ANY WRITE, the same rule `ISC-6`
  // established for `scheduleTimezone` four lines of intent away. The `!res.ok`
  // branch below was correct AND thrown AFTER `configs.put`, so the one refusal
  // it can actually produce left the caller with a 400 and a persisted row: a
  // `GET /config` advertising a cron that is not armed and cannot be armed. That
  // is the "refusal that persists is worse than the bug" defect this PR fixed
  // one function call up, re-created in the opposite direction.
  //
  // The refusal it can produce is `jobid_conflict`, and the reasoning that said
  // it could not ("the id embeds the tenantId") was wrong: `routes/scheduler.ts`
  // accepts `body.jobId` VERBATIM under the CALLER's tenant, so any authenticated
  // tenant can squat this deterministic id and 400 the victim's every save.
  // (`schedule_horizon_exceeded` needs `firstFireAtMs`, which this call never
  // passes — genuinely unreachable, and named rather than implied.)
  //
  // The refusal has an EXIT, which is what keeps it from being the worse cure:
  // clearing the cron takes the `else` branch, which removes the squatted row,
  // after which the save succeeds.
  if (intendedSchedule) {
    const prior = await getJob(jobId);
    if (prior && prior.tenantId !== config.tenantId) {
      throw new OpenwopError(
        'invalid_request',
        'The weekly variance schedule could not be armed: its schedule id is held by another workspace. '
        + 'Clear `scheduleCron` and save to release it, then re-arm.',
        400,
        { field: 'scheduleCron', reason: 'jobid_conflict' },
      );
    }
  }
  await configs.put(config);
  let scheduleArmed = false;
  if (intendedSchedule) {
    const res = await registerJob({
      jobId,
      tenantId: config.tenantId,
      cronExpr: config.scheduleCron!,
      workflowId: WEEKLY_VARIANCE_ID,
      ownerUserId: config.principalUserId,
      enabled: true,
      // ADR 0599 §6 — the owning feature, resolved per tenant at FIRE time.
      // Replaces the toggle-status listener that used to be the only protection
      // and was backwards in both directions (see `teardownAllSchedules`'s
      // removal note below).
      featureId: TOGGLE_ID,
      // ADR 0599 §6 (ISWF-5) — the two values the weekly-variance chain needs,
      // which this route has always COLLECTED and always thrown away.
      // `registerJob` has supported `inputs` since the KickTodo daily loop lost
      // its `enrollmentId` to exactly this omission, and `scheduleDaemon`
      // forwards it into `seedRunVariables`. Without this the scheduled run
      // resolves `{{params.projectId}}` to `undefined`, SILENTLY, and dies at
      // node 1. `planSource` was previously read by NOTHING repo-wide.
      inputs: {
        ...(config.planSource?.projectId ? { projectId: config.planSource.projectId } : {}),
        ...(config.businessUnits[0] ? { businessUnit: config.businessUnits[0] } : {}),
      },
      ...(config.scheduleTimezone ? { timezone: config.scheduleTimezone } : {}),
    });
    // ADR 0599 §6 (ISC-7) — `registerJob` reports failure BY VALUE
    // (`schedule_horizon_exceeded`, `jobid_conflict`), and this call used to be
    // a bare `await` whose result was dropped. The route then 200'd and the one
    // ops line this feature emits asserted `scheduleArmed:true` for a job that
    // was never written — strictly worse than emitting nothing, because it
    // defeats the investigation that would find the real defect.
    //
    // §Correction 6 — this is now the RACE BACKSTOP, not the primary gate: the
    // pre-flight above catches the one reachable refusal before anything is
    // written. Kept because a squat landing between the pre-flight and here is a
    // real (if narrow) window, and a by-value failure must never be dropped
    // again. It is NOT separately witnessed — the pre-flight is what the test
    // exercises — and that is stated rather than implied.
    if (!res.ok) {
      throw new OpenwopError('invalid_request', `The weekly variance schedule was refused: ${res.error.message}`, 400, {
        field: 'scheduleCron', reason: res.error.code,
      });
    }
    scheduleArmed = true;
  } else {
    await deleteJob(jobId).catch(() => undefined);
  }

  const annivSubId = anniversaryTriggerSubscriptionId(config);
  const anniversaryArmed = Boolean(config.anniversaryTriggerEnabled && config.principalUserId);
  if (anniversaryArmed) {
    await registerSubscription({
      subscriptionId: annivSubId,
      tenantId: config.tenantId,
      source: 'webhook',
      workflowId: ANNIVERSARY_DRAFT_ID,
      // ADR 0599 §6 — resolved per tenant at INGEST time. Without it, disabling
      // the feature for one tenant left this webhook accepting events and
      // starting LLM runs on their BYOK key indefinitely, while their config
      // route 404'd so they could not disarm it themselves.
      featureId: TOGGLE_ID,
      // Documented (ADR 0081 P4 / architect C2): a production Workday webhook SHOULD register
      // with verificationMode 'required' + a signing secret. The host-extension ingest route
      // is already tenant-auth-gated; 'none' keeps the path deterministic.
      verificationMode: 'none',
      label: 'Work-anniversary recognition draft',
    });
    await setSubscriptionState(annivSubId, 'active'); // revive if a prior save paused it
  } else {
    await setSubscriptionState(annivSubId, 'paused'); // no-op when absent (returns null)
  }
  // INS-1: suite-level reconciliation telemetry — one structured line per config apply so
  // ops can see, per tenant, whether the weekly variance schedule is armed (and on what
  // cron) and whether the anniversary trigger is live. The per-RUN outcome/cost of the
  // workflows themselves surfaces through the executor's standard run events.
  log.info('insights_suite_reconciled', {
    tenantId: config.tenantId,
    businessUnits: config.businessUnits.length,
    scheduleArmed, ...(scheduleArmed ? { jobId, cron: config.scheduleCron } : {}),
    anniversaryArmed, ...(anniversaryArmed ? { subscriptionId: annivSubId } : {}),
  });
  return config;
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

/** Test-only — clear the config collection. */
export async function __resetInsightsSuiteStore(): Promise<void> {
  await configs.__clear();
}
