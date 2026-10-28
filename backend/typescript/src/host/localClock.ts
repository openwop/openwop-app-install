/**
 * The ONE Intl wrapper for "what time is it there?" (ADR 0955 P2 architect finding 3).
 * Used by notification quiet hours (fails toward delivering) and journey send windows
 * (fail toward not sending): the semantics differ, the clock reading must not.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(timeZone);
  if (!f) {
    try { f = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' }); }
    catch { return null; }
    formatters.set(timeZone, f);
  }
  return f;
}

/** True iff `tz` is an IANA zone this runtime knows. */
export function isValidTimeZone(tz: unknown): tz is string {
  return typeof tz === 'string' && tz.length > 0 && tz.length <= 64 && formatterFor(tz) !== null;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Local minute-of-day (0–1439) and weekday (0 = Sunday) of `at` in `timeZone`; null on a bad zone. */
export function localClock(at: Date, timeZone: string): { minuteOfDay: number; weekday: number } | null {
  const f = formatterFor(timeZone);
  if (!f) return null;
  const parts = f.formatToParts(at);
  const weekday = WEEKDAYS.indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
  const hour = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value);
  if (weekday < 0 || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { minuteOfDay: hour * 60 + minute, weekday };
}

/** `"HH:MM"` → minutes, or null. */
export function parseClockTime(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
