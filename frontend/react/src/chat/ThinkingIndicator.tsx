/**
 * Pre-token "thinking" heartbeat shown in an assistant bubble before any
 * content or reasoning has streamed. Three muted dots whose pulse tempo is the
 * REAL streamed cadence (`--think-dur` from `useStreamCadence`): a calm beat
 * while the model deliberates, quickening the instant output begins.
 *
 * Shares the `.think-dot` look with the in-flight ThoughtsDisclosure so the
 * bare state and the reasoning disclosure read as one continuous gesture.
 * Reduced-motion is handled in global.css (dots hold static, still visible).
 */

import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

export function ThinkingIndicator({ durationVar }: { durationVar: string }): JSX.Element {
  const { t } = useTranslation('chat');
  return (
    <span
      className="think-indicator"
      style={{ '--think-dur': durationVar } as CSSProperties}
      aria-live="polite"
    >
      <span>{t('thinkingLabel')}</span>
      <span className="think-dots u-gap-0-5" aria-hidden>
        <span className="think-dot" />
        <span className="think-dot" />
        <span className="think-dot" />
      </span>
    </span>
  );
}
