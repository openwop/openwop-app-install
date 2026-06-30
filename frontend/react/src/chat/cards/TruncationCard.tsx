/**
 * TruncationCard — RFC 0032 §B.4 `envelope.truncated` event.
 *
 * The model stopped emitting before the envelope was complete. Surfaces
 * the stop reason + the partial-payload availability + (when known) the
 * output token count. Sets a hint chip when a continuation retry with a
 * bumped budget is in flight (RFC 0033).
 */

import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import type { EnvelopeTruncation } from '../types.js';

interface Props {
  truncation: EnvelopeTruncation;
}

const STOP_REASON_KEY: Record<string, string> = {
  max_tokens: 'truncReasonMaxTokens',
  length: 'truncReasonLength',
  stop_sequence: 'truncReasonStopSequence',
};

export function TruncationCard({ truncation }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  const reasonKey = STOP_REASON_KEY[truncation.stopReason];
  const reasonLabel = reasonKey ? t(reasonKey) : truncation.stopReason;
  return (
    <div className="env-chip env-chip-warning" role="status" aria-label={t('truncatedTitle')}>
      <span className="env-chip-tag">{t('truncatedBadge')}</span>
      <span className="env-chip-text">
        <span className="env-chip-mono">{truncation.provider}/{truncation.model}</span> — {reasonLabel}
        {typeof truncation.outputTokenCount === 'number' ? (
          <> · <span className="env-chip-mono">{t('truncatedTokens', { count: formatNumber(truncation.outputTokenCount) })}</span></>
        ) : null}
      </span>
      {truncation.partialPayloadAvailable ? (
        <span className="env-chip-pill">{t('partialPayloadRecovered')}</span>
      ) : null}
    </div>
  );
}
