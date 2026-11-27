/**
 * ADR 0924 P2c — the email that carries a client approver's link to one change
 * set, as a registered transactional kind (ADR 0905 D6) in the four product
 * locales. The ADR 0957 D7 report-link email is the precedent.
 *
 * It carries THE LINK ONLY: the client's name and the URL. No change, no diff,
 * no request text, so a forwarded email shows nothing. When the link is
 * recipient-bound (ADR 1141), the email says opening it asks for a code sent to
 * this address: a forwardee who clicks it cannot read or decide.
 */
import { registerTransactionalTemplate, type TransactionalTemplate } from '../../host/transactionalEmail.js';

export const APPROVAL_LINK_KIND = 'campaign-ops.approval-link';

export interface ApprovalLinkMailData { clientName: string; url: string; verified: boolean }

export const approvalLinkTemplate: TransactionalTemplate<ApprovalLinkMailData> = {
  kind: APPROVAL_LINK_KIND,
  catalog: {
    en: {
      subject: 'A change for {{clientName}} needs your approval',
      lead: 'Your agency asked you to review a change for {{clientName}}.',
      open: 'Review it here: {{url}}',
      code: 'When you open the link, we will email a one-time code to this address.',
      private: 'This link is for you. Please do not forward it. It stops working when the change is decided or updated.',
    },
    es: {
      subject: 'Un cambio para {{clientName}} necesita tu aprobación',
      lead: 'Tu agencia te pidió revisar un cambio para {{clientName}}.',
      open: 'Revísalo aquí: {{url}}',
      code: 'Al abrir el enlace, te enviaremos un código de un solo uso a esta dirección.',
      private: 'Este enlace es para ti. No lo reenvíes. Deja de funcionar cuando el cambio se decide o se actualiza.',
    },
    fr: {
      subject: 'Une modification pour {{clientName}} attend votre approbation',
      lead: 'Votre agence vous demande de vérifier une modification pour {{clientName}}.',
      open: 'Vérifiez-la ici : {{url}}',
      code: "En ouvrant le lien, vous recevrez un code à usage unique à cette adresse.",
      private: 'Ce lien vous est destiné. Merci de ne pas le transférer. Il cesse de fonctionner quand la modification est décidée ou mise à jour.',
    },
    'pt-BR': {
      subject: 'Uma alteração para {{clientName}} precisa da sua aprovação',
      lead: 'Sua agência pediu que você revise uma alteração para {{clientName}}.',
      open: 'Revise aqui: {{url}}',
      code: 'Ao abrir o link, enviaremos um código de uso único para este endereço.',
      private: 'Este link é para você. Não o encaminhe. Ele deixa de funcionar quando a alteração é decidida ou atualizada.',
    },
  },
  compose: (f, d) => ({
    subject: f.subject('subject', { clientName: d.clientName }),
    text: [
      f.text('lead', { clientName: d.clientName }), '', f.text('open', { url: d.url }), '',
      ...(d.verified ? [f.text('code'), ''] : []),
      f.text('private'),
    ].join('\n'),
  }),
};

export function registerApprovalLinkTemplate(): void {
  registerTransactionalTemplate(approvalLinkTemplate);
}
