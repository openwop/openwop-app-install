/**
 * ADR 0905 P3 (D6, booking sender) — the booking confirmation and cancel/reschedule
 * emails render through the host transactional registry in the four product locales;
 * the English copy equals the pre-registry copy. The `.ics` attachments stay with the
 * sender (`bookingService.ts`).
 *
 * Sabotage-witnessed: hard-coding the English lead line reds three locale goldens.
 */
import { describe, expect, it } from 'vitest';
import { renderTransactional, TRANSACTIONAL_LOCALES } from '../src/host/transactionalEmail.js';
import { BOOKING_CONFIRMED_KIND, BOOKING_CANCELLED_KIND, registerBookingTransactionalTemplates } from '../src/features/crm/bookingTemplates.js';

registerBookingTransactionalTemplates();
const confirmed = { title: 'Intro call', whenUtc: '2026-11-01T15:00:00.000Z', videoLink: 'https://meet.example/x', manageUrl: 'https://app.example/m/t' };
const lead: Record<string, string> = {
  en: 'Your booking for "Intro call" is confirmed.', es: 'Tu reserva de «Intro call» está confirmada.',
  fr: 'Votre réservation pour « Intro call » est confirmée.', 'pt-BR': 'Sua reserva de "Intro call" está confirmada.',
};

describe('crm.booking-confirmed / crm.booking-cancelled — four locales', () => {
  for (const locale of TRANSACTIONAL_LOCALES) {
    it(locale, () => {
      expect(renderTransactional(BOOKING_CONFIRMED_KIND, confirmed, { locale }).text.split('\n')[0]).toBe(lead[locale]);
    });
  }
  it('english equals the pre-registry copy', () => {
    expect(renderTransactional(BOOKING_CONFIRMED_KIND, confirmed, { locale: 'en' })).toMatchObject({
      subject: 'Confirmed: Intro call',
      text: ['Your booking for "Intro call" is confirmed.', 'When: 2026-11-01T15:00:00.000Z (UTC) — see the attached calendar invite for your local time.', 'Join: https://meet.example/x', 'Reschedule or cancel: https://app.example/m/t'].join('\n'),
    });
    expect(renderTransactional(BOOKING_CONFIRMED_KIND, { title: 'T', whenUtc: 'W' }, { locale: 'en' }).text)
      .toBe(['Your booking for "T" is confirmed.', 'When: W (UTC) — see the attached calendar invite for your local time.'].join('\n'));
    expect(renderTransactional(BOOKING_CANCELLED_KIND, { title: 'T', rescheduled: false, previousUtc: 'W' }, { locale: 'en' }))
      .toMatchObject({ subject: 'Cancelled: T', text: 'Your booking for "T" has been cancelled.' });
    expect(renderTransactional(BOOKING_CANCELLED_KIND, { title: 'T', rescheduled: true, previousUtc: 'W' }, { locale: 'en' }).subject).toBe('Rescheduled: T');
  });
});
