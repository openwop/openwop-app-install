/**
 * ADR 0476 §2/§3 — fleet insights: per-workflow success rate, duration
 * percentiles, cost trend, and failure hotspots, aggregated from RUN ROWS in
 * ONE bounded `listRuns` read (the `aggregateWorkforceMetrics` template —
 * deliberately NOT a durable read-model: ADR 0082 deleted that shape).
 *
 * The window is ROW-bounded (`STATS_WINDOW_ROWS` most recent runs) and the
 * response DISCLOSES it (`rowsConsidered`, `truncated`, `sinceOldest`) so the
 * FE can label the stats honestly instead of implying all-time truth.
 * Cost reads the ADR 0476 §1 terminal stamp (`run.metadata.costUsd`) — runs
 * that predate the stamp simply contribute no cost (never a guess).
 */

import type { Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import { getRegisteredWorkflowAsync } from './workflowsRegistry.js';

export const STATS_WINDOW_ROWS = 2000;

export interface WorkflowStatsRow {
  workflowId: string;
  /** PRODUCTION runs in the window (grade-data H2 — debug subgraph runs,
   *  eval-case runs, and builder draft test-runs are excluded from every
   *  outcome/latency/hotspot figure; their spend still lands in
   *  costUsdTotal/costDaily). */
  runs: number;
  /** Debug/eval/draft-launch runs excluded from the outcome figures —
   *  disclosed so "runs" is never mistaken for total activity. */
  nonProductionRuns: number;
  completed: number;
  failed: number;
  cancelled: number;
  active: number;
  /** completed / (completed + failed) — cancellation is an operator act, not
   *  a workflow outcome (ADR 0476 OQ2); null when no terminal outcomes. */
  successRate: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  costUsdTotal: number;
  costUsdMedian: number | null;
  /** p95 of terminal-run cost stamps + sample count — lets the estimate
   *  endpoint reuse the (cached) aggregation instead of its own scan (M2). */
  costUsdP95: number | null;
  costSamples: number;
  /** Daily cost buckets, oldest→newest, only days with spend. */
  costDaily: Array<{ day: string; usd: number }>;
  /** Failed runs' last-active node (run.currentNodeId), top 3 by count.
   *  `label` is the node's display name on the CURRENT head when it still
   *  exists (ux-review H3: a raw node id is debug leakage on a product
   *  surface) — absent when the node was renamed/removed. */
  topFailures: Array<{ nodeId: string; label?: string; count: number }>;
  /** The FULL per-node failure counts (review M4): the builder heatmap paints
   *  every hotspot, not just the dashboard chip's top 3. Bounded by the
   *  definition's node count. */
  nodeFailures: Array<{ nodeId: string; count: number }>;
  lastRunAt: string | null;
}

export interface FleetStats {
  rowsConsidered: number;
  truncated: boolean;
  /** createdAt of the OLDEST run in the window — the honest "since". */
  sinceOldest: string | null;
  workflows: WorkflowStatsRow[];
}

/** Nearest-rank percentile over a sorted-or-not sample; null when empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank]!;
}

function durationMs(r: RunRecord): number | null {
  if (!r.completedAt) return null;
  const ms = Date.parse(r.completedAt) - Date.parse(r.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

function costUsdOf(r: RunRecord): number | null {
  const v = (r.metadata as Record<string, unknown> | undefined)?.costUsd;
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Review M2 — a short per-tenant TTL cache: the dashboard, the builder
 *  estimate, and the heatmap toggle can each hit the aggregation within one
 *  page view, and each pass is a 2000-wide-row scan on a small DB tier.
 *  30s staleness on OBSERVATIONAL stats is honest (the window note already
 *  frames them as approximate); mutations don't need to invalidate. */
const STATS_CACHE_TTL_MS = 30_000;
const statsCache = new Map<string, { at: number; value: FleetStats }>();

/** Test seam: assertions about JUST-completed runs must not read a stale
 *  cache entry (production staleness is disclosed by the window note). */
export function clearFleetStatsCache(): void {
  statsCache.clear();
}

export async function aggregateFleetStats(storage: Storage, tenantId: string): Promise<FleetStats> {
  const cached = statsCache.get(tenantId);
  if (cached && Date.now() - cached.at < STATS_CACHE_TTL_MS) return cached.value;
  const value = await aggregateFleetStatsUncached(storage, tenantId);
  statsCache.set(tenantId, { at: Date.now(), value });
  // Opportunistic sweep so dead tenants don't accrete entries.
  if (statsCache.size > 500) {
    const cutoff = Date.now() - STATS_CACHE_TTL_MS;
    for (const [k, v] of statsCache) { if (v.at < cutoff) statsCache.delete(k); }
  }
  return value;
}

async function aggregateFleetStatsUncached(storage: Storage, tenantId: string): Promise<FleetStats> {
  const rows = await storage.listRuns({ tenantId, limit: STATS_WINDOW_ROWS });
  const byWf = new Map<string, RunRecord[]>();
  let sinceOldest: string | null = null;
  for (const r of rows) {
    byWf.set(r.workflowId, [...(byWf.get(r.workflowId) ?? []), r]);
    if (sinceOldest === null || r.createdAt < sinceOldest) sinceOldest = r.createdAt;
  }

  const workflows: WorkflowStatsRow[] = [];
  for (const [workflowId, allRuns] of byWf) {
    // Grade-data H2 — headline numbers describe PRODUCTION runs only. The
    // program's own debug subgraph runs, eval-case runs (which include
    // first-class negative tests asserting `status:'failed'`), and builder
    // draft test-runs would otherwise tank successRate, mint hotspots for
    // nodes that never failed in production, and skew the percentiles.
    // Their SPEND stays counted (money is real) — disclosed separately.
    const isProduction = (r: RunRecord): boolean => {
      const m = (r.metadata ?? {}) as Record<string, unknown>;
      return m.debug === undefined && m.eval === undefined && m.launch !== 'draft';
    };
    const runs = allRuns.filter(isProduction);
    const nonProductionRuns = allRuns.length - runs.length;
    const completed = runs.filter((r) => r.status === 'completed');
    const failed = runs.filter((r) => r.status === 'failed');
    const cancelled = runs.filter((r) => r.status === 'cancelled');
    const active = runs.filter((r) => !TERMINAL.has(r.status));
    const durations = completed
      .map(durationMs)
      .filter((d): d is number => d !== null);
    const costs = runs
      .filter((r) => TERMINAL.has(r.status))
      .map(costUsdOf)
      .filter((c): c is number => c !== null);
    const allTerminalCosts = allRuns
      .filter((r) => TERMINAL.has(r.status))
      .map(costUsdOf)
      .filter((c): c is number => c !== null);
    const costDailyMap = new Map<string, number>();
    for (const r of allRuns) {
      if (!TERMINAL.has(r.status)) continue;
      const usd = costUsdOf(r);
      if (usd === null || usd <= 0) continue;
      const day = (r.completedAt ?? r.createdAt).slice(0, 10);
      costDailyMap.set(day, (costDailyMap.get(day) ?? 0) + usd);
    }
    const failureCounts = new Map<string, number>();
    for (const r of failed) {
      if (!r.currentNodeId) continue;
      failureCounts.set(r.currentNodeId, (failureCounts.get(r.currentNodeId) ?? 0) + 1);
    }
    // ux-review H3 — resolve hotspot node ids to display labels from the
    // current head (only for workflows that HAVE failures; bounded: one
    // registry read per failing workflow in the window).
    let labelOf = (id: string): string | undefined => { void id; return undefined; };
    if (failureCounts.size > 0) {
      const def = await getRegisteredWorkflowAsync(workflowId).catch(() => null);
      if (def) {
        const names = new Map(def.nodes.map((n) => [n.nodeId, (n as { name?: string }).name]));
        labelOf = (id: string) => {
          const v = names.get(id);
          return typeof v === 'string' && v.trim().length > 0 ? v : undefined;
        };
      }
    }
    const outcomes = completed.length + failed.length;
    workflows.push({
      workflowId,
      runs: runs.length,
      nonProductionRuns,
      completed: completed.length,
      failed: failed.length,
      cancelled: cancelled.length,
      active: active.length,
      successRate: outcomes > 0 ? completed.length / outcomes : null,
      p50Ms: percentile(durations, 50),
      p95Ms: percentile(durations, 95),
      costUsdTotal: Number(allTerminalCosts.reduce((a, b) => a + b, 0).toFixed(6)),
      costUsdMedian: percentile(costs, 50),
      costUsdP95: percentile(costs, 95),
      costSamples: costs.length,
      costDaily: [...costDailyMap.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, usd]) => ({ day, usd: Number(usd.toFixed(6)) })),
      topFailures: [...failureCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([nodeId, count]) => {
          const label = labelOf(nodeId);
          return { nodeId, ...(label ? { label } : {}), count };
        }),
      nodeFailures: [...failureCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([nodeId, count]) => ({ nodeId, count })),
      lastRunAt: allRuns.reduce<string | null>((acc, r) => (acc === null || r.createdAt > acc ? r.createdAt : acc), null),
    });
  }
  workflows.sort((a, b) => (b.lastRunAt ?? '').localeCompare(a.lastRunAt ?? ''));

  return {
    rowsConsidered: rows.length,
    truncated: rows.length >= STATS_WINDOW_ROWS,
    sinceOldest,
    workflows,
  };
}
