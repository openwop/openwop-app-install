/**
 * ADR 0905 P3 (D6, invitations sender) — the org invitation email renders through the
 * host transactional registry as `org.invitation`, in the four product locales.
 * Delivery is unchanged (the inviter's brokered connection, `orgs-invite-delivery.test.ts`).
 *
 * Sabotage-witnessed: hard-coding the English lead line reds three locale goldens; letting
 * a CRLF in the org name through reds the header case.
 */
import { describe, expect, it } from 'vitest';
import { renderTransactional, TRANSACTIONAL_LOCALES } from '../src/host/transactionalEmail.js';
import { ORG_INVITATION_KIND, registerOrgsTransactionalTemplates, type OrgInvitationData } from '../src/features/orgs/inviteTemplates.js';

registerOrgsTransactionalTemplates();

const data: OrgInvitationData = { inviter: 'Dana', orgName: 'Acme', role: 'editor', acceptUrl: 'https://app.example/invitations/accept?token=t', expiresDay: '2026-11-01' };
const golden: Record<string, { subject: string; text: string }> = {
  en: { subject: 'Dana invited you to join Acme', text: 'Dana has invited you to join Acme as editor.\n\nAccept your invitation:\nhttps://app.example/invitations/accept?token=t\n\nThis link is single-use and expires on 2026-11-01. If you were not expecting this invitation, you can ignore this email.' },
  es: { subject: 'Dana te invitó a unirte a Acme', text: 'Dana te ha invitado a unirte a Acme como editor.\n\nAcepta tu invitación:\nhttps://app.example/invitations/accept?token=t\n\nEste enlace es de un solo uso y caduca el 2026-11-01. Si no esperabas esta invitación, puedes ignorar este correo.' },
  fr: { subject: 'Dana vous a invité à rejoindre Acme', text: 'Dana vous a invité à rejoindre Acme en tant que editor.\n\nAcceptez votre invitation :\nhttps://app.example/invitations/accept?token=t\n\nCe lien est à usage unique et expire le 2026-11-01. Si vous n’attendiez pas cette invitation, vous pouvez ignorer cet e-mail.' },
  'pt-BR': { subject: 'Dana convidou você para entrar em Acme', text: 'Dana convidou você para entrar em Acme como editor.\n\nAceite seu convite:\nhttps://app.example/invitations/accept?token=t\n\nEste link é de uso único e expira em 2026-11-01. Se você não esperava este convite, pode ignorar este e-mail.' },
};

describe('org.invitation — goldens in the four product locales', () => {
  for (const locale of TRANSACTIONAL_LOCALES) {
    it(locale, () => {
      const r = renderTransactional(ORG_INVITATION_KIND, data, { locale });
      expect({ subject: r.subject, text: r.text }).toEqual(golden[locale]);
    });
  }
  it('without a named inviter the copy does not invent one', () => {
    const { inviter: _i, ...anon } = data;
    const r = renderTransactional(ORG_INVITATION_KIND, anon, { locale: 'en' });
    expect(r.subject).toBe("You've been invited to join Acme");
    expect(r.text.startsWith('You have been invited to join Acme as editor.')).toBe(true);
  });
  it('a CRLF in the org name cannot reach a header', () => {
    const r = renderTransactional(ORG_INVITATION_KIND, { ...data, orgName: 'Acme\r\nBcc: x@evil.test' }, { locale: 'en' });
    expect(r.subject).not.toMatch(/[\r\n]/);
  });
});
