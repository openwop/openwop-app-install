/**
 * CapabilitySubstitutionCard — RFC 0031 §D `model.capability.substituted` event.
 *
 * The host silently substituted a fallback model because the configured
 * model lacked one or more capabilities the workflow needed. Copy leads
 * with the *missing capability* (not the model swap), because that's the
 * user-relevant cause — the swap is the mechanism.
 */

import { useTranslation } from 'react-i18next';
import type { ModelCapabilitySubstitution } from '../types.js';

interface Props {
  sub: ModelCapabilitySubstitution;
}

export function CapabilitySubstitutionCard({ sub }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <div className="env-chip env-chip-info" role="status" aria-label={t('capSubstitutionTitle')}>
      <span className="env-chip-tag">{t('capSubstitutionBadge')}</span>
      <span className="env-chip-text">
        {t('routedAroundMissing')}{' '}
        {sub.missingCapabilities.map((c, i) => (
          <span key={c}>
            <span className="env-chip-pill">{c}</span>
            {i < sub.missingCapabilities.length - 1 ? ' ' : ''}
          </span>
        ))}
        {' '}— <span className="env-chip-mono">{sub.originalProvider}/{sub.originalModel}</span>
        {' → '}
        <span className="env-chip-mono">{sub.fallbackProvider}/{sub.fallbackModel}</span>
      </span>
    </div>
  );
}
