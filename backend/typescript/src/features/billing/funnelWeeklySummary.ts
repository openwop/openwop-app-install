/**
 * The operator's weekly paywall-funnel summary (monetization strategy §8, ADR 0820
 * §7 note "the funnel digest").
 *
 * Once per ISO week it tells the host's operator what the funnel did in the week
 * that just ended, against the week before: lock views, upgrade clicks, plan
 * refusals, checkouts started / completed, and bundle grants started / ended.
 *
 * REUSE, no new pipeline:
 *   - the numbers are the funnel read itself (`buildFunnelReport` over
 *     `paywall:funnel-counts` + the checkout ledger), for two 7-day ranges;
 *   - delivery is the in-app NOTIFICATION CENTER (`getNotificationEmitter`), one
 *     notice per workspace listed in `OPENWOP_SUPERADMIN_TENANTS` — a personal
 *     workspace gets a broadcast (its one member), a shared one is addressed to
 *     its `admin` role (the `runNoticeAudience` rule). There is no operator email
 *     channel on this host (notification email is the per-recipient approval
 *     opt-in only), so there is no email leg;
 *   - the cadence is the weekly sweep-daemon idiom the CRM pipeline snapshots
 *     use (an hourly unref'd poll, a `storage.claimOnce` slot per ISO week),
 *     not a scheduler job.
 *
 * ONCE PER WEEK, fleet-wide: the slot `paywall-weekly-summary:sent:<isoWeek>` is
 * an atomic insert-if-absent, so two instances, a superseded revision still
 * running its workers, or a redeploy mid-week can never send a week twice. The
 * claim is taken AFTER the numbers are read and BEFORE anything is emitted: a
 * crash between claim and emit loses that week's notice (at-most-once — a
 * missed digest is cheaper than a duplicate one).
 *
 * OFF by default: nothing runs unless `OPENWOP_BILLING_FUNNEL_WEEKLY_SUMMARY=true`
 * (checked at the daemon's START in index.ts and again on every pass, so the
 * env can be flipped off without a restart).
 */
import type { Storage } from '../../storage/storage.js';
import type { NotificationRecord } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { getNotificationEmitter } from '../../notifications/emitter.js';
import { runNoticeAudience } from '../../notifications/runNoticeAudience.js';
import { listedSuperadminTenants } from '../../host/superadmin.js';
import { listPaywallCountsForDays, windowDays } from '../../host/paywallFunnel.js';
import { listCheckoutsSince, countActiveEntitlements } from './billingService.js';
import { buildFunnelReport, rate, type FunnelReport } from './funnelReport.js';

const log = createLogger('billing.funnelWeeklySummary');

export const WEEKLY_SUMMARY_ENV = 'OPENWOP_BILLING_FUNNEL_WEEKLY_SUMMARY';
export const WEEKLY_SUMMARY_TYPE = 'billing.funnel-weekly-summary';
const CLAIM_PREFIX = 'paywall-weekly-summary:sent:';
const DAY_MS = 86_400_000;
const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly; the slot is weekly

export function weeklySummaryEnabled(): boolean {
  return process.env[WEEKLY_SUMMARY_ENV] === 'true';
}

/** ISO-8601 week label (`YYYY-Www`) of a UTC instant. */
export function isoWeekOf(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // the week's Thursday names its ISO year
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = 1 + Math.floor((date.getTime() - yearStart) / DAY_MS / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** 00:00Z of the Monday of `d`'s ISO week. */
function mondayOf(d: Date): Date {
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS);
}

type Totals = Omit<FunnelReport['totals'], 'demoCheckouts'>;
const TOTAL_KEYS = ['impressions', 'clicks', 'refusals', 'checkoutsStarted', 'checkoutsCompleted', 'grantsStarted', 'grantsEnded'] as const;

export interface WeekOverWeek {
  /** The ISO week of the CURRENT range's last day. */
  week: string;
  current: { since: string; until: string; totals: Totals };
  previous: { since: string; until: string; totals: Totals };
  /** (current − previous) ÷ previous, 4 places; null when previous is 0. */
  change: Record<keyof Totals, number | null>;
  bundles: Array<{ bundleId: string; grantsStarted: number; grantsEnded: number; previousGrantsStarted: number; previousGrantsEnded: number }>;
}

const pick = (t: FunnelReport['totals']): Totals => Object.fromEntries(TOTAL_KEYS.map((k) => [k, t[k]])) as Totals;

/** PURE: two week reports → the comparison. */
export function buildWeekOverWeek(week: string, current: FunnelReport, previous: FunnelReport): WeekOverWeek {
  const cur = pick(current.totals);
  const prev = pick(previous.totals);
  const change = Object.fromEntries(TOTAL_KEYS.map((k) => [k, rate(cur[k] - prev[k], prev[k])])) as WeekOverWeek['change'];
  const ids = new Set([...current.bundles, ...previous.bundles].filter((b) => b.grantsStarted || b.grantsEnded).map((b) => b.bundleId));
  const of = (r: FunnelReport, id: string) => r.bundles.find((b) => b.bundleId === id);
  const bundles = [...ids].sort().map((id) => ({
    bundleId: id,
    grantsStarted: of(current, id)?.grantsStarted ?? 0,
    grantsEnded: of(current, id)?.grantsEnded ?? 0,
    previousGrantsStarted: of(previous, id)?.grantsStarted ?? 0,
    previousGrantsEnded: of(previous, id)?.grantsEnded ?? 0,
  }));
  return {
    week,
    current: { since: current.since, until: current.until, totals: cur },
    previous: { since: previous.since, until: previous.until, totals: prev },
    change,
    bundles,
  };
}

/** The funnel over 7 whole UTC days ending with `lastDay`'s day. */
async function weekReport(lastDay: Date, active: { bundles: Record<string, number>; plans: Record<string, number> }): Promise<FunnelReport> {
  const days = windowDays(7, lastDay);
  const since = `${days[days.length - 1]}T00:00:00.000Z`;
  const until = new Date(Date.parse(`${days[0]}T00:00:00.000Z`) + DAY_MS).toISOString();
  const [counts, checkouts] = await Promise.all([listPaywallCountsForDays(days), listCheckoutsSince(since, until)]);
  return buildFunnelReport({ days: 7, since, until, counts, checkouts, active });
}

/**
 * The 7 UTC days ending with `lastDay` (that day included) against the 7 before.
 * The panel passes now (a rolling "this week"); the weekly notice passes the
 * Sunday that closed the ISO week.
 */
export async function weekOverWeek(lastDay: Date): Promise<WeekOverWeek> {
  const active = await countActiveEntitlements(lastDay.getTime());
  const [current, previous] = await Promise.all([
    weekReport(lastDay, active), weekReport(new Date(lastDay.getTime() - 7 * DAY_MS), active),
  ]);
  return buildWeekOverWeek(isoWeekOf(lastDay), current, previous);
}

const signed = (v: number | null): string => (v === null ? 'new' : `${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`);

/** The notice text (English: notifications carry host-written strings). */
export function summaryMessage(w: WeekOverWeek): string {
  const t = w.current.totals;
  const c = w.change;
  const line = (n: number, label: string, ch: number | null, prev: number) => `${n} ${label} (${prev === 0 && n === 0 ? 'no change' : signed(ch)})`;
  const parts = [
    `${line(t.impressions, 'lock views', c.impressions, w.previous.totals.impressions)}, ${line(t.clicks, 'upgrade clicks', c.clicks, w.previous.totals.clicks)}, ${line(t.refusals, 'plan refusals', c.refusals, w.previous.totals.refusals)}.`,
    `Checkouts: ${line(t.checkoutsStarted, 'started', c.checkoutsStarted, w.previous.totals.checkoutsStarted)}, ${line(t.checkoutsCompleted, 'completed', c.checkoutsCompleted, w.previous.totals.checkoutsCompleted)}.`,
    `Bundle grants: ${t.grantsStarted} new, ${t.grantsEnded} cancelled (last week ${w.previous.totals.grantsStarted} new, ${w.previous.totals.grantsEnded} cancelled).`,
  ];
  if (w.bundles.length > 0) parts.push(w.bundles.map((b) => `${b.bundleId} +${b.grantsStarted}/−${b.grantsEnded}`).join(', ') + '.');
  return parts.join(' ');
}

type Emit = (n: Omit<NotificationRecord, 'notificationId' | 'createdAt' | 'status'>) => Promise<unknown>;

export type WeeklySummaryOutcome = 'disabled' | 'no-recipients' | 'already-sent' | 'sent';

/**
 * One pass: summarise the ISO week that ENDED before `now`, once per week.
 * Exported for tests (pass a fixed `now` and a fake `emit`).
 */
export async function processWeeklyFunnelSummary(deps: { storage: Storage; emit?: Emit }, now: Date): Promise<WeeklySummaryOutcome> {
  if (!weeklySummaryEnabled()) return 'disabled';
  // Recipients first: with nobody listed, claim nothing, so listing an operator
  // later in the week still delivers it.
  const recipients = listedSuperadminTenants().filter((t) => !t.startsWith('anon:'));
  if (recipients.length === 0) return 'no-recipients';
  const lastDay = new Date(mondayOf(now).getTime() - 1); // Sunday 23:59:59.999Z
  const week = isoWeekOf(lastDay);
  const summary = await weekOverWeek(lastDay);
  const claim = await deps.storage.claimOnce(`${CLAIM_PREFIX}${week}`, now.toISOString());
  if (!claim.claimed) return 'already-sent';
  const emit: Emit = deps.emit ?? ((n) => getNotificationEmitter().emit(n));
  const message = summaryMessage(summary);
  for (const tenantId of recipients) {
    const audience = runNoticeAudience({ tenantId });
    try {
      await emit({
        tenantId,
        ...(audience.recipientRole ? { recipientRole: audience.recipientRole } : {}),
        type: WEEKLY_SUMMARY_TYPE,
        priority: 'low',
        title: `Paywall funnel, week ${week}`,
        message,
        actionUrl: '/billing',
        // Counts only: no tenant, user or session of any customer is in here.
        metadata: { kind: WEEKLY_SUMMARY_TYPE, week, current: summary.current.totals, previous: summary.previous.totals },
      });
    } catch (err) {
      log.warn('funnel_weekly_summary_emit_failed', { week, error: err instanceof Error ? err.message : String(err) });
    }
  }
  log.info('funnel_weekly_summary_sent', { week, recipients: recipients.length });
  return 'sent';
}

export interface FunnelWeeklySummaryDaemon { stop: () => void }

/** Start the hourly poll (the `startCrmSnapshotDaemon` shape: ±20% jitter, unref'd, re-entrancy guarded). */
export function startFunnelWeeklySummaryDaemon(deps: { storage: Storage }): FunnelWeeklySummaryDaemon {
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try { await processWeeklyFunnelSummary(deps, new Date()); } catch (err) {
      log.warn('funnel_weekly_summary_tick_error', { error: err instanceof Error ? err.message : String(err) });
    } finally { running = false; }
  };
  const schedule = (): void => {
    timer = setTimeout(() => { void tick().finally(() => { if (!stopped) schedule(); }); }, POLL_INTERVAL_MS * (0.8 + Math.random() * 0.4));
    timer.unref?.();
  };
  schedule();
  log.info('funnel_weekly_summary_daemon_started', { pollIntervalMs: POLL_INTERVAL_MS });
  return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}
