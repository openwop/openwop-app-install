/**
 * Priority Matrix schedule derivation (ADR 0103) — pure unit tests for the six
 * states + the at-risk window + blocked + cancellation handling + the rollup. The
 * clock is injected (`nowMs`) so every case is deterministic.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveScheduleStatus,
  rollupSchedule,
  ATRISK_WINDOW_DAYS,
  type ScheduleState,
} from '../src/features/priority-matrix/schedule.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-06-22T12:00:00.000Z');
const open = { isTerminal: false, isCancelled: false, isBlocked: false, nowMs: NOW };

describe('deriveScheduleStatus — open ideas', () => {
  it('unscheduled when no target date', () => {
    expect(deriveScheduleStatus({ ...open }).state).toBe('unscheduled');
  });

  it('on-track when the target is comfortably in the future', () => {
    const r = deriveScheduleStatus({ ...open, targetDate: '2026-07-30' });
    expect(r.state).toBe('on-track');
    expect(r.dueInDays).toBeGreaterThan(ATRISK_WINDOW_DAYS);
  });

  it('at-risk inside the at-risk window', () => {
    // target = today + 2 days (within the 3-day window).
    const target = new Date(NOW + 2 * DAY).toISOString().slice(0, 10);
    const r = deriveScheduleStatus({ ...open, targetDate: target });
    expect(r.state).toBe('at-risk');
    expect(r.dueInDays).toBeLessThanOrEqual(ATRISK_WINDOW_DAYS);
  });

  it('at-risk when blocked even if the target is far off', () => {
    const r = deriveScheduleStatus({ ...open, isBlocked: true, targetDate: '2099-01-01' });
    expect(r.state).toBe('at-risk');
  });

  it('behind when the target date has passed', () => {
    const r = deriveScheduleStatus({ ...open, targetDate: '2026-06-01' });
    expect(r.state).toBe('behind');
    expect(r.overdueByDays).toBeGreaterThan(0);
  });

  it('counts the whole target day as on-time (date-only is end-of-day)', () => {
    // Target is *today*; even at noon it is not yet behind (the day is on-time).
    const today = new Date(NOW).toISOString().slice(0, 10);
    expect(deriveScheduleStatus({ ...open, targetDate: today }).state).toBe('at-risk');
  });
});

describe('deriveScheduleStatus — completed + cancelled', () => {
  it('done-early when completed on/before target', () => {
    const r = deriveScheduleStatus({ targetDate: '2026-06-30', completedAt: '2026-06-20T09:00:00.000Z', isTerminal: true, isCancelled: false, isBlocked: false, nowMs: NOW });
    expect(r.state).toBe('done-early');
  });

  it('done-late when completed after target', () => {
    const r = deriveScheduleStatus({ targetDate: '2026-06-10', completedAt: '2026-06-20T09:00:00.000Z', isTerminal: true, isCancelled: false, isBlocked: false, nowMs: NOW });
    expect(r.state).toBe('done-late');
  });

  it('done but never scheduled reads unscheduled (cannot be early/late)', () => {
    const r = deriveScheduleStatus({ completedAt: '2026-06-20T09:00:00.000Z', isTerminal: true, isCancelled: false, isBlocked: false, nowMs: NOW });
    expect(r.state).toBe('unscheduled');
  });

  it('cancelled (Won\'t Do) carries no schedule pressure even when overdue', () => {
    const r = deriveScheduleStatus({ targetDate: '2000-01-01', isTerminal: true, isCancelled: true, isBlocked: false, nowMs: NOW });
    expect(r.state).toBe('unscheduled');
  });

  it('an unparseable target date is treated as unscheduled (never throws)', () => {
    expect(deriveScheduleStatus({ ...open, targetDate: 'garbage' }).state).toBe('unscheduled');
  });
});

describe('rollupSchedule — worst-wins health', () => {
  const roll = (states: ScheduleState[]) => rollupSchedule(states);

  it('any behind ⇒ behind', () => {
    expect(roll(['on-track', 'at-risk', 'behind', 'done-early']).health).toBe('behind');
  });
  it('any at-risk (no behind) ⇒ at-risk', () => {
    expect(roll(['on-track', 'at-risk', 'done-early']).health).toBe('at-risk');
  });
  it('otherwise on-track, with accurate counts', () => {
    const r = roll(['on-track', 'on-track', 'done-late', 'unscheduled']);
    expect(r.health).toBe('on-track');
    expect(r).toMatchObject({ onTrack: 2, doneLate: 1, unscheduled: 1, total: 4 });
  });
});
