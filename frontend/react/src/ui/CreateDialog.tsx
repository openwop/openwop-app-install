/**
 * CreateDialog — the create form a list page opens from its header button (issue 5921).
 *
 * List pages used to render their create form permanently above the list, so the
 * first screen of every visit went to an action done rarely, with a disabled
 * primary button as its loudest control. The pages that moved it into a dialog
 * (Strategy, Documents) each wrote their own open/busy/error/close; this is that
 * shape once, over the shared `Modal`, which already owns the focus trap, focus
 * return to the opening button, Escape, and the announced error slot.
 *
 * The page keeps its fields (children) and its own gating (whether to offer the
 * button at all). This owns the rest:
 *  - submit is a real `<form>` submit, so Enter works; the button is disabled
 *    until `canSubmit` and while busy;
 *  - a failure keeps the dialog open with the message in it, announced;
 *  - success closes it; the page announces the result and refreshes its list,
 *    since the dialog's own region is gone by then;
 *  - while the page cannot offer the form at all (`ready` false: a failed or empty
 *    read the fields depend on), the footer holds only Close, so the dialog never
 *    shows a dead primary button beside the explanation.
 *
 * A ratchet (`ui/__tests__/inlineCreateFormRatchet.test.ts`) keeps new inline
 * create forms from coming back.
 */

import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Modal.js';
import { Button } from './Button.js';

export function CreateDialog({
  title,
  submitLabel,
  canSubmit,
  ready = true,
  onSubmit,
  onClose,
  errorFallback,
  children,
}: {
  /** The dialog's heading and accessible name, e.g. "New project". */
  title: string;
  /** The primary button, e.g. "Create project". */
  submitLabel: ReactNode;
  /** Whether the fields are complete enough to submit. */
  canSubmit: boolean;
  /** False while a read the form depends on failed or came back empty: the body
   *  explains it and the footer offers only Close. Default true. */
  ready?: boolean;
  /** Create the thing. Resolve to close the dialog; throw to keep it open with the error. */
  onSubmit: () => Promise<void>;
  onClose: () => void;
  /** Shown when the thrown value carries no message. */
  errorFallback: string;
  children: ReactNode;
}): JSX.Element {
  const { t } = useTranslation('common');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!ready || !canSubmit || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit();
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : errorFallback);
      setBusy(false);
    }
  };

  return (
    <Modal label={title} onClose={busy ? () => undefined : onClose} error={error} errorAnnounce={error ?? undefined}>
      <h2 className="u-mt-0">{title}</h2>
      <form className="u-flex u-flex-col u-gap-3" onSubmit={(e) => void submit(e)} aria-busy={busy || undefined}>
        {children}
        <div className="action-bar u-justify-end">
          <Button variant="secondary" type="button" onClick={onClose} disabled={busy}>{ready ? t('cancel') : t('close')}</Button>
          {ready ? <Button variant="primary" type="submit" disabled={!canSubmit || busy}>{submitLabel}</Button> : null}
        </div>
      </form>
    </Modal>
  );
}
