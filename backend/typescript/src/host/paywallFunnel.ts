/**
 * Paywall funnel counters (monetization strategy §8 "Instrumentation", ADR 0820).
 *
 * ONE counts-only store for the three paywall signals the funnel needs and the
 * app did not record: a plan lock SEEN (`impression`), its upgrade link FOLLOWED
 * (`click`), and the backend REFUSING a feature on the plan (`refusal`).
 *
 * The checkout and grant half rides the SAME store as server-written LEDGER
 * metrics ({@link LEDGER_METRICS}, ADR 0820 §7 note "the funnel digest"): billing
 * counts a checkout started / completed and a bundle grant started / ended at the
 * write that makes it true (the `billing:checkout` put, its `fulfilledAt` CAS, the
 * grant CAS), so each counts once. The `billing:checkout` ledger ages out at 30
 * days; these counts live {@link TTL_DAYS}, which is what lets the read offer 90.
 *
 * Privacy is the ADR 0512 nav-telemetry posture, structurally: a row is
 * `(UTC day, tenant, metric, featureId | product, surface) → count`. No user id, no
 * session, no URL, nothing finer than a day. A per-person trail never exists, so
 * there is nothing for a DSAR to find (the store is classified no-subject in
 * `test/subject-erasure-coverage.test.ts`).
 *
 * Cost on the request path is a synchronous Map increment. `notePaywallEvent`
 * never awaits, never throws and never touches storage: writes are BUFFERED and
 * flushed off the request (a short unref'd timer, or at a size threshold). A
 * lost buffer on shutdown, or a lost CAS race across instances, undercounts;
 * these are evidence-grade counts, never billing (the nav-telemetry trade).
 *
 * Bounded: a (day, tenant) slice mints at most {@link DISTINCT_ROWS_CAP} rows,
 * and rows age out after {@link TTL_DAYS} on the default-on kvAgeOut lane
 * (plus the opt-in `internal` retention window). Teardown reaches the rows via
 * the `tenantId` FIELD (`purgeTenantRows`' JSON probe), as for nav-counts.
 */
import { DurableCollection } from './hostExtPersistence.js';
import { registerRetentionPurger, purgeRowsByAge } from './retentionPurger.js';
import { registerKvAgeOut } from './kvAgeOut.js';
import { bundleOfFeature } from './featureBundles.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.paywallFunnel');

export const PAYWALL_METRICS = ['impression', 'click', 'refusal'] as const;
export type PaywallMetric = (typeof PAYWALL_METRICS)[number];
/** Server-only metrics billing writes (never accepted from a client: the beacon
 *  validates against {@link PAYWALL_METRICS}). Keyed by `product`
 *  (`plan:<tier>` / `bundle:<id>` / `pack:<key>`), not by feature. */
export const LEDGER_METRICS = ['checkout-started', 'checkout-completed', 'checkout-demo', 'grant-started', 'grant-ended'] as const;
export type LedgerMetric = (typeof LEDGER_METRICS)[number];
export type FunnelMetric = PaywallMetric | LedgerMetric;
const LEDGER_SET = new Set<string>(LEDGER_METRICS);
export const isLedgerMetric = (m: string): m is LedgerMetric => LEDGER_SET.has(m);
/** `plan:<tier>` / `bundle:<id>` / `pack:<key>` (the funnel read's product key). */
const PRODUCT = /^(plan|bundle|pack):[A-Za-z0-9_.-]{1,64}$/;

/** Where a lock was seen or followed (frontend), or which backend lane refused. */
export const PAYWALL_SURFACES = [
  // frontend lock affordances
  'locked-page', 'sidebar', 'palette', 'admin-rail', 'admin-overview', 'chat-picker',
  // backend refusal lanes: an HTTP route's plan 403 / any other `resolveOne` lane
  'route', 'lane',
] as const;
export type PaywallSurface = (typeof PAYWALL_SURFACES)[number];
/** The surface of every ledger metric row. */
export const LEDGER_SURFACE = 'billing' as const;
const SURFACE_SET = new Set<string>(PAYWALL_SURFACES);
const METRIC_SET = new Set<string>(PAYWALL_METRICS);
/** A first-party toggle id. Anything else is dropped, never stored. */
const FEATURE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Per (day, tenant): the most distinct rows we will mint. */
const DISTINCT_ROWS_CAP = 400;
/** Rows older than this are deleted. The read's longest window is 90 days; the
 *  slack keeps day −89 whole whatever hour its last write landed. */
export const TTL_DAYS = 92;
/** Flush the buffer this long after its first entry … */
const FLUSH_DELAY_MS = 5_000;
/** … or as soon as it holds this many distinct keys. */
const FLUSH_AT_KEYS = 200;

export interface PaywallCountRow {
  day: string;            // UTC 'YYYY-MM-DD'
  tenantId: string;
  metric: FunnelMetric;
  /** The paywalled feature ('' on a ledger row). */
  featureId: string;
  /** The bundle that sells the feature at record time, or the bundle a ledger
   *  row's product is ('' when none). */
  bundleId: string;
  surface: PaywallSurface | typeof LEDGER_SURFACE;
  /** Ledger rows only: what was sold (`plan:pro`, `bundle:crm`, `pack:<key>`). */
  product?: string;
  count: number;
  updatedAt: string;
}

const rowId = (r: Pick<PaywallCountRow, 'day' | 'tenantId' | 'metric' | 'featureId' | 'surface' | 'product'>): string =>
  `${r.day}::${r.tenantId}::${r.metric}::${r.product ?? r.featureId}::${r.surface}`;

const counts = new DurableCollection<PaywallCountRow>('paywall:funnel-counts', rowId);

registerKvAgeOut({ id: 'paywall:funnel-counts', prefix: 'hostext:paywall:funnel-counts:', ttlDays: TTL_DAYS, timestampField: 'updatedAt' });
// Counts-only operational data → `internal`. Keyed day-first (the operator read
// scans by day), so a tenant purge is a full scan + tenant filter, bounded by the TTL.
registerRetentionPurger({
  feature: 'paywall:funnel-counts',
  dryRun: 'rows-by-age',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'internal') return 0;
    return purgeRowsByAge('paywall:funnel-counts', await counts.list(), tenantId, cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: r.updatedAt, id: rowId(r) }),
      (id) => counts.delete(id));
  },
});

export interface PaywallEventInput {
  tenantId: string;
  metric: PaywallMetric;
  featureId: string;
  surface: PaywallSurface;
  // No `bundleId`: it is resolved from the catalog at record time, never taken
  // from a client (a client could only be wrong about it).
}

const buffer = new Map<string, { row: Omit<PaywallCountRow, 'count' | 'updatedAt'>; delta: number }>();
let timer: ReturnType<typeof setTimeout> | undefined;
let flushing: Promise<void> | undefined;

/** Whether an input is well-formed. Invalid input is dropped, never stored. */
export function isValidPaywallEvent(e: { metric?: unknown; featureId?: unknown; surface?: unknown }): boolean {
  return typeof e.metric === 'string' && METRIC_SET.has(e.metric)
    && typeof e.featureId === 'string' && FEATURE_ID.test(e.featureId)
    && typeof e.surface === 'string' && SURFACE_SET.has(e.surface);
}

/**
 * Count one paywall event. Synchronous, NEVER throws, never awaits storage — safe
 * to call from inside a refusal on any hot path. Returns whether it was buffered.
 */
export function notePaywallEvent(e: PaywallEventInput, now: Date = new Date()): boolean {
  try {
    if (!e.tenantId || !isValidPaywallEvent(e)) return false;
    const bundleId = bundleOfFeature(e.featureId) ?? '';
    const row = { day: now.toISOString().slice(0, 10), tenantId: e.tenantId, metric: e.metric, featureId: e.featureId, bundleId, surface: e.surface };
    const id = rowId(row);
    const pending = buffer.get(id);
    if (pending) pending.delta += 1;
    else buffer.set(id, { row, delta: 1 });
    if (buffer.size >= FLUSH_AT_KEYS) scheduleFlush(0);
    else scheduleFlush(FLUSH_DELAY_MS);
    return true;
  } catch (err) {
    log.warn('paywall_funnel_note_failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

function scheduleFlush(delayMs: number): void {
  if (timer && delayMs > 0) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; void flushPaywallCounts(); }, delayMs);
  timer.unref?.();
}

/** Write the buffer to the store. Never throws. Exported for tests and shutdown. */
export async function flushPaywallCounts(): Promise<void> {
  if (flushing) await flushing.catch(() => undefined);
  if (buffer.size === 0) return;
  const batch = [...buffer.values()];
  buffer.clear();
  flushing = (async () => {
    for (const { row, delta } of batch) {
      try { await addToRow(row, delta); } catch (err) {
        log.warn('paywall_funnel_flush_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  })();
  try { await flushing; } finally { flushing = undefined; }
}

async function addToRow(row: Omit<PaywallCountRow, 'count' | 'updatedAt'>, delta: number, opts: { capped?: boolean; attempts?: number } = {}): Promise<boolean> {
  const id = rowId(row);
  for (let attempt = 0; attempt < (opts.attempts ?? 3); attempt++) {
    const existing = await counts.get(id);
    if (!existing && opts.capped !== false) {
      const slice = await counts.listByPrefix(`${row.day}::${row.tenantId}::`);
      if (slice.length >= DISTINCT_ROWS_CAP) return false; // capped: junk cannot balloon rows
    }
    const next: PaywallCountRow = { ...row, count: (existing?.count ?? 0) + delta, updatedAt: new Date().toISOString() };
    if (await counts.compareAndSwap(existing, next)) return true;
  }
  // Lost every race: undercount by design (evidence-grade, never billing).
  return false;
}

/**
 * Count one LEDGER event (a checkout started / completed / demo, a bundle grant
 * started / ended). Called by billing AFTER the write that makes the event true,
 * and only by the caller that WON that write (a fresh checkout row, the
 * `fulfilledAt` CAS, the grant CAS): that is what makes it count once under
 * webhook redelivery, not anything here. Written straight through (these are
 * rare, and a lost buffer would lose a sale), uncapped (a junk flood of client
 * metrics cannot crowd a sale out of its day), and it NEVER throws: a failed
 * count undercounts, it never fails the purchase.
 */
export async function recordLedgerCount(e: { tenantId: string; metric: LedgerMetric; product: string }, now: Date = new Date()): Promise<boolean> {
  try {
    if (!e.tenantId || !isLedgerMetric(e.metric) || !PRODUCT.test(e.product)) return false;
    const bundleId = e.product.startsWith('bundle:') ? e.product.slice('bundle:'.length) : '';
    const row = { day: now.toISOString().slice(0, 10), tenantId: e.tenantId, metric: e.metric, featureId: '', bundleId, surface: LEDGER_SURFACE, product: e.product };
    return await addToRow(row, 1, { capped: false, attempts: 6 });
  } catch (err) {
    log.warn('paywall_funnel_ledger_count_failed', { metric: e?.metric, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/** The UTC days of a window ending at `now`, newest first. */
export function windowDays(days: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  for (let i = 0; i < days; i++) out.push(new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  return out;
}

/** Every stored row in the window, all tenants (the operator read). Flushes first. */
export async function listPaywallCounts(days: number, now: Date = new Date()): Promise<PaywallCountRow[]> {
  return listPaywallCountsForDays(windowDays(days, now));
}
/** Every stored row on the given UTC days (`YYYY-MM-DD`), all tenants. Flushes first. */
export async function listPaywallCountsForDays(days: readonly string[]): Promise<PaywallCountRow[]> {
  await flushPaywallCounts();
  const out: PaywallCountRow[] = [];
  for (const day of days) out.push(...await counts.listByPrefix(`${day}::`));
  return out;
}

/** Test-only: drop the buffer and the stored rows. */
export async function __resetPaywallFunnel(): Promise<void> {
  if (timer) clearTimeout(timer);
  timer = undefined;
  buffer.clear();
  await counts.__clear();
}
/** Test-only: buffered (unflushed) key count. */
export function __bufferedPaywallKeys(): number { return buffer.size; }
