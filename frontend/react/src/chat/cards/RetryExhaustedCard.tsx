/**
 * RetryExhaustedCard — RFC 0032 §B.2 `envelope.retry.exhausted` event.
 *
 * Action-required state: the host gave up after N attempts. Clay-rule
 * outline marks the urgency.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import type { EnvelopeRetryExhausted } from '../types.js';

interface Props {
  exhausted: EnvelopeRetryExhausted;
}

export function RetryExhaustedCard({ exhausted }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  return (
    <div className="env-chip env-chip-danger" role="alert" aria-label={t('retryExhaustedTitle')}>
      <span className="env-chip-tag">{t('retryExhaustedBadge')}</span>
      <span className="env-chip-text">
        {t('gaveUpAfter', { count: exhausted.totalAttempts, formattedCount: formatNumber(exhausted.totalAttempts) })}{exhausted.finalReason}
      </span>
      {exhausted.finalError ? (
        <button
          type="button"
          className="env-chip-toggle"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? t('hideError') : t('showError')}
        </button>
      ) : null}
      {open && exhausted.finalError ? (
        <pre className="env-chip-detail">{exhausted.finalError}</pre>
      ) : null}
    </div>
  );
}
