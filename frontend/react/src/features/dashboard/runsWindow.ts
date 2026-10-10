/**
 * The dashboard's runs reads and the pure statistics computed from them
 * (ADR 0844). TWO reads, by audience (issue 4511):
 *   - `readRecentRuns` — the WORKSPACE's runs (`GET /runs`). Admin-tier only:
 *     Run health, Run activity, and Needs you for an admin. It returns full
 *     snapshots of everyone's runs, which the admin-tier /runs pages show too.
 *   - `readMyRuns` — the caller's OWN runs, slim, ownership decided server-side.
 *     Needs you for a member, and Get started for everyone ("did *I* run one").
 * `sharedRead` collapses each into one request per page load.
 *
 * There is no server-side run-statistics endpoint, so the numbers here are
 * computed from at most `RUN_WINDOW` rows. That is a SAMPLE, and the functions
 * below say so: `coverage` reports whether the rows actually reach back to the
 * start of the window, and a delta against the previous period is only
 * produced when the previous period is fully covered too. A number computed
 * from a truncated window must never be presented as the whole period.
 */
import { listMyRuns, type RunListItem } from '../../client/runsClient.js';
import { listOwnRuns } from './dashboardClient.js';
import { MY_RUNS_KEY, RECENT_RUNS_KEY, sharedRead } from './sharedRead.js';

/** Rows fetched — one v2 page (`runList.maxPageSize` is 100). */
export const RUN_WINDOW = 100;

/** The workspace's recent runs — admin-tier callers only (see above). */
export function readRecentRuns(): Promise<RunListItem[]> {
  return sharedRead(RECENT_RUNS_KEY, () => listMyRuns({ limit: RUN_WINDOW }));
}

/** The caller's own recent runs, newest first, at most `RUN_WINDOW`. */
export function readMyRuns(): Promise<RunListItem[]> {
  return sharedRead(MY_RUNS_KEY, async () => (await listOwnRuns(RUN_WINDOW)).runs);
}

export type RunRange = '24h' | '7d' | '30d';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
export const RANGE_MS: Record<RunRange, number> = { '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY };
/** Sparkline buckets per range: 2-hourly, daily, daily. */
const BUCKETS: Record<RunRange, number> = { '24h': 12, '7d': 7, '30d': 30 };

/** Statuses a person has to act on before the run can continue. */
const WAITING = new Set(['paused', 'suspended', 'waiting', 'waiting-approval', 'waiting-input', 'input-required']);
const TERMINAL_OK = new Set(['completed', 'succeeded']);
const TERMINAL_BAD = new Set(['failed', 'error']);

export function isWaiting(status: string): boolean { return WAITING.has(status.toLowerCase()); }
export function isFailed(status: string): boolean { return TERMINAL_BAD.has(status.toLowerCase()); }
export function isRunning(status: string): boolean { return status.toLowerCase() === 'running'; }

function startedMs(r: RunListItem): number | null {
  if (!r.startedAt) return null;
  const t = Date.parse(r.startedAt);
  return Number.isFinite(t) ? t : null;
}

export function durationMs(r: RunListItem): number | null {
  const s = startedMs(r);
  if (s === null || !r.completedAt) return null;
  const e = Date.parse(r.completedAt);
  return Number.isFinite(e) && e >= s ? e - s : null;
}

interface PeriodStats {
  runs: number;
  /** Succeeded ÷ finished (succeeded + failed); null when nothing finished. */
  successRate: number | null;
  /** Median wall time of succeeded runs, ms; null when none. */
  medianMs: number | null;
}

function periodStats(rows: RunListItem[]): PeriodStats {
  let ok = 0;
  let bad = 0;
  const durations: number[] = [];
  for (const r of rows) {
    const s = r.status.toLowerCase();
    if (TERMINAL_OK.has(s)) {
      ok += 1;
      const d = durationMs(r);
      if (d !== null) durations.push(d);
    } else if (TERMINAL_BAD.has(s)) {
      bad += 1;
    }
  }
  durations.sort((a, b) => a - b);
  return {
    runs: rows.length,
    successRate: ok + bad > 0 ? ok / (ok + bad) : null,
    medianMs: durations.length > 0 ? durations[Math.floor(durations.length / 2)]! : null,
  };
}

export interface RunHealth extends PeriodStats {
  /** Runs waiting on a person right now (any age). */
  waiting: number;
  /** Runs started per bucket, oldest first — the sparkline. */
  series: number[];
  /** True when the rows reach back to the window's start (or the list ended). */
  covered: boolean;
  /** The previous equal-length period, only when it is fully covered. */
  previous: PeriodStats | null;
}

/**
 * @param rows newest-first or any order; at most `RUN_WINDOW` of them.
 * @param truncated true when the read returned a full page, i.e. older runs
 *   may exist that were not fetched.
 */
export function computeRunHealth(rows: readonly RunListItem[], range: RunRange, now: number, truncated: boolean): RunHealth {
  const span = RANGE_MS[range];
  const start = now - span;
  const prevStart = start - span;
  const dated = rows.map((r) => ({ r, t: startedMs(r) })).filter((x): x is { r: RunListItem; t: number } => x.t !== null);
  const oldest = dated.reduce((m, x) => Math.min(m, x.t), Number.POSITIVE_INFINITY);
  // Not truncated ⇒ we hold every run there is, so any window is covered.
  const reaches = (from: number): boolean => !truncated || oldest <= from;

  const inWindow = dated.filter((x) => x.t >= start && x.t <= now).map((x) => x.r);
  const inPrev = dated.filter((x) => x.t >= prevStart && x.t < start).map((x) => x.r);

  const n = BUCKETS[range];
  const width = span / n;
  const series = new Array<number>(n).fill(0);
  for (const x of dated) {
    if (x.t < start || x.t > now) continue;
    const i = Math.min(n - 1, Math.floor((x.t - start) / width));
    series[i] = (series[i] ?? 0) + 1;
  }

  return {
    ...periodStats(inWindow),
    waiting: rows.filter((r) => isWaiting(r.status)).length,
    series,
    covered: reaches(start),
    previous: reaches(prevStart) ? periodStats(inPrev) : null,
  };
}

/** "1m 04s", "22s", "3h 05m" — compact wall time for a list cell. */
export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
}
