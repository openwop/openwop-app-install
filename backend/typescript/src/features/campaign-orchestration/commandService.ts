/**
 * ADR 0960 D1/D2 — the campaign command snapshot: one bounded, campaign-scoped
 * read of what is running, what is waiting, and on what.
 *
 * - **Runs** come ONLY from ADR 0941's per-campaign run index (a prefix read on
 *   one campaign, never `/v1/runs` and never a tenant scan). Each indexed run is
 *   then read by id and kept only when its stored tag still names THIS campaign
 *   and client org (the index is written by a post-insert hook; the run row is
 *   the authority).
 * - **Nodes** are folded from the event log of the LIVE runs only (a terminal
 *   run's nodes are on its run page). There is no persisted per-node state; the
 *   builder overlay folds the same events client-side.
 * - **Gates** are the open interrupts of the listed runs. The interrupt `token`
 *   is a bearer capability and is never returned.
 * - A section whose owner has not shipped says so (`unavailable`), never an
 *   empty list pretending to be data.
 *
 * @see docs/adr/0960-campaign-command-center.md
 */
import { isTerminalRunStatus } from '@openwop/openwop';
import { getEventLog } from '../../executor/eventLog.js';
import type { Storage } from '../../storage/storage.js';
import type { RunRecord } from '../../types.js';
import { listCampaignRuns, readCampaignRunTag } from './campaignRunTag.js';
import type { CampaignRunRole, MarketingCampaign } from './types.js';

export const COMMAND_LIMITS = { runs: 25, nodes: 100, gates: 50, eventsPerRun: 2000 } as const;

export type CommandNodeStatus = 'running' | 'completed' | 'failed' | 'suspended';

export interface CampaignCommandSnapshot {
  campaign: { id: string; orgId: string; name: string; status: MarketingCampaign['status']; goalVersion?: number };
  runs: Array<{ runId: string; workflowId: string; role: CampaignRunRole | 'fork' | 'unknown'; status: string; startedAt: string; definitionRevision?: string; parentRunId?: string }>;
  runsTruncated: boolean;
  nodes: Array<{ runId: string; nodeId: string; status: CommandNodeStatus }>;
  nodesTruncated: boolean;
  gates: Array<{ interruptId: string; runId: string; nodeId: string; kind: string; createdAt: string; ageMs: number }>;
  gatesTruncated: boolean;
  /** Sections whose owner is not on this host yet (ADR 0960 D1). */
  unavailable: { autonomy: 'campaign-orchestration.autonomy'; playbook: 'campaign-playbooks'; spend: 'campaign-intel.caps'; experiments: 'experiments' };
  generatedAt: string;
}

const NODE_EVENTS: Readonly<Record<string, CommandNodeStatus>> = {
  'node.started': 'running',
  'node.completed': 'completed',
  'node.failed': 'failed',
  'node.suspended': 'suspended',
};

/** Last status per node, in event order. */
async function foldNodes(runId: string): Promise<{ nodes: Map<string, CommandNodeStatus>; truncated: boolean }> {
  const events = await getEventLog().list(runId, { limit: COMMAND_LIMITS.eventsPerRun });
  const nodes = new Map<string, CommandNodeStatus>();
  for (const e of events) {
    const status = NODE_EVENTS[e.type];
    if (status && typeof e.nodeId === 'string' && e.nodeId) nodes.set(e.nodeId, status);
  }
  return { nodes, truncated: events.length >= COMMAND_LIMITS.eventsPerRun };
}

export async function buildCommandSnapshot(storage: Storage, campaign: MarketingCampaign, now: number = Date.now()): Promise<CampaignCommandSnapshot> {
  const tenantId = campaign.tenantId;
  const indexed = await listCampaignRuns(tenantId, campaign.id); // newest first
  const runs: CampaignCommandSnapshot['runs'] = [];
  const live: string[] = [];
  let runsTruncated = false;
  for (const row of indexed) {
    if (runs.length >= COMMAND_LIMITS.runs) { runsTruncated = true; break; }
    const run = await storage.getRun(row.runId);
    if (!run || run.tenantId !== tenantId) continue;
    let tag;
    try { tag = readCampaignRunTag(run.metadata as Record<string, unknown> | undefined); } catch { tag = null; }
    if (!tag || tag.campaignId !== campaign.id || tag.orgId !== campaign.orgId) continue;
    const revision = (run.metadata as Record<string, unknown> | undefined)?.definitionRevision;
    runs.push({
      runId: run.runId,
      workflowId: run.workflowId,
      role: row.forkOf ? 'fork' : (row.role ?? 'unknown'),
      status: run.status,
      startedAt: run.createdAt,
      ...(typeof revision === 'string' && revision ? { definitionRevision: revision } : {}),
      ...(run.parentRunId ? { parentRunId: run.parentRunId } : {}),
    });
    if (!isTerminalRunStatus(run.status)) live.push(run.runId);
  }

  const nodes: CampaignCommandSnapshot['nodes'] = [];
  let nodesTruncated = false;
  for (const runId of live) {
    const folded = await foldNodes(runId);
    if (folded.truncated) nodesTruncated = true;
    for (const [nodeId, status] of folded.nodes) {
      if (nodes.length >= COMMAND_LIMITS.nodes) { nodesTruncated = true; break; }
      nodes.push({ runId, nodeId, status });
    }
  }

  const gates: CampaignCommandSnapshot['gates'] = [];
  let gatesTruncated = false;
  for (const runId of live) {
    for (const i of await storage.listOpenInterrupts(runId)) {
      if (gates.length >= COMMAND_LIMITS.gates) { gatesTruncated = true; break; }
      // Explicit fields only: the interrupt `token` is a bearer capability.
      gates.push({ interruptId: i.interruptId, runId: i.runId, nodeId: i.nodeId, kind: i.kind, createdAt: i.createdAt, ageMs: Math.max(0, now - Date.parse(i.createdAt)) });
    }
  }

  return {
    campaign: {
      id: campaign.id, orgId: campaign.orgId, name: campaign.name, status: campaign.status,
      ...(campaign.goal ? { goalVersion: campaign.goal.version } : {}),
    },
    runs, runsTruncated, nodes, nodesTruncated, gates, gatesTruncated,
    unavailable: { autonomy: 'campaign-orchestration.autonomy', playbook: 'campaign-playbooks', spend: 'campaign-intel.caps', experiments: 'experiments' },
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * ADR 0960 D3 — one run of THIS campaign, or null. The run must be in the
 * campaign's run index AND still carry its tag (same rule as the snapshot), so
 * a run id from another campaign or client is indistinguishable from a missing
 * one. A prefix read on one campaign plus one run read.
 */
export async function campaignRunOf(storage: Storage, campaign: MarketingCampaign, runId: string): Promise<RunRecord | null> {
  const rows = await listCampaignRuns(campaign.tenantId, campaign.id);
  if (!rows.some((r) => r.runId === runId)) return null;
  const run = await storage.getRun(runId);
  if (!run || run.tenantId !== campaign.tenantId) return null;
  let tag;
  try { tag = readCampaignRunTag(run.metadata as Record<string, unknown> | undefined); } catch { tag = null; }
  return tag && tag.campaignId === campaign.id && tag.orgId === campaign.orgId ? run : null;
}
