import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

// ── Stepper ────────────────────────────────────────────────────────────

export function BYOKStepper({ current }: { current: 'provider' | 'model' | 'key' }): JSX.Element {
  const { t } = useTranslation('byok');
  const steps = useMemo(() => [
    { id: 'provider', label: t('stepProvider') },
    { id: 'model', label: t('stepModel') },
    { id: 'key', label: t('stepKey') },
  ] as const, [t]);
  const currentIdx = steps.findIndex((s) => s.id === current);
  return (
    <ol className="byok-stepper">
      {steps.map((s, i) => {
        const done = i < currentIdx;
        const active = i === currentIdx;
        return (
          <li key={s.id} className={`byok-stepper-step${active ? ' is-active' : done ? ' is-done' : ''}`}>
            <div className="byok-stepper-bar" />
            <span className="byok-stepper-label">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
