/**
 * Assistant perception loops (ADR 0023 §12 T2) — the activation layer that
 * turns the deploy-gated loop DESIGN into registered workflows + RFC 0052
 * scheduler jobs, per tenant.
 *
 * Each loop is a small DAG of EXISTING nodes: `core.openwop.http.fetch`
 * carrying the ADR 0024 Phase D `config.connection` annotation (the host
 * resolves the enabling principal's Google connection and injects the
 * credential — nothing here touches a secret), feeding the pack's
 * deterministic `ingest-commitments` transform (idempotent, taint-stamped
 * graph writes, per-tick volume cap).
 *
 * Enabling a loop registers a scheduler job whose `metadata.actingUserId` is
 * the ENABLING human — the D2 actor discipline: the loop acts for a named
 * principal, never "as the workspace", and the Connections resolver keys the
 * per-user credential off that identity (falling back org → workspace for
 * principals that own no personal connection).
 *
 * Loop status (enabled / lastRunAt / lastRunId / nextFireAt) reads straight
 * off the scheduler job row — no parallel bookkeeping store.
 */

import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { stripAutoTerminalOutputRole } from './chainBackedShape.js';
import { getJob, registerJob, setJobEnabled, updateJob, ScheduleCadenceError, type ScheduledJob, type ScheduleSkipReason } from '../../host/schedulingService.js';
import { RECONNECT_CODES } from '../../notifications/notify.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import type { RunTerminalStatus } from '../../executor/runLifecycle.js';
import { ensureAssistantAgent } from './capability.js';
import { parseCron } from '../../host/cronSchedule.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';

const log = createLogger('features.assistant.loops');

export interface AssistantLoopDef {
  loopId: string;
  /** The ADR 0023 §3 loop number this activates (or partially activates). */
  loopNumber: number;
  label: string;
  description: string;
  workflowId: string;
  defaultCron: string;
}

/** The per-tick volume cap. EXPORTED and otherwise unused on purpose (WF-COS-1):
 *  the live value now lives in the chain pack's `maxItemsPerTick` node config and
 *  in the fetch URL's page size, and `test/assistant-chain-backed-workflows.test.ts`
 *  asserts all three agree — so this constant cannot quietly drift into a lie
 *  about what the loops actually do. */
export const MAX_ITEMS_PER_TICK = 25;

export const ASSISTANT_LOOPS: readonly AssistantLoopDef[] = [
  {
    loopId: 'calendar-ingest',
    loopNumber: 6,
    label: 'Calendar ingestion',
    description:
      'Reads upcoming Google Calendar events through the Connections broker and maintains prep commitments in the memory graph (idempotent; sources stamped untrusted).',
    workflowId: 'assistant.loop.calendar-ingest',
    defaultCron: '*/30 * * * *',
  },
  {
    loopId: 'drive-ingest',
    loopNumber: 1,
    label: 'Drive ingestion',
    description:
      'Reads recently-modified Google Drive files through the Connections broker and maintains review commitments in the memory graph (idempotent; sources stamped untrusted).',
    workflowId: 'assistant.loop.drive-ingest',
    defaultCron: '0 * * * *',
  },
  {
    loopId: 'morning-briefing',
    loopNumber: 5,
    label: 'Morning briefing',
    description:
      'Composes a source-grounded brief (top commitments with citations, what is at risk, today’s meetings, what awaits approval) and drops it in your Notifications inbox.',
    workflowId: 'assistant.loop.morning-briefing',
    defaultCron: '0 7 * * *',
  },
];

/**
 * Register the three loop workflows CHAIN-BACKED (WF-COS-1). Boot-time,
 * idempotent — definitions are tenant-agnostic; per-tenant state lives on the
 * scheduler job + the credential the resolver picks at run time.
 *
 * WHAT CHANGED AND WHY. This used to build an in-tree `WorkflowDefinition`
 * literal per loop and hand it to `registerWorkflow()` — one of the two pin
 * sites this feature held in `PIN_SITE_QUARANTINE`, and the pattern
 * `CLAUDE.md` § "Workflows — never hard-code" forbids: a code-pinned workflow
 * is invisible to `/builder` and the `/` picker (both list only the tenant
 * ownership index) and is not tenant-editable. The graphs now ship as
 * `core.openwop.workflows.assistant` (`examples/workflow-chain-packs/assistant`)
 * and are registered under the SAME workflowIds, so every existing per-tenant
 * scheduler job row (`assistant:<loopId>:<tenantId>`) and every existing run
 * stamp keeps resolving.
 *
 * REPLAY NOTE, stated rather than assumed. The chain expansion rewrites node ids
 * from the bare `fetch`/`ingest`/`brief` to `<chain>_<expansionId>_<id>`, so a
 * run created against the OLD definition does not replay def-identically. The
 * expansion is deterministic (same chainId + version ⇒ same expansionId), so the
 * NEW shape is stable from here on; the discontinuity is one-time and applies to
 * the pre-existing run population, which the deploy should state rather than
 * assume is zero (the `WFC-DATA-1` precedent).
 *
 * `postProcess` strips the auto-assigned terminal `outputRole: 'primary'` that
 * `expandChain` adds and the retired literals never had — a difference the
 * builder would render and `/reviews` would read, so it is removed rather than
 * silently accepted (the `registerLegacyDefsChainBacked` precedent).
 */
export function registerAssistantLoopWorkflows(): void {
  for (const loop of ASSISTANT_LOOPS) {
    registerChainBackedWorkflow(loop.workflowId, { postProcess: stripAutoTerminalOutputRole });
  }
}

function getLoopDef(loopId: string): AssistantLoopDef | null {
  return ASSISTANT_LOOPS.find((l) => l.loopId === loopId) ?? null;
}

const jobIdOf = (tenantId: string, loopId: string): string => `assistant:${loopId}:${tenantId}`;

export interface AssistantLoopStatus extends AssistantLoopDef {
  enabled: boolean;
  cronExpr?: string;
  lastRunAt?: string;
  lastRunId?: string;
  nextFireAt?: number;
  /** WF-COS-4 — the last fire that consumed its slot and produced NO run, with
   *  the reason. Rendered ALONGSIDE `lastRunAt`: without it the panel said
   *  "last run: just now" over a `/runs/<id>` link to a run from hours before. */
  lastSkippedAt?: string;
  lastSkipReason?: ScheduleSkipReason;
  /** ADR 0662 D3 — the OUTCOME of `lastRunId`, not merely that a run happened.
   *
   *  Without it the panel renders "last run: <time>" over a run that FAILED, which is the
   *  same lie `lastSkippedAt` was added to stop one level up: fixing the run half alone
   *  (an ingest that now fails honestly) would still leave this surface green. */
  lastRunStatus?: string;
  /** ADR 0862 — WHY the last run failed (the run's typed `error.code`, e.g.
   *  `connection_reauth_required`), so the panel can name the fix instead of only
   *  saying "failed". A code, never the message: the message can carry provider text. */
  lastRunErrorCode?: string;
  /** ADR 0862 — set when the loop PAUSED ITSELF after repeated connection refusals
   *  (`AUTH_PAUSE_AFTER` in a row): the code that did it and when. Cleared on re-enable. */
  autoPausedCode?: string;
  autoPausedAt?: string;
}

/** ADR 0662 D3 — read the run's own status. The scheduled-job row records THAT a run was
 *  dispatched, never how it ended, so the outcome has to come from the run. A run that can
 *  no longer be read yields nothing rather than a fabricated verdict. */
async function lastRunStatusOf(runId: string | undefined): Promise<{ lastRunStatus?: string; lastRunErrorCode?: string }> {
  if (!runId) return {};
  try {
    const run = await hostExtStorage().getRun(runId);
    if (!run?.status) return {};
    const code = run.status === 'failed' && typeof run.error?.code === 'string' ? run.error.code : undefined;
    return { lastRunStatus: run.status, ...(code !== undefined ? { lastRunErrorCode: code } : {}) };
  } catch {
    return {};
  }
}

export async function listLoopStatuses(tenantId: string): Promise<AssistantLoopStatus[]> {
  return Promise.all(
    ASSISTANT_LOOPS.map(async (loop) => {
      const job = await getJob(jobIdOf(tenantId, loop.loopId));
      return {
        ...loop,
        enabled: job?.enabled === true,
        ...(job?.cronExpr !== undefined ? { cronExpr: job.cronExpr } : {}),
        ...(job?.lastRunAt !== undefined ? { lastRunAt: job.lastRunAt } : {}),
        ...(job?.lastRunId !== undefined ? { lastRunId: job.lastRunId } : {}),
        ...(await lastRunStatusOf(job?.lastRunId)),
        ...(job?.nextFireAt !== undefined ? { nextFireAt: job.nextFireAt } : {}),
        ...(job?.lastSkippedAt !== undefined ? { lastSkippedAt: job.lastSkippedAt } : {}),
        ...(job?.lastSkipReason !== undefined ? { lastSkipReason: job.lastSkipReason } : {}),
        ...((h) => (h?.autoPausedCode && job?.enabled !== true ? { autoPausedCode: h.autoPausedCode, ...(h.autoPausedAt ? { autoPausedAt: h.autoPausedAt } : {}) } : {}))(loopHealthOf(job)),
      };
    }),
  );
}

export async function enableLoop(
  tenantId: string,
  loopId: string,
  opts: { actingUserId?: string; cronExpr?: string },
): Promise<ScheduledJob | null> {
  const loop = getLoopDef(loopId);
  if (!loop) return null;
  // COS-5 — validate a caller-supplied cron HERE, the ONE composition owner
  // (not only the route): `registerJob` stores an unparseable expr `enabled:true`
  // with no `nextFireAt`, so the panel reads "On" over a job that never fires.
  // Guard ONLY the cronExpr-provided branch — the re-enable-in-place path below
  // touches no cadence and must stay unaffected.
  // CORRECTED (ADR 0787 D6): this used to add "a syntactically-valid-but-never-
  // fires expr like `0 0 30 2 *` parses fine and MUST be accepted". That is the
  // same "On over a job that never fires" defect COS-5 exists to stop, one shape
  // over — and RFC 0052 §B.3 says a schedule beyond the horizon is REJECTED.
  // `registerJob` now refuses it (`schedule_horizon_exceeded`), surfaced below.
  if (opts.cronExpr !== undefined && !parseCron(opts.cronExpr)) {
    throw new OpenwopError('validation_error', `Invalid cron expression: \`${opts.cronExpr}\`.`, 400, { loopId, cronExpr: opts.cronExpr });
  }
  const existing = await getJob(jobIdOf(tenantId, loopId));
  if (existing) {
    // Re-enable in place, preserving cadence + attribution.
    // ADR 0862 — a person re-enabling is the "I fixed the connection" signal: the
    // consecutive-refusal count and any auto-pause marker start over.
    const job = await updateJob(existing.jobId, (current) => {
      const health = loopHealthOf(current);
      return { enabled: true, ...(opts.cronExpr !== undefined ? { cronExpr: opts.cronExpr, ...(opts.actingUserId !== undefined ? { actingUserId: opts.actingUserId } : {}) } : {}), mergeMetadata: { [LOOP_HEALTH_KEY]: {
        observedRuns: health?.observedRuns ?? [],
        ...(health?.observedThrough ? { observedThrough: health.observedThrough } : {}),
      } } };
    });
    log.info('assistant_loop_enabled', { tenantId, loopId, jobId: existing.jobId, reenabled: true });
    return job;
  }
  // A loop is the assistant-capability agent's recurring task, so the
  // ScheduledJob carries its REAL rosterId/agentId — it shows in that agent's
  // workspace Schedules tab on the same rails as every other agent's scheduled
  // work. The acting agent is resolved by the `assistant` CAPABILITY (ADR 0023
  // corrected 2026-06-13), never by a hardcoded `chief-of-staff` roleKey.
  const agent = await ensureAssistantAgent(tenantId);
  const result = await registerJob({
    jobId: jobIdOf(tenantId, loopId),
    tenantId,
    cronExpr: opts.cronExpr ?? loop.defaultCron,
    workflowId: loop.workflowId,
    enabled: true,
    rosterId: agent.rosterId,
    agentId: agent.agentRef.agentId,
    // ADR 0024 §4 / Option C — the run-level credential opt-in for the
    // perception reads; the briefing loop reads only the graph (no opt-in).
    ...(loop.loopId !== 'morning-briefing' ? { configurable: { connections: ['google'] } } : {}),
    metadata: {
      assistantLoop: { loopId },
      // D2 actor discipline — the loop runs AS the enabling human; the
      // schedule daemon carries this onto run.metadata, where the ADR 0024
      // Phase D seam keys credential resolution.
      ...(opts.actingUserId !== undefined ? { actingUserId: opts.actingUserId } : {}),
    },
  });
  if (result.ok) {
    log.info('assistant_loop_enabled', { tenantId, loopId, jobId: result.job.jobId, cronExpr: result.job.cronExpr });
    return result.job;
  }
  // A refused registration is NOT "no such loop" — returning null made the route
  // answer 404 for a cadence the store had refused (ADR 0787 D6).
  const { code, message } = result.error;
  if (code === 'invalid_cron' || code === 'invalid_timezone' || code === 'schedule_horizon_exceeded') {
    throw new ScheduleCadenceError({ code, message });
  }
  throw new OpenwopError('conflict', message, 409, { loopId, reason: code });
}

export async function disableLoop(tenantId: string, loopId: string): Promise<ScheduledJob | null> {
  if (!getLoopDef(loopId)) return null;
  const job = await setJobEnabled(jobIdOf(tenantId, loopId), false);
  if (job) log.info('assistant_loop_disabled', { tenantId, loopId, jobId: job.jobId });
  return job;
}


// ─── ADR 0862 — a loop stops burning runs on a connection it cannot use ─────
//
// MEASURED in production: from 2026-09-08 to 2026-09-29 the calendar and drive
// loops failed 1,233 runs, every 30 minutes, on a Google 403 the node reported as
// `upstream_unavailable` ("the credential may have expired"). c29aeacd6 made the
// failure NAME itself (`connection_scope_missing` / `connection_reauth_required` /
// `connection_forbidden`) and notify once a day — but a loop whose connection is
// refused still fires every tick, forever, and every tick is a failed run.
//
// So: after `AUTH_PAUSE_AFTER` consecutive scheduled runs refused for a
// reconnect-class reason, the loop PAUSES ITSELF and tells the person it acts as,
// once. Re-enabling it (after reconnecting) clears the count. A run that fails for
// any OTHER reason neither counts nor resets — a flaky upstream is not a dead
// connection, and a success is the only evidence the connection works.
export const AUTH_PAUSE_AFTER = 3;
const LOOP_HEALTH_KEY = 'assistantLoopHealth';

interface LoopHealth {
  consecutiveAuthFailures?: number;
  lastAuthCode?: string;
  autoPausedCode?: string;
  autoPausedAt?: string;
  observedRuns?: Array<{ runId: string; key: string }>;
  observedThrough?: string;
}
// Durable, bounded dedupe on the job row itself. Observations older than the
// evicted high-water mark cannot rewrite current health (ADR 0862 D7 correction).
const LOOP_OBSERVATION_LIMIT = 64;

function loopHealthOf(job: ScheduledJob | null | undefined): LoopHealth | undefined {
  const h = (job?.metadata as Record<string, unknown> | undefined)?.[LOOP_HEALTH_KEY];
  return h && typeof h === 'object' ? (h as LoopHealth) : undefined;
}

/** The `onAnyRunTerminal` subscriber (registered at boot by `feature.ts`). Bounded:
 *  one run read and at most one job write per terminal assistant-loop run. */
export async function onLoopRunTerminal(runId: string, status: RunTerminalStatus): Promise<void> {
  if (status === 'cancelled') return;
  const run = await hostExtStorage().getRun(runId);
  if (!run || run.status !== status || !run.workflowId.startsWith('assistant.loop.')) return;
  // Forks retain schedule attribution for provenance; they are not new cron fires.
  if (run.parentRunId !== undefined || run.forkMode !== undefined) return;
  const schedule = run.metadata?.schedule as { jobId?: unknown; trigger?: unknown } | undefined;
  const jobId = schedule?.jobId;
  if (typeof jobId !== 'string' || schedule?.trigger !== 'cron') return;
  const code = run.error?.code;
  if (status !== 'completed' && (typeof code !== 'string' || !RECONNECT_CODES.has(code))) return;
  const observationKey = `${run.createdAt}/${runId}`;
  const at = new Date().toISOString();
  let pauseWon = false;
  const updated = await updateJob(jobId, (job) => {
    // A retry must recompute the transition, never notify for a lost CAS attempt.
    pauseWon = false;
    if (job.tenantId !== run.tenantId || job.workflowId !== run.workflowId) return null;
    const health = loopHealthOf(job) ?? {};
    const observed = health.observedRuns ?? [];
    if (observed.some((r) => r.runId === runId) || (health.observedThrough && observationKey <= health.observedThrough)) return null;
    const nextObserved = [...observed, { runId, key: observationKey }].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    let observedThrough = health.observedThrough;
    while (nextObserved.length > LOOP_OBSERVATION_LIMIT) {
      const retired = nextObserved.shift();
      if (retired && (!observedThrough || retired.key > observedThrough)) observedThrough = retired.key;
    }
    const dedupe = { observedRuns: nextObserved, ...(observedThrough ? { observedThrough } : {}) };
    if (status === 'completed') {
      // A completed run cannot re-enable a manually or automatically paused job.
      return { mergeMetadata: { [LOOP_HEALTH_KEY]: { ...health, ...dedupe, consecutiveAuthFailures: 0 } } };
    }
    const n = (health.consecutiveAuthFailures ?? 0) + 1;
    pauseWon = n >= AUTH_PAUSE_AFTER && job.enabled;
    const nextHealth: LoopHealth = {
      ...health, ...dedupe, consecutiveAuthFailures: n, lastAuthCode: code,
      ...(pauseWon ? { autoPausedCode: code, autoPausedAt: at } : {}),
    };
    return { ...(pauseWon ? { enabled: false } : {}), mergeMetadata: { [LOOP_HEALTH_KEY]: nextHealth } };
  });
  if (!updated || !pauseWon) return;
  const job = updated;
  const n = loopHealthOf(job)?.consecutiveAuthFailures ?? AUTH_PAUSE_AFTER;
  const loop = ASSISTANT_LOOPS.find((l) => l.workflowId === run.workflowId);
  log.warn('assistant_loop_auto_paused', { tenantId: run.tenantId, jobId, loopId: loop?.loopId, code, consecutive: n });
  const actingUserId = (job.metadata as Record<string, unknown> | undefined)?.actingUserId;
  try {
    await getNotificationEmitter().emit({
      tenantId: run.tenantId,
      ...(typeof actingUserId === 'string' ? { recipientUserId: actingUserId } : {}),
      type: 'workflow.failed',
      priority: 'high',
      title: 'A recurring task was paused',
      message: `${loop?.label ?? run.workflowId} was refused by Google ${n} times in a row, so it has stopped running. Reconnect Google, then turn it back on under Recurring tasks.`,
      runId,
      workflowId: run.workflowId,
      actionUrl: '/connections',
      metadata: { assistantLoopAutoPaused: true, code, jobId },
    });
  } catch (err) {
    log.warn('assistant_loop_auto_pause_notification_failed', { tenantId: run.tenantId, jobId, error: err instanceof Error ? err.message : String(err) });
  }
}
