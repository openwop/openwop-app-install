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

import type { WorkflowDefinition } from '../../executor/types.js';
import { registerWorkflow } from '../../host/workflowsRegistry.js';
import { getJob, registerJob, setJobEnabled, type ScheduledJob } from '../../host/schedulingService.js';
import { ensureAssistantAgent } from './capability.js';

export interface AssistantLoopDef {
  loopId: string;
  /** The ADR 0023 §3 loop number this activates (or partially activates). */
  loopNumber: number;
  label: string;
  description: string;
  workflowId: string;
  defaultCron: string;
}

const MAX_ITEMS_PER_TICK = 25;

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

function loopDefinition(loop: AssistantLoopDef): WorkflowDefinition {
  if (loop.loopId === 'morning-briefing') {
    // Loop 5 — a single graph-read node; `notify:true` makes the host-side
    // surface drop the inbox notification (ADR 0010). No external I/O at all.
    return {
      workflowId: loop.workflowId,
      nodes: [
        { nodeId: 'brief', typeId: 'feature.assistant.nodes.compose-briefing', config: { notify: true } },
      ],
      edges: [],
    };
  }
  // ADR 0024 §4 / Option C: the credential opt-in is RUN-LEVEL
  // (`configurable.connections`, set on the scheduler job in enableLoop) —
  // node config stays exactly the pack's published schema; the host injects
  // the acting user's token when the URL matches the provider's curated
  // apiHosts. No connection material or annotation lives in the definition.
  const fetchConfig =
    loop.loopId === 'calendar-ingest'
      ? { url: `https://www.googleapis.com/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=${MAX_ITEMS_PER_TICK}` }
      : { url: `https://www.googleapis.com/drive/v3/files?orderBy=modifiedTime%20desc&pageSize=${MAX_ITEMS_PER_TICK}&fields=files(id,name,modifiedTime,webViewLink)` };
  return {
    workflowId: loop.workflowId,
    nodes: [
      { nodeId: 'fetch', typeId: 'core.openwop.http.fetch', config: fetchConfig },
      {
        nodeId: 'ingest',
        typeId: 'feature.assistant.nodes.ingest-commitments',
        config: {
          sourceKind: loop.loopId === 'calendar-ingest' ? 'calendar' : 'drive',
          maxItemsPerTick: MAX_ITEMS_PER_TICK,
        },
      },
    ],
    edges: [{ edgeId: 'fetch→ingest', sourceNodeId: 'fetch', targetNodeId: 'ingest' }],
  };
}

/** Register the loop workflow definitions in the host catalog. Boot-time,
 *  idempotent — definitions are tenant-agnostic; per-tenant state lives on
 *  the scheduler job + the credential the resolver picks at run time. */
export function registerAssistantLoopWorkflows(): void {
  for (const loop of ASSISTANT_LOOPS) registerWorkflow(loopDefinition(loop));
}

export function getLoopDef(loopId: string): AssistantLoopDef | null {
  return ASSISTANT_LOOPS.find((l) => l.loopId === loopId) ?? null;
}

const jobIdOf = (tenantId: string, loopId: string): string => `assistant:${loopId}:${tenantId}`;

export interface AssistantLoopStatus extends AssistantLoopDef {
  enabled: boolean;
  cronExpr?: string;
  lastRunAt?: string;
  lastRunId?: string;
  nextFireAt?: number;
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
        ...(job?.nextFireAt !== undefined ? { nextFireAt: job.nextFireAt } : {}),
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
  const existing = await getJob(jobIdOf(tenantId, loopId));
  if (existing && !opts.cronExpr) {
    // Re-enable in place, preserving cadence + attribution.
    return setJobEnabled(existing.jobId, true);
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
  return result.ok ? result.job : null;
}

export async function disableLoop(tenantId: string, loopId: string): Promise<ScheduledJob | null> {
  if (!getLoopDef(loopId)) return null;
  return setJobEnabled(jobIdOf(tenantId, loopId), false);
}
