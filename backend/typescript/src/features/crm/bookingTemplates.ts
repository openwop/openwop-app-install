/**
 * The booking emails as registered transactional kinds (ADR 0905 D6): confirmation,
 * and cancellation / reschedule notice, in the four product locales. Delivery and the
 * `.ics` attachments are unchanged (`bookingService.ts`); only the copy moved here.
 */
import { registerTransactionalTemplate, type TransactionalTemplate } from '../../host/transactionalEmail.js';

export const BOOKING_CONFIRMED_KIND = 'crm.booking-confirmed';
export const BOOKING_CANCELLED_KIND = 'crm.booking-cancelled';

export interface BookingConfirmedData { title: string; whenUtc: string; videoLink?: string; location?: string; manageUrl?: string }
export interface BookingCancelledData { title: string; rescheduled: boolean; previousUtc: string }

export const bookingConfirmedTemplate: TransactionalTemplate<BookingConfirmedData> = {
  kind: BOOKING_CONFIRMED_KIND,
  catalog: {
    en: { subject: 'Confirmed: {{title}}', lead: 'Your booking for "{{title}}" is confirmed.', when: 'When: {{when}} (UTC) — see the attached calendar invite for your local time.', join: 'Join: {{url}}', where: 'Where: {{place}}', manage: 'Reschedule or cancel: {{url}}' },
    es: { subject: 'Confirmada: {{title}}', lead: 'Tu reserva de «{{title}}» está confirmada.', when: 'Cuándo: {{when}} (UTC) — consulta la invitación de calendario adjunta para tu hora local.', join: 'Unirse: {{url}}', where: 'Dónde: {{place}}', manage: 'Cambiar o cancelar: {{url}}' },
    fr: { subject: 'Confirmé : {{title}}', lead: 'Votre réservation pour « {{title}} » est confirmée.', when: 'Quand : {{when}} (UTC) — voir l’invitation d’agenda jointe pour votre heure locale.', join: 'Rejoindre : {{url}}', where: 'Où : {{place}}', manage: 'Reprogrammer ou annuler : {{url}}' },
    'pt-BR': { subject: 'Confirmado: {{title}}', lead: 'Sua reserva de "{{title}}" está confirmada.', when: 'Quando: {{when}} (UTC) — veja o convite de calendário anexo para o seu horário local.', join: 'Entrar: {{url}}', where: 'Onde: {{place}}', manage: 'Remarcar ou cancelar: {{url}}' },
  },
  compose: (f, d) => ({
    subject: f.subject('subject', { title: d.title }),
    text: [
      f.text('lead', { title: d.title }), f.text('when', { when: d.whenUtc }),
      d.videoLink ? f.text('join', { url: d.videoLink }) : d.location ? f.text('where', { place: d.location }) : '',
      d.manageUrl ? f.text('manage', { url: d.manageUrl }) : '',
    ].filter(Boolean).join('\n'),
  }),
};

export const bookingCancelledTemplate: TransactionalTemplate<BookingCancelledData> = {
  kind: BOOKING_CANCELLED_KIND,
  catalog: {
    en: { cancelledSubject: 'Cancelled: {{title}}', rescheduledSubject: 'Rescheduled: {{title}}', cancelled: 'Your booking for "{{title}}" has been cancelled.', rescheduled: 'Your booking for "{{title}}" has been rescheduled. The previous time ({{when}}) is cancelled — your new confirmation is in a separate email.' },
    es: { cancelledSubject: 'Cancelada: {{title}}', rescheduledSubject: 'Reprogramada: {{title}}', cancelled: 'Tu reserva de «{{title}}» se ha cancelado.', rescheduled: 'Tu reserva de «{{title}}» se ha reprogramado. El horario anterior ({{when}}) queda cancelado; tu nueva confirmación llega en otro correo.' },
    fr: { cancelledSubject: 'Annulé : {{title}}', rescheduledSubject: 'Reprogrammé : {{title}}', cancelled: 'Votre réservation pour « {{title}} » a été annulée.', rescheduled: 'Votre réservation pour « {{title}} » a été reprogrammée. L’ancien créneau ({{when}}) est annulé — votre nouvelle confirmation arrive dans un e-mail séparé.' },
    'pt-BR': { cancelledSubject: 'Cancelado: {{title}}', rescheduledSubject: 'Remarcado: {{title}}', cancelled: 'Sua reserva de "{{title}}" foi cancelada.', rescheduled: 'Sua reserva de "{{title}}" foi remarcada. O horário anterior ({{when}}) foi cancelado — sua nova confirmação chega em outro e-mail.' },
  },
  compose: (f, d) => ({
    subject: f.subject(d.rescheduled ? 'rescheduledSubject' : 'cancelledSubject', { title: d.title }),
    text: d.rescheduled ? f.text('rescheduled', { title: d.title, when: d.previousUtc }) : f.text('cancelled', { title: d.title }),
  }),
};

export function registerBookingTransactionalTemplates(): void {
  registerTransactionalTemplate(bookingConfirmedTemplate);
  registerTransactionalTemplate(bookingCancelledTemplate);
}
