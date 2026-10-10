/**
 * Workspace navigation telemetry (ADR 0512) — counts-only destination × source
 * aggregates for the DSA-028 IA evidence gate. Owned by `features/analytics`
 * per the ADR's acceptance rider; gated by the `workspace-nav-telemetry`
 * sub-toggle AND its parent `analytics` toggle (ADR 0404 §P4 rule).
 *
 * Privacy is structural, not policy: a row is
 * `(tenant, ISO week, source, route PATTERN) → count`. There is no user id,
 * no session key, no timestamp finer than the week, and no concrete URL (the
 * client sends the matched manifest pattern, e.g. `/crm/deals/:dealId`) — a
 * per-user trail never exists to leak or to erase.
 *
 * Aggregation is read-modify-write; concurrent increments may undercount by
 * design (evidence-grade counts, not billing). Growth is bounded per
 * (tenant, week) by a distinct-route cap so junk input cannot balloon rows.
 * TEARDOWN (WF-ANL-10 — this used to credit the wrong mechanism). The key does
 * embed the tenant id first, mirroring `workflow:spend-day`, but that is NOT what
 * ADR 0284 teardown reads. This collection declares **no `tenantOf`** (it is
 * constructed with name + idOf only), so `purgeTenantRows`
 * (`hostExtPersistence.ts:549`) takes its else branch and resolves the row's
 * tenant with `jsonTenantId(parsed)` — a CONTENT PROBE on the row's `tenantId`
 * FIELD. The rows ARE swept; the key shape is simply not why.
 *
 * The direction matters for maintenance: reordering the key is harmless, while
 * dropping or renaming the `tenantId` FIELD silently stops teardown from reaching
 * these rows — and the old wording would still have read as satisfied.
 * `analytics:identity-link` (`identityLinkService.ts:41`) has the identical shape.
 * Pinned by `test/nav-telemetry-teardown-mechanism.test.ts`.
 */
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';

export const NAV_SOURCES = [
  'sidebar', 'palette', 'hub', 'breadcrumb', 'deep-link', 'in-app-link', 'admin-rail',
] as const;
export type NavSource = (typeof NAV_SOURCES)[number];
const SOURCE_SET = new Set<string>(NAV_SOURCES);

/** Route patterns only: manifest-shaped paths, bounded length, no query/ids. */
const ROUTE_PATTERN = /^\/[A-Za-z0-9\-_/:]{0,119}$/;

/** Per (tenant, week): the most distinct (source, route) rows we will mint. */
const DISTINCT_ROWS_CAP = 600;

interface NavCountRow {
  tenantId: string;
  week: string;      // ISO week, e.g. '2026-W31'
  source: NavSource;
  route: string;     // the manifest route PATTERN
  count: number;
}

/** The row key — ONE definition, used by the collection and by the purger.
 *  The collection's key fn names `r.tenantId` inline on purpose: the teardown
 *  reachability ratchet reads that text to prove the key is tenant-prefixed. */
const navKeyOf = (tenantId: string, r: Pick<NavCountRow, 'week' | 'source' | 'route'>): string => `${tenantId}::${r.week}::${r.source}::${r.route}`;
const counts = new DurableCollection<NavCountRow>(
  'analytics:nav-counts',
  (r) => navKeyOf(r.tenantId, r),
);

/** ISO-8601 week label for a date (UTC). */
export function isoWeek(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** ADR 0857 D4 — the exclusive END of an ISO week label (`YYYY-Www` → the
 *  following Monday 00:00Z), or undefined for a malformed label. Anchored on
 *  4 January of the ISO year — the date ISO 8601 guarantees is in week 1 — so a
 *  week 1 that starts in the previous calendar year (2020-W01 = 2019-12-30)
 *  comes out right. A row is purged only once its WHOLE week is older than the
 *  cutoff, which errs toward retention. */
export function isoWeekEnd(week: string): string | undefined {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return undefined;
  const jan4 = Date.UTC(Number(m[1]), 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7;
  const week1Monday = jan4 - (dow - 1) * 86_400_000;
  return new Date(week1Monday + Number(m[2]) * 7 * 86_400_000).toISOString();
}

// ADR 0857 D4 (was ANLWF-12) — weekly rows accumulated forever (`navReport`
// reads 6). Counts-only aggregates hold no individual data ⇒ `internal`. A
// malformed week label carries no age, so it is never deleted on a guess.
registerRetentionPurger({
  feature: 'analytics-nav-counts',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'internal') return 0;
    const rows = (await counts.listByPrefix(`${tenantId}::`)).filter((r) => isoWeekEnd(r.week) !== undefined);
    return purgeRowsByAge('analytics-nav-counts', rows, tenantId, cutoffIso,
      (r) => ({ tenantId: r.tenantId, updatedAt: isoWeekEnd(r.week)!, id: navKeyOf(r.tenantId, r) }),
      (id) => counts.delete(id));
  },
});

export type RecordNavResult = 'recorded' | 'invalid' | 'capped';

/** Validate + aggregate one navigation. Invalid input is DROPPED, never stored. */
export async function recordNav(tenantId: string, route: unknown, source: unknown, now = new Date()): Promise<RecordNavResult> {
  if (typeof source !== 'string' || !SOURCE_SET.has(source)) return 'invalid';
  if (typeof route !== 'string' || !ROUTE_PATTERN.test(route)) return 'invalid';
  const week = isoWeek(now);
  const key = `${tenantId}::${week}::${source}::${route}`;
  const existing = await counts.get(key);
  if (!existing) {
    const weekRows = await counts.listByPrefix(`${tenantId}::${week}::`);
    if (weekRows.length >= DISTINCT_ROWS_CAP) return 'capped';
    await counts.put({ tenantId, week, source: source as NavSource, route, count: 1 });
    return 'recorded';
  }
  await counts.put({ ...existing, count: existing.count + 1 });
  return 'recorded';
}

export interface NavReportRow { route: string; source: NavSource; count: number }

/** Aggregate report over the last `weeks` ISO weeks (default 6). */
export async function navReport(tenantId: string, weeks = 6, now = new Date()): Promise<{ weeks: string[]; rows: NavReportRow[] }> {
  const labels: string[] = [];
  for (let i = 0; i < weeks; i++) {
    labels.push(isoWeek(new Date(now.getTime() - i * 7 * 86400000)));
  }
  const byKey = new Map<string, NavReportRow>();
  for (const week of labels) {
    for (const row of await counts.listByPrefix(`${tenantId}::${week}::`)) {
      const k = `${row.route}::${row.source}`;
      const agg = byKey.get(k);
      if (agg) agg.count += row.count;
      else byKey.set(k, { route: row.route, source: row.source, count: row.count });
    }
  }
  const rows = [...byKey.values()].sort((a, b) => b.count - a.count);
  return { weeks: labels, rows };
}
