/**
 * ADR 0951 P1 — heat-map aggregates: identifier-free cells.
 *
 * One row per (tenant, org, page, day, device, experiment arm) holding COUNTS only:
 * clicks per cell, a scroll-reach histogram, attention per section, a page-view
 * count and a separately counted bot tally. There is no session key, visitor hash,
 * subject, IP or user agent anywhere in the row — the beacon's `sessionKey` is read
 * only for the consent decision and the experiment-arm derivation, then dropped
 * (D1/D3; `test/adr0951-p1-heatmaps.test.ts` pins the field set, the exit
 * criterion). Because the rows name no person they are exempt from DSAR erasure
 * (ADR 0464 no-subject) and age out at 13 months (the CNIL audience-measurement
 * ceiling) on the ADR 0380 kv lane.
 *
 * Bounds (D3): a cell is a 2% square of the page (x, y as fractions of the
 * document) or a stable author-given element id; at most 500 cells per row, the
 * rest fold into `other`. At most 200 pages per org; a new page beyond that is
 * dropped and counted. Sections are capped at 100 per row. Increments are CAS'd,
 * so concurrent batches never lose counts silently (an exhausted retry is logged).
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('feature.analytics.heat');

export const GRID = 50; // 2% squares
export const MAX_CELLS_PER_ROW = 500;
export const MAX_SECTIONS_PER_ROW = 100;
export const MAX_PAGES_PER_ORG = 200;
export const SCROLL_BUCKETS = 21; // 0%, 5%, …, 100%
export const MAX_ATTENTION_MS = 30 * 60_000;
export const HEAT_RETENTION_DAYS = 396; // 13 months
export const OTHER_CELL = 'other';

export type DeviceClass = 'mobile' | 'tablet' | 'desktop';
export const DEVICE_CLASSES: readonly DeviceClass[] = ['mobile', 'tablet', 'desktop'];

/** A heat row. EVERY field is listed in `HEAT_ROW_FIELDS`; the schema test fails on
 *  any field that could identify a visitor. */
export interface HeatRow {
  tenantId: string;
  orgId: string;
  pageKey: string;
  /** Server-derived experiment arm (`experimentId/variant`), or `''` for none. */
  arm: string;
  device: DeviceClass;
  /** UTC day `YYYY-MM-DD`. */
  day: string;
  /** Start of `day` as ISO — the age-out timestamp. */
  dayStart: string;
  views: number;
  clicks: Record<string, number>;
  scroll: number[];
  attention: Record<string, { ms: number; views: number }>;
  bots: number;
  updatedAt: string;
}
export const HEAT_ROW_FIELDS: readonly (keyof HeatRow)[] = [
  'tenantId', 'orgId', 'pageKey', 'arm', 'device', 'day', 'dayStart', 'views', 'clicks', 'scroll', 'attention', 'bots', 'updatedAt',
];

/** The org's page index, for the page picker and the page cap. */
export interface HeatPage { tenantId: string; orgId: string; pageKey: string; firstSeen: string; lastSeen: string }

/** One atomic admission boundary for an org, replacing the legacy per-page index. */
interface HeatPageCatalog { tenantId: string; orgId: string; pages: HeatPage[]; lastSeen: string }
const catalogId = (p: { tenantId: string; orgId: string }): string => createHash('sha256').update(JSON.stringify([p.tenantId, p.orgId])).digest('hex');
const livePages = (items: readonly HeatPage[], nowIso: string): HeatPage[] => {
  const cutoff = Date.parse(nowIso) - HEAT_RETENTION_DAYS * 86_400_000;
  return items.filter((p) => Date.parse(p.lastSeen) > cutoff);
};

const pageHash = (pageKey: string): string => createHash('sha256').update(pageKey).digest('hex').slice(0, 24);
// Keyed tenant → org → page first, so a page's whole history is one prefix read
// (no tenant secondary index needed; the prefix IS the tenant slice).
const rowId = (r: Pick<HeatRow, 'tenantId' | 'orgId' | 'pageKey' | 'day' | 'device' | 'arm'>): string =>
  `${r.tenantId}:${r.orgId}:${pageHash(r.pageKey)}:${r.day}:${r.device}:${r.arm ? createHash('sha256').update(r.arm).digest('hex').slice(0, 16) : '-'}`;
const pageId = (p: Pick<HeatPage, 'tenantId' | 'orgId' | 'pageKey'>): string => `${p.tenantId}:${p.orgId}:${pageHash(p.pageKey)}`;

// `tenantOf` makes both stores reachable by ADR 0284 tenant teardown (the census in
// teardown-reachability-coverage). The kv age-out deletes through the collection,
// so the index markers go with the rows (`acceptIndexed`).
const rows = new DurableCollection<HeatRow>('analytics:heat', rowId, undefined, (r) => r.tenantId);
const pages = new DurableCollection<HeatPage>('analytics:heat-page', pageId, undefined, (p) => p.tenantId);
// Legacy rows are adopted on the first catalog CAS, then retained until their
// existing age-out. Over-cap legacy indexes remain readable without truncation.
const catalogs = new DurableCollection<HeatPageCatalog>('analytics:heat-catalog', catalogId, undefined, (p) => p.tenantId);

registerKvAgeOut({ id: 'analytics:heat', prefix: 'hostext:analytics:heat:', ttlDays: HEAT_RETENTION_DAYS, timestampField: 'dayStart', acceptIndexed: true });
registerKvAgeOut({ id: 'analytics:heat-page', prefix: 'hostext:analytics:heat-page:', ttlDays: HEAT_RETENTION_DAYS, timestampField: 'lastSeen', acceptIndexed: true });
registerKvAgeOut({ id: 'analytics:heat-catalog', prefix: 'hostext:analytics:heat-catalog:', ttlDays: HEAT_RETENTION_DAYS, timestampField: 'lastSeen', acceptIndexed: true });

// ───────────────────────── ingest shapes ────────────────────────────────────

export type HeatEvent =
  | { t: 'click'; cell: string }
  | { t: 'scroll'; depth: number }
  | { t: 'attn'; section: string; ms: number };

/** `g<x>.<y>` grid cell for fractional page coordinates, clamped. */
export function gridCell(x: number, y: number): string {
  const ix = Math.min(GRID - 1, Math.max(0, Math.floor(x * GRID)));
  const iy = Math.min(GRID - 1, Math.max(0, Math.floor(y * GRID)));
  return `g${ix}.${iy}`;
}

/** A stable, author-given element id (`data-owx-id` or `id`). Restricted to a
 *  markup-safe alphabet so free text can never become a cell key. */
export function selectorCell(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(s) ? `s:${s}` : null;
}

export function sectionKey(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(s) ? s : null;
}

function addCell(clicks: Record<string, number>, cell: string): void {
  if (cell in clicks || Object.keys(clicks).length < MAX_CELLS_PER_ROW) clicks[cell] = (clicks[cell] ?? 0) + 1;
  else clicks[OTHER_CELL] = (clicks[OTHER_CELL] ?? 0) + 1;
}

function apply(row: HeatRow, events: readonly HeatEvent[]): HeatRow {
  const next: HeatRow = { ...row, clicks: { ...row.clicks }, scroll: [...row.scroll], attention: { ...row.attention } };
  for (const e of events) {
    if (e.t === 'click') addCell(next.clicks, e.cell);
    else if (e.t === 'scroll') {
      // One scroll report per page view: it counts the view and every bucket reached.
      next.views += 1;
      const reached = Math.min(SCROLL_BUCKETS - 1, Math.max(0, Math.floor(e.depth * (SCROLL_BUCKETS - 1) + 1e-9)));
      for (let i = 0; i <= reached; i++) next.scroll[i] = (next.scroll[i] ?? 0) + 1;
    } else {
      const cur = Object.hasOwn(next.attention, e.section) ? next.attention[e.section] : undefined;
      if (cur || Object.keys(next.attention).length < MAX_SECTIONS_PER_ROW) {
        next.attention[e.section] = { ms: (cur?.ms ?? 0) + Math.min(MAX_ATTENTION_MS, Math.max(0, Math.round(e.ms))), views: (cur?.views ?? 0) + 1 };
      }
    }
  }
  return next;
}

export interface HeatRecordInput {
  tenantId: string; orgId: string; pageKey: string; arm: string; device: DeviceClass; now: Date;
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

/** Read legacy metadata only while this org has no canonical catalog. */
async function legacyPages(tenantId: string, orgId: string, nowIso: string): Promise<HeatPage[]> {
  return livePages((await pages.listByPrefix(`${tenantId}:${orgId}:`))
    .filter((p) => p.tenantId === tenantId && p.orgId === orgId), nowIso);
}

function catalogOf(tenantId: string, orgId: string, items: HeatPage[], emptyAt: string): HeatPageCatalog {
  return { tenantId, orgId, pages: items, lastSeen: items.reduce((last, p) => p.lastSeen > last ? p.lastSeen : last, items.length ? items[0]!.lastSeen : emptyAt) };
}

/** Admission and page metadata commit in ONE CAS across all host instances.
 * A count followed by inserting a separate page row cannot enforce an org cap.
 * Expired entries free their slots under that same CAS; no counter can drift.
 */
async function admitPage(tenantId: string, orgId: string, pageKey: string, nowIso: string): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await catalogs.get(catalogId({ tenantId, orgId }));
    if (cur && (cur.tenantId !== tenantId || cur.orgId !== orgId)) throw new Error('Heat catalog identity mismatch');
    const active = cur ? livePages(cur.pages, nowIso) : await legacyPages(tenantId, orgId, nowIso);
    const existing = active.find((p) => p.pageKey === pageKey);
    // Historical over-cap metadata is preserved, never silently truncated. It
    // admits no new page until retention frees enough space for a bounded catalog.
    if (!cur && active.length > MAX_PAGES_PER_ORG) {
      if (!existing) return false;
      const next = { ...existing, lastSeen: nowIso > existing.lastSeen ? nowIso : existing.lastSeen };
      if (next.lastSeen === existing.lastSeen || await pages.compareAndSwap(existing, next)) return true;
      continue;
    }
    if (!existing && active.length >= MAX_PAGES_PER_ORG) {
      log.warn('heat_page_cap_reached', { tenantId, orgId, cap: MAX_PAGES_PER_ORG });
      return false;
    }
    const lastSeen = existing && existing.lastSeen > nowIso ? existing.lastSeen : nowIso;
    if (cur && existing && existing.lastSeen.slice(0, 10) === lastSeen.slice(0, 10) && active.length === cur.pages.length) return true;
    const nextPages = existing
      ? active.map((p) => p.pageKey === pageKey ? { ...p, lastSeen } : p)
      : [...active, { tenantId, orgId, pageKey, firstSeen: nowIso, lastSeen: nowIso }];
    if (await catalogs.compareAndSwap(cur, catalogOf(tenantId, orgId, nextPages, nowIso))) return true;
  }
  log.warn('heat_page_admission_contended', { tenantId, orgId });
  return false;
}

function emptyRow(input: HeatRecordInput): HeatRow {
  const day = dayOf(input.now);
  return {
    tenantId: input.tenantId, orgId: input.orgId, pageKey: input.pageKey, arm: input.arm, device: input.device,
    day, dayStart: `${day}T00:00:00.000Z`, views: 0, clicks: {}, scroll: new Array<number>(SCROLL_BUCKETS).fill(0), attention: {}, bots: 0,
    updatedAt: input.now.toISOString(),
  };
}

async function casUpdate(input: HeatRecordInput, mutate: (r: HeatRow) => HeatRow, createIfAbsent: boolean): Promise<'ok' | 'absent' | 'contended'> {
  const id = rowId({ ...input, day: dayOf(input.now) });
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await rows.get(id);
    if (!cur && !createIfAbsent) return 'absent';
    const next = { ...mutate(cur ?? emptyRow(input)), updatedAt: input.now.toISOString() };
    if (await rows.compareAndSwap(cur, next)) return 'ok';
  }
  log.warn('heat_increment_contended', { tenantId: input.tenantId, orgId: input.orgId });
  return 'contended';
}

/** Fold one consented, non-bot batch into its row. Returns false when the page was
 *  refused by the org page cap or the increment could not land. */
export async function recordHeat(input: HeatRecordInput, events: readonly HeatEvent[]): Promise<boolean> {
  if (events.length === 0) return true;
  if (!(await admitPage(input.tenantId, input.orgId, input.pageKey, input.now.toISOString()))) return false;
  return (await casUpdate(input, (r) => apply(r, events), true)) === 'ok';
}

/** D2 — bots and automation are excluded from the aggregates and counted
 *  separately, on a page that already has human data (bot traffic never creates
 *  a page, so it cannot fill the org's page cap). */
async function knownLegacyPage(input: HeatRecordInput, nowIso: string): Promise<boolean> {
  const row = await pages.get(pageId(input));
  return !!row && row.tenantId === input.tenantId && row.orgId === input.orgId && row.pageKey === input.pageKey && livePages([row], nowIso).length === 1;
}

export async function countBotBatch(input: HeatRecordInput): Promise<void> {
  const nowIso = input.now.toISOString();
  const catalog = await catalogs.get(catalogId(input));
  const known = catalog
    ? catalog.tenantId === input.tenantId && catalog.orgId === input.orgId && livePages(catalog.pages, nowIso).some((p) => p.pageKey === input.pageKey)
    : await knownLegacyPage(input, nowIso);
  if (!known) return;
  await casUpdate(input, (r) => ({ ...r, bots: r.bots + 1 }), true);
}

// ───────────────────────── reads ────────────────────────────────────────────

export async function listHeatPages(tenantId: string, orgId: string): Promise<HeatPage[]> {
  const nowIso = new Date().toISOString();
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await catalogs.get(catalogId({ tenantId, orgId }));
    if (cur && (cur.tenantId !== tenantId || cur.orgId !== orgId)) throw new Error('Heat catalog identity mismatch');
    const active = cur ? livePages(cur.pages, nowIso) : await legacyPages(tenantId, orgId, nowIso);
    if (!cur && active.length > MAX_PAGES_PER_ORG) return active.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    if (!cur || active.length !== cur.pages.length) {
      if (!(await catalogs.compareAndSwap(cur, catalogOf(tenantId, orgId, active, cur?.lastSeen ?? nowIso)))) continue;
    }
    return active.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }
  throw new Error('Heat page catalog is contended');
}

/** Q5 (decided as proposed) — an experiment arm with fewer page views than this is
 *  not shown as its own heat map (k-anonymity on small cells). */
export const MIN_ARM_VIEWS = 30;

export interface HeatmapView {
  pageKey: string;
  device: DeviceClass | 'all';
  days: number;
  views: number;
  bots: number;
  clicks: Array<{ cell: string; count: number }>;
  totalClicks: number;
  /** Share of page views that reached each 5% depth step (index 0 = 0%). */
  scrollReach: number[];
  attention: Array<{ section: string; avgMs: number; views: number }>;
  arms: Array<{ arm: string; views: number; suppressed: boolean }>;
}

/** Aggregate a page's rows over the window (and device), optionally for one arm.
 *  An arm under MIN_ARM_VIEWS is reported as suppressed and its cells are NOT
 *  returned on their own (they stay inside the page-wide totals). */
export async function readHeatmap(input: {
  tenantId: string; orgId: string; pageKey: string; device: DeviceClass | 'all'; days: number; arm?: string; now?: Date;
}): Promise<HeatmapView> {
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - (input.days - 1) * 86_400_000).toISOString().slice(0, 10);
  const all = (await rows.listByPrefix(`${input.tenantId}:${input.orgId}:${pageHash(input.pageKey)}:`))
    .filter((r) => r.tenantId === input.tenantId && r.orgId === input.orgId && r.pageKey === input.pageKey && r.day >= since)
    .filter((r) => input.device === 'all' || r.device === input.device);
  const armViews = new Map<string, number>();
  for (const r of all) if (r.arm) armViews.set(r.arm, (armViews.get(r.arm) ?? 0) + r.views);
  const arms = [...armViews].map(([arm, views]) => ({ arm, views, suppressed: views < MIN_ARM_VIEWS })).sort((a, b) => a.arm.localeCompare(b.arm));
  const wantArm = input.arm || undefined; // '' is "no arm filter", the same as absent
  const armOk = wantArm === undefined || arms.some((a) => a.arm === wantArm && !a.suppressed);
  const selected = wantArm === undefined ? all : (armOk ? all.filter((r) => r.arm === wantArm) : []);
  const clicks = new Map<string, number>();
  const scroll = new Array<number>(SCROLL_BUCKETS).fill(0);
  const attention = new Map<string, { ms: number; views: number }>();
  let views = 0; let bots = 0;
  for (const r of selected) {
    views += r.views; bots += r.bots;
    for (const [c, n] of Object.entries(r.clicks)) clicks.set(c, (clicks.get(c) ?? 0) + n);
    r.scroll.forEach((n, i) => { scroll[i] = (scroll[i] ?? 0) + n; });
    for (const [s, a] of Object.entries(r.attention)) {
      const cur = attention.get(s) ?? { ms: 0, views: 0 };
      attention.set(s, { ms: cur.ms + a.ms, views: cur.views + a.views });
    }
  }
  const sortedClicks = [...clicks].map(([cell, count]) => ({ cell, count })).sort((a, b) => b.count - a.count).slice(0, MAX_CELLS_PER_ROW);
  return {
    pageKey: input.pageKey,
    device: input.device,
    days: input.days,
    views,
    bots,
    clicks: sortedClicks,
    totalClicks: [...clicks.values()].reduce((a, b) => a + b, 0),
    scrollReach: scroll.map((n) => (views > 0 ? n / views : 0)),
    attention: [...attention].map(([section, a]) => ({ section, avgMs: a.views > 0 ? Math.round(a.ms / a.views) : 0, views: a.views })).sort((a, b) => b.avgMs - a.avgMs),
    arms,
  };
}

/** Test-only. */
export async function __resetHeatStoreForTests(): Promise<void> {
  await rows.__clear();
  await pages.__clear();
  await catalogs.__clear();
}
/** Test-only: the raw stored rows (the schema test reads them). */
export async function __listHeatRowsForTests(): Promise<HeatRow[]> { return rows.list(); }
