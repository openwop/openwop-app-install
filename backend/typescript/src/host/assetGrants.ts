/**
 * ADR 1122 P1 — public-asset grants kept in step with what each public surface
 * shows. The grant store (`asset:grant`, `assetAccess.ts`) answers the serve
 * route's point lookup; this module decides what goes in it.
 *
 * Each public surface registers a provider that answers one question: which asset
 * tokens does this grantor (a published page, a listed product…) make public right
 * now? `resyncPublicAssetGrantor` asks it, diffs the answer against the grantor's
 * last recorded set (`asset:grantor`), and grants or revokes the difference. Write
 * paths call it after they commit (`schedulePublicAssetResync`, best-effort: it never
 * fails or slows the write). A reconcile runs on its own short tick to catch every
 * path without a hook (an expiry, an owner lapse, a raw write):
 *  - it pages the recorded grantor rows on a stored cursor, so a stale grant is
 *    revoked within one cycle (the leak direction);
 *  - it pages each provider's own enumeration on a second cursor, which is also the
 *    one-time backfill (a missing grant only breaks an image, the safe direction).
 * Each tick takes a lease, handles a bounded slice sized so a whole cycle takes about
 * an hour, and never scans every tenant at once (EVID-4, ADR 1110).
 *
 * A provider that throws or times out keeps that grantor's grants as they are: one
 * failing read must never revoke every image on a live site.
 *
 * Off while `OPENWOP_ASSET_ACCESS` is `off`: nothing reads the grants then.
 */
import { runUnderWorkerContract } from '../storage/eventEraAdapter.js';
import { DurableCollection, hostExtStorage } from './hostExtPersistence.js';
import { assetAccessMode, assetOrgResolver, grantPublicAsset, purgeLegacyGrantRows, revokePublicAsset } from './assetAccess.js';
import { getInstanceId } from './instanceId.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.assetGrants');

export interface PublicAssetRefProvider {
  /** Names the surface and prefixes its grantors (`cms-page`, `seo-page`, …). */
  surface: string;
  /** The tokens grantor `id` makes public now; [] when it shows nothing (unpublished,
   *  deleted). Throw on a read failure: the caller then keeps the existing grants. */
  tokensFor(tenantId: string, id: string): Promise<string[]>;
  /** One bounded step of this surface's own enumeration, for the backfill. `next`
   *  absent means the cycle is complete and starts again from the top. */
  backfillStep(cursor: string | undefined): Promise<{ items: Array<{ tenantId: string; id: string }>; next?: string }>;
}

const providers = new Map<string, PublicAssetRefProvider>();

export function registerPublicAssetRefProvider(p: PublicAssetRefProvider): void {
  providers.set(p.surface, p);
}

/** What one grantor last made public. Keyed `<surface>:<id>`. */
interface GrantorRow { grantor: string; surface: string; id: string; tenantId: string; tokens: string[] }
const grantors = new DurableCollection<GrantorRow>('asset:grantor', (r) => r.grantor, undefined, (r) => r.tenantId);

const PROVIDER_TIMEOUT_MS = 10_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms); timer.unref?.(); });
  return Promise.race([p, deadline]).finally(() => { if (timer) clearTimeout(timer); });
}

export type ResyncOutcome = 'unchanged' | 'changed' | 'kept' | 'off' | 'unknown-surface';

/**
 * Bring one grantor's grants in line with what it makes public now.
 * Crash-safe ordering: the row first records the UNION of old and new, then the
 * grants and revokes run, then the row records the new set. A crash part-way
 * leaves the union recorded, so the next resync still revokes what it must.
 */
export async function resyncPublicAssetGrantor(surface: string, tenantId: string, id: string): Promise<ResyncOutcome> {
  if (assetAccessMode() === 'off') return 'off';
  const provider = providers.get(surface);
  if (!provider) return 'unknown-surface';
  const key = `${surface}:${id}`;
  let next: string[];
  try {
    next = [...new Set(await withTimeout(provider.tokensFor(tenantId, id), PROVIDER_TIMEOUT_MS))].sort();
  } catch (err) {
    log.warn('asset_grant_provider_failed', { surface, tenantId, error: err instanceof Error ? err.message : String(err) });
    return 'kept';
  }
  const cur = await grantors.get(key);
  if (cur && cur.tenantId !== tenantId) return 'unchanged'; // a grantor belongs to one tenant
  const prev = cur?.tokens ?? [];
  const add = next.filter((t) => !prev.includes(t));
  const remove = prev.filter((t) => !next.includes(t));
  if (add.length === 0 && remove.length === 0) return 'unchanged';
  const union = [...new Set([...prev, ...next])].sort();
  await grantors.put({ grantor: key, surface, id, tenantId, tokens: union });
  for (const t of add) await grantPublicAsset(tenantId, t, key);
  for (const t of remove) await revokePublicAsset(tenantId, t, key);
  if (next.length === 0) await grantors.delete(key);
  else await grantors.put({ grantor: key, surface, id, tenantId, tokens: next });
  return 'changed';
}

/** Whether grants are kept at all (the switch is not `off`): a write path checks this
 *  before doing any extra read to find what to resync. */
export function publicAssetGrantsActive(): boolean {
  return assetAccessMode() !== 'off';
}

/** Hook for a write path, called after it commits: resync off the request, never
 *  failing or delaying it. A failure is logged; the reconcile catches up. */
export function schedulePublicAssetResync(surface: string, tenantId: string, id: string): void {
  if (assetAccessMode() === 'off') return;
  setImmediate(() => {
    resyncPublicAssetGrantor(surface, tenantId, id).catch((err) =>
      log.warn('asset_grant_resync_failed', { surface, tenantId, error: err instanceof Error ? err.message : String(err) }));
  });
}

// ── The reconcile ────────────────────────────────────────────────────────────

/** One tick every two minutes: 30 slices an hour. */
export const RECONCILE_TICK_MS = 2 * 60_000;
const TICKS_PER_HOUR = 30;
const ROWS_PREFIX = 'hostext:asset:grantor:';
const CURSOR_ROWS = 'assetgrant:cursor:rows';
const CURSOR_ORG_INDEX = 'assetgrant:cursor:org-index';
const cursorBackfill = (surface: string): string => `assetgrant:cursor:backfill:${surface}`;
const LEASE = (slot: number): string => `assetgrant:lease:${slot}`;

/** Rows per tick: enough that the recorded set is revisited about once an hour. */
async function rowSliceSize(): Promise<number> {
  const storage = hostExtStorage();
  const total = storage.kvCount ? await storage.kvCount(ROWS_PREFIX) : 3000;
  return Math.min(500, Math.max(20, Math.ceil(total / TICKS_PER_HOUR)));
}

export interface ReconcileReport { rows: number; backfilled: number; changed: number; kept: number; ms: number }

/** One reconcile slice. Exported for tests; the daemon runs it under a lease. */
export async function reconcilePublicAssetGrantsOnce(): Promise<ReconcileReport> {
  const started = Date.now();
  const report: ReconcileReport = { rows: 0, backfilled: 0, changed: 0, kept: 0, ms: 0 };
  if (assetAccessMode() === 'off') return report;
  const storage = hostExtStorage();
  const tally = (o: ResyncOutcome): void => { if (o === 'changed') report.changed += 1; else if (o === 'kept') report.kept += 1; };

  // 1. Revisit recorded grantors: the revocation safety net.
  const limit = await rowSliceSize();
  const after = (await storage.kvGet(CURSOR_ROWS)) ?? undefined;
  const page = storage.kvListPage
    ? await storage.kvListPage(ROWS_PREFIX, { ...(after ? { after } : {}), limit })
    : (await storage.kvList(ROWS_PREFIX)).filter((r) => !after || r.key > after).slice(0, limit);
  for (const { value } of page) {
    let row: GrantorRow;
    try { row = JSON.parse(value) as GrantorRow; } catch { continue; }
    report.rows += 1;
    tally(await resyncPublicAssetGrantor(row.surface, row.tenantId, row.id));
  }
  const last = page.length > 0 ? page[page.length - 1]?.key : undefined;
  if (page.length < limit || !last) await storage.kvDelete(CURSOR_ROWS);
  else await storage.kvSet(CURSOR_ROWS, last);

  // 2. One bounded backfill step per surface: grants a surface shows but has not recorded.
  for (const provider of providers.values()) {
    const cursor = (await storage.kvGet(cursorBackfill(provider.surface))) ?? undefined;
    let step: Awaited<ReturnType<PublicAssetRefProvider['backfillStep']>>;
    try {
      step = await withTimeout(provider.backfillStep(cursor), PROVIDER_TIMEOUT_MS);
    } catch (err) {
      log.warn('asset_grant_backfill_failed', { surface: provider.surface, error: err instanceof Error ? err.message : String(err) });
      continue;
    }
    for (const it of step.items) {
      report.backfilled += 1;
      tally(await resyncPublicAssetGrantor(provider.surface, it.tenantId, it.id));
    }
    if (step.next) await storage.kvSet(cursorBackfill(provider.surface), step.next);
    else await storage.kvDelete(cursorBackfill(provider.surface));
  }
  // 3. ADR 1122 P1c — one bounded step of the org-floor index backfill (rows that
  // predate the media token index), on its own cursor.
  const orgResolver = assetOrgResolver();
  if (orgResolver) {
    try {
      const cur = (await storage.kvGet(CURSOR_ORG_INDEX)) ?? undefined;
      const step = await withTimeout(orgResolver.backfillStep(cur), PROVIDER_TIMEOUT_MS);
      if (step.next) await storage.kvSet(CURSOR_ORG_INDEX, step.next);
      else await storage.kvDelete(CURSOR_ORG_INDEX);
    } catch (err) {
      log.warn('asset_org_index_backfill_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }
  report.ms = Date.now() - started;
  return report;
}

/** Claim this two-minute slot for one instance (the first writer wins). */
async function claimSlot(slot: number): Promise<boolean> {
  const storage = hostExtStorage();
  const { swapped } = await storage.kvCompareAndSwap(LEASE(slot), null, getInstanceId()).catch(() => ({ swapped: false }));
  if (swapped) await storage.kvDelete(LEASE(slot - 2)).catch(() => undefined); // keep the lease keys from piling up
  return swapped;
}

export function startAssetGrantReconciler(): { stop: () => void } {
  let running = false;
  let legacyChecked = false;
  const tick = async (): Promise<void> => {
    if (running || assetAccessMode() === 'off') return;
    running = true;
    try {
      if (!legacyChecked) { legacyChecked = true; await purgeLegacyGrantRows(hostExtStorage()); }
      if (!(await claimSlot(Math.floor(Date.now() / RECONCILE_TICK_MS)))) return;
      const r = await reconcilePublicAssetGrantsOnce();
      if (r.rows + r.backfilled > 0) log.info('asset_grant_reconcile', { ...r });
    } catch (err) {
      log.warn('asset_grant_reconcile_failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  // ADR 0650 — a worker enters the event seat under the named worker contract,
  // never the ambient default.
  const timer = setInterval(() => void runUnderWorkerContract(tick), RECONCILE_TICK_MS);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** Test seam: what a grantor last recorded. */
export async function __grantorTokensForTest(surface: string, id: string): Promise<string[] | null> {
  return (await grantors.get(`${surface}:${id}`))?.tokens ?? null;
}
