/**
 * CRM pipeline snapshots (ADR 0210 §2) — weekly, via the sweep-daemon
 * pattern. Split out of the former `crmEntitiesService.ts` god-file
 * (CRMGAP-10) — re-exported unchanged via that file's barrel.
 *
 * @see docs/adr/0210-crm-stage-history-snapshots-reports.md
 */

import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { listAllPipelinesUnscoped } from './pipelines.js';

export interface StageSnapshotEntry {
  stageId: string;
  name: string;
  count: number;
  sum: number;
  weightedSum: number;
}
export interface CrmSnapshot {
  snapshotId: string;
  tenantId: string;
  orgId: string;
  pipelineId: string;
  isoWeek: string;
  at: string;
  perStage: StageSnapshotEntry[];
}

const snapshots = new DurableCollection<CrmSnapshot>('crm:snapshot', (s) => s.snapshotId, undefined, (s) => s.tenantId);

/** Cap: prune oldest (by `isoWeek`) so at most 104 rows persist per (org,pipeline). */
export const MAX_SNAPSHOTS_PER_PIPELINE = 104;

/** Deterministic snapshotId — same (tenant,org,pipeline,week) upserts the same
 *  row (idempotent re-computation within a week; growth only across weeks). */
export function crmSnapshotId(tenantId: string, orgId: string, pipelineId: string, isoWeek: string): string {
  return `snap:${tenantId}:${orgId}:${pipelineId}:${isoWeek}`;
}

/** Upsert one snapshot row, then prune the (org,pipeline) slice down to the cap. */
export async function upsertCrmSnapshot(snapshot: CrmSnapshot): Promise<void> {
  await snapshots.put(snapshot);
  const siblings = (await snapshots.listForTenantIndexed(snapshot.tenantId))
    .filter((s) => s.orgId === snapshot.orgId && s.pipelineId === snapshot.pipelineId)
    .sort((a, b) => (a.isoWeek < b.isoWeek ? -1 : a.isoWeek > b.isoWeek ? 1 : 0));
  const excess = siblings.length - MAX_SNAPSHOTS_PER_PIPELINE;
  if (excess > 0) {
    for (const stale of siblings.slice(0, excess)) await snapshots.delete(stale.snapshotId);
  }
}

/** The last `limit` snapshot rows for a pipeline, oldest → newest (report input). */
export async function listCrmSnapshots(tenantId: string, orgId: string, pipelineId: string, limit: number): Promise<CrmSnapshot[]> {
  const rows = (await snapshots.listForTenantIndexed(tenantId))
    .filter((s) => s.orgId === orgId && s.pipelineId === pipelineId)
    .sort((a, b) => (a.isoWeek < b.isoWeek ? -1 : a.isoWeek > b.isoWeek ? 1 : 0));
  return rows.slice(Math.max(0, rows.length - limit));
}

/** Distinct (tenantId, orgId) pairs that have ≥1 pipeline — the snapshot
 *  daemon's tenant/org enumerator (mirrors `listSyncSourceTenants`: no global
 *  tenant listing exists by design, so a feature-owned daemon derives its own
 *  scan input from its own rows). */
export async function listCrmOrgScopes(): Promise<Array<{ tenantId: string; orgId: string }>> {
  const seen = new Set<string>();
  const out: Array<{ tenantId: string; orgId: string }> = [];
  for (const p of await listAllPipelinesUnscoped()) {
    const key = `${p.tenantId}:${p.orgId}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ tenantId: p.tenantId, orgId: p.orgId });
    }
  }
  return out;
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __clearSnapshots(): Promise<void> {
  await snapshots.__clear();
}
