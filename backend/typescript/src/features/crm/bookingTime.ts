/**
 * Booking slot math (ADR 0402 §a) — timezone-aware slot generation, DST-correct.
 *
 * The host cron scheduler (`host/cronSchedule.ts`) only does the FORWARD
 * direction (a UTC instant → wall-clock fields in an IANA zone, to match a cron
 * expression). Booking slot generation needs the INVERSE — given a booking
 * link's weekly availability expressed in ITS zone (e.g. "Mon 09:00–17:00
 * America/New_York"), produce the UTC instants for each offered slot. That
 * inverse (wall-clock-in-zone → UTC instant) does not exist in the host, so it
 * lives here as ONE well-tested helper, using the same `Intl.DateTimeFormat`
 * offset-resolution approach the cron scheduler uses (never a naive fixed UTC
 * offset). All stored booking times are UTC instants; the link's `timezone` is
 * compute/display-only (ADR 0402: "All stored booking times are UTC instants").
 *
 * DST correctness:
 *  - Fall-back (a wall clock that occurs twice): the EARLIER instant is chosen.
 *  - Spring-forward (a wall clock that does not exist, e.g. 02:30 when clocks
 *    jump 02:00→03:00): the slot is REJECTED (`wallClockToUtc` round-trips the
 *    result and returns null when it does not match the requested fields), so a
 *    nonexistent local slot is never offered.
 */

export interface WallClockFields {
  year: number;
  /** 1–12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
}

/** Weekly availability window — `day` is 0 (Sun)–6 (Sat); `start`/`end` are
 *  `HH:MM` wall-clock times in the link's zone (`end` exclusive). */
export interface WeeklyHours {
  day: number;
  start: string;
  end: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parse an `HH:MM` string to minutes-since-midnight, or null when malformed. */
export function parseHhmm(hhmm: string): number | null {
  const m = HHMM.exec(hhmm);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Cache one formatter per zone — construction is heavy and zones repeat. */
const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  let dtf: Intl.DateTimeFormat;
  try {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
  } catch {
    return null; // an invalid IANA zone id
  }
  formatterCache.set(timeZone, dtf);
  return dtf;
}

/** True iff `timeZone` is a valid IANA zone id this runtime recognizes. */
export function isValidTimeZone(timeZone: string): boolean {
  return formatterFor(timeZone) !== null;
}

/** Render a UTC instant to its wall-clock fields in `timeZone`. */
export function wallClockInZone(utcMs: number, timeZone: string): WallClockFields | null {
  const dtf = formatterFor(timeZone);
  if (!dtf) return null;
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 'NaN');
  // hour12:false renders midnight as "24" on some ICU builds — normalize.
  const hour = get('hour') % 24;
  const fields = { year: get('year'), month: get('month'), day: get('day'), hour, minute: get('minute') };
  return Object.values(fields).some((n) => Number.isNaN(n)) ? null : fields;
}

/** The zone's offset from UTC (ms) at the given instant. */
function offsetMsAt(utcMs: number, timeZone: string): number | null {
  const wc = wallClockInZone(utcMs, timeZone);
  if (!wc) return null;
  const asIfUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute);
  return asIfUtc - utcMs;
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC instant (epoch ms).
 * DST-correct via two-step offset resolution. Returns null when the wall clock
 * does not exist in the zone (a spring-forward gap) — so a nonexistent local
 * slot is never offered.
 */
export function wallClockToUtc(fields: WallClockFields, timeZone: string): number | null {
  const asIfUtc = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute);
  const off1 = offsetMsAt(asIfUtc, timeZone);
  if (off1 === null) return null;
  let utc = asIfUtc - off1;
  const off2 = offsetMsAt(utc, timeZone);
  if (off2 === null) return null;
  if (off2 !== off1) utc = asIfUtc - off2;
  // Round-trip: reject a wall clock that does not map back to itself (a DST gap).
  const back = wallClockInZone(utc, timeZone);
  if (!back || back.year !== fields.year || back.month !== fields.month || back.day !== fields.day || back.hour !== fields.hour || back.minute !== fields.minute) {
    return null;
  }
  return utc;
}

export interface SlotConfig {
  timeZone: string;
  weeklyHours: WeeklyHours[];
  /** Chosen slot length, minutes. */
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  minNoticeMin: number;
  maxAdvanceDays: number;
}

/** An already-claimed booking, for conflict subtraction. */
export interface ClaimedSlot {
  startUtcMs: number;
  durationMin: number;
}

const MS_MIN = 60_000;
const MS_DAY = 86_400_000;

/**
 * Generate the available slot start instants (UTC ms, ascending) for `cfg`
 * within `[fromMs, toMs]`, given `nowMs` (for notice/advance windows) and the
 * set of already-claimed bookings to subtract. Pure + deterministic — `nowMs`
 * is a parameter, never read from the clock here.
 *
 * A candidate is unavailable when its padded interval
 * `[start - bufferBefore, start + duration + bufferAfter)` overlaps any claimed
 * booking's own interval, so buffers protect the owner's calendar on both sides.
 */
export function generateSlots(cfg: SlotConfig, fromMs: number, toMs: number, nowMs: number, claimed: ClaimedSlot[]): number[] {
  if (cfg.durationMin <= 0 || !isValidTimeZone(cfg.timeZone)) return [];
  const earliest = nowMs + cfg.minNoticeMin * MS_MIN;
  const latest = Math.min(toMs, nowMs + cfg.maxAdvanceDays * MS_DAY);
  const windowStart = Math.max(fromMs, earliest);
  if (windowStart > latest) return [];

  // Each meeting RESERVES its slot plus the owner's before/after padding:
  // reserved(start, dur) = [start - bufferBefore, start + dur + bufferAfter). Two
  // meetings conflict when their reserved intervals overlap, so the free gap
  // between adjacent bookings holds both the after-pad of one and the before-pad
  // of the next. Both the candidate AND every claimed booking are padded.
  const padBefore = cfg.bufferBeforeMin * MS_MIN;
  const padAfter = cfg.bufferAfterMin * MS_MIN;
  const claimedIntervals = claimed.map((c) => ({ s: c.startUtcMs - padBefore, e: c.startUtcMs + c.durationMin * MS_MIN + padAfter }));
  const slotDurationMs = cfg.durationMin * MS_MIN;

  const out: number[] = [];
  // Walk each calendar day the window can touch, in the link's zone. Start one
  // day before `windowStart` to cover a window that opens just after midnight
  // local (the prior day's wall-clock date can still host an in-range slot).
  for (let dayCursor = windowStart - MS_DAY; dayCursor <= latest + MS_DAY; dayCursor += MS_DAY) {
    const wc = wallClockInZone(dayCursor, cfg.timeZone);
    if (!wc) continue;
    const localDow = localDayOfWeek(wc);
    for (const wh of cfg.weeklyHours) {
      if (wh.day !== localDow) continue;
      const startMin = parseHhmm(wh.start);
      const endMin = parseHhmm(wh.end);
      if (startMin === null || endMin === null || endMin <= startMin) continue;
      for (let m = startMin; m + cfg.durationMin <= endMin; m += cfg.durationMin) {
        const startUtc = wallClockToUtc({ year: wc.year, month: wc.month, day: wc.day, hour: Math.floor(m / 60), minute: m % 60 }, cfg.timeZone);
        if (startUtc === null) continue; // DST gap — not a real local time
        if (startUtc < windowStart || startUtc > latest) continue;
        // De-dupe (the day-cursor overlap can revisit the same local date).
        if (out.includes(startUtc)) continue;
        const pStart = startUtc - padBefore;
        const pEnd = startUtc + slotDurationMs + padAfter;
        const conflict = claimedIntervals.some((ci) => pStart < ci.e && ci.s < pEnd);
        if (!conflict) out.push(startUtc);
      }
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

/** Day-of-week (0 Sun–6 Sat) for a local wall-clock date, zone-independent
 *  (a calendar date's weekday is the same regardless of zone). */
function localDayOfWeek(wc: WallClockFields): number {
  // Date.UTC + getUTCDay is a pure calendar computation (no zone involved).
  return new Date(Date.UTC(wc.year, wc.month - 1, wc.day)).getUTCDay();
}
