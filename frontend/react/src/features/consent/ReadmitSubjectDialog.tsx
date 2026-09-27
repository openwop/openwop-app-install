/**
 * ReadmitSubjectDialog — ADR 0657 D7 (CONS-UX-24 / CONS-UX-26).
 *
 * The audited door back for an ERASED subject. Erasure tombstones every
 * resolved identity key, and the tombstone out-ranks every public re-subscribe
 * path (D2) — so a person who asked to be forgotten and later asks to return
 * has NO self-service route. An administrator opens this door, and only with a
 * typed statement that is written to the audit log.
 *
 * Why not `confirm()`: the shared helper resolves a boolean and has no slot for
 * the one input this action needs — the operator's attestation. The dialog
 * composes the same `Modal` shell `ConfirmDialog` uses (scrim, focus trap,
 * Escape, restore) and re-uses its type-to-confirm idiom + `common` label, so
 * nothing about the confirm posture is re-invented here; only the attestation
 * field is new.
 *
 * Two gates before the button arms: the attestation is at least
 * `READMIT_ATTESTATION_MIN_CHARS` long (the server's floor — the client mirrors
 * it so the 400 is unreachable from a well-formed dialog), and the subject key
 * has been TYPED (SET-R2-1 — the blast radius of this action exceeds the row
 * under the pointer: it re-opens every marketing channel to a person who once
 * asked to be forgotten).
 *
 * A failed call renders INSIDE the dialog (ADV-UX-3) and the dialog stays open
 * so the statement the operator just wrote is not lost.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../ui/Button.js';
import { Modal } from '../../ui/Modal.js';
import { READMIT_ATTESTATION_MIN_CHARS } from './consentClient.js';

export function ReadmitSubjectDialog({
  subjectKey,
  busy,
  error,
  errorAnnounce,
  onConfirm,
  onCancel,
}: {
  subjectKey: string;
  /** The request is in flight: both buttons + scrim/Escape close are disabled. */
  busy: boolean;
  /** A failed call, rendered inside the dialog. Falsy renders nothing. */
  error?: ReactNode;
  /** The text to speak when `error` appears (see Modal#errorAnnounce). */
  errorAnnounce?: string | undefined;
  onConfirm: (attestation: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation('consent');
  const { t: tCommon } = useTranslation('common');
  const [attestation, setAttestation] = useState('');
  const [typed, setTyped] = useState('');
  const length = attestation.trim().length;
  const longEnough = length >= READMIT_ATTESTATION_MIN_CHARS;
  const armed = longEnough && typed.trim() === subjectKey;
  const title = t('readmitDialogTitle', { subjectKey });
  return (
    <Modal label={title} onClose={() => { if (!busy) onCancel(); }} error={error} errorAnnounce={errorAnnounce}>
      <div className="u-grid u-gap-3">
        <h2 className="u-fs-16 u-m-0">{title}</h2>
        <p className="u-fs-13 muted u-m-0">{t('readmitDialogBody')}</p>
        <label className="u-grid u-gap-1 u-fs-13">
          {t('readmitAttestationLabel')}
          <textarea
            autoFocus
            className="ui-input u-w-full"
            rows={3}
            value={attestation}
            onChange={(e) => setAttestation(e.target.value)}
            placeholder={t('readmitAttestationPlaceholder')}
            disabled={busy}
            aria-describedby="consent-readmit-attestation-hint"
          />
          {/* The floor is stated as a running count, so "why is the button
              disabled" never has to be guessed. */}
          <span id="consent-readmit-attestation-hint" className="muted u-fs-12">
            {t('readmitAttestationHint', { count: length, min: READMIT_ATTESTATION_MIN_CHARS })}
          </span>
        </label>
        <label className="u-grid u-gap-1 u-fs-13">
          {tCommon('typeToConfirmLabel', { value: subjectKey })}
          <input
            className="ui-input u-w-full"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            disabled={busy}
          />
        </label>
        <div className="action-bar u-justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>{tCommon('cancel')}</Button>
          <Button variant="primary" onClick={() => onConfirm(attestation.trim())} disabled={!armed} loading={busy}>
            {t('readmitConfirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
