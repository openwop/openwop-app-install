/**
 * CRM booking `.ics` (ADR 0402 §a) — now a thin adapter over the shared
 * `host/ics.ts` builder (ADR 0454). This module keeps the booking-specific
 * shape (`IcsEvent` with `method`/`sequence`/UTC instants) and maps it onto the
 * one RFC 5545 builder, so the escaping/folding/CRLF logic lives in exactly one
 * place. Output is byte-identical to the previous hand-rolled builder.
 */

import { buildIcsCalendar } from '../../host/ics.js';

export interface IcsEvent {
  /** Stable UID for this booking — same across confirm + cancel so calendars
   *  update the existing event rather than creating a duplicate. */
  uid: string;
  /** Monotonic revision — bump on cancel/reschedule so the update wins. */
  sequence: number;
  startUtcMs: number;
  endUtcMs: number;
  summary: string;
  description?: string;
  location?: string;
  organizerEmail?: string;
  attendeeEmail?: string;
  method: 'REQUEST' | 'CANCEL';
  /** DTSTAMP — the generation instant (epoch ms); passed in for determinism. */
  stampMs: number;
}

/** Build a complete VCALENDAR document (CRLF-terminated) for one booking event. */
export function buildIcs(ev: IcsEvent): string {
  return buildIcsCalendar({
    prodId: '-//OpenWOP//CRM Booking//EN',
    calScale: true,
    method: ev.method,
    events: [
      {
        uid: ev.uid,
        sequence: ev.sequence,
        dtstampMs: ev.stampMs,
        start: { kind: 'utc', ms: ev.startUtcMs },
        end: { kind: 'utc', ms: ev.endUtcMs },
        summary: ev.summary,
        status: ev.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED',
        ...(ev.description ? { description: ev.description } : {}),
        ...(ev.location ? { location: ev.location } : {}),
        ...(ev.organizerEmail ? { organizerEmail: ev.organizerEmail } : {}),
        ...(ev.attendeeEmail ? { attendeeEmail: ev.attendeeEmail } : {}),
      },
    ],
  });
}
