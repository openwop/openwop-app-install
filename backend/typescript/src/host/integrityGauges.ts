/**
 * ADR 1104 — daily integrity gauges.
 *
 * A data assessment ends with read-only probes ("count the rows where X"). Run by
 * hand they need database access, and once run they say nothing about tomorrow.
 * A feature registers each probe here as a gauge instead: the retention daemon's
 * tick runs every registered gauge once per UTC day across all instances (one
 * kv lease), and each logs one `integrity_gauge` line of aggregate counts that
 * `gcloud logging read` reads back. A non-zero count is a finding.
 *
 * Read-only and aggregate by construction: a gauge returns numbers only, so no
 * line can carry a tenant id, a page id or content. Each gauge fails on its own;
 * one that throws logs `integrity_gauge_failed` and the rest still run.
 * `OPENWOP_INTEGRITY_GAUGES=false` turns them off.
 *
 * Features register into this module (feature → core, the `registerRetentionPurger`
 * direction); nothing here imports a feature.
 */
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.integrityGauges');

const DAY_MS = 86_400_000;
/** One kv row holding the last UTC day claimed (the storage-gauge lease shape). */
const LEASE_KEY = 'integrity-gauges:day';

/** The most rows of one type a gauge reads per tenant. A tenant over it is
 *  counted, not read whole: gauges report `truncatedTenants` and `rowsSeen`, so
 *  a capped count says it is a floor. */
export const INTEGRITY_GAUGE_ROW_CAP = 10_000;

/** A gauge: read-only, returns aggregate counts only. */
export type IntegrityGauge = () => Promise<Readonly<Record<string, number>>>;

const gauges = new Map<string, IntegrityGauge>();

/** Register (or replace) a named gauge. Idempotent, so a re-registered feature
 *  in a test harness does not run its gauge twice. */
export function registerIntegrityGauge(name: string, run: IntegrityGauge): void {
  gauges.set(name, run);
}

/** The registered gauge names (a wiring witness for tests). */
export function integrityGaugeNames(): string[] {
  return [...gauges.keys()];
}

/** Test-only: forget every registered gauge. */
export function __resetIntegrityGaugesForTest(): void {
  gauges.clear();
}

async function claimDay(storage: Storage, slot: number): Promise<boolean> {
  const current = await storage.kvGet(LEASE_KEY);
  if (current !== null && Number(current) >= slot) return false;
  return (await storage.kvCompareAndSwap(LEASE_KEY, current, String(slot))).swapped;
}

/**
 * One pass over every registered gauge, if this instance wins the UTC day.
 * Returns whether it ran.
 */
export async function runIntegrityGaugesOnce(storage: Storage, now: number = Date.now()): Promise<boolean> {
  if (process.env.OPENWOP_INTEGRITY_GAUGES === 'false') return false;
  if (gauges.size === 0) return false;
  if (!(await claimDay(storage, Math.floor(now / DAY_MS)))) return false;
  for (const [gauge, run] of gauges) {
    const started = Date.now();
    try {
      const counts = await run();
      const numeric = Object.fromEntries(Object.entries(counts).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)));
      log.info('integrity_gauge', { gauge, ...numeric, ms: Date.now() - started });
    } catch (err) {
      log.warn('integrity_gauge_failed', { gauge, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return true;
}
