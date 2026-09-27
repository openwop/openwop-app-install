/**
 * Analytics service (host-extension, ADR 0018) — the MEASURE leg. An APPEND-ONLY
 * event store fed by a public beacon + read-time aggregates. Does NOT re-implement
 * A/B — the host toggle/variant engine owns experiments; Analytics only reports.
 * The beacon is consent-gated through `consentService.isAllowed` (ADR 0020) — which is
 * PERMISSIVE when the `consent` feature is off, the default (ADR 0651 D4) — the
 * one consent rule, never a second copy.
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerRetentionPurger, purgeRowsByAge } from '../../host/retentionPurger.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { linkSession } from './identityLinkService.js';
import { resolveExperimentStamp, type ExperimentStampDropReason } from './experimentStampResolver.js';
import { createLogger } from '../../observability/logger.js';

// ANL-11 (grade-code 2026-09-10) — this feature had ZERO log calls; a public write
// endpoint whose refusals are invisible cannot be operated.
const log = createLogger('analytics');
// Cross-feature READ (the documented precedent): resolve the opaque email-click
// token through its owning service (ADR 0226) — never a direct store read.
import { claimClickTokenForSession } from '../email/engagementService.js';

/** ANL-12 — everything from the first `?` or `#` on is dropped (a referrer's
 *  query can carry the referring site's session/email; ours can carry `owx`). */
function stripQueryAndFragment(v: string | undefined): string | undefined {
  if (!v) return v;
  const cut = v.search(/[?#]/);
  return cut === -1 ? v : v.slice(0, cut) || undefined;
}

export type EventType = 'pageview' | 'event' | 'conversion';
const EVENT_TYPES: readonly EventType[] = ['pageview', 'event', 'conversion'];

export interface Utm { source?: string; medium?: string; campaign?: string; term?: string; content?: string }
export interface ClickIds { fbclid?: string; gclid?: string; ttclid?: string; li_fat_id?: string }

export interface AnalyticsEvent {
  eventId: string;
  tenantId: string;
  orgId: string;
  type: EventType;
  path?: string;
  name?: string;
  ts: string;
  sessionKey?: string;
  referrer?: string;
  utm?: Utm;
  clickIds?: ClickIds;
  /** ADR 0226: the opaque email-click token echoed by the destination page's
   *  beacon — an id-less server-side token, never an address or contact id. */
  owx?: string;
  /** ADR 0236 (D1): the page-experiment assignment the public read stamped on
   *  the renderer — an experiment id + variant key, ADDITIVE (the `owx`
   *  precedent). Only present on events from an assigned, consented visitor. */
  experiment?: {
    id: string; variant: string;
    /** ADR 0651 D3 / ANL-18 — `true` iff the variant was RE-DERIVED at ingest from
     *  the owner's deterministic assignment. Absent on pre-D3 rows, which carry
     *  the client's claim verbatim and are NOT counted by the results projection. */
    derived?: true;
  };
  /** ADR 0651 D3 / ANL-21 — a stamp the beacon requested and ingest REFUSED. The
   *  `id` is present only when the experiment is known to this tenant+org (never
   *  the client's string), so the results projection can count its own drops. */
  experimentDropped?: { reason: ExperimentStampDropReason; id?: string };
  /** ADR 0569 — the cookieless daily-rotating visitor hash, computed AT INGEST
   *  (`visitorIdentity.ts`); the raw IP/UA are never persisted. Absent on
   *  pre-deployment rows and when the tenant's `analytics-visitor-identity`
   *  toggle is off. Cross-day linking is impossible by construction (the salt
   *  rotates daily and is discarded). */
  visitorHash?: string;
  props?: Record<string, string | number | boolean>;
}

const MAX_STR = 1024;
const MAX_PROPS_CHARS = 4096;
// GOV-1: `tenantOf` arms the tenant secondary index (bounded retention-purge scan).
const events = new DurableCollection<AnalyticsEvent>('analytics:event', (e) => e.eventId, undefined, (e) => e.tenantId);

/**
 * ANL-3 (ADR 0077 P1) — the analytics row's PII fields, declared to the
 * classification registry. `features/analytics` called `declarePiiFields` ZERO
 * times before this, so `classificationOf('analytics.event')` read plain
 * `internal` over a row carrying cross-site advertising identifiers — while the
 * retention purger already classified the same store `confidential-pii`.
 *
 * SPLIT INTO TWO CALLS ON PURPOSE (the CSM `maskGloballyByFieldName` lesson).
 * The default joins each NAME to an ENTITY-AGNOSTIC union that drives app-wide
 * log masking off the leaf key alone. `visitorHash` / `clickIds` / `owx` are
 * distinctive, so masking them anywhere they appear is right. `path`,
 * `referrer`, `props` and `sessionKey` are NOT: MEASURED on this tree, `path` is
 * a live operational log key in at least four places — `byok/encryption.ts:85`
 * logs the master-key FILE path, and `routes/mcp.ts:70,96` + `chat-widget/
 * publicGateway.ts:62` log `req.path` as a security/enumeration signal.
 * Declaring it globally would rewrite all of those to `pii_<sha>` and make the
 * logs actively misleading. TRADE-OFF, stated: a value logged under a bare
 * `path`/`referrer`/`props`/`sessionKey` key is then not masked for THIS entity
 * either — accepted because `features/analytics` emits no logs at all, and
 * entity-aware callers (`isPiiField`, `maskRecordForRead`, erasure, exports,
 * retention) are unaffected either way.
 */
declarePiiFields('analytics.event', ['visitorHash', 'clickIds', 'owx']);
declarePiiFields('analytics.event', ['path', 'referrer', 'props', 'sessionKey'], { maskGloballyByFieldName: false });

const cap = (v: unknown): string | undefined => (typeof v === 'string' && v ? v.slice(0, MAX_STR) : undefined);

function pick<T extends string>(v: unknown, keys: readonly T[]): Partial<Record<T, string>> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: Partial<Record<T, string>> = {};
  for (const k of keys) { const s = cap(o[k]); if (s) out[k] = s; }
  return Object.keys(out).length > 0 ? out : undefined;
}

function pickProps(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  if (JSON.stringify(v).length > MAX_PROPS_CHARS) throw new OpenwopError('validation_error', '`props` too large.', 413, {});
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === 'string') out[k] = val.slice(0, MAX_STR);
    else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    else if (typeof val === 'boolean') out[k] = val;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Record one event (APPEND-ONLY); eventId/tenantId/orgId/ts are server-set.
 *  `visitorHash` (ADR 0569) is SERVER-computed by the collect route — never
 *  read from the client body (a client-supplied hash could inflate uniques). */
export async function recordEvent(input: { tenantId: string; orgId: string; raw: Record<string, unknown>; visitorHash?: string }): Promise<AnalyticsEvent> {
  const r = input.raw;
  const e: AnalyticsEvent = {
    eventId: `evt:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    type: EVENT_TYPES.includes(r.type as EventType) ? (r.type as EventType) : 'event',
    ts: new Date().toISOString(),
  };
  if (input.visitorHash) e.visitorHash = input.visitorHash;
  // ANL-12 — the query string / fragment is where tokens, emails and ids ride;
  // the pathname is the analytic unit. Stripped at ingest, never stored.
  const path = stripQueryAndFragment(cap(r.path)); if (path) e.path = path;
  const name = cap(r.name); if (name) e.name = name;
  const sessionKey = cap(r.sessionKey); if (sessionKey) e.sessionKey = sessionKey;
  const referrer = stripQueryAndFragment(cap(r.referrer)); if (referrer) e.referrer = referrer;
  const utm = pick(r.utm, ['source', 'medium', 'campaign', 'term', 'content'] as const); if (utm) e.utm = utm;
  const clickIds = pick(r.clickIds, ['fbclid', 'gclid', 'ttclid', 'li_fat_id'] as const); if (clickIds) e.clickIds = clickIds;
  const owx = cap(r.owx); if (owx) e.owx = owx;
  // ADR 0236 (D1) — optional bounded experiment stamp {id, variant}; both parts
  // must be present + non-empty strings or the field is dropped whole.
  // ANLWF-3 / ADR 0651 D3 — the stamp is RE-DERIVED, never trusted. This used to
  // accept `{id, variant}` verbatim (caps + both-or-neither were the whole check),
  // and `experimentResults` computed a significance verdict from it — so any
  // anonymous caller could place conversions on a variant no visitor was ever
  // assigned. Only the client's `id` is read; the variant is the deterministic
  // assignment for THIS session, resolved by the cms-registered seam. Unknown,
  // not-running, wrong-org, or no resolver ⇒ the stamp is dropped (the EVENT is
  // still recorded — capture-before-effect).
  if (r.experiment && typeof r.experiment === 'object') {
    const id = cap((r.experiment as Record<string, unknown>).id);
    if (id) {
      const outcome = await resolveExperimentStamp(input.tenantId, input.orgId, id.slice(0, 128), e.sessionKey ?? '');
      if (outcome.ok) e.experiment = { id: outcome.id, variant: outcome.variant, derived: true };
      else e.experimentDropped = outcome.id ? { reason: outcome.reason, id: outcome.id } : { reason: outcome.reason };
    }
  }
  const props = pickProps(r.props); if (props) e.props = props;
  await events.put(e);
  // D4 (ADR 0226): when the beacon carries an `owx` email-click token AND a
  // session, resolve it and write the deterministic session↔contact link.
  // BEST-EFFORT — never fails (or delays the semantics of) the beacon write;
  // the tenant on the token MUST match the beacon's tenant (no cross-tenant
  // linking from a leaked/replayed token).
  if (owx && e.sessionKey) {
    try {
      // ANLWF-1 / ADR 0651 D1 — the token is CLAIMED by the first session that links
      // through it; a later session presenting the same token gets no link. Before
      // this, `resolveClickToken` bound the token to nothing but tenant+contact,
      // never expired it and never consumed it, and `sessionKey` is caller-chosen —
      // so a forwarded newsletter's token plus ANY session key durably linked that
      // session to the original recipient's contact, and the ADR 0381 DSAR resolver
      // then expanded the recipient's erasure to a stranger's history. The
      // cross-tenant guard below was read as protection; the same-tenant forge
      // was the hole. The event itself still lands (capture-before-effect).
      const resolved = await claimClickTokenForSession(owx, e.sessionKey);
      if (resolved && resolved.tenantId === input.tenantId) {
        await linkSession(input.tenantId, e.sessionKey, resolved.contactId, 'email-click');
      } else {
        // ANL-11 — a refused/unknown/foreign-tenant token is the abuse signal this
        // lane produces; it used to vanish. No token or session in the log line.
        log.info('analytics_click_token_unlinked', { tenantId: input.tenantId, orgId: input.orgId, reason: resolved ? 'foreign_tenant' : 'unclaimable' });
      }
    } catch { /* best-effort — the event row is already durable */ }
  }
  return e;
}

/** Every event stamped for one experiment (ADR 0236 D1) — the cross-feature
 *  READ the CMS results projection goes through (the resolveClickToken
 *  precedent: through the owning service, never a direct store read).
 *  Tenant+org-scoped; bounded only by the analytics retention purger. */
export async function listEventsForExperiment(tenantId: string, orgId: string, experimentId: string): Promise<AnalyticsEvent[]> {
  // Tenant-INDEXED (EXP-1): the armed secondary index bounds the scan to this
  // tenant's rows instead of a full cross-tenant `events.list()`.
  const all = await events.listForTenantIndexed(tenantId);
  // ANL-18 — dropped-stamp rows for this experiment ride along so the results
  // projection can COUNT what it refused (it never attributes them).
  return all.filter((e) => e.orgId === orgId && (e.experiment?.id === experimentId || e.experimentDropped?.id === experimentId));
}

/** Every `conversion` event for a tenant+org — UNCAPPED (bounded only by the
 *  retention purger), unlike `listEvents`' recency slice. The C5 attribution
 *  join MUST see all conversions: a `listEvents(…, 5000)` window is consumed by
 *  high-volume pageviews on a real-traffic tenant, silently dropping older
 *  conversions and undercounting attribution (grade-code AUDIT-1). Same
 *  through-the-service read as `listEventsForExperiment`. */
export async function listConversions(tenantId: string, orgId: string): Promise<AnalyticsEvent[]> {
  // Tenant-INDEXED (EXP-1): the armed secondary index bounds the scan to this
  // tenant instead of a full cross-tenant `events.list()`.
  const all = await events.listForTenantIndexed(tenantId);
  return all.filter((e) => e.orgId === orgId && e.type === 'conversion');
}

/** UX_UPGRADE-analytics AN-G1 — the reporting window, as an ISO lower bound.
 *  `undefined` means all time, which is what both reads did unconditionally. */
export function sinceIsoForDays(days: number | undefined): string | undefined {
  if (days === undefined || !Number.isFinite(days) || days <= 0) return undefined;
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export async function listEvents(tenantId: string, orgId: string, limit = 100, sinceIso?: string): Promise<AnalyticsEvent[]> {
  // R2 AN-SP-4 — the INDEXED tenant slice (used 3× elsewhere in this file);
  // the bare list() was a full cross-tenant scan.
  const all = await events.listForTenantIndexed(tenantId);
  return all
    // R2 AN-SP-6 — web-vital telemetry rows are excluded from `total` (they
    // are TELEMETRY, not business events); the stream must agree with the
    // figures it sits under, so exclude them here too.
    .filter((e) => e.orgId === orgId && (!sinceIso || e.ts >= sinceIso) && !(e.type === 'event' && e.name === 'web-vital'))
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, limit);
}

export interface AnalyticsSummary {
  total: number;
  byType: Record<EventType, number>;
  /** ANL-UX-15 — omitted when no business row in the window carried a sessionKey. */
  sessions?: number;
  /** ADR 0569 — "daily uniques (cookieless)": distinct visitor hashes per UTC
   *  day, SUMMED across the window's days (the Plausible definition — a 7-day
   *  figure is the sum of daily uniques, and the UI says so).
   *
   *  THREE states, and the difference between the last two is the point
   *  (ANL-UX-3 R2): `> 0` measured; `0` measured zero — the dimension existed
   *  for the whole window and nobody visited; ABSENT — the dimension did not
   *  exist across this window (pre-deployment history, or the
   *  `analytics-visitor-identity` opt-out), so no number is claimed at all.
   *  Only `summarizeForReport` can tell `0` from absent, because only it holds
   *  the org's history; `computeSummary` alone can never emit `0`. */
  uniqueVisitors?: number;
  /** When the visitor dimension began for this ORG — deployment-scoped, not
   *  window-scoped, so it does not move when the user changes the picker
   *  (ADR 0569 §5). Set ONLY by `summarizeForReport`. */
  uniqueVisitorsSince?: string;
  topPaths: { path: string; count: number }[];
  /** ANL-UX-10 — distinct counts before the top-10 cut. */
  topPathsTotal?: number;
  utmSourcesTotal?: number;
  utmSources: { source: string; count: number }[];
  /** ADR 0018 CWV fold-in — real-user Core Web Vitals, the p75 per metric over
   *  client-measured (approximate) samples. Absent when no `web-vital` events. */
  vitals?: { metric: string; p75: number; rating: VitalRating; count: number }[];
}

export type VitalRating = 'good' | 'needs-improvement' | 'poor';

/** web.dev "good / needs-improvement" thresholds; a value at-or-below the first
 *  is good, at-or-below the second is needs-improvement, else poor. CLS is
 *  unitless ×1000-free; the rest are milliseconds. */
const VITAL_THRESHOLDS: Record<string, [number, number]> = {
  LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25], TTFB: [800, 1800], FCP: [1800, 3000],
};
function rateVital(metric: string, value: number): VitalRating {
  const t = VITAL_THRESHOLDS[metric];
  if (!t) return 'needs-improvement';
  return value <= t[0] ? 'good' : value <= t[1] ? 'needs-improvement' : 'poor';
}
/** Nearest-rank 75th percentile (web.dev RUM convention — no interpolation). */
function p75(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(0.75 * s.length) - 1)] ?? 0;
}

/** ADR 0569 — daily uniques over a row set: distinct visitor hashes per UTC
 *  day, summed. PURE (mechanism tested apart from route wiring — the ADR 0502
 *  lesson). Rows without a hash contribute nothing; a hash seen on two days
 *  counts twice BY DESIGN (cross-day identity does not exist — the daily salt
 *  rotation makes same-visitor-two-days indistinguishable from two visitors,
 *  so summing is the only honest definition). */
export function countDailyUniques(rows: readonly Pick<AnalyticsEvent, 'ts' | 'visitorHash'>[]): { uniques: number; since?: string } {
  const perDay = new Set<string>();
  let since: string | undefined;
  for (const r of rows) {
    if (!r.visitorHash) continue;
    perDay.add(`${r.ts.slice(0, 10)}|${r.visitorHash}`);
    if (!since || r.ts < since) since = r.ts;
  }
  return { uniques: perDay.size, ...(since ? { since } : {}) };
}

/** R2 AN-R2-1 — the trend aggregate behind the table-stakes chart: per-UTC-day
 *  counts over the window (web-vital telemetry excluded, matching `total`).
 *
 *  `ANL-UX-5` — BUCKETS AND FILTER NOW AGREE. The buckets have always been
 *  CALENDAR UTC days, but the row filter used a ROLLING-INSTANT cutoff
 *  (`now − N×86 400 000`), so rows on the oldest partially-covered UTC day
 *  passed the filter and were then SILENTLY DROPPED by the `if (!p) continue`
 *  below — a bucket the chart drew as a real day while discarding part of it.
 *  The cutoff is now the START of the oldest seeded UTC day, so every row that
 *  passes lands in a bucket and nothing is discarded.
 *
 *  The right edge is a DIFFERENT fact and is not "fixed", it is DISCLOSED:
 *  today's bucket is inherently partial (the day is still running), which is
 *  why the last point carries `partial: true` and the UI says so instead of
 *  drawing a dip that looks like a collapse in traffic.
 *
 *  STATED, because the numbers still differ: this window is CALENDAR-aligned
 *  while the key figures above the chart use the summary's ROLLING window, so
 *  the trend's sum and the Pageviews figure are answers to two different
 *  questions and will not match. The copy names both rather than implying one
 *  number (`trendSrSummary` / `trendPartialNote`). */
/** `uniques` (ADR 0569) — distinct visitor hashes that UTC day; 0 when the
 *  day's rows carry no hash (pre-deployment, or the opt-out). Additive.
 *  `partial` — the bucket does not cover a whole UTC day yet (today). */
export interface TrendPoint { day: string; pageviews: number; events: number; conversions: number; uniques: number; partial?: boolean }
export async function trendForDays(tenantId: string, orgId: string, days: number): Promise<TrendPoint[]> {
  const byDay = new Map<string, TrendPoint>();
  const today = new Date(Date.now()).toISOString().slice(0, 10);
  // Seed every day in the window so quiet days render as ZERO, not a gap the
  // chart silently skips (a missing point reads as "no data collected").
  for (let i = 0; i < days; i += 1) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    byDay.set(day, { day, pageviews: 0, events: 0, conversions: 0, uniques: 0, ...(day === today ? { partial: true } : {}) });
  }
  // ANL-UX-5 — the CALENDAR cutoff that matches the seeded buckets, not a
  // rolling instant. `YYYY-MM-DDT00:00:00.000Z` compares correctly against the
  // ISO `ts` lexicographically, like every other read in this file.
  const oldestDay = [...byDay.keys()].sort()[0]!;
  const since = `${oldestDay}T00:00:00.000Z`;
  const rows = (await events.listForTenantIndexed(tenantId)).filter((e) =>
    e.orgId === orgId && e.ts >= since && !(e.type === 'event' && e.name === 'web-vital'));
  const seenHashes = new Set<string>(); // day|hash — per-day distinct (ADR 0569)
  for (const e of rows) {
    const day = e.ts.slice(0, 10);
    const p = byDay.get(day);
    if (!p) continue; // a future-dated row (clock skew) — never a windowed one now
    if (e.type === 'pageview') p.pageviews += 1;
    else if (e.type === 'conversion') p.conversions += 1;
    else p.events += 1;
    if (e.visitorHash && !seenHashes.has(`${day}|${e.visitorHash}`)) {
      seenHashes.add(`${day}|${e.visitorHash}`);
      p.uniques += 1;
    }
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Facts about an org's WHOLE recorded history — deliberately NOT window-scoped,
 * because both of these answer questions the window cannot.
 *
 * `ANL-UX-2` — `firstEventAt` is the only honest "has this beacon ever recorded
 * anything" signal. Nothing on the wire carried one, so the page asserted "The
 * beacon is connected — this window is just quiet" from `summary.total === 0`
 * alone. That is false in at least three reachable states: the snippet was
 * never embedded; every visitor declined consent (the beacon 202s and stores
 * nothing); and all traffic was `web-vital` telemetry, which `total` excludes.
 * This field counts EVERY row including web-vitals, precisely so the third case
 * reads as "connected" rather than "never installed".
 *
 * `ANL-UX-4` — `uniqueVisitorsSince` is the date ADR 0569 §5 requires the UI to
 * name ("uniques begin at deployment"). `computeSummary` derives it from rows
 * ALREADY filtered to the window, so on a 7-day view it always read "began ~8
 * days ago" and MOVED every time the user changed the picker — the opposite of
 * what the ADR asks. Computed here over the org's full history instead, so the
 * disclosure names a fixed date.
 */
export interface OrgLifetimeFacts {
  /** Earliest recorded event of ANY type for this org, web-vitals included.
   *  Absent ⇒ this org has never recorded a single beacon hit. */
  firstEventAt?: string;
  /** Earliest event carrying a `visitorHash` — when the visitor dimension began
   *  for this org. Absent ⇒ no hashed row has ever been recorded. */
  uniqueVisitorsSince?: string;
}

function lifetimeFactsOf(orgRows: readonly AnalyticsEvent[]): OrgLifetimeFacts {
  let firstEventAt: string | undefined;
  let firstHashedAt: string | undefined;
  for (const e of orgRows) {
    if (!firstEventAt || e.ts < firstEventAt) firstEventAt = e.ts;
    if (e.visitorHash && (!firstHashedAt || e.ts < firstHashedAt)) firstHashedAt = e.ts;
  }
  return { ...(firstEventAt ? { firstEventAt } : {}), ...(firstHashedAt ? { uniqueVisitorsSince: firstHashedAt } : {}) };
}

/**
 * The whole summary route in ONE indexed read: the window's summary, the AN-G3
 * prior window (windowed views only), and the org's lifetime facts. Replaces
 * the route's separate `summarize` / `summarizeWithPrior` calls so adding the
 * ANL-UX-2/4 signals costs no extra scan.
 */
export async function summarizeForReport(
  tenantId: string,
  orgId: string,
  days?: number,
): Promise<{ summary: AnalyticsSummary; current: AnalyticsSummary; prior?: AnalyticsSummary; lifetime: OrgLifetimeFacts }> {
  const orgRows = (await events.listForTenantIndexed(tenantId)).filter((e) => e.orgId === orgId);
  const lifetime = lifetimeFactsOf(orgRows);
  // ANL-UX-3 R2 — see `withVisitorDimension`. Resolved ONCE per report and
  // fail-CLOSED: if the toggle read throws we treat the dimension as inactive,
  // which yields ABSENT — the conservative answer. Claiming a measured zero we
  // cannot back would be the same defect in a new place.
  const visitorDimensionActive = await resolveOne('analytics-visitor-identity', { tenantId })
    .then((t) => t?.enabled === true)
    .catch(() => false);
  /**
   * Attach the visitor dimension's DEPLOYMENT-scoped facts to a windowed
   * summary. Two things, both of which the window alone gets wrong:
   *
   * ANL-UX-4 — the disclosure date is deployment-scoped, never window-scoped
   * (`computeSummary` no longer produces one at all).
   *
   * ANL-UX-3 R2 — "measured zero" was UNREACHABLE on the wire. `computeSummary`
   * emits `uniqueVisitors` only when `uniques > 0`, so a window in which the
   * dimension was live and nobody visited looked IDENTICAL to a window in which
   * the dimension did not exist — and a tenant going 0 → N therefore got no
   * delta, because the client (correctly) refuses to invent one from an absent
   * prior. A `0` is only emitted where it is a MEASUREMENT, which needs both:
   *   - the dimension was already recording before this window opened
   *     (`uniqueVisitorsSince <= windowStart`), and
   *   - it is still switched on (`analytics-visitor-identity`) — otherwise the
   *     window is UNMEASURED, and "0 visitors" would be the absence-as-a-claim
   *     defect wearing a number.
   * Otherwise the field stays absent, which is the honest "no measurement here".
   * `windowStartIso` is `''` for all-time, which nothing can precede —
   * correctly, since "before the org's first event" is not a period in which
   * the dimension existed.
   *
   * Known residual, stated rather than papered over: a toggle flipped OFF and
   * back ON inside the window reads as active throughout, so its dark stretch
   * is folded into the measured zero. Nothing in the row data records a toggle
   * flip, so this is the limit of what can be told without a new signal.
   */
  const withVisitorDimension = (s: AnalyticsSummary, windowStartIso: string): AnalyticsSummary => {
    const since = lifetime.uniqueVisitorsSince;
    if (!since) return s;
    if (s.uniqueVisitors !== undefined) return { ...s, uniqueVisitorsSince: since };
    return visitorDimensionActive && since <= windowStartIso
      ? { ...s, uniqueVisitors: 0, uniqueVisitorsSince: since }
      : s;
  };
  if (days === undefined) {
    const summary = withVisitorDimension(computeSummary(orgRows), '');
    return { summary, current: summary, lifetime };
  }
  const since = sinceIsoForDays(days)!;
  const priorSince = sinceIsoForDays(days * 2)!;
  const rows = orgRows.filter((e) => e.ts >= priorSince);
  const current = withVisitorDimension(computeSummary(rows.filter((e) => e.ts >= since)), since);
  // The prior window gets the SAME treatment against ITS OWN start — otherwise
  // the 0 → N delta this fix exists for is still unavailable, because the prior
  // side is the one that is zero.
  const prior = withVisitorDimension(computeSummary(rows.filter((e) => e.ts < since)), priorSince);
  return { summary: current, current, prior, lifetime };
}

export async function summarize(tenantId: string, orgId: string, sinceIso?: string, untilIso?: string): Promise<AnalyticsSummary> {
  // `ts` is an ISO string, so a lexicographic `>=` is a correct instant compare
  // — no parsing per row on what is already a full-table scan. `untilIso`
  // (exclusive) exists for the AN-G3 prior-period aggregate; the primary
  // window never passes it.
  // R2 AN-SP-4 — indexed tenant slice, not a cross-tenant scan.
  const all = (await events.listForTenantIndexed(tenantId)).filter((e) => e.orgId === orgId && (!sinceIso || e.ts >= sinceIso) && (!untilIso || e.ts < untilIso));
  return computeSummary(all);
}

function computeSummary(all: AnalyticsEvent[]): AnalyticsSummary {
  const byType: Record<EventType, number> = { pageview: 0, event: 0, conversion: 0 };
  const paths = new Map<string, number>();
  const sources = new Map<string, number>();
  const sessions = new Set<string>();
  let keyedRows = 0;
  const vitalSamples = new Map<string, number[]>(); // metric → client-measured values
  let webVitalCount = 0;
  for (const e of all) {
    // CWV fold-in: a web-vital rides `type:'event'`, `name:'web-vital'`, props
    // { metric, value } (rating derived here from p75, never ingested). It is
    // TELEMETRY, not a business event — do NOT inflate byType/sessions/topPaths.
    // The public beacon is unauthenticated, so ALLOWLIST the metric name (an open
    // namespace would let a client inflate `vitals[]` with junk keys) and CLAMP the
    // client-measured value (nearest-rank p75 resists outliers, but bound anyway).
    if (e.type === 'event' && e.name === 'web-vital') {
      webVitalCount += 1;
      const metric = e.props?.metric; const value = e.props?.value;
      if (typeof metric === 'string' && Object.prototype.hasOwnProperty.call(VITAL_THRESHOLDS, metric) && typeof value === 'number' && Number.isFinite(value)) {
        const clamped = Math.max(0, Math.min(metric === 'CLS' ? 100 : 900_000, value));
        (vitalSamples.get(metric) ?? vitalSamples.set(metric, []).get(metric)!).push(clamped);
      }
      continue;
    }
    byType[e.type] += 1;
    if (e.sessionKey) { sessions.add(e.sessionKey); keyedRows += 1; }
    if (e.type === 'pageview' && e.path) paths.set(e.path, (paths.get(e.path) ?? 0) + 1);
    const src = e.utm?.source; if (src) sources.set(src, (sources.get(src) ?? 0) + 1);
  }
  const topPaths = [...paths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, count]) => ({ path, count }));
  const utmSources = [...sources.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([source, count]) => ({ source, count }));
  // Aggregate p75 + rating per metric (rating derived server-side from p75, not
  // the client's per-hit rating — the honest aggregate).
  const vitals = [...vitalSamples.entries()]
    .map(([metric, values]) => { const v = p75(values); return { metric, p75: Math.round(v * 1000) / 1000, rating: rateVital(metric, v), count: values.length }; })
    .sort((a, b) => a.metric.localeCompare(b.metric));
  // `total` counts BUSINESS events only — web-vitals are telemetry (CWV-2).
  // ADR 0569 — daily uniques over the same business rows (web-vital telemetry
  // carries no hash relevance either way; excluded for consistency with total).
  const { uniques } = countDailyUniques(all.filter((e) => !(e.type === 'event' && e.name === 'web-vital')));
  return {
    total: all.length - webVitalCount, byType, topPaths, utmSources,
    // ANL-UX-15 — `sessions` is OMITTED when business rows exist but none carried a
    // sessionKey: a confident 0 was a claim about traffic the beacon never keyed.
    ...(keyedRows > 0 || all.length - webVitalCount === 0 ? { sessions: sessions.size } : {}),
    // ANL-UX-10 — the distinct counts BEFORE the top-10 cut, so the page can say so.
    topPathsTotal: paths.size, utmSourcesTotal: sources.size,
    // ANL-UX-4 R2 — `uniqueVisitorsSince` is DELIBERATELY not set here. This
    // function only ever sees rows already filtered to a window, so any date it
    // derived was the window's edge wearing a deployment date's meaning ("began
    // ~8 days ago" on a 7-day view). The route learned to override it, but the
    // fabricated value still reached the LLM tool, the feature surface and the
    // strategy metric sync, which call `summarize` and never saw the override.
    // Fixing it at the OVERRIDE was fixing one caller; the value is unsourceable
    // here, so it is not produced here. Only `summarizeForReport`, which holds
    // the org's full history, may set it.
    ...(uniques > 0 ? { uniqueVisitors: uniques } : {}),
    ...(vitals.length ? { vitals } : {}),
  };
}

/** The outcome of one subject erasure over the event store. Reported rather
 *  than reduced to a single number so an INCOMPLETE erasure cannot present as a
 *  clean one (ANL-2). */
export interface SubjectEventErasure {
  /** Rows the store CONFIRMED deleted. A `delete()` that returned false is not
   *  counted here — it is counted in `failed`. */
  removed: number;
  /** Rows targeted for deletion whose delete did not take. `> 0` means the
   *  subject's data is still present; the registered eraser THROWS on it so the
   *  ADR 0381 fan-out records `erasure_partial` instead of a green receipt. */
  failed: number;
  /** Distinct `visitorHash` values reached from the subject's own rows — the
   *  SECOND key form, and the only way a sessionless-but-hashed row of the same
   *  visitor is reachable at all. */
  hashesReached: number;
}

/**
 * GDPR data-subject erasure over the event store.
 *
 * ANL-2 (CODEBASE-ASSESSMENT, 2026-08-18) — WHAT THIS USED TO MISS. The match
 * was `e.sessionKey === sessionKey` and nothing else, while the row also carries
 * `visitorHash`, `clickIds` (gclid/fbclid/ttclid/li_fat_id — cross-site
 * advertising identifiers), `owx`, a full `referrer` URL, a query-bearing `path`
 * and free-text `props`. Sessionless rows are ROUTINE, not hypothetical: the
 * `consent` feature defaults OFF, so `isAllowed` returns permissively and the
 * beacon records with `subjectKey = ''`; and `commerce/commerceService.ts:1261`
 * writes a `conversion` carrying `props.orderId` with no `sessionKey` at all.
 * Nothing but tenant teardown reclaimed those.
 *
 * THE REACH NOW, in two hops:
 *  1. DIRECT — a row whose `sessionKey` OR `visitorHash` equals the subject key
 *     (the second form matters because ADR 0381 resolves a subject to several
 *     key spaces, and because an operator may erase by the hash itself).
 *  2. TRANSITIVE — every row carrying a `visitorHash` seen on one of those rows.
 *     This is what reaches the same visitor's sessionless hashed rows.
 *
 * RESIDUAL, stated instead of claimed away (two of them):
 *  - A `visitorHash` is `sha256(salt|orgId|ip|ua)`, so two people behind one NAT
 *    on the same browser build collapse to one hash for that day. Hop 2 can
 *    therefore over-reach onto a co-located visitor's anonymous telemetry. That
 *    is accepted deliberately: on an anonymous beacon row, over-erasure costs a
 *    count and under-erasure leaves advertising identifiers behind — and the
 *    decision is now recorded in ADR 0569, not only here.
 *    CORRECTED (review): this used to say the over-reach is "bounded to one org
 *    and one UTC day". The DAY half was wrong, and understated the blast radius
 *    of the fix's own second hop. `hashes` collects a hash from EVERY direct
 *    row, and the subject's direct rows span every day they were active — each
 *    day contributing a DIFFERENT hash (the salt rotates), each of which hop 2
 *    then expands across that day's co-located visitors. So the true bound is
 *    "one org × every UTC day the subject was active". One org still holds:
 *    `orgId` is inside the hash, so a hash cannot collide across orgs.
 *  - A row with NEITHER a `sessionKey` NOR a `visitorHash` (the commerce
 *    conversion above; any tenant with the visitor-identity toggle off) is
 *    unreachable by ANY subject key, because it is linked to no subject
 *    identifier. It is RETAINED, not erased — the `crm:suppression` precedent of
 *    saying so in the eraser rather than implying coverage by silence. The
 *    retention purger and tenant teardown are what reclaim it.
 *
 * ANL-5 / WF-ANL-7 — reads through `listForTenantIndexed`, like the file's five
 * other reads. This was the ONE analytics read still doing a bare cross-tenant
 * `events.list()`, and the DSAR path invokes it once per ADR 0381-resolved key.
 */
export async function deleteSubjectEvents(tenantId: string, subjectKey: string): Promise<SubjectEventErasure> {
  const empty: SubjectEventErasure = { removed: 0, failed: 0, hashesReached: 0 };
  if (!tenantId || !subjectKey) return empty;
  const all = (await events.listForTenantIndexed(tenantId)).filter((e) => e.tenantId === tenantId);
  const direct = all.filter((e) => e.sessionKey === subjectKey || e.visitorHash === subjectKey);
  const hashes = new Set<string>();
  for (const e of direct) if (e.visitorHash) hashes.add(e.visitorHash);
  const targets = new Map<string, AnalyticsEvent>();
  for (const e of direct) targets.set(e.eventId, e);
  for (const e of all) if (e.visitorHash && hashes.has(e.visitorHash)) targets.set(e.eventId, e);
  let removed = 0;
  let failed = 0;
  for (const e of targets.values()) {
    // A delete that returns FALSE means the row is still there. Counting it as
    // removed is precisely the "success with data remaining" shape this fix is
    // about — so it counts against the erasure, not for it.
    if (await events.delete(e.eventId)) removed += 1; else failed += 1;
  }
  return { removed, failed, hashesReached: hashes.size };
}

// Register the analytics purge handler so Consent's data-subject delete cascades
// here (the subject-erasure seam — ADR 0020 / 0018). Module-load once per process.
// NAMED (not an anonymous arrow) so `eraseSubject`'s `failedFeatures` can name
// the feature an operator has to escalate about (CN-SP-6).
async function eraseSubjectAnalytics(tenantId: string, subjectKey: string): Promise<void> {
  const outcome = await deleteSubjectEvents(tenantId, subjectKey);
  // ANL-2 — an erasure that could not delete what it targeted MUST NOT report
  // success. Throwing is how this seam reports failure: `eraseSubject` counts
  // the eraser as failed, `consentService.deleteSubject` then records the
  // governance decision as `erasure_partial`/`deny` instead of a green receipt.
  // A key that simply MATCHES NOTHING is a no-op, not a failure — that is the
  // normal case for a key from another identity space (see `SubjectEraser`).
  if (outcome.failed > 0) {
    throw new OpenwopError(
      'internal_error',
      `analytics: ${outcome.failed} event row(s) targeted for erasure were not deleted.`,
      500,
      {},
    );
  }
}
registerSubjectEraser(eraseSubjectAnalytics);

// ADR 0077 P3 — time-based retention. Analytics events are session/behavior data
// (confidential-pii). Delete this tenant's events older than the cutoff. No-op on a
// falsy tenant (fail-closed — never a cross-tenant/global purge).
registerRetentionPurger({
  feature: 'analytics',
  async purge(tenantId, classification, cutoffIso) {
    if (!tenantId || classification !== 'confidential-pii') return 0;
    // Analytics ages on `ts` (event time); map it onto the helper's `updatedAt` slot.
    return purgeRowsByAge('analytics', await events.listForTenantIndexed(tenantId), tenantId, cutoffIso,
      (e) => ({ tenantId: e.tenantId, updatedAt: e.ts, id: e.eventId }),
      (id) => events.delete(id));
  },
});

/** Test-only: clear the event store. */
export async function __resetAnalyticsStore(): Promise<void> { await events.__clear(); }
/** Test-only: seed a row the INGEST path can no longer produce (a pre-ADR 0651 D3
 *  client-claimed stamp, a back-dated `ts` for the retention purger). Never routed. */
export async function __putRawEventForTests(e: AnalyticsEvent): Promise<void> { await events.put(e); }
