/**
 * UX_UPGRADE-analytics AN-G1 — the reporting window.
 *
 * `summarize` and `listEvents` were unconditionally ALL-TIME, and the page never
 * said so, so a lifetime total read as recent activity. These pin the filter at
 * the service layer, and — the part that matters for anyone already using this —
 * that an absent or bad `days` keeps exactly the old all-time behaviour.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import {
  __resetAnalyticsStore,
  listEvents,
  recordEvent,
  trendForDays,
  sinceIsoForDays,
  summarize,
  summarizeForReport,
  type AnalyticsEvent,
} from '../src/features/analytics/analyticsService.js';

const TENANT = 'tenant-a';
const ORG = 'org-1';

/** `recordEvent` stamps `ts` itself, so events are always "now". Rather than
 *  reach into the store to back-date rows, the window is exercised from the
 *  OTHER side: a cutoff in the future excludes everything, a cutoff in the past
 *  includes it. That tests the same predicate on the same data. */
const ev = (path: string, orgId = ORG): Promise<unknown> =>
  recordEvent({ tenantId: TENANT, orgId, raw: { type: 'pageview', path } });

const isoFromNow = (ms: number): string => new Date(Date.now() + ms).toISOString();

beforeEach(async () => {
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(':memory:'));
  await __resetAnalyticsStore();
});

describe('analytics window — sinceIsoForDays', () => {
  it('returns undefined for the values that mean "all time"', () => {
    expect(sinceIsoForDays(undefined)).toBeUndefined();
    expect(sinceIsoForDays(0)).toBeUndefined();
    expect(sinceIsoForDays(-7)).toBeUndefined();
    expect(sinceIsoForDays(Number.NaN)).toBeUndefined();
  });

  it('returns an ISO instant the requested number of days back', () => {
    const iso = sinceIsoForDays(30)!;
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const deltaDays = (Date.now() - Date.parse(iso)) / 86_400_000;
    expect(deltaDays).toBeGreaterThan(29.9);
    expect(deltaDays).toBeLessThan(30.1);
  });
});

describe('analytics window — summarize + listEvents honour it', () => {
  it('counts only events inside the window — and the breakdowns narrow with it', async () => {
    await ev('/a');
    await ev('/b');

    // A window that covers "now" keeps everything…
    const wide = await summarize(TENANT, ORG, sinceIsoForDays(7));
    expect(wide.total).toBe(2);
    expect(wide.byType.pageview).toBe(2);

    // …and a cutoff after them excludes everything, including the derived
    // breakdowns rather than just the headline number.
    const narrow = await summarize(TENANT, ORG, isoFromNow(60_000));
    expect(narrow.total).toBe(0);
    expect(narrow.byType.pageview).toBe(0);
    expect(narrow.topPaths).toEqual([]);
  });

  it('narrows the event list the same way', async () => {
    await ev('/a');
    expect((await listEvents(TENANT, ORG, 100, sinceIsoForDays(7))).length).toBe(1);
    expect((await listEvents(TENANT, ORG, 100, isoFromNow(60_000))).length).toBe(0);
  });

  it('an ABSENT window is exactly the previous all-time behaviour', async () => {
    await ev('/a');
    await ev('/b');
    // The compatibility guarantee: an older client, or a bookmarked URL with no
    // `days`, must see what it always saw.
    expect((await summarize(TENANT, ORG)).total).toBe(2);
    expect((await listEvents(TENANT, ORG, 100)).length).toBe(2);
  });

  it('does not leak another org’s events into the window', async () => {
    await ev('/mine');
    await ev('/theirs', 'org-other');
    const s = await summarize(TENANT, ORG, sinceIsoForDays(7));
    expect(s.total).toBe(1);
    expect(s.topPaths.some((p) => p.path === '/theirs')).toBe(false);
  });
});

describe('analytics prior-period comparison — the untilIso bound (AN-G3)', () => {
  it('an exclusive upper bound splits the same data the lower bound does', async () => {
    await ev('/a');
    await ev('/b');
    // Prior-window shape: [since, until). A window ending in the past excludes
    // "now" events; a window that straddles now includes them.
    const pastOnly = await summarize(TENANT, ORG, undefined, isoFromNow(-60_000));
    expect(pastOnly.total).toBe(0);
    const straddling = await summarize(TENANT, ORG, sinceIsoForDays(7), isoFromNow(60_000));
    expect(straddling.total).toBe(2);
    expect(straddling.byType.pageview).toBe(2);
  });

  it('the route-shaped prior window (2N..N days back) excludes current-window events', async () => {
    await ev('/a');
    // days=7 → prior = [14d ago, 7d ago). Events recorded "now" are outside it.
    const prior = await summarize(TENANT, ORG, sinceIsoForDays(14), sinceIsoForDays(7));
    expect(prior.total).toBe(0);
    // …while the current window still sees them (the comparison never leaks
    // current events into the prior aggregate or vice versa).
    const current = await summarize(TENANT, ORG, sinceIsoForDays(7));
    expect(current.total).toBe(1);
  });
});

describe('R2 XAN — single-scan pair, trend buckets, stream honesty', () => {
  it('summarizeForReport partitions ONE read into current + prior windows', async () => {
    await ev('/a'); await ev('/b');
    const { current, prior } = await summarizeForReport(TENANT, ORG, 7);
    // Everything seeded "now" lands in the current window; prior is empty.
    expect(current.total).toBe(2);
    expect(prior!.total).toBe(0);
  });

  it('trendForDays seeds EVERY day (quiet days are zero, not gaps) and counts today', async () => {
    await ev('/a'); await ev('/a');
    const points = await trendForDays(TENANT, ORG, 7);
    expect(points).toHaveLength(7);
    const today = new Date().toISOString().slice(0, 10);
    expect(points[points.length - 1]!.day).toBe(today);
    expect(points[points.length - 1]!.pageviews).toBe(2);
    // The six earlier days exist as zeros.
    expect(points.slice(0, 6).every((p) => p.pageviews === 0)).toBe(true);
  });

  it('listEvents excludes web-vital telemetry rows, agreeing with the summary total (AN-SP-6)', async () => {
    await ev('/a');
    await recordEvent({ tenantId: TENANT, orgId: ORG, raw: { type: 'event', name: 'web-vital', props: { metric: 'LCP', value: 1200 } } });
    const summary = await summarize(TENANT, ORG);
    const stream = await listEvents(TENANT, ORG);
    expect(summary.total).toBe(1);
    expect(stream).toHaveLength(1); // the vital row is telemetry, not a stream event
    expect(stream[0]!.type).toBe('pageview');
  });
});

/**
 * ANL-UX-2 / ANL-UX-4 / ANL-UX-5 (UX-ASSESSMENT 2026-08-18) — the three figures
 * the page was asserting without a measurement behind them.
 *
 * Rows are back-dated through an independent handle on the same namespace,
 * because `recordEvent` stamps `ts` itself and every claim here is about
 * HISTORY the current window cannot see.
 */
const backdated = new DurableCollection<AnalyticsEvent>('analytics:event', (e) => e.eventId, undefined, (e) => e.tenantId);
let seq = 0;
const seed = (tsIso: string, extra: Partial<AnalyticsEvent> = {}): Promise<void> => backdated.put({
  eventId: `evt:seed-${seq += 1}`, tenantId: TENANT, orgId: ORG, type: 'pageview', ts: tsIso, ...extra,
});
const daysAgoIso = (n: number, time = 'T12:00:00.000Z'): string =>
  `${new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)}${time}`;

describe('ANL-UX-2 — `firstEventAt`: the beacon-ever-recorded signal the page had to invent', () => {
  it('is absent for an org that has NEVER recorded anything', async () => {
    const { summary, lifetime } = await summarizeForReport(TENANT, ORG, 7);
    expect(summary.total).toBe(0);
    expect(lifetime.firstEventAt).toBeUndefined();
  });

  it('is PRESENT when the only traffic was web-vital telemetry — the case `total` excludes', async () => {
    // The state that made "The beacon is connected — this window is just quiet"
    // indistinguishable from "the snippet was never pasted": `total` excludes
    // web-vitals, so a vitals-only org reported 0 with no way to tell.
    await recordEvent({ tenantId: TENANT, orgId: ORG, raw: { type: 'event', name: 'web-vital', props: { metric: 'LCP', value: 1200 } } });
    const { summary, lifetime } = await summarizeForReport(TENANT, ORG, 7);
    expect(summary.total, 'web-vitals are telemetry, not business events').toBe(0);
    expect(lifetime.firstEventAt, 'but the beacon HAS reported — say so from a signal, not a guess').toBeTruthy();
  });

  it('names the org\'s earliest row, not the window\'s', async () => {
    await seed(daysAgoIso(400));
    await ev('/now');
    const { lifetime } = await summarizeForReport(TENANT, ORG, 7);
    expect(lifetime.firstEventAt!.slice(0, 10)).toBe(daysAgoIso(400).slice(0, 10));
  });
});

describe('ANL-UX-4 — "Counting began …" is DEPLOYMENT-scoped, not window-scoped', () => {
  it('the same org reports the SAME since date on a 7-day and a 90-day window', async () => {
    const first = daysAgoIso(45);
    await seed(first, { visitorHash: 'h-old' });
    await seed(daysAgoIso(1), { visitorHash: 'h-new' });
    const wide = await summarizeForReport(TENANT, ORG, 90);
    const narrow = await summarizeForReport(TENANT, ORG, 7);
    // Pre-fix the narrow window derived `since` from rows already filtered to
    // it, so the disclosure read "began ~2 days ago" and MOVED with the picker
    // — the opposite of what ADR 0569 §5 asks the UI to say.
    expect(narrow.summary.uniqueVisitorsSince).toBe(first);
    expect(narrow.summary.uniqueVisitorsSince).toBe(wide.summary.uniqueVisitorsSince);
    // …and the COUNT still narrows with the window (the date is fixed, the
    // measurement is not).
    expect(narrow.summary.uniqueVisitors).toBe(1);
    expect(wide.summary.uniqueVisitors).toBe(2);
  });

  it('stays absent when the window has no visitor dimension at all', async () => {
    await seed(daysAgoIso(45), { visitorHash: 'h-old' });
    const narrow = await summarizeForReport(TENANT, ORG, 7);
    expect(narrow.summary.uniqueVisitors, 'no hashed row in the window ⇒ the tile disappears').toBeUndefined();
    expect(narrow.summary.uniqueVisitorsSince, 'and so must the disclosure — no orphaned date').toBeUndefined();
  });
});

describe('ANL-UX-5 — the trend\'s partial right edge is DISCLOSED, and its filter matches its buckets', () => {
  it('marks TODAY partial and no other day', async () => {
    await ev('/a');
    const points = await trendForDays(TENANT, ORG, 7);
    expect(points[points.length - 1]!.partial, 'today is still running — the dip is not a traffic collapse').toBe(true);
    expect(points.slice(0, -1).every((p) => p.partial === undefined), 'a completed UTC day is not partial').toBe(true);
  });

  it('the oldest seeded bucket is a WHOLE UTC day (the filter no longer passes rows it then discards)', async () => {
    // Boundary pin. NOTE, STATED: this does NOT discriminate the pre-fix code —
    // the rolling cutoff also admitted this row. What the fix removes is the
    // pass-then-`if (!p) continue`-drop for rows on the day BEFORE the oldest
    // bucket, which produced the same number by a route that made the window
    // claim untrue. The observable half of ANL-UX-5 is `partial` above and the
    // copy that stops equating this sum with the rolling Pageviews figure.
    await seed(daysAgoIso(6, 'T00:00:00.000Z'));
    const points = await trendForDays(TENANT, ORG, 7);
    expect(points[0]!.day).toBe(daysAgoIso(6).slice(0, 10));
    expect(points[0]!.pageviews).toBe(1);
  });
});

