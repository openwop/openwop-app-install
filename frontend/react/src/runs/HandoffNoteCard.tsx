/**
 * ADR 0829 P3 — the ONE renderer of a structured handoff note (intent,
 * decisions and who made them, open questions, what was tried, confidence).
 *
 * Used by the handoff strip (an expanded chip), the run page above an
 * escalation's resume form, and a child run's page ("handed off with this
 * note"). Text renders as plain React text — never as Markdown or HTML — because
 * another model wrote it. `producedBy` is shown as a claim, not a verified fact.
 */
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { BotIcon, InfoIcon, UserIcon } from '../ui/icons/index.js';
import { formatPercent } from '../i18n/format.js';
import type { HandoffNote } from './handoffNote.js';

interface Props {
  note: HandoffNote;
  /** The card's heading — the caller names the context ("Why this needs you", …). */
  title: string;
  /** Lets a caller point `aria-controls` at the card. */
  id?: string;
  /** The heading level that fits the caller's outline (default 3, inside a section card).
   *  Section labels render one level below it, so the outline never skips a level. */
  headingLevel?: 2 | 3;
  /** `inline` drops the card chrome, for a note shown INSIDE another card (a kanban card). */
  variant?: 'card' | 'inline';
}

export function HandoffNoteCard({ note, title, id, headingLevel = 3, variant = 'card' }: Props) {
  const { t } = useTranslation('runs');
  const headingId = useId();
  const Label = headingLevel === 2 ? 'h3' : 'h4';
  const source = note.producedBy === 'agent'
    ? { Icon: BotIcon, label: t('handoffNoteFromAgent'), chip: 'chip--ai' }
    : note.producedBy === 'host'
      ? { Icon: InfoIcon, label: t('handoffNoteFromHost'), chip: 'chip--muted' }
      : { Icon: UserIcon, label: t('handoffNoteFromPerson'), chip: 'chip--muted' };

  return (
    <section className={variant === 'inline' ? 'handoff-note handoff-note--inline' : 'surface-card handoff-note'} aria-labelledby={headingId} {...(id ? { id } : {})}>
      <div className="handoff-note-head">
        {headingLevel === 2
          ? <h2 id={headingId} className="handoff-note-title">{title}</h2>
          : <h3 id={headingId} className="handoff-note-title">{title}</h3>}
        <span className={`chip ${source.chip}`}>
          <source.Icon size={12} />
          {source.label}
        </span>
      </div>
      <p className="handoff-note-intent">{note.intent}</p>

      {note.decisions.length > 0 && (
        <div className="handoff-note-section">
          <Label className="handoff-note-label">{t('handoffNoteDecisions')}</Label>
          <ul>
            {note.decisions.map((d, i) => (
              <li key={i}>
                {d.summary}
                {d.decidedBy && <span className="muted"> — {t('handoffNoteDecidedBy', { who: d.decidedBy })}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {note.openQuestions.length > 0 && (
        <div className="handoff-note-section">
          <Label className="handoff-note-label">{t('handoffNoteOpenQuestions')}</Label>
          <ul>{note.openQuestions.map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
      )}
      {note.tried.length > 0 && (
        <div className="handoff-note-section">
          <Label className="handoff-note-label">{t('handoffNoteTried')}</Label>
          <ul>
            {note.tried.map((x, i) => (
              <li key={i}>
                {x.approach}
                {x.droppedBecause && <span className="muted"> — {t('handoffNoteDroppedBecause', { why: x.droppedBecause })}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {note.confidence && (
        <p className="handoff-note-confidence muted">
          {note.producedBy === 'human'
            ? t('handoffNoteConfidenceLevel', { level: t(humanConfidenceKey(note.confidence.value)) })
            : t('handoffNoteConfidence', { value: formatPercent(note.confidence.value) })}
          {note.confidence.basis && ` — ${note.confidence.basis}`}
        </p>
      )}
    </section>
  );
}

/** A person picked low / medium / high (stored 0.3 / 0.6 / 0.9); show the word, not a percentage. */
function humanConfidenceKey(value: number): string {
  if (value < 0.45) return 'handoffNoteConfidenceLow';
  if (value < 0.75) return 'handoffNoteConfidenceMedium';
  return 'handoffNoteConfidenceHigh';
}
