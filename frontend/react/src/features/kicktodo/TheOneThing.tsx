/**
 * KickTodo Today — "The One Thing" hero focus card + the evidence-aware action
 * completer (ADR 0436 §3.2/§3.3/§4.3). The signature: a --kt-focus completion arc
 * over a time-of-day --kt-dawn wash, both reduced-motion + AA safe. Completion
 * honors the occurrence's `evidencePolicy` (KTFULL-B6): attestation is one tap;
 * note/photo require a note; measurement requires a number. Clay stays the CTA
 * (`btn-accent-solid`) — DESIGN.md button law; --kt-focus never fills a button.
 */
import { Button } from '../../ui/Button.js';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckIcon } from '../../ui/icons/index.js';
import type { CheckInEvidence, TodayAction } from '../../client/kicktodoClient.js';

/** Wash anchor for the local time of day: morning left, afternoon centre, evening right. */
export function washPosition(hour: number): string {
  if (hour < 12) return '18%';
  if (hour < 18) return '50%';
  return '82%';
}

/** The daypart for the greeting copy. */
export function daypartOf(hour: number): 'morning' | 'afternoon' | 'evening' {
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

/** The signature card shell: the completion arc + time-of-day wash wrap a single
 *  hero action. `arcFill` is 0–1 (today's completion ratio); `washX` is a CSS
 *  position from `washPosition`. The visual is `aria-hidden`; the content carries
 *  the meaning. */
export function TheOneThing({ arcFill, washX, eyebrowSuffix, children }: {
  arcFill: number;
  washX: string;
  /** already-translated daypart ("morning") appended to the eyebrow — the design's
   *  "The one thing · morning" reading; the caller owns the literal t() call. */
  eyebrowSuffix?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation('kicktodo');
  const vars = { '--kt-arc-fill': String(Math.max(0, Math.min(1, arcFill))), '--kt-wash-x': washX } as CSSProperties;
  return (
    <section className="surface-card kt-onething" aria-label={t('oneThingLabel')} style={vars}>
      <span className="kt-onething__arc" aria-hidden><span className="kt-onething__arc-fill" /></span>
      <p className="kt-onething__label">
        <span className="kt-onething__dot" aria-hidden />
        {t('oneThingLabel')}
        {eyebrowSuffix && <span className="kt-onething__label-suffix"> · {eyebrowSuffix}</span>}
      </p>
      {children}
    </section>
  );
}

/** Evidence-aware completion for ONE action, shared by the hero + the compact rows.
 *  Renders exactly the input the policy demands (nothing for attestation), and the
 *  clay Done stays disabled until that evidence is present — so the button never
 *  fires a check-in the server (KTFULL-B6) would refuse. A photo policy rides the
 *  note field as a reference until a media binding exists (the backend's contract). */
export function ActionCompleter({ action, busy, onComplete }: {
  action: TodayAction;
  busy: boolean;
  onComplete: (cardId: string, evidence?: CheckInEvidence) => void;
}) {
  const { t } = useTranslation('kicktodo');
  const [note, setNote] = useState('');
  const [measure, setMeasure] = useState('');
  const policy = action.occurrence.evidencePolicy;
  const cardId = action.occurrence.cardId;
  const title = action.card?.title ?? '';

  if (action.card?.completed) {
    return <span className="chip chip--success"><CheckIcon aria-hidden /> {t('doneBadge')}</span>;
  }

  const measureNum = Number(measure);
  const measureOk = measure.trim() !== '' && Number.isFinite(measureNum);
  const noteOk = note.trim() !== '';
  const canSubmit =
    policy === 'measurement' ? measureOk : policy === 'note' || policy === 'photo' ? noteOk : true;

  const submit = () => {
    if (!canSubmit || busy) return;
    if (policy === 'measurement') onComplete(cardId, { measuredValue: measureNum });
    else if (policy === 'note' || policy === 'photo') onComplete(cardId, { note });
    else onComplete(cardId);
  };

  const noteLabel = policy === 'photo' ? t('evidencePhotoLabel') : t('evidenceNoteLabel');

  return (
    <div className="kt-onething__evidence">
      {policy === 'measurement' && (
        <label className="u-flex u-items-center u-gap-2 u-fs-13">
          <span>{t('evidenceMeasurementLabel')}</span>
          <input type="number" inputMode="decimal" value={measure} disabled={busy}
            onChange={(e) => setMeasure(e.target.value)} />
        </label>
      )}
      {(policy === 'note' || policy === 'photo') && (
        <label className="u-flex u-items-center u-gap-2 u-fs-13">
          <span>{noteLabel}</span>
          <input type="text" value={note} disabled={busy} maxLength={280}
            onChange={(e) => setNote(e.target.value)}
            placeholder={policy === 'photo' ? t('evidencePhotoPlaceholder') : t('evidenceNotePlaceholder')} />
        </label>
      )}
      <div>
        {/* The CTA names the evidence it collects (ADR 0436 §4.3 — the control IS
            the evidence ask, never a generic "Done"). Literal keys (KTUX-9 rule). */}
        <Button variant="accent-solid" disabled={busy || !canSubmit}
          onClick={submit} aria-label={`${t('markDone')}: ${title}`}>
          {busy ? t('markingDone')
            : policy === 'photo' ? t('completePhotoCta')
            : policy === 'note' ? t('completeNoteCta')
            : policy === 'measurement' ? t('completeMeasureCta')
            : t('markDone')}
        </Button>
      </div>
    </div>
  );
}
