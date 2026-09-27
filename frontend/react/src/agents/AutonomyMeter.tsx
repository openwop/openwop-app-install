import { useTranslation } from 'react-i18next';

/**
 * Autonomy meter — the 3-bar Supervised / Guided / Autonomous scale on the
 * host-ext `autonomyLevel` field. All three positions are LIVE (architect
 * memo 2026-06-05):
 *   review → 1 · Supervised (every heartbeat pick proposes for sign-off)
 *   guided → 2 · Guided (routine picks run; HIGH-priority picks propose)
 *   auto   → 3 · Autonomous (every pick runs immediately)
 *
 * `level` drives the filled-bar count; the operator label + gloss are i18n
 * keys in the `agents` catalog (so es/fr/pt-BR are covered — the labels were
 * previously hardcoded English). The label set is the canonical autonomy
 * vocabulary shared with /workforces (DESIGN.md §5.3).
 */
const LEVELS = {
  review: { level: 1, labelKey: 'autonomySupervised', glossKey: 'autonomySupervisedHelp' },
  guided: { level: 2, labelKey: 'autonomyGuided', glossKey: 'autonomyGuidedHelp' },
  auto: { level: 3, labelKey: 'autonomyAutonomous', glossKey: 'autonomyAutonomousHelp' },
} as const;

export function AutonomyMeter({ autonomyLevel, showLabel = true }: {
  /** The roster entry's host-ext field; absent ⇒ `auto`. */
  autonomyLevel: 'auto' | 'guided' | 'review' | undefined;
  showLabel?: boolean;
}): JSX.Element {
  const { t } = useTranslation('agents');
  const meta = LEVELS[autonomyLevel === 'review' || autonomyLevel === 'guided' ? autonomyLevel : 'auto'];
  const label = t(meta.labelKey);
  const gloss = t(meta.glossKey);
  return (
    <span
      className="auto-meter"
      // role="img": this is a visual gauge (filled dots). A bare <span> may not
      // carry aria-label (aria-prohibited-attr); role=img makes it a named
      // graphic, so SRs announce "Autonomy: Autonomous" instead of the bars.
      role="img"
      title={t('autonomyTitle', { label, gloss })}
      aria-label={t('autonomyAria', { label })}
    >
      <span className="auto-meter-dots" aria-hidden>
        {[0, 1, 2].map((i) => {
          // dots below current = done (granted), at current = emphasized, above = future
          const tone = i < meta.level - 1 ? ' auto-meter-dot--done' : i === meta.level - 1 ? ' auto-meter-dot--current' : '';
          return <i key={i} className={`auto-meter-dot${tone}`} />;
        })}
      </span>
      {showLabel ? <span className="auto-meter-label" aria-hidden>{label}</span> : null}
    </span>
  );
}
