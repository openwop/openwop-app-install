/**
 * ADR 0905 P3 (D6, e-sign sender) — the signer request and completion emails render
 * through the host transactional registry in the four product locales; the legal
 * notice stays verbatim English in every locale (counsel-owned text).
 *
 * Sabotage-witnessed: hard-coding the English lead line reds three locale goldens.
 */
import { describe, expect, it } from 'vitest';
import { renderTransactional, TRANSACTIONAL_LOCALES } from '../src/host/transactionalEmail.js';
import { SIGN_REQUEST_KIND, SIGN_COMPLETED_KIND, SIGN_LEGAL_NOTICE, registerSignTransactionalTemplates } from '../src/features/crm/signTemplates.js';

registerSignTransactionalTemplates();
const d = { title: 'MSA', url: 'https://app.example/sign/t' };
const lead: Record<string, string> = {
  en: 'You have been asked to review and sign "MSA".', es: 'Te han pedido revisar y firmar «MSA».',
  fr: 'Vous êtes invité à relire et signer « MSA ».', 'pt-BR': 'Pediram que você revise e assine "MSA".',
};

describe('crm.sign-request / crm.sign-completed — four locales', () => {
  for (const locale of TRANSACTIONAL_LOCALES) {
    it(locale, () => {
      const r = renderTransactional(SIGN_REQUEST_KIND, d, { locale });
      expect(r.text.split('\n')[0]).toBe(lead[locale]);
      expect(r.text.endsWith(SIGN_LEGAL_NOTICE)).toBe(true);
      expect(renderTransactional(SIGN_COMPLETED_KIND, d, { locale }).text).toContain('https://app.example/sign/t');
    });
  }
  it('english goldens are the pre-registry copy', () => {
    expect(renderTransactional(SIGN_REQUEST_KIND, d, { locale: 'en' })).toMatchObject({
      subject: 'Signature requested: MSA',
      text: ['You have been asked to review and sign "MSA".', '', 'Open to sign: https://app.example/sign/t', '', SIGN_LEGAL_NOTICE].join('\n'),
    });
    expect(renderTransactional(SIGN_COMPLETED_KIND, d, { locale: 'en' }).subject).toBe('Signed: MSA');
  });
});
