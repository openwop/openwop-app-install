/**
 * KTUX-13 — the seat-hold countdown boundary. `minutesLeft` returning null at
 * (and past) expiry is what lets the SeatPurchasePage interval stop itself; a
 * `0` there would keep the "held for you, 0 min" Notice on screen and the timer
 * running forever.
 */
import { describe, it, expect } from 'vitest';
import { minutesLeft } from '../SeatPurchasePage.js';

const NOW = Date.parse('2026-06-01T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

describe('minutesLeft', () => {
  it('rounds up whole minutes while the hold is live', () => {
    expect(minutesLeft(iso(60_000), NOW)).toBe(1);
    expect(minutesLeft(iso(61_000), NOW)).toBe(2); // 1m1s → 2 (ceil)
    expect(minutesLeft(iso(15 * 60_000), NOW)).toBe(15);
  });

  it('is null exactly at expiry and after — never 0 (the runaway-timer guard)', () => {
    expect(minutesLeft(iso(0), NOW)).toBeNull();
    expect(minutesLeft(iso(-1), NOW)).toBeNull();
    expect(minutesLeft(iso(-60_000), NOW)).toBeNull();
  });

  it('is null when there is no hold', () => {
    expect(minutesLeft(undefined, NOW)).toBeNull();
  });
});
