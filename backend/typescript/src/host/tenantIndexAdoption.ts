/**
 * ADR 0866 — deploy-safe adoption of a DurableCollection tenant index.
 *
 * A collection that gains `tenantOf` registers here. The hourly retention tick
 * runs one `reconcileTenantIndex` pass per registration, under a per-hour slot claim so
 * duplicate ticks normally reconcile once. A pass may span an hour boundary;
 * verification uses metadata CAS to protect a newer reset. The owning feature reads through the index only while
 * `tenantIndexVerified()` is true and keeps its full scan otherwise.
 *
 * The window is how long a superseded revision may keep writing after this code
 * first reconciles: the request timeout plus idle shutdown (WHD-28 measured about
 * 55 minutes). The default leaves room for a slow drain; a TAGGED old revision
 * stays routable indefinitely, so remove tags after a deploy (CLAUDE.md, Postgres
 * budget) — and if one ever writes, the next pass un-verifies the index.
 */
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import type { DurableCollection } from './hostExtPersistence.js';

const log = createLogger('host.tenantIndexAdoption');

const HOUR_MS = 60 * 60_000;
/** One kv row per collection holding the last hour slot claimed. A CAS from the
 *  value read to the new slot is the lease: no row per slot, so nothing to prune. */
const leaseKey = (id: string): string => `tenant-index-adoption:${id}:slot`;

async function claimSlot(storage: Storage, id: string, slot: number): Promise<boolean> {
  const current = await storage.kvGet(leaseKey(id));
  if (current !== null && Number(current) >= slot) return false;
  return (await storage.kvCompareAndSwap(leaseKey(id), current, String(slot))).swapped;
}

/** Minutes a pre-index writer may still be serving after the first reconcile. */
export function adoptionWindowMs(): number {
  const raw = process.env.OPENWOP_INDEX_ADOPTION_WINDOW_MIN;
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return (Number.isFinite(n) && n > 0 ? n : 180) * 60_000;
}

type AdoptableTenantIndex = Pick<DurableCollection<unknown>, 'reconcileTenantIndex'>;
interface Registration { collection: AdoptableTenantIndex; beforeReconcile?: () => Promise<void> }
const registrations = new Map<string, Registration>();

/** `beforeReconcile` (ADR 0872 D2) runs under the same hourly slot, right before
 *  the pass: a collection whose rows can lack a tenant stamps them here, so the
 *  pass sees them. A row it cannot stamp keeps the index unverified (D3). */
export function registerTenantIndexAdoption<T>(
  id: string,
  collection: DurableCollection<T>,
  opts: { beforeReconcile?: () => Promise<void> } = {},
): void {
  registrations.set(id, { collection, ...(opts.beforeReconcile ? { beforeReconcile: opts.beforeReconcile } : {}) });
}

/** One pass over every registration. Fail-open per collection: one bad store never
 *  stops the tick, and a failed pass leaves the index unverified or as it was. */
export async function reconcileTenantIndexesOnce(storage: Storage, now: number = Date.now()): Promise<void> {
  const slot = Math.floor(now / HOUR_MS);
  for (const [id, { collection, beforeReconcile }] of registrations) {
    try {
      if (!(await claimSlot(storage, id, slot))) continue;
      // A failed hook still lets the pass run: unstamped rows then keep the index unverified.
      if (beforeReconcile) {
        await beforeReconcile().catch((err) =>
          log.warn('tenant_index_before_reconcile_failed', { collection: id, error: err instanceof Error ? err.message : String(err) }));
      }
      const r = await collection.reconcileTenantIndex({ windowMs: adoptionWindowMs(), now });
      if (r.reset) log.warn('tenant_index_unindexed_writer', { collection: id, repaired: r.repaired, skipped: r.skipped });
      else if (r.verifiedNow) log.info('tenant_index_verified', { collection: id, repaired: r.repaired, skipped: r.skipped });
      // Every pass logs, so a silent hour means the tick stopped, not that nothing changed.
      log.info('tenant_index_reconciled', { collection: id, repaired: r.repaired, skipped: r.skipped, verified: r.verified });
    } catch (err) {
      log.warn('tenant_index_reconcile_failed', { collection: id, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Test-only. */
export function __resetTenantIndexAdoptionRegistry(): void {
  registrations.clear();
}
