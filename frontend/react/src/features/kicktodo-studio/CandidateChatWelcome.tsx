/**
 * Empty-state for the candidate workspace's embedded Challenge Author chat
 * (ADR 0461 P3). Candidate-focused — no workflow portfolio here (that lives on
 * the Studio index welcome); instead, example intents that carry the candidate
 * id + topic VERBATIM in the seeded text, so the model's first turn holds the
 * durable id its `openwop:kicktodo.candidates` tool needs. The id is shown in
 * the mono provenance register BEFORE any click — what gets seeded is visible,
 * never hidden context (the architect-review refinement; no system-prompt
 * injection, one scoping mechanism: the pack persona).
 */
import { useTranslation } from 'react-i18next';
import { WandIcon, ListIcon, ActivityIcon, ZapIcon } from '../../ui/icons/index.js';

const EXAMPLES = [
  { key: 'outline', Glyph: ListIcon, titleKey: 'candExOutlineTitle', textKey: 'candExOutlineText' },
  { key: 'status', Glyph: ActivityIcon, titleKey: 'candExStatusTitle', textKey: 'candExStatusText' },
  { key: 'rework', Glyph: ZapIcon, titleKey: 'candExReworkTitle', textKey: 'candExReworkText' },
] as const;

export function CandidateChatWelcome({ onPick, candidateId, topic }: {
  onPick: (text: string) => void;
  candidateId: string;
  topic: string;
}): JSX.Element {
  const { t } = useTranslation('kicktodo-studio');
  return (
    <div className="welcome-root">
      <div className="welcome-icon-circle" aria-hidden><WandIcon size={22} /></div>
      <h3 className="welcome-title">{t('candWelcomeTitle')}</h3>
      <p className="muted welcome-lede">{t('candWelcomeBody')}</p>
      {/* The provenance line: exactly what every example below will reference. */}
      <p className="studio-id">{candidateId}</p>
      <div className="welcome-agents-label">{t('candExamplesLabel')}</div>
      <div className="welcome-grid">
        {EXAMPLES.map(({ key, Glyph, titleKey, textKey }) => (
          <button key={key} type="button" className="welcome-card"
            onClick={() => onPick(t(textKey, { id: candidateId, topic }))}>
            <span className="welcome-card-head">
              <span className="welcome-card-icon" aria-hidden><Glyph size={16} /></span>
              <span className="welcome-card-title">{t(titleKey)}</span>
            </span>
            <span className="welcome-card-desc">{t(textKey, { id: candidateId, topic })}</span>
          </button>
        ))}
      </div>
      <p className="muted welcome-footnote">{t('candWelcomeFootnote')}</p>
    </div>
  );
}
