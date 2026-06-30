/**
 * RecoveryCard — RFC 0032 §B.6 `envelope.recovery.applied` event.
 *
 * The host recovered a partial envelope by parsing up to a specific
 * byte offset. Technical / low-noise; renders as a tiny mono chip.
 * Mostly useful next to a TruncationCard for the same node.
 */

import { useTranslation } from 'react-i18next';
import { formatNumber } from '../../i18n/format.js';
import type { EnvelopeRecovery } from '../types.js';

interface Props {
  recovery: EnvelopeRecovery;
}

export function RecoveryCard({ recovery }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <div className="env-chip env-chip-muted" role="status" aria-label={t('recoveryTitle')}>
      <span className="env-chip-tag">{t('recoveryBadge')}</span>
      <span className="env-chip-text">
        {t('recoveryPrefix')}<span className="env-chip-mono">{recovery.path}</span>
        {typeof recovery.byteOffset === 'number' ? (
          <> · <span className="env-chip-mono">{t('recoveryByteOffset', { offset: formatNumber(recovery.byteOffset) })}</span></>
        ) : null}
      </span>
    </div>
  );
}
