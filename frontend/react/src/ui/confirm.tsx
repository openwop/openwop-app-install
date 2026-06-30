/**
 * Imperative confirm — a promise-based wrapper over <ConfirmDialog>, backed by a
 * single host (<ConfirmRoot>) mounted once at the app shell (mirrors toast +
 * <Toaster>). Lets ANY caller — a component handler, an inline onClick, or even
 * a non-React controller (orgs/useOrgsController) — replace a blocking, off-brand
 * `window.confirm` with the in-app dialog and keep the same control flow:
 *
 *   if (!(await confirm({ title: t('deleteX'), danger: true, confirmLabel: t('common:delete') }))) return;
 *
 * Resolves `true` on confirm, `false` on cancel / Escape / scrim. Falls back to
 * the native dialog when the host isn't mounted (SSR / unit tests).
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from './ConfirmDialog.js';

export interface ConfirmOptions {
  /** Heading + accessible name (use the action question, e.g. "Delete X?"). */
  title: string;
  /** Optional second line — consequences / "can't be undone". */
  body?: ReactNode;
  /** Affirmative button label. Defaults to the generic "Confirm". */
  confirmLabel?: string;
  /** Destructive styling for the affirmative button. Reserve for irreversible actions. */
  danger?: boolean;
  /** Optional leading icon for the affirmative button. */
  confirmIcon?: ReactNode;
}

interface Pending extends ConfirmOptions { resolve: (ok: boolean) => void }

// Single in-flight request channel. The host registers `emit` on mount.
let emit: ((p: Pending | null) => void) | null = null;

/** Ask the user to confirm an action. Returns a promise that resolves to the
 *  user's choice. Drop-in for `window.confirm` inside async handlers. */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    if (!emit) { resolve(window.confirm(opts.title)); return; } // host not mounted
    emit({ ...opts, resolve });
  });
}

/** Mount ONCE at the app shell (beside <Toaster>). Renders the pending confirm. */
export function ConfirmRoot(): JSX.Element | null {
  const { t } = useTranslation('common');
  const [pending, setPending] = useState<Pending | null>(null);
  useEffect(() => {
    // If a second confirm() arrives while one is open, resolve the superseded
    // request as cancelled — otherwise its promise (a caller's `await`) leaks.
    emit = (next) => setPending((prev) => { if (prev && next) prev.resolve(false); return next; });
    return () => { emit = null; };
  }, []);
  if (!pending) return null;
  const settle = (ok: boolean): void => { pending.resolve(ok); setPending(null); };
  return (
    <ConfirmDialog
      title={pending.title}
      body={pending.body}
      confirmLabel={pending.confirmLabel ?? t('confirm')}
      confirmIcon={pending.confirmIcon}
      danger={pending.danger ?? false}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
}
