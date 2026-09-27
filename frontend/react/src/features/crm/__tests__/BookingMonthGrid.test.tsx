/**
 * BookingMonthGrid (R2 B-G3 / CRMPUB1-11) — the month day-picker that also
 * OWNS slot fetching, one clamped query per visible month.
 *
 * The load-bearing claims:
 * - month navigation issues a NEW query for the newly visible month (this is
 *   the client-side pagination the server's 62-day cap docblock promises, so
 *   a >62-day horizon stops silently truncating);
 * - an empty month AUTO-ADVANCES to the first month with availability, and
 *   reports exhaustion (not "no times") only after reaching the horizon empty;
 * - a failed month read surfaces via onLoadFailed instead of rendering the
 *   month as fully unavailable.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BookingMonthGrid } from '../BookingMonthGrid.js';

const DAY_MS = 86_400_000;
/**
 * H74-r — the instant is PINNED, and the pin is complete.
 *
 * These three cases used to build `nowMs` from `Date.now()`, and every one of
 * them reasons about civil-month boundaries, so what they asserted depended on
 * the day the suite happened to run. That is the shape that detonated elsewhere
 * in this component family.
 *
 * The pin is total rather than partial: `BookingMonthGrid` never reads the
 * clock — `nowMs` is its only source of "now" (grep: no `Date.now()` / `new
 * Date()` with no argument in `BookingMonthGrid.tsx`) — so fixing the prop fixes
 * the component, and no fake timers are needed.
 *
 * 2026-03-12 is chosen for being unremarkable: mid-month, a 31-day month, far
 * from a year boundary, and irrelevant to DST because every case runs `tz="UTC"`.
 * Nothing below depends on it being that date; it depends on it being A date.
 */
const NOW = Date.UTC(2026, 2, 12, 9, 0, 0); // 2026-03-12T09:00:00Z
/** `BookingMonthGrid.tsx:28` — civil-month bounds are padded by 36h at BOTH
 *  ends so any display timezone is covered. Consecutive windows therefore
 *  overlap by exactly 2x that, by construction and on every date. */
const TZ_SLACK_MS = 36 * 3_600_000;

beforeEach(() => { vi.restoreAllMocks(); });

function firstOfNextMonthUtc(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

describe('BookingMonthGrid', () => {
  it('paginates: next-month navigation issues a second, later-window query', async () => {
    const nowMs = NOW;
    const slotToday = nowMs + 2 * 3_600_000;
    const nextMonth = firstOfNextMonthUtc(nowMs);
    const all = [slotToday, nextMonth + 10 * DAY_MS];
    const fetchSlots = vi.fn(async (from: number, to: number) => all.filter((ms) => ms >= from && ms < to));
    render(
      <BookingMonthGrid
        tz="UTC" locale="en" nowMs={nowMs} maxAdvanceDays={90}
        fetchSlots={fetchSlots} onLoadFailed={() => {}} selectedDay="" onSelectDay={() => {}}
      />,
    );
    await waitFor(() => expect(fetchSlots).toHaveBeenCalledTimes(1));

    fireEvent.click(await screen.findByRole('button', { name: /later month/i }));
    await waitFor(() => expect(fetchSlots).toHaveBeenCalledTimes(2));
    const [firstCall, secondCall] = fetchSlots.mock.calls as [number, number][];
    // A FRESH page: both bounds move strictly later, so the second query cannot
    // be a re-read of the first capped window.
    expect(secondCall![0]).toBeGreaterThan(firstCall![0]);
    expect(secondCall![1]).toBeGreaterThan(firstCall![1]);

    // The windows OVERLAP, and by an exact, constant amount. The previous
    // version of this test asserted `secondCall[0] > firstCall[1] - 4 * DAY_MS`
    // under a comment claiming the second window "starts at (or after) the next
    // month". That comment is false — the second window starts 3 days BEFORE the
    // first one ends — and the bare `4 * DAY_MS` read as a margin tuned around a
    // moving calendar boundary. MEASURED across 36 pinned dates (every month of
    // 2026 x the 1st/12th/26th): the overlap is 3.00 days on all of them, because
    // it is `2 * TZ_SLACK_MS` and nothing else. Pinning the identity makes the
    // padding visible and turns a change to it into a red test, which the
    // inequality could not do.
    expect(firstCall![1] - secondCall![0]).toBe(2 * TZ_SLACK_MS);
    expect(2 * TZ_SLACK_MS).toBe(3 * DAY_MS);
  });

  it('auto-advances an empty month to the first month WITH availability', async () => {
    const nowMs = NOW;
    const nextMonth = firstOfNextMonthUtc(nowMs);
    const laterSlot = nextMonth + 12 * DAY_MS + 15 * 3_600_000;
    // Behave like the real server: return the slots inside the asked window.
    const fetchSlots = vi.fn(async (from: number, to: number) => [laterSlot].filter((ms) => ms >= from && ms < to));
    const onSelectDay = vi.fn();
    render(
      <BookingMonthGrid
        tz="UTC" locale="en" nowMs={nowMs} maxAdvanceDays={90}
        fetchSlots={fetchSlots} onLoadFailed={() => {}} selectedDay="" onSelectDay={onSelectDay}
      />,
    );
    // The jump lands on the availability month and auto-picks its first day.
    await waitFor(() => expect(onSelectDay).toHaveBeenCalled());
    const [key, slots] = onSelectDay.mock.calls[0]!;
    expect(slots).toEqual([laterSlot]);
    expect(key).toBe(new Date(laterSlot).toISOString().slice(0, 10));
    // Exactly two: the empty March window, then April's, which has the slot.
    // With the clock pinned this is derivable rather than a floor.
    expect(fetchSlots.mock.calls.length).toBe(2);
  });

  it('reports exhaustion only after reaching the horizon empty — and a failed read is a FAILURE, not an empty month', async () => {
    const nowMs = NOW;
    const onExhausted = vi.fn();
    const empty = vi.fn(async () => []);
    render(
      <BookingMonthGrid
        tz="UTC" locale="en" nowMs={nowMs} maxAdvanceDays={40}
        fetchSlots={empty} onLoadFailed={() => {}} selectedDay="" onSelectDay={() => {}} onExhausted={onExhausted}
      />,
    );
    await waitFor(() => expect(onExhausted).toHaveBeenCalled());
    // EXACTLY two reads, and the count is now derived rather than floored.
    //
    // The horizon is `nowMs + (40 + 1) days` = 2026-04-22T09:00Z, so
    // `lastMonth = civilMonthOf(horizonMs)` is APRIL. The auto-jump walks March
    // then April, finds April empty while `atLast`, and reports exhaustion
    // (`BookingMonthGrid.tsx:118`) — it never advances to May at all. So the
    // count is exactly `civilMonthsBetween(now, horizon)` inclusive = 2.
    //
    // TWO REDUNDANT BOUNDS, AND WHAT THAT COSTS THIS ASSERTION. The first draft
    // of this comment credited the `from < to` guard at `:94` for suppressing a
    // May query. Sabotage refuted it, and then refuted the correction too:
    //
    //   - delete `from < to` alone            -> still 2 (the walk never reaches May)
    //   - extend `lastMonth` by a month alone -> still 2 (May's window is empty,
    //                                            so `from < to` suppresses it)
    //   - delete BOTH                         -> `expected 3 to be 2` (red)
    //
    // So the walk is bounded twice over, each bound sufficient alone, and each
    // masking the other. `toBe(2)` is therefore a real assertion — it can be
    // falsified — but it CANNOT tell you which bound is carrying it, and no
    // single-guard regression will red it. On the auto-jump path `atLast` is the
    // one that actually fires; `from < to` is defensive and unreachable here
    // (reaching it requires a cursor past `civilMonthOf(horizonMs)`, which is
    // exactly what `atLast` prevents). `atLast`'s own regression IS caught,
    // by the `onExhausted` assertion above rather than by this count.
    //
    // The old assertion was `>= 2` under a comment reading "a 41-day horizon
    // spans 2–3 civil months" — it described an ambiguity and then loosened
    // itself to survive it. The ambiguity was the unpinned clock, and nothing
    // else; with an instant fixed, the span is not a range.
    expect(empty.mock.calls.length).toBe(2);

    const onLoadFailed = vi.fn();
    const failing = vi.fn(async () => { throw new Error('boom'); });
    render(
      <BookingMonthGrid
        tz="UTC" locale="en" nowMs={nowMs} maxAdvanceDays={40}
        fetchSlots={failing} onLoadFailed={onLoadFailed} selectedDay="" onSelectDay={() => {}}
      />,
    );
    await waitFor(() => expect(onLoadFailed).toHaveBeenCalled());
  });
});
