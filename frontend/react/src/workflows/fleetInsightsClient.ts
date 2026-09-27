/**
 * ADR 0476 — fleet insights + pre-run cost estimate client. A separate module
 * (not workflowsClient) for the same reason as the debug client: the chat
 * entry chunk imports workflowsClient, and these are dashboard/builder reads.
 */

import { authedHeaders, config, fetchOpts } from '../client/config.js';

export interface WorkflowStatsRow {
  workflowId: string;
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
  successRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  costUsdTotal: number;
  costUsdMedian: number | null;
  costDaily: Array<{ day: string; usd: number }>;
  topFailures: Array<{ nodeId: string; label?: string; count: number }>;
  nodeFailures: Array<{ nodeId: string; count: number }>;
  lastRunAt: string | null;
}

export interface FleetStats {
  rowsConsidered: number;
  truncated: boolean;
  sinceOldest: string | null;
  workflows: WorkflowStatsRow[];
}

/** The caller's tenant fleet stats — ONE bounded aggregation; the window is
 *  disclosed so callers label it honestly. Throws on non-OK. */
export async function fetchFleetStats(): Promise<FleetStats> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/workflows/stats`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) throw new Error(`stats_${res.status}`);
  return (await res.json()) as FleetStats;
}

export interface WorkflowCostEstimate {
  historical?: { medianUsd: number; p95Usd: number; samples: number };
  static?: {
    floorUsd: number;
    aiNodes: number;
    assumptions: { tokensPerNode: { input: number; output: number }; model: string; ratePer1k: { input: number; output: number } };
  };
}

/** Pre-run estimate for an owned workflow. Null on any failure — the
 *  estimate is contextual, never blocking. */
export async function fetchWorkflowEstimate(workflowId: string): Promise<WorkflowCostEstimate | null> {
  const res = await fetch(
    `${config.baseUrl}/host/openwop-app/workflows/${encodeURIComponent(workflowId)}/estimate`,
    fetchOpts({ headers: authedHeaders() }),
  );
  if (!res.ok) return null;
  return (await res.json()) as WorkflowCostEstimate;
}
