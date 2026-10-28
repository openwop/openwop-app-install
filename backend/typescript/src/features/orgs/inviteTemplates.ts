/**
 * The org invitation email as a registered transactional kind (ADR 0905 D6), in the
 * four product locales. Delivery stays the inviter's brokered connection
 * (`inviteDelivery.ts`); only the copy moved here.
 */
import { registerTransactionalTemplate, type TransactionalTemplate } from '../../host/transactionalEmail.js';

export const ORG_INVITATION_KIND = 'org.invitation';

export interface OrgInvitationData {
  /** The inviter's display name — absent when it is unknown or looks like an address. */
  inviter?: string;
  orgName: string;
  role: string;
  acceptUrl: string;
  /** `YYYY-MM-DD`. */
  expiresDay: string;
}

export const orgInvitationTemplate: TransactionalTemplate<OrgInvitationData> = {
  kind: ORG_INVITATION_KIND,
  catalog: {
    en: {
      subjectBy: '{{inviter}} invited you to join {{org}}', subjectAnon: "You've been invited to join {{org}}",
      leadBy: '{{inviter}} has invited you to join {{org}} as {{role}}.', leadAnon: 'You have been invited to join {{org}} as {{role}}.',
      accept: 'Accept your invitation:\n{{url}}',
      expiry: 'This link is single-use and expires on {{day}}. If you were not expecting this invitation, you can ignore this email.',
    },
    es: {
      subjectBy: '{{inviter}} te invitó a unirte a {{org}}', subjectAnon: 'Te invitaron a unirte a {{org}}',
      leadBy: '{{inviter}} te ha invitado a unirte a {{org}} como {{role}}.', leadAnon: 'Te han invitado a unirte a {{org}} como {{role}}.',
      accept: 'Acepta tu invitación:\n{{url}}',
      expiry: 'Este enlace es de un solo uso y caduca el {{day}}. Si no esperabas esta invitación, puedes ignorar este correo.',
    },
    fr: {
      subjectBy: '{{inviter}} vous a invité à rejoindre {{org}}', subjectAnon: 'Vous avez été invité à rejoindre {{org}}',
      leadBy: '{{inviter}} vous a invité à rejoindre {{org}} en tant que {{role}}.', leadAnon: 'Vous avez été invité à rejoindre {{org}} en tant que {{role}}.',
      accept: 'Acceptez votre invitation :\n{{url}}',
      expiry: 'Ce lien est à usage unique et expire le {{day}}. Si vous n’attendiez pas cette invitation, vous pouvez ignorer cet e-mail.',
    },
    'pt-BR': {
      subjectBy: '{{inviter}} convidou você para entrar em {{org}}', subjectAnon: 'Você foi convidado para entrar em {{org}}',
      leadBy: '{{inviter}} convidou você para entrar em {{org}} como {{role}}.', leadAnon: 'Você foi convidado para entrar em {{org}} como {{role}}.',
      accept: 'Aceite seu convite:\n{{url}}',
      expiry: 'Este link é de uso único e expira em {{day}}. Se você não esperava este convite, pode ignorar este e-mail.',
    },
  },
  compose(f, d) {
    const v = { inviter: d.inviter ?? '', org: d.orgName, role: d.role };
    return {
      subject: f.subject(d.inviter ? 'subjectBy' : 'subjectAnon', v),
      text: [f.text(d.inviter ? 'leadBy' : 'leadAnon', v), f.text('accept', { url: d.acceptUrl }), f.text('expiry', { day: d.expiresDay })].join('\n\n'),
    };
  },
};

export function registerOrgsTransactionalTemplates(): void {
  registerTransactionalTemplate(orgInvitationTemplate);
}
