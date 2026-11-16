/**
 * ADR 0454 — the one shared RFC 5545 iCalendar builder (`host/ics.ts`). Pins:
 *  - §3.3.11 text escaping incl. the Unicode line/para separators (injection guard);
 *  - §3.1 75-octet line folding (continuation = CRLF + space);
 *  - byte-exact output for both event shapes: the crm timed invite (every field the
 *    booking adapter can pass) and the all-day feed (its in-tree caller left with
 *    KickTodo, ADR 1031 P3; the shape stays part of the shared builder).
 *
 * BLOCKED-ON-PRODUCT: ICS-FOLD-OCTETS. RFC 5545 §3.1 folds at 75 OCTETS; `foldIcsLine`
 * counts JS string units, so multi-byte text yields longer lines and can split a
 * surrogate pair. The fold case below asserts only what holds today, an ASCII line
 * (where units == octets), until the product counts bytes.
 *
 * Tracker TST-DFD-2. Red when (w71g1, witnessed): backslash or the Unicode separators
 * stop being escaped; the fold threshold moves off 75 (a 76-char line must fold, a 75-char line must not) or the 74-wide continuation changes; a
 * `sequence: 0` is dropped; the trailing CRLF is dropped; the UTC stamp keeps millis.
 * Wave 116 adds: the timed VEVENT's field order or the ORGANIZER/ATTENDEE lines change.
 */
import { describe, expect, it } from 'vitest';
import { buildIcsCalendar, escapeIcsText, foldIcsLine, icsUtc } from '../src/host/ics.js';

describe('escapeIcsText (RFC 5545 §3.3.11 + injection guard)', () => {
  it('escapes backslash, semicolon, comma', () => {
    expect(escapeIcsText('a\\b;c,d')).toBe('a\\\\b\\;c\\,d');
  });
  it('neutralises every newline form to a literal \\n (no property injection)', () => {
    expect(escapeIcsText('x\r\ny\rz\nw\u2028v\u2029u')).toBe('x\\ny\\nz\\nw\\nv\\nu');
    // A malicious value can never introduce its own content line.
    expect(escapeIcsText('t\r\nX-EVIL:pwned')).toBe('t\\nX-EVIL:pwned');
  });
});

describe('foldIcsLine (RFC 5545 §3.1)', () => {
  it('leaves a ≤75-octet line unchanged', () => {
    const s = 'A'.repeat(75);
    expect(foldIcsLine(s)).toBe(s);
  });
  it('folds a >75-octet line at 75 then 74, continuation = CRLF + space', () => {
    // 160 ASCII chars fold TWICE: 75, then a 74-wide continuation, then the 11 left.
    const folded = foldIcsLine('B'.repeat(160));
    expect(folded).toBe('B'.repeat(75) + '\r\n ' + 'B'.repeat(74) + '\r\n ' + 'B'.repeat(11));
    expect(folded.split('\r\n').map((l) => l.length)).toEqual([75, 75, 12]); // each line ≤ 75 incl. the leading space
    // The boundary itself: 76 characters is the shortest line that must fold.
    expect(foldIcsLine('C'.repeat(76))).toBe('C'.repeat(75) + '\r\n ' + 'C');
  });
});

describe('icsUtc', () => {
  it('formats epoch-ms as YYYYMMDDTHHMMSSZ', () => {
    expect(icsUtc(Date.UTC(2026, 6, 20, 13, 0, 0))).toBe('20260720T130000Z');
    expect(icsUtc(0)).toBe('19700101T000000Z');
  });
});

describe('buildIcsCalendar — all-day feed shape (a challenge feed)', () => {
  it('emits a VALUE=DATE VEVENT, no CALSCALE/METHOD, trailing CRLF', () => {
    const ics = buildIcsCalendar({
      prodId: '-//Acme//EN',
      events: [{ uid: 'c1@acme', start: { kind: 'date', value: '20260720' }, summary: 'Acme day 1: Walk' }],
    });
    expect(ics).toBe(
      'BEGIN:VCALENDAR\r\n' +
        'VERSION:2.0\r\n' +
        'PRODID:-//Acme//EN\r\n' +
        'BEGIN:VEVENT\r\n' +
        'UID:c1@acme\r\n' +
        'DTSTART;VALUE=DATE:20260720\r\n' +
        'SUMMARY:Acme day 1: Walk\r\n' +
        'END:VEVENT\r\n' +
        'END:VCALENDAR\r\n',
    );
  });
});

describe('buildIcsCalendar — timed invite shape (crm booking)', () => {
  it('emits CALSCALE + METHOD + a fully-populated timed VEVENT in canonical order', () => {
    const ics = buildIcsCalendar({
      prodId: '-//OpenWOP//CRM Booking//EN',
      calScale: true,
      method: 'REQUEST',
      events: [
        {
          uid: 'b1@openwop',
          sequence: 0,
          dtstampMs: 0,
          start: { kind: 'utc', ms: Date.UTC(2026, 6, 20, 13, 0, 0) },
          end: { kind: 'utc', ms: Date.UTC(2026, 6, 20, 14, 0, 0) },
          summary: 'Intro; call, with comma',
          status: 'CONFIRMED',
          description: 'Agenda: scope, budget',
          location: 'Remote',
          organizerEmail: 'host@example.invalid',
          attendeeEmail: 'guest@example.invalid',
        },
      ],
    });
    // Byte-exact: every field the CRM booking adapter (features/crm/ics.ts) can
    // pass is populated, so the canonical order and each prefix are pinned.
    expect(ics).toBe(
      'BEGIN:VCALENDAR\r\n' +
        'VERSION:2.0\r\n' +
        'PRODID:-//OpenWOP//CRM Booking//EN\r\n' +
        'CALSCALE:GREGORIAN\r\n' +
        'METHOD:REQUEST\r\n' +
        'BEGIN:VEVENT\r\n' +
        'UID:b1@openwop\r\n' +
        'SEQUENCE:0\r\n' +
        'DTSTAMP:19700101T000000Z\r\n' +
        'DTSTART:20260720T130000Z\r\n' +
        'DTEND:20260720T140000Z\r\n' +
        'SUMMARY:Intro\\; call\\, with comma\r\n' +
        'STATUS:CONFIRMED\r\n' +
        'DESCRIPTION:Agenda: scope\\, budget\r\n' +
        'LOCATION:Remote\r\n' +
        'ORGANIZER:mailto:host@example.invalid\r\n' +
        'ATTENDEE;RSVP=FALSE:mailto:guest@example.invalid\r\n' +
        'END:VEVENT\r\n' +
        'END:VCALENDAR\r\n',
    );
  });
});
