/**
 * ADR 0402 §a — booking slot math + ICS + the CAS claim (pure/unit level).
 * The tz math is the riskiest core (DST correctness); the claim is the
 * double-book gate. Both are exercised here without booting the app.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  generateSlots, wallClockToUtc, wallClockInZone, parseHhmm, isValidTimeZone,
} from '../src/features/crm/bookingTime.js';
import { buildIcs } from '../src/features/crm/ics.js';
import {
  bookingIdFor, claimBooking, listBookingsForLink, __clearBookings, type Booking,
} from '../src/features/crm/entities/bookings.js';

const NY = 'America/New_York';
const MS_MIN = 60_000;
const HOUR = 60 * MS_MIN;

describe('bookingTime — timezone conversion (DST-correct)', () => {
  it('parses HH:MM and rejects malformed', () => {
    expect(parseHhmm('09:30')).toBe(570);
    expect(parseHhmm('24:00')).toBeNull();
    expect(parseHhmm('9:30')).toBeNull();
    expect(parseHhmm('bad')).toBeNull();
  });

  it('validates IANA zones', () => {
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });

  it('round-trips a normal wall clock through UTC and back', () => {
    // 2026-07-20 09:00 America/New_York = 13:00 UTC (EDT, -4).
    const utc = wallClockToUtc({ year: 2026, month: 7, day: 20, hour: 9, minute: 0 }, NY);
    expect(utc).not.toBeNull();
    expect(new Date(utc!).toISOString()).toBe('2026-07-20T13:00:00.000Z');
    const back = wallClockInZone(utc!, NY);
    expect(back).toEqual({ year: 2026, month: 7, day: 20, hour: 9, minute: 0 });
  });

  it('applies the winter (EST, -5) offset', () => {
    // 2026-01-20 09:00 America/New_York = 14:00 UTC (EST, -5).
    const utc = wallClockToUtc({ year: 2026, month: 1, day: 20, hour: 9, minute: 0 }, NY);
    expect(new Date(utc!).toISOString()).toBe('2026-01-20T14:00:00.000Z');
  });

  it('rejects a nonexistent wall clock in the spring-forward gap', () => {
    // 2026-03-08 02:30 America/New_York does not exist (clocks jump 02:00→03:00).
    expect(wallClockToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, NY)).toBeNull();
    // 03:30 that day is valid (already EDT).
    expect(wallClockToUtc({ year: 2026, month: 3, day: 8, hour: 3, minute: 30 }, NY)).not.toBeNull();
  });
});

describe('bookingTime — slot generation', () => {
  const cfg = {
    timeZone: NY,
    weeklyHours: [{ day: 1, start: '09:00', end: '11:00' }], // Monday 9–11
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    minNoticeMin: 0,
    maxAdvanceDays: 30,
  };
  // Monday 2026-07-20.
  const monday9EDT = wallClockToUtc({ year: 2026, month: 7, day: 20, hour: 9, minute: 0 }, NY)!;
  const now = monday9EDT - 2 * 24 * HOUR; // two days before

  it('generates four 30-min slots in a 9–11 window', () => {
    const slots = generateSlots(cfg, monday9EDT - HOUR, monday9EDT + 3 * HOUR, now, []);
    expect(slots).toEqual([monday9EDT, monday9EDT + 30 * MS_MIN, monday9EDT + HOUR, monday9EDT + 90 * MS_MIN]);
  });

  it('subtracts a claimed slot (and its buffers)', () => {
    const slots = generateSlots(cfg, monday9EDT - HOUR, monday9EDT + 3 * HOUR, now, [{ startUtcMs: monday9EDT, durationMin: 30 }]);
    expect(slots).not.toContain(monday9EDT);
    expect(slots).toContain(monday9EDT + 30 * MS_MIN);
  });

  it('a buffer-after removes the adjacent following slot', () => {
    const withBuffer = { ...cfg, bufferAfterMin: 30 };
    const slots = generateSlots(withBuffer, monday9EDT - HOUR, monday9EDT + 3 * HOUR, now, [{ startUtcMs: monday9EDT, durationMin: 30 }]);
    // The 09:30 slot is buffered out by the 09:00 booking's 30-min after-pad.
    expect(slots).not.toContain(monday9EDT + 30 * MS_MIN);
  });

  it('honors minNotice and maxAdvance windows', () => {
    const late = generateSlots({ ...cfg, minNoticeMin: 3 * 24 * 60 }, monday9EDT - HOUR, monday9EDT + 3 * HOUR, now, []);
    expect(late).toEqual([]); // all within the 3-day notice
    const advance = generateSlots({ ...cfg, maxAdvanceDays: 1 }, monday9EDT - HOUR, monday9EDT + 3 * HOUR, now, []);
    expect(advance).toEqual([]); // Monday is 2 days out, beyond the 1-day horizon
  });
});

describe('ics — VEVENT builder', () => {
  it('emits a well-formed VCALENDAR with CRLF + UTC stamps', () => {
    const ics = buildIcs({
      uid: 'b1@openwop', sequence: 0,
      startUtcMs: Date.UTC(2026, 6, 20, 13, 0), endUtcMs: Date.UTC(2026, 6, 20, 13, 30),
      summary: 'Intro; call, with comma', method: 'REQUEST', stampMs: Date.UTC(2026, 6, 18, 0, 0),
      attendeeEmail: 'v@x.test',
    });
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('DTSTART:20260720T130000Z');
    expect(ics).toContain('SUMMARY:Intro\\; call\\, with comma'); // escaped
    expect(ics.endsWith('\r\n')).toBe(true);
  });

  it('emits a CANCEL variant with a bumped sequence', () => {
    const ics = buildIcs({ uid: 'b1@openwop', sequence: 1, startUtcMs: 0, endUtcMs: HOUR, summary: 'X', method: 'CANCEL', stampMs: 0 });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:1');
  });
});

describe('entities/bookings — atomic claim (double-book gate)', () => {
  beforeEach(async () => {
    initHostExtPersistence(await openStorage('memory://'));
    await __clearBookings();
  });

  const mkRow = (slotMs: number, overrides: Partial<Booking> = {}): Booking => ({
    bookingId: bookingIdFor('booking-link:L1', slotMs),
    tenantId: 't1', orgId: 'o1', bookingLinkId: 'booking-link:L1',
    slotStartUtcMs: slotMs, durationMin: 30, status: 'confirmed',
    inviteeName: 'Ann', inviteeEmail: 'ann@x.test',
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  });

  it('first claim wins; a second on the same slot is slot_taken', async () => {
    const first = await claimBooking(mkRow(1000, { idempotencyKey: 'k1' }));
    expect(first.outcome).toBe('claimed');
    const second = await claimBooking(mkRow(1000, { idempotencyKey: 'k2', inviteeEmail: 'bob@x.test' }));
    expect(second.outcome).toBe('slot_taken');
    expect(await listBookingsForLink('booking-link:L1')).toHaveLength(1);
  });

  it('a retry with the same idempotency key replays the same booking', async () => {
    await claimBooking(mkRow(2000, { idempotencyKey: 'same' }));
    const replay = await claimBooking(mkRow(2000, { idempotencyKey: 'same' }));
    expect(replay.outcome).toBe('replayed');
    expect(await listBookingsForLink('booking-link:L1')).toHaveLength(1);
  });

  it('a cancelled slot can be re-claimed', async () => {
    await claimBooking(mkRow(3000, { idempotencyKey: 'k1' }));
    const rows = await listBookingsForLink('booking-link:L1');
    const cancelled = { ...rows[0]!, status: 'cancelled' as const };
    const { putBooking } = await import('../src/features/crm/entities/bookings.js');
    await putBooking(cancelled);
    const reclaim = await claimBooking(mkRow(3000, { idempotencyKey: 'k2', inviteeEmail: 'new@x.test' }));
    expect(reclaim.outcome).toBe('claimed');
    expect((await listBookingsForLink('booking-link:L1'))[0]!.inviteeEmail).toBe('new@x.test');
  });
});
