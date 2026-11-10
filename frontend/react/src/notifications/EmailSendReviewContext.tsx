/**
 * ADR 0905 D3 — what an `email-campaign-send` approval covers, shown on its inbox card:
 * the PINNED template version's subject and body (approve what you see), the sender,
 * the audience definition, and the recipient count at submit, labelled as an estimate
 * (membership is resolved at send, after consent and suppression).
 *
 * A row without `emailSend.reviewHash` cannot be approved: the server refuses an approve
 * that does not echo the digest. Every deciding surface (`/inbox`, the Approvals inbox,
 * the chat review card) disables Approve on `!emailSendApprovable(row)`, and this
 * component says why (NYI-EMAIL-1 and its follow-up).
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../i18n/format.js';
import type { PendingApproval } from '../agents/approvalsClient.js';

/** True when the row carries the digest an approve must echo. */
export function emailSendApprovable(a: Pick<PendingApproval, 'emailSend'>): boolean {
  return !!a.emailSend?.reviewHash;
}

export function EmailSendReviewContext({ a }: { a: Pick<PendingApproval, 'emailSend'> }): JSX.Element | null {
  const { t } = useTranslation('notifications');
  const e = a.emailSend;
  const missing = emailSendApprovable(a) ? null : <p className="muted u-fs-12 u-m-0">{t('emailReviewMissing')}</p>;
  if (!e) return missing;
  return (
    <div className="u-grid u-gap-1 u-fs-13">
      <div className="u-flex u-gap-2 u-wrap u-items-center">
        <span className="chip chip--muted">{t('emailReviewVersion', { version: formatNumber(e.templateVersion) })}</span>
        <span>{t('emailReviewFrom', { sender: e.senderAddress })}</span>
        <span>{t('emailReviewAudience', { audience: e.audienceLabel })}</span>
        {typeof e.estimatedRecipients === 'number'
          ? <span className="muted">{t('emailReviewEstimate', { count: e.estimatedRecipients, n: formatNumber(e.estimatedRecipients) })}</span>
          : null}
      </div>
      <div className="surface-inset u-grid u-gap-1">
        <strong>{e.subject}</strong>
        <pre className="u-fs-13 u-m-0 u-prewrap">{e.body}</pre>
      </div>
      {missing}
    </div>
  );
}
