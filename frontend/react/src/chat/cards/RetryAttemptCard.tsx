/**
 * RetryAttemptCard — RFC 0032 §B.1 `envelope.retry.attempted` event.
 *
 * Mono "RETRY N" pill + reason chip + collapsed previousError details.
 * The narrative reads as: "The host re-asked the model because <reason>."
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import type { EnvelopeRetryAttempt } from '../types.js';

interface Props {
  retry: EnvelopeRetryAttempt;
}

const RETRY_REASON_KEY: Record<string, string> = {
  'schema-violation': 'retryReasonSchema',
  truncation: 'retryReasonTruncated',
  refusal: 'retryReasonRefusal',
};

export function RetryAttemptCard({ retry }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const reasonKey = RETRY_REASON_KEY[retry.reason];
  const reasonLabel = reasonKey ? t(reasonKey) : retry.reason;
  return (
    <div className="env-chip env-chip-info" role="status" aria-label={t('retryAttemptTitle', { attempt: formatNumber(retry.attempt) })}>
      <span className="env-chip-tag">{t('retryBadge', { attempt: formatNumber(retry.attempt) })}</span>
      <span className="env-chip-text">{t('retryPrefix')}{reasonLabel}</span>
      {retry.previousError ? (
        <button
          type="button"
          className="env-chip-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? t('hideError') : t('showError')}
        </button>
      ) : null}
      {open && retry.previousError ? (
        <pre className="env-chip-detail">{retry.previousError}</pre>
      ) : null}
    </div>
  );
}
