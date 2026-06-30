/**
 * Priority Matrix schedule derivation (ADR 0103) — a PURE module (no I/O, no
 * store, no clock) so it is trivially unit-testable and replay-deterministic. The
 * caller passes `nowMs` (the server clock at read time); this never reads time
 * itself.
 *
 * A priority "idea" is a `host.kanban` card (ADR 0058). The card's column is pure
 * workflow-state — NOT a schedule — so "ahead/behind schedule" can only be derived
 * once an idea has a `targetDate` (the `IdeaSchedule` overlay). Completion = the
 * card sits in a `terminal` lane (ADR 0049); a cancellation lane ("Won't Do") is
 * terminal but NOT a completion, so it is excluded from schedule pressure (you
 * cannot be late for something you cancelled).
 *
 * @see docs/adr/0103-priority-schedule-status.md
 */

/** The derived schedule state of one idea. */
export type ScheduleState =
  | 'unscheduled' // no targetDate (or a cancelled idea)
  | 'on-track' // open, targetDate comfortably in the future
  | 'at-risk' // open, within ATRISK_WINDOW_DAYS of targetDate, or Blocked
  | 'behind' // open, targetDate already passed
  | 'done-early' // completed on/before targetDate
  | 'done-late'; // completed after targetDate

/** How close to the target date an open idea must be before it reads `at-risk`. */
export const ATRISK_WINDOW_DAYS = 3;

const DAY_MS = 86_400_000;

/** The pure inputs for one idea's derivation (the caller resolves these from the
 *  card + its column + the schedule overlay). */
export interface ScheduleInput {
  /** ISO date (`yyyy-mm-dd`) or full ISO timestamp; absent ⇒ unscheduled. */
  targetDate?: string;
  /** `card.completedAt` — set while the card is in a terminal lane (ADR 0049). */
  completedAt?: string;
  /** The card is in a terminal lane (Done OR Won't Do). */
  isTerminal: boolean;
  /** The terminal lane is a cancellation (Won't Do), not a completion. */
  isCancelled: boolean;
  /** The card is in a "Blocked" status column. */
  isBlocked: boolean;
  /** The server clock at read time (ms since epoch). */
  nowMs: number;
}

/** The derived status of one idea. `dueInDays` is present for open future-dated
 *  ideas (≥ 0); `overdueByDays` for `behind` ideas (> 0). */
export interface ScheduleStatus {
  state: ScheduleState;
  targetDate?: string;
  dueInDays?: number;
  overdueByDays?: number;
  completedAt?: string;
}

/** The instant a target *date* is still "on time" through — the end of that day.
 *  A date-only string (`yyyy-mm-dd`) counts the whole day as on-time (UTC); a full
 *  timestamp is honored as given. Returns NaN for an unparseable value. */
function targetDeadlineMs(targetDate: string): number {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(targetDate);
  const base = Date.parse(dateOnly ? `${targetDate}T00:00:00.000Z` : targetDate);
  if (Number.isNaN(base)) return NaN;
  return dateOnly ? base + DAY_MS - 1 : base;
}

/**
 * Derive one idea's schedule state. Never throws; an unparseable `targetDate` is
 * treated as unscheduled. Pure — caller owns I/O and the clock.
 */
export function deriveScheduleStatus(input: ScheduleInput): ScheduleStatus {
  const { targetDate, completedAt, isTerminal, isCancelled, isBlocked, nowMs } = input;

  // A cancelled idea (Won't Do) carries no schedule pressure.
  if (isCancelled) return { state: 'unscheduled' };

  const deadlineMs = targetDate ? targetDeadlineMs(targetDate) : NaN;
  const scheduled = targetDate !== undefined && !Number.isNaN(deadlineMs);

  // Completed (in a non-cancellation terminal lane).
  if (isTerminal) {
    if (!scheduled) return { state: 'unscheduled', ...(completedAt ? { completedAt } : {}) };
    const doneMs = completedAt ? Date.parse(completedAt) : nowMs;
    const onTime = Number.isNaN(doneMs) ? true : doneMs <= deadlineMs;
    return { state: onTime ? 'done-early' : 'done-late', targetDate, ...(completedAt ? { completedAt } : {}) };
  }

  if (!scheduled) return { state: 'unscheduled' };

  // Open + dated: compare the deadline to now.
  if (nowMs > deadlineMs) {
    const overdueByDays = Math.max(1, Math.ceil((nowMs - deadlineMs) / DAY_MS));
    return { state: 'behind', targetDate, overdueByDays };
  }
  const dueInDays = Math.max(0, Math.floor((deadlineMs - nowMs) / DAY_MS));
  if (isBlocked) return { state: 'at-risk', targetDate, dueInDays };
  if (dueInDays <= ATRISK_WINDOW_DAYS) return { state: 'at-risk', targetDate, dueInDays };
  return { state: 'on-track', targetDate, dueInDays };
}

/** A list's schedule rollup (mirrors strategy `get-health` shape — ADR 0103).
 *  Cancelled ideas are excluded entirely (not counted in any bucket or `total`). */
export interface ScheduleRollup {
  behind: number;
  atRisk: number;
  onTrack: number;
  doneLate: number;
  doneEarly: number;
  unscheduled: number;
  total: number;
  /** Worst-wins: any `behind` ⇒ `behind`; else any `at-risk` ⇒ `at-risk`; else `on-track`. */
  health: 'on-track' | 'at-risk' | 'behind';
}

/** Roll a list's per-idea states into one summary. Cancelled ideas (state
 *  `unscheduled` *because* of cancellation) are filtered by the caller before this;
 *  every state passed in counts toward `total`. */
export function rollupSchedule(states: ScheduleState[]): ScheduleRollup {
  const r: ScheduleRollup = { behind: 0, atRisk: 0, onTrack: 0, doneLate: 0, doneEarly: 0, unscheduled: 0, total: states.length, health: 'on-track' };
  for (const s of states) {
    switch (s) {
      case 'behind': r.behind++; break;
      case 'at-risk': r.atRisk++; break;
      case 'on-track': r.onTrack++; break;
      case 'done-late': r.doneLate++; break;
      case 'done-early': r.doneEarly++; break;
      case 'unscheduled': r.unscheduled++; break;
    }
  }
  r.health = r.behind > 0 ? 'behind' : r.atRisk > 0 ? 'at-risk' : 'on-track';
  return r;
}
