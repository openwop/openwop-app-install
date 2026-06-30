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
import { registerJob, deleteJob } from '../../host/schedulingService.js';
import { registerSubscription, setSubscriptionState } from '../../host/triggerBridgeService.js';
import { registerToggleStatusListener } from '../../host/featureToggles/service.js';
import { WEEKLY_VARIANCE_ID, ANNIVERSARY_DRAFT_ID } from './metaWorkflows.js';

const log = createLogger('features.insights-suite');

// ADR 0077 — talent/succession data is confidential-pii: `subjectId` identifies the assessed
// person (the talent-score node + talent workflow process it). Declare it so the field is
// masked in logs + classifies confidential-pii, even though the result is now a run output
// (not a persisted read-model row). The 9-box numbers are generic field names — not added to
// the global PII union to avoid over-masking.
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

export async function putConfig(config: InsightsSuiteConfig): Promise<InsightsSuiteConfig> {
  await configs.put(config);
  return config;
}

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
  await configs.put(config);
  const jobId = weeklyScheduleJobId(config);
  const scheduleArmed = Boolean(config.scheduleCron && config.principalUserId);
  if (scheduleArmed) {
    await registerJob({
      jobId,
      tenantId: config.tenantId,
      cronExpr: config.scheduleCron!,
      workflowId: WEEKLY_VARIANCE_ID,
      ownerUserId: config.principalUserId,
      enabled: true,
      ...(config.scheduleTimezone ? { timezone: config.scheduleTimezone } : {}),
    });
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
 * INS-3 — tear down every tenant's armed schedule + anniversary subscription. Called when
 * the `insights-suite` toggle flips OFF: a persisted scheduled job/subscription would
 * otherwise keep firing the workflows even though the feature is disabled (the scheduler
 * does not itself gate on the toggle). Mirrors `applyConfig`'s disarm branches (delete the
 * job, pause the subscription — both deterministic-id, so reconciliation is idempotent).
 * Returns the count of tenants reconciled. Re-enabling the toggle does NOT auto-resurrect
 * the schedules — a deliberate config re-save (`applyConfig`) re-arms them.
 */
export async function teardownAllSchedules(): Promise<number> {
  const all = await configs.list();
  for (const cfg of all) {
    await deleteJob(weeklyScheduleJobId(cfg)).catch(() => undefined);
    await setSubscriptionState(anniversaryTriggerSubscriptionId(cfg), 'paused').catch(() => undefined);
  }
  if (all.length > 0) log.info('insights_suite_torn_down', { reason: 'toggle_off', tenants: all.length });
  return all.length;
}

// Register the toggle-OFF teardown (INS-3). Module-load side-effect, like the feature's
// PII declaration — runs once when the feature module is imported at bootstrap.
registerToggleStatusListener(async (id, _prev, next) => {
  if (id === 'insights-suite' && next === 'off') await teardownAllSchedules();
});

/** Test-only — clear the config collection. */
export async function __resetInsightsSuiteStore(): Promise<void> {
  await configs.__clear();
}
