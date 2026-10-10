/**
 * HandoffDialog — ADR 0829 P4. A person handing a card to someone else writes a
 * short note for them: what this is for, what has been decided, what is still
 * open, what was already tried.
 *
 * The draft is prefilled from the card and lives only in this dialog's state:
 * NOTHING is sent until the person presses one of the two assign buttons
 * ("with note" / "without note"). Cancel sends nothing and leaves the card as
 * it was. Lists are one item per line.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button.js';
import { IconButton } from '../ui/IconButton.js';
import { XIcon } from '../ui/icons/index.js';
import { Modal } from '../ui/Modal.js';
import type { HandoffNoteDraft } from './kanbanClient.js';

/** A person states confidence as a word, not a number; these are the stored values. */
export const HANDOFF_CONFIDENCE = { low: 0.3, medium: 0.6, high: 0.9 } as const;
export type HandoffConfidenceLevel = keyof typeof HANDOFF_CONFIDENCE;

const lines = (s: string): string[] => s.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);

/** Build the wire draft from the form; empty lists are omitted. */
export function toHandoffDraft(form: { intent: string; decisions: string; openQuestions: string; tried: string; confidence?: HandoffConfidenceLevel | ''; confidenceBasis?: string }): HandoffNoteDraft {
  const decisions = lines(form.decisions).map((summary) => ({ summary }));
  const openQuestions = lines(form.openQuestions);
  const tried = lines(form.tried).map((approach) => ({ approach }));
  const basis = form.confidenceBasis?.trim();
  const confidence = form.confidence ? { value: HANDOFF_CONFIDENCE[form.confidence], ...(basis ? { basis } : {}) } : undefined;
  return {
    intent: form.intent.trim(),
    ...(decisions.length ? { decisions } : {}),
    ...(openQuestions.length ? { openQuestions } : {}),
    ...(tried.length ? { tried } : {}),
    ...(confidence ? { confidence } : {}),
  };
}

export function HandoffDialog({ assigneeName, cardTitle, busy, onAssign, onClose }: {
  assigneeName: string;
  cardTitle: string;
  busy: boolean;
  /** `draft` undefined ⇒ assign without a note. */
  onAssign: (draft?: HandoffNoteDraft) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('kanban');
  const [intent, setIntent] = useState(cardTitle);
  const [decisions, setDecisions] = useState('');
  const [openQuestions, setOpenQuestions] = useState('');
  const [tried, setTried] = useState('');
  const [confidence, setConfidence] = useState<HandoffConfidenceLevel | ''>('');
  const [confidenceBasis, setConfidenceBasis] = useState('');
  const canSend = intent.trim().length > 0 && !busy;

  return (
    <Modal onClose={onClose} label={t('handoffDialogLabel', { name: assigneeName })}>
      <div className="hire-head">
        <div>
          <h2 className="hire-title">{t('handoffDialogTitle', { name: assigneeName })}</h2>
          <p className="hire-lede">{t('handoffDialogLede')}</p>
        </div>
        <IconButton label={t('common:close')} icon={<XIcon size={16} />} onClick={onClose} />
      </div>
      <form onSubmit={(e) => { e.preventDefault(); if (canSend) onAssign(toHandoffDraft({ intent, decisions, openQuestions, tried, confidence, confidenceBasis })); }}>
        <label className="hire-label" htmlFor="ho-intent">{t('handoffIntentLabel')} <span className="hire-label-optional">{t('handoffRequired')}</span></label>
        <textarea id="ho-intent" className="ui-input" rows={2} maxLength={500} required aria-required="true" value={intent} onChange={(e) => setIntent(e.target.value)} autoFocus />

        <label className="hire-label" htmlFor="ho-decisions">{t('handoffDecisionsLabel')} <span className="hire-label-optional">{t('handoffOnePerLine')}</span></label>
        <textarea id="ho-decisions" className="ui-input" rows={2} value={decisions} onChange={(e) => setDecisions(e.target.value)} />

        <label className="hire-label" htmlFor="ho-questions">{t('handoffQuestionsLabel')} <span className="hire-label-optional">{t('handoffOnePerLine')}</span></label>
        <textarea id="ho-questions" className="ui-input" rows={2} value={openQuestions} onChange={(e) => setOpenQuestions(e.target.value)} />

        <label className="hire-label" htmlFor="ho-tried">{t('handoffTriedLabel')} <span className="hire-label-optional">{t('handoffOnePerLine')}</span></label>
        <textarea id="ho-tried" className="ui-input" rows={2} value={tried} onChange={(e) => setTried(e.target.value)} />

        <label className="hire-label" htmlFor="ho-confidence">{t('handoffConfidenceLabel')} <span className="hire-label-optional">{t('handoffOptional')}</span></label>
        <select id="ho-confidence" className="ui-input" value={confidence} onChange={(e) => setConfidence(e.target.value as HandoffConfidenceLevel | '')}>
          <option value="">{t('handoffConfidenceUnset')}</option>
          <option value="low">{t('handoffConfidenceLow')}</option>
          <option value="medium">{t('handoffConfidenceMedium')}</option>
          <option value="high">{t('handoffConfidenceHigh')}</option>
        </select>
        {confidence ? (
          <>
            <label className="hire-label" htmlFor="ho-confidence-basis">{t('handoffConfidenceBasisLabel')} <span className="hire-label-optional">{t('handoffOptional')}</span></label>
            <input id="ho-confidence-basis" className="ui-input" maxLength={300} value={confidenceBasis} onChange={(e) => setConfidenceBasis(e.target.value)} />
          </>
        ) : null}

        <div className="hire-foot action-bar">
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>{t('common:cancel')}</Button>
          <Button variant="secondary" size="sm" onClick={() => onAssign(undefined)} disabled={busy}>{t('handoffAssignWithout')}</Button>
          <Button type="submit" variant="accent-solid" size="sm" disabled={!canSend}>{t('handoffAssignWith')}</Button>
        </div>
      </form>
    </Modal>
  );
}
