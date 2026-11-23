/**
 * ADR 0957 D7 — the email that carries a published client report's link, as a
 * registered transactional kind (ADR 0905 D6) in the four product locales.
 *
 * It carries THE LINK ONLY: the client's name, the report's title and the URL.
 * No figure, no period total, no narrative. A forwarded email leaks no numbers;
 * the numbers stay behind the grant-backed link, which re-checks on every view.
 * The title is the agency's own label for the definition, not a computed value.
 */
import { registerTransactionalTemplate, type TransactionalTemplate } from '../../../host/transactionalEmail.js';

export const CLIENT_REPORT_LINK_KIND = 'campaign-ops.client-report-link';

export interface ClientReportLinkMailData { clientName: string; title: string; url: string }

export const clientReportLinkTemplate: TransactionalTemplate<ClientReportLinkMailData> = {
  kind: CLIENT_REPORT_LINK_KIND,
  catalog: {
    en: {
      subject: 'Your report is ready: {{title}}',
      lead: 'A new report for {{clientName}} is ready: "{{title}}".',
      open: 'Open the report: {{url}}',
      private: 'This link is for you. It stops working if your access is removed or the report is withdrawn.',
    },
    es: {
      subject: 'Tu informe está listo: {{title}}',
      lead: 'Hay un nuevo informe para {{clientName}}: «{{title}}».',
      open: 'Abrir el informe: {{url}}',
      private: 'Este enlace es para ti. Deja de funcionar si se retira tu acceso o se retira el informe.',
    },
    fr: {
      subject: 'Votre rapport est prêt : {{title}}',
      lead: 'Un nouveau rapport pour {{clientName}} est prêt : « {{title}} ».',
      open: 'Ouvrir le rapport : {{url}}',
      private: 'Ce lien vous est destiné. Il cesse de fonctionner si votre accès est retiré ou si le rapport est retiré.',
    },
    'pt-BR': {
      subject: 'Seu relatório está pronto: {{title}}',
      lead: 'Há um novo relatório para {{clientName}}: "{{title}}".',
      open: 'Abrir o relatório: {{url}}',
      private: 'Este link é para você. Ele deixa de funcionar se o seu acesso for removido ou se o relatório for retirado.',
    },
  },
  compose: (f, d) => ({
    subject: f.subject('subject', { title: d.title }),
    text: [f.text('lead', { clientName: d.clientName, title: d.title }), '', f.text('open', { url: d.url }), '', f.text('private')].join('\n'),
  }),
};

export function registerClientReportLinkTemplate(): void {
  registerTransactionalTemplate(clientReportLinkTemplate);
}
