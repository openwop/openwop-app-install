/**
 * ConfirmDialog — the one confirm-before-acting dialog across the app (delete a
 * board / priority list / strategy, archive a strategy, …). Built on the shared
 * Modal primitive (scrim + focus-trap + Escape + restore), so features stop
 * re-implementing the same title + body + Cancel/confirm cluster inline.
 *
 * `danger` switches the affirmative button to the destructive treatment
 * (`secondary u-text-danger`, the app convention) — reserve it for irreversible
 * actions; a reversible one (e.g. archive) leaves it `primary`. Cancel + the
 * scrim/Escape close are disabled while `busy` so a double-submit can't fire.
 */

import { Button } from '../ui/Button.js';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal.js';

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  confirmIcon,
  danger = false,
  busy = false,
  typeToConfirm,
  error,
  errorAnnounce,
  onConfirm,
  onCancel,
}: {
  /** Dialog heading + accessible name. */
  title: string;
  /** Optional explanatory line — say what happens (and that it can't be undone). */
  body?: ReactNode;
  /** The affirmative button label (keep the verb consistent with the trigger). */
  confirmLabel: string;
  /** Optional leading icon for the affirmative button (e.g. a trash glyph). */
  confirmIcon?: ReactNode;
  /** Destructive styling for the affirmative button. Reserve for irreversible actions. */
  danger?: boolean;
  /** Disables both buttons + scrim/Escape close while the action is in flight. */
  busy?: boolean;
  /** SET-R2-1 — highest-blast-radius deletions (an org, a workspace): the
   *  affirmative button stays disabled until the user TYPES this exact value
   *  (the Vercel/GitHub danger-zone convention). Reserve for actions whose
   *  blast radius exceeds the thing under the pointer; a plain `danger`
   *  confirm remains right for single-record deletes. */
  typeToConfirm?: string;
  /** ADV-UX-3 — a failed confirm (a 403 delete, a dead backend) must render
   *  INSIDE the dialog. `Modal` has shipped this slot all along and
   *  ConfirmDialog did not forward it, so every delete failure in the app landed
   *  on a page-level notice UNDER the scrim — invisible, while the dialog stayed
   *  open over it. */
  error?: ReactNode | undefined;
  /** The text to speak when `error` appears (see Modal#errorAnnounce). */
  errorAnnounce?: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation('common');
  const [typed, setTyped] = useState('');
  const armed = !typeToConfirm || typed.trim() === typeToConfirm;
  return (
    <Modal label={title} onClose={() => { if (!busy) onCancel(); }} error={error} errorAnnounce={errorAnnounce}>
      <div className="u-grid u-gap-3">
        <h2 className="u-fs-16 u-m-0">{title}</h2>
        {body ? <p className="u-fs-13 muted u-m-0">{body}</p> : null}
        {typeToConfirm ? (
          <label className="u-grid u-gap-1 u-fs-13">
            {t('typeToConfirmLabel', { value: typeToConfirm })}
            <input
              autoFocus
              className="ui-input u-w-full"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              disabled={busy}
            />
          </label>
        ) : null}
        <div className="action-bar u-justify-end">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t('cancel')}
          </Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy || !armed}
          >
            {confirmIcon ?? null}{confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
