/**
 * NLCoercionCard — RFC 0032 §B.5 `envelope.nlToFormat.engaged` event.
 *
 * The model returned natural-language prose where the host expected a
 * structured envelope; the host invoked the NL→format coercion path
 * (a second LLM call that translates the prose into the right shape).
 * Quiet info chip — most users don't need to think about this, but the
 * extra round-trip is visible to anyone counting tokens.
 */

import { useTranslation } from 'react-i18next';
import type { EnvelopeNLCoercion } from '../types.js';

interface Props {
  coercion: EnvelopeNLCoercion;
}

export function NLCoercionCard({ coercion }: Props): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <div className="env-chip env-chip-info" role="status" aria-label={t('nlCoercionTitle')}>
      <span className="env-chip-tag">{t('nlCoercionBadge')}</span>
      <span className="env-chip-text">
        {t('nlCoercionPrefix')}<span className="env-chip-mono">{coercion.originalEnvelopeType}</span>
        {typeof coercion.fallbackCalls === 'number' ? (
          <> · {t('fallbackCalls', { count: coercion.fallbackCalls })}</>
        ) : null}
      </span>
    </div>
  );
}
