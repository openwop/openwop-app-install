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
import { getJob, registerJob, setJobEnabled, type ScheduledJob } from '../../host/schedulingService.js';
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
  lastSkipReason?: 'budget' | 'workflow-unresolved' | 'dispatch-error' | 'feature-disabled';
  /** ADR 0662 D3 — the OUTCOME of `lastRunId`, not merely that a run happened.
   *
   *  Without it the panel renders "last run: <time>" over a run that FAILED, which is the
   *  same lie `lastSkippedAt` was added to stop one level up: fixing the run half alone
   *  (an ingest that now fails honestly) would still leave this surface green. */
  lastRunStatus?: string;
}

/** ADR 0662 D3 — read the run's own status. The scheduled-job row records THAT a run was
 *  dispatched, never how it ended, so the outcome has to come from the run. A run that can
 *  no longer be read yields nothing rather than a fabricated verdict. */
async function lastRunStatusOf(runId: string | undefined): Promise<{ lastRunStatus?: string }> {
  if (!runId) return {};
  try {
    const run = await hostExtStorage().getRun(runId);
    return run?.status ? { lastRunStatus: run.status } : {};
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
  // touches no cadence and must stay unaffected. `parseCron` (not
  // `computeNextFire`) is the right instrument: a syntactically-valid-but-never-
  // fires expr like `0 0 30 2 *` parses fine and MUST be accepted.
  if (opts.cronExpr !== undefined && !parseCron(opts.cronExpr)) {
    throw new OpenwopError('validation_error', `Invalid cron expression: \`${opts.cronExpr}\`.`, 400, { loopId, cronExpr: opts.cronExpr });
  }
  const existing = await getJob(jobIdOf(tenantId, loopId));
  if (existing && !opts.cronExpr) {
    // Re-enable in place, preserving cadence + attribution.
    const job = await setJobEnabled(existing.jobId, true);
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
  return null;
}

export async function disableLoop(tenantId: string, loopId: string): Promise<ScheduledJob | null> {
  if (!getLoopDef(loopId)) return null;
  const job = await setJobEnabled(jobIdOf(tenantId, loopId), false);
  if (job) log.info('assistant_loop_disabled', { tenantId, loopId, jobId: job.jobId });
  return job;
}
