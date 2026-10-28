/**
 * The approval-notice email as a registered transactional kind (ADR 0905 D6) — the
 * MyndHyve `approval_requested` / `approval_escalated` port. Delivery stays
 * `emailApprovalDelivery.ts` (tenant-scope SMTP, transactional purpose); only the copy
 * moved here. The title and message come from the notification producer as written.
 */
import { registerTransactionalTemplate, type TransactionalTemplate } from './transactionalEmail.js';

export const APPROVAL_NOTICE_KIND = 'approval.notice';

export interface ApprovalNoticeData {
  title: string;
  message: string;
  inboxUrl: string;
  /** Decide-by-email links (interrupt gates only, RFC 0093). */
  approveUrl?: string;
  rejectUrl?: string;
}

export const approvalNoticeTemplate: TransactionalTemplate<ApprovalNoticeData> = {
  kind: APPROVAL_NOTICE_KIND,
  catalog: {
    en: {
      subject: '{{title}}', message: '{{message}}', approve: 'Approve: {{url}}', reject: 'Reject:  {{url}}',
      confirm: 'The links open a confirmation page (nothing happens until you confirm there).',
      orReview: 'Or review in the app: {{url}}', expires: 'Links expire with the request.', review: 'Review in the app: {{url}}',
    },
    es: {
      subject: '{{title}}', message: '{{message}}', approve: 'Aprobar: {{url}}', reject: 'Rechazar: {{url}}',
      confirm: 'Los enlaces abren una página de confirmación (no pasa nada hasta que confirmes allí).',
      orReview: 'O revísalo en la app: {{url}}', expires: 'Los enlaces caducan con la solicitud.', review: 'Revísalo en la app: {{url}}',
    },
    fr: {
      subject: '{{title}}', message: '{{message}}', approve: 'Approuver : {{url}}', reject: 'Refuser : {{url}}',
      confirm: 'Les liens ouvrent une page de confirmation (rien ne se passe tant que vous n’y confirmez pas).',
      orReview: 'Ou examinez-la dans l’application : {{url}}', expires: 'Les liens expirent avec la demande.', review: 'Examinez-la dans l’application : {{url}}',
    },
    'pt-BR': {
      subject: '{{title}}', message: '{{message}}', approve: 'Aprovar: {{url}}', reject: 'Rejeitar: {{url}}',
      confirm: 'Os links abrem uma página de confirmação (nada acontece até você confirmar lá).',
      orReview: 'Ou revise no app: {{url}}', expires: 'Os links expiram junto com a solicitação.', review: 'Revise no app: {{url}}',
    },
  },
  compose(f, d) {
    const message = f.text('message', { message: d.message }); // the producer's text, cleaned like any value
    const text = d.approveUrl && d.rejectUrl
      ? [message, '', f.text('approve', { url: d.approveUrl }), f.text('reject', { url: d.rejectUrl }), '', f.text('confirm'), f.text('orReview', { url: d.inboxUrl }), f.text('expires')].join('\n')
      : [message, '', f.text('review', { url: d.inboxUrl })].join('\n');
    return { subject: f.subject('subject', { title: d.title }), text };
  },
};

// Host core registers its own kind at module load (no feature boot owns host/).
registerTransactionalTemplate(approvalNoticeTemplate);
