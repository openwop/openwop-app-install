/**
 * The e-signature emails as registered transactional kinds (ADR 0905 D6): the signer
 * request and the completion notice, in the four product locales. Delivery is unchanged
 * (`signService.ts`). The legal notice is kept VERBATIM in English in every locale:
 * it is a legal statement, and it is translated only by counsel, never by product copy.
 */
import { registerTransactionalTemplate, type TransactionalCatalog, type TransactionalTemplate } from '../../host/transactionalEmail.js';

export const SIGN_REQUEST_KIND = 'crm.sign-request';
export const SIGN_COMPLETED_KIND = 'crm.sign-completed';

export const SIGN_LEGAL_NOTICE =
  'This is a lightweight electronic-signature record (signer intent plus a cryptographic hash binding the signature to the exact signed content, with an audit trail). It is suitable for internal approvals and general business agreements under e-signature statutes that recognize electronic records (e.g. US ESIGN / UETA). It is NOT a qualified or advanced electronic signature under eIDAS, does not use a trust-service-provider certificate, and does not perform government-ID identity verification.';

export interface SignEmailData { title: string; url: string }

const withLegal = (c: Record<'en' | 'es' | 'fr' | 'pt-BR', Record<string, string>>): TransactionalCatalog => ({
  en: { ...c.en, legal: SIGN_LEGAL_NOTICE }, es: { ...c.es, legal: SIGN_LEGAL_NOTICE },
  fr: { ...c.fr, legal: SIGN_LEGAL_NOTICE }, 'pt-BR': { ...c['pt-BR'], legal: SIGN_LEGAL_NOTICE },
});

export const signRequestTemplate: TransactionalTemplate<SignEmailData> = {
  kind: SIGN_REQUEST_KIND,
  catalog: withLegal({
    en: { subject: 'Signature requested: {{title}}', lead: 'You have been asked to review and sign "{{title}}".', open: 'Open to sign: {{url}}' },
    es: { subject: 'Firma solicitada: {{title}}', lead: 'Te han pedido revisar y firmar «{{title}}».', open: 'Abrir para firmar: {{url}}' },
    fr: { subject: 'Signature demandée : {{title}}', lead: 'Vous êtes invité à relire et signer « {{title}} ».', open: 'Ouvrir pour signer : {{url}}' },
    'pt-BR': { subject: 'Assinatura solicitada: {{title}}', lead: 'Pediram que você revise e assine "{{title}}".', open: 'Abrir para assinar: {{url}}' },
  }),
  compose: (f, d) => ({
    subject: f.subject('subject', { title: d.title }),
    text: [f.text('lead', { title: d.title }), '', f.text('open', { url: d.url }), '', f.text('legal')].join('\n'),
  }),
};

export const signCompletedTemplate: TransactionalTemplate<SignEmailData> = {
  kind: SIGN_COMPLETED_KIND,
  catalog: withLegal({
    en: { subject: 'Signed: {{title}}', lead: 'Everyone has signed "{{title}}".', open: 'Download the signed certificate: {{url}}' },
    es: { subject: 'Firmado: {{title}}', lead: 'Todos han firmado «{{title}}».', open: 'Descarga el certificado firmado: {{url}}' },
    fr: { subject: 'Signé : {{title}}', lead: 'Tout le monde a signé « {{title}} ».', open: 'Téléchargez le certificat signé : {{url}}' },
    'pt-BR': { subject: 'Assinado: {{title}}', lead: 'Todos assinaram "{{title}}".', open: 'Baixe o certificado assinado: {{url}}' },
  }),
  compose: (f, d) => ({
    subject: f.subject('subject', { title: d.title }),
    text: [f.text('lead', { title: d.title }), '', f.text('open', { url: d.url }), '', f.text('legal')].join('\n'),
  }),
};

export function registerSignTransactionalTemplates(): void {
  registerTransactionalTemplate(signRequestTemplate);
  registerTransactionalTemplate(signCompletedTemplate);
}
