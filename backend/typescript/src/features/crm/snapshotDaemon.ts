/**
 * Weekly pipeline-snapshot cadence daemon (ADR 0210 §2) — mirrors
 * `features/knowledge-sync/knowledgeSyncDaemon.ts` EXACTLY (self-rescheduling
 * ±20% jitter timer, `.unref()`, in-flight re-entrancy guard) with a per-
 * (tenant, org, ISO-week) `claimOnce` slot instead of a per-source one:
 * the FIRST poll to land in a given ISO week wins the snapshot for every
 * pipeline in that org; every later poll in the same week finds the slot
 * already claimed and skips. Explicitly NOT a scheduler job (per-subject
 * only) and NOT a chain (no all-tenant enumeration primitive) — this composes
 * the existing sweep-daemon idiom. Boot-gated behind
 * `OPENWOP_CRM_SNAPSHOT_ENABLED` (default off) at the `index.ts` call site;
 * this module itself has no env-read (mirrors the other unconditionally-
 * constructed daemons — the gate lives at the START call, not in here).
 */

import type { Storage } from '../../storage/storage.js';
import { createLogger } from '../../observability/logger.js';
import { crmSnapshotId, listDeals, listPipelines, upsertCrmSnapshot, type StageSnapshotEntry } from './crmEntitiesService.js';

const log = createLogger('crm.snapshot');

const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly

/** ISO-8601 week label (`YYYY-Www`), UTC-based — a stable, deterministic slot
 *  key independent of server timezone. */
export function isoWeek(now: number): string {
  const d = new Date(now);
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday determines the ISO year
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** One daemon pass: for every (tenant, org) that owns ≥1 pipeline, claim this
 *  week's slot and — on a WON claim — snapshot every pipeline in that org.
 *  Returns the number of per-pipeline snapshot rows written. */
export async function processDueCrmSnapshots(
  deps: { storage: Storage },
  listCrmTenants: () => Promise<Array<{ tenantId: string; orgId: string }>>,
  now: number,
): Promise<number> {
  const week = isoWeek(now);
  const at = new Date(now).toISOString();
  let written = 0;
  for (const { tenantId, orgId } of await listCrmTenants()) {
    let claim: { claimed: boolean };
    try {
      claim = await deps.storage.claimOnce(`crm-snapshot:${tenantId}:${orgId}:${week}`, at);
    } catch (err) {
      log.warn('crm_snapshot_claim_failed', { tenantId, orgId, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    if (!claim.claimed) continue;
    try {
      for (const pipeline of await listPipelines(tenantId, orgId)) {
        // CRMGAP-7: ONE query per pipeline (not one per stage) — group the
        // pipeline's deals by stageId in memory instead of re-querying per stage.
        const pipelineDeals = await listDeals(tenantId, orgId, { pipelineId: pipeline.pipelineId });
        const dealsByStage = new Map<string, typeof pipelineDeals>();
        for (const d of pipelineDeals) {
          const bucket = dealsByStage.get(d.stageId);
          if (bucket) bucket.push(d);
          else dealsByStage.set(d.stageId, [d]);
        }
        const perStage: StageSnapshotEntry[] = [];
        for (const stage of pipeline.stages) {
          const stageDeals = dealsByStage.get(stage.stageId) ?? [];
          const sum = stageDeals.reduce((acc, d) => acc + (d.amount ?? 0), 0);
          const weightedSum = stageDeals.reduce((acc, d) => acc + (d.amount ?? 0) * (stage.probability / 100), 0);
          perStage.push({ stageId: stage.stageId, name: stage.name, count: stageDeals.length, sum, weightedSum });
        }
        await upsertCrmSnapshot({
          snapshotId: crmSnapshotId(tenantId, orgId, pipeline.pipelineId, week),
          tenantId,
          orgId,
          pipelineId: pipeline.pipelineId,
          isoWeek: week,
          at,
          perStage,
        });
        written += 1;
      }
    } catch (err) {
      log.warn('crm_snapshot_org_failed', { tenantId, orgId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return written;
}

export interface CrmSnapshotDaemon {
  stop: () => void;
}

/** Start the polling cadence daemon (mirrors `startKnowledgeSyncDaemon`). */
export function startCrmSnapshotDaemon(
  deps: { storage: Storage },
  listCrmTenants: () => Promise<Array<{ tenantId: string; orgId: string }>>,
): CrmSnapshotDaemon {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await processDueCrmSnapshots(deps, listCrmTenants, Date.now());
    } catch (err) {
      log.warn('crm_snapshot_daemon_tick_error', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  // ±20% jitter self-rescheduling timer — same reasoning as knowledge-sync's
  // MKP-6 note: N Cloud Run instances shouldn't all poll on the same tick.
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const nextDelay = (): number => POLL_INTERVAL_MS * (0.8 + Math.random() * 0.4);
  const schedule = (): void => {
    timer = setTimeout(() => {
      void tick().finally(() => {
        if (!stopped) schedule();
      });
    }, nextDelay());
    if (typeof timer.unref === 'function') timer.unref();
  };
  schedule();
  log.info('crm_snapshot_daemon_started', { pollIntervalMs: POLL_INTERVAL_MS, jitter: '±20%' });
  return {
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
