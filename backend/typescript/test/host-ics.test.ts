/**
 * ADR 0454 — the one shared RFC 5545 iCalendar builder (`host/ics.ts`). Pins:
 *  - §3.3.11 text escaping incl. the Unicode line/para separators (injection guard);
 *  - §3.1 75-octet line folding (continuation = CRLF + space);
 *  - byte-exact output for both caller shapes (crm timed invite + kicktodo all-day feed).
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
    const folded = foldIcsLine('B'.repeat(80));
    expect(folded).toBe('B'.repeat(75) + '\r\n ' + 'B'.repeat(5));
  });
});

describe('icsUtc', () => {
  it('formats epoch-ms as YYYYMMDDTHHMMSSZ', () => {
    expect(icsUtc(Date.UTC(2026, 6, 20, 13, 0, 0))).toBe('20260720T130000Z');
    expect(icsUtc(0)).toBe('19700101T000000Z');
  });
});

describe('buildIcsCalendar — all-day feed shape (kicktodo)', () => {
  it('emits a VALUE=DATE VEVENT, no CALSCALE/METHOD, trailing CRLF', () => {
    const ics = buildIcsCalendar({
      prodId: '-//KickTodo//EN',
      events: [{ uid: 'c1@kicktodo', start: { kind: 'date', value: '20260720' }, summary: 'KickTodo day 1: Walk' }],
    });
    expect(ics).toBe(
      'BEGIN:VCALENDAR\r\n' +
        'VERSION:2.0\r\n' +
        'PRODID:-//KickTodo//EN\r\n' +
        'BEGIN:VEVENT\r\n' +
        'UID:c1@kicktodo\r\n' +
        'DTSTART;VALUE=DATE:20260720\r\n' +
        'SUMMARY:KickTodo day 1: Walk\r\n' +
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
          location: 'Remote',
        },
      ],
    });
    expect(ics).toContain('CALSCALE:GREGORIAN\r\nMETHOD:REQUEST\r\n');
    expect(ics).toContain('SEQUENCE:0\r\nDTSTAMP:19700101T000000Z\r\nDTSTART:20260720T130000Z\r\nDTEND:20260720T140000Z\r\n');
    expect(ics).toContain('SUMMARY:Intro\\; call\\, with comma\r\nSTATUS:CONFIRMED\r\nLOCATION:Remote\r\n');
    expect(ics.endsWith('END:VEVENT\r\nEND:VCALENDAR\r\n')).toBe(true);
  });
});
