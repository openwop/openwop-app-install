/**
 * ADR 0871 — the hourly storage-growth gauge.
 *
 * ADR 0868's `surface_scan_heavy` fires only once a read crosses its threshold,
 * so a quiet log cannot show growth TOWARD a trigger. This logs the sizes the
 * three deferred decisions are measured against, once per UTC hour across all
 * instances:
 *
 *   - `surface_rows_gauge`, one line per durable surface family: tenants holding
 *     rows, the largest tenant's row count, the total, and the tenants at or over
 *     the T1 trigger (ADR 0868 open question 1, a per-tenant row quota);
 *   - `vector_rows_gauge` when pgvector is selected: namespaces, the largest
 *     namespace, the total, the namespaces at or over the T3 trigger, and the
 *     pgvector version (ADR 0867 open question 2, an HNSW index).
 *
 * No line carries a tenant id or a namespace: the database returns aggregates.
 * `scripts/measure-storage-growth.sh` reads these lines back.
 */
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { readPgVectorStats } from './vector/pgVectorVector.js';

const log = createLogger('host.storageGrowthGauge');

const HOUR_MS = 60 * 60_000;
/** One kv row holding the last hour slot claimed, the `tenantIndexAdoption` lease. */
const LEASE_KEY = 'storage-growth-gauge:slot';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/** T1 — rows one tenant holds in one durable surface family. */
export const surfaceRowTrigger = (): number => envInt('OPENWOP_SURFACE_ROW_TRIGGER', 100_000);
/** T3 — vectors in one (tenant, namespace). */
export const vectorNamespaceTrigger = (): number => envInt('OPENWOP_VECTOR_NAMESPACE_TRIGGER', 50_000);

async function claimHour(storage: Storage, slot: number): Promise<boolean> {
  const current = await storage.kvGet(LEASE_KEY);
  if (current !== null && Number(current) >= slot) return false;
  return (await storage.kvCompareAndSwap(LEASE_KEY, current, String(slot))).swapped;
}

/**
 * One gauge pass, if this instance wins the hour. Returns whether it ran.
 * Fail-open per half: a failed surface read does not stop the vector read.
 */
export async function runStorageGrowthGaugeOnce(storage: Storage, now: number = Date.now()): Promise<boolean> {
  if (process.env.OPENWOP_STORAGE_GROWTH_GAUGE === 'false') return false;
  if (!(await claimHour(storage, Math.floor(now / HOUR_MS)))) return false;

  if (storage.surfaceRowStats) {
    const started = Date.now();
    try {
      const stats = await storage.surfaceRowStats(surfaceRowTrigger());
      const ms = Date.now() - started;
      for (const s of stats) {
        log.info('surface_rows_gauge', {
          family: s.family, tenants: s.tenants, maxTenantRows: s.maxTenantRows,
          totalRows: s.totalRows, tenantsAtOrOverTrigger: s.tenantsAtOrOver,
          trigger: surfaceRowTrigger(), ms,
        });
      }
      if (stats.length === 0) log.info('surface_rows_gauge', { family: null, totalRows: 0, ms });
    } catch (err) {
      log.warn('surface_rows_gauge_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const started = Date.now();
  try {
    const v = await readPgVectorStats(vectorNamespaceTrigger());
    if (v) {
      log.info('vector_rows_gauge', {
        namespaces: v.namespaces, maxNamespaceRows: v.maxNamespaceRows, totalRows: v.totalRows,
        namespacesAtOrOverTrigger: v.namespacesAtOrOver, trigger: vectorNamespaceTrigger(),
        dim: v.dim, pgvector: v.extversion, ms: Date.now() - started,
      });
    }
  } catch (err) {
    log.warn('vector_rows_gauge_failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return true;
}
