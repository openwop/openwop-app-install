/**
 * The ONE iCalendar (RFC 5545) builder for the app (ADR 0454). Both the CRM
 * booking `.ics` (ADR 0402) and the KickTodo challenge feed (ADR 0434) build
 * their calendar text here instead of hand-rolling escaping + folding twice —
 * fiddly spec code that must live in exactly one place (a fold/escape bug is
 * silent: a malformed `.ics` just fails in the user's calendar app).
 *
 * Spec-correct by construction: RFC 5545 §3.3.11 text escaping (including the
 * Unicode line/paragraph separators U+2028/U+2029), §3.1 75-octet line folding
 * (continuation = CRLF + space), CRLF line endings, and a trailing CRLF.
 * Supports both all-day (`VALUE=DATE`) and timed-UTC events, plus the optional
 * METHOD / SEQUENCE / STATUS / ORGANIZER / ATTENDEE fields a booking invite
 * carries. No RRULE / alarms in v1 (neither current caller needs them).
 */

/** A calendar instant — an all-day date or a timed UTC moment. */
export type IcsInstant =
  | { kind: 'date'; value: string } // all-day, `YYYYMMDD` (emits `;VALUE=DATE`)
  | { kind: 'utc'; ms: number }; //    timed, epoch-ms (emits a UTC timestamp)

export interface IcsEvent {
  uid: string;
  summary: string;
  start: IcsInstant;
  end?: IcsInstant;
  /** Monotonic revision — bump on cancel/reschedule so the update wins. */
  sequence?: number;
  /** DTSTAMP generation instant (epoch ms) — passed in for determinism. */
  dtstampMs?: number;
  status?: 'CONFIRMED' | 'CANCELLED' | 'TENTATIVE';
  description?: string;
  location?: string;
  organizerEmail?: string;
  attendeeEmail?: string;
}

export interface IcsCalendar {
  /** The `PRODID` (e.g. `-//OpenWOP//CRM Booking//EN`). */
  prodId: string;
  method?: 'REQUEST' | 'CANCEL' | 'PUBLISH';
  /** Emit `CALSCALE:GREGORIAN` (the booking invite does; the feed does not). */
  calScale?: boolean;
  events: IcsEvent[];
}

/** Escape a text value per RFC 5545 §3.3.11 (backslash, semicolon, comma) and
 *  neutralise every newline form — CRLF, CR, LF, and the Unicode line/para
 *  separators — to the literal `\n` the spec defines. This is the property-
 *  injection guard: a value can never introduce its own content line. */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, '\\n');
}

/** Format an epoch-ms instant as an iCal UTC timestamp: `YYYYMMDDTHHMMSSZ`. */
export function icsUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Fold a content line to ≤75 octets per RFC 5545 §3.1 (continuation = CRLF + space). */
export function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [line.slice(0, 75)];
  let rest = line.slice(75);
  while (rest.length > 0) {
    parts.push(' ' + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  return parts.join('\r\n');
}

function dtLine(prop: 'DTSTART' | 'DTEND', at: IcsInstant): string {
  return at.kind === 'date' ? `${prop};VALUE=DATE:${at.value}` : `${prop}:${icsUtc(at.ms)}`;
}

/** VEVENT lines in the canonical order (a superset of both callers' shapes). */
function eventLines(ev: IcsEvent): string[] {
  const lines: string[] = ['BEGIN:VEVENT', `UID:${escapeIcsText(ev.uid)}`];
  if (ev.sequence !== undefined) lines.push(`SEQUENCE:${ev.sequence}`);
  if (ev.dtstampMs !== undefined) lines.push(`DTSTAMP:${icsUtc(ev.dtstampMs)}`);
  lines.push(dtLine('DTSTART', ev.start));
  if (ev.end) lines.push(dtLine('DTEND', ev.end));
  lines.push(`SUMMARY:${escapeIcsText(ev.summary)}`);
  if (ev.status) lines.push(`STATUS:${ev.status}`);
  if (ev.description) lines.push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
  if (ev.location) lines.push(`LOCATION:${escapeIcsText(ev.location)}`);
  if (ev.organizerEmail) lines.push(`ORGANIZER:mailto:${escapeIcsText(ev.organizerEmail)}`);
  if (ev.attendeeEmail) lines.push(`ATTENDEE;RSVP=FALSE:mailto:${escapeIcsText(ev.attendeeEmail)}`);
  lines.push('END:VEVENT');
  return lines;
}

/** Build a complete VCALENDAR document (CRLF-terminated, including a trailing CRLF). */
export function buildIcsCalendar(cal: IcsCalendar): string {
  const lines: string[] = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${cal.prodId}`];
  if (cal.calScale) lines.push('CALSCALE:GREGORIAN');
  if (cal.method) lines.push(`METHOD:${cal.method}`);
  for (const ev of cal.events) lines.push(...eventLines(ev));
  lines.push('END:VCALENDAR');
  return lines.map(foldIcsLine).join('\r\n') + '\r\n';
}
