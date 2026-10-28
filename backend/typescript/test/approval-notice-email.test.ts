/**
 * ADR 0905 P3 (D6, approval-notice sender) — the approval notice email renders through
 * the host transactional registry as `approval.notice` in the four product locales, with
 * decide-by-email links for interrupt gates and a link-out otherwise.
 *
 * Sabotage-witnessed: hard-coding the English "Approve:" line reds three locale goldens.
 */
import { describe, expect, it } from 'vitest';
import { renderTransactional, TRANSACTIONAL_LOCALES } from '../src/host/transactionalEmail.js';
import { APPROVAL_NOTICE_KIND, type ApprovalNoticeData } from '../src/host/approvalNoticeTemplates.js';

const withLinks: ApprovalNoticeData = { title: 'Approve the launch', message: 'A run is waiting.', inboxUrl: 'https://app.example/inbox', approveUrl: 'https://app.example/a', rejectUrl: 'https://app.example/r' };
const first: Record<string, string> = { en: 'Approve: https://app.example/a', es: 'Aprobar: https://app.example/a', fr: 'Approuver : https://app.example/a', 'pt-BR': 'Aprovar: https://app.example/a' };

describe('approval.notice — four product locales', () => {
  for (const locale of TRANSACTIONAL_LOCALES) {
    it(`${locale}: subject is the title; the decide links are localized`, () => {
      const r = renderTransactional(APPROVAL_NOTICE_KIND, withLinks, { locale });
      expect(r.subject).toBe('Approve the launch');
      const lines = r.text.split('\n');
      expect(lines[0]).toBe('A run is waiting.');
      expect(lines[2]).toBe(first[locale]);
    });
  }
  it('without decide links it is a link-out to the inbox', () => {
    const r = renderTransactional(APPROVAL_NOTICE_KIND, { title: 't', message: 'm', inboxUrl: 'https://app.example/inbox' }, { locale: 'en' });
    expect(r.text).toBe('m\n\nReview in the app: https://app.example/inbox');
  });
});
