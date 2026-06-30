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

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal.js';

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  confirmIcon,
  danger = false,
  busy = false,
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
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation('common');
  return (
    <Modal label={title} onClose={() => { if (!busy) onCancel(); }}>
      <div className="u-grid u-gap-3">
        <h2 className="u-fs-16 u-m-0">{title}</h2>
        {body ? <p className="u-fs-13 muted u-m-0">{body}</p> : null}
        <div className="action-bar u-justify-end">
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            {t('cancel')}
          </button>
          <button
            type="button"
            className={danger ? 'secondary u-text-danger' : 'primary'}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmIcon ?? null}{confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}
