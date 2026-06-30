/**
 * Modal — the shared centered-dialog shell (GAP-ANALYSIS E7). Owns the one
 * scrim + Escape + role="dialog"/aria-modal + focus-trap-and-restore that ~18
 * dialogs each re-implemented (and most got wrong — they focused on mount but
 * never trapped Tab or restored focus on close). Built on ModalPortal (fixed-
 * position escape from transformed ancestors) + useFocusTrap.
 *
 * Dialogs provide only their content; `onClose` fires on scrim click + Escape.
 */

import { useEffect, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ModalPortal } from './ModalPortal.js';
import { useFocusTrap } from './useFocusTrap.js';
import { Notice } from './Notice.js';
import { Skeleton } from './Skeleton.js';
import { IconButton } from './IconButton.js';
import { XIcon } from './icons/index.js';

export function Modal({
  onClose,
  label,
  children,
  className = 'surface-card hire-modal',
  scrimClassName = 'hire-scrim',
  loading = false,
  error,
  showClose = false,
}: {
  onClose: () => void;
  /** Accessible name for the dialog (aria-label). */
  label: string;
  children: ReactNode;
  /** Override the dialog box class (default matches the hire/board modals). */
  className?: string;
  /** Override the scrim class. */
  scrimClassName?: string;
  /** When true, the dialog body is swapped for a designed busy state and the
   *  dialog is marked `aria-busy` for assistive tech. Backward compatible:
   *  unset falls through to the normal `children` render. */
  loading?: boolean;
  /** Inline error region rendered above the dialog body via the shared
   *  <Notice> primitive. Falsy renders nothing (the dialog stays clean). */
  error?: ReactNode;
  /** OPT-IN labeled close (×) control in the top corner. Default false so the ~18
   *  existing consumers are unchanged (they dismiss via scrim/Escape). */
  showClose?: boolean;
}): JSX.Element {
  const { t } = useTranslation('common');
  const ref = useFocusTrap<HTMLDivElement>(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <ModalPortal>
      {/* Backdrop dismiss is a convenience; the keyboard path is Escape
          (handled above). The target check means a click on the dialog body
          (which bubbles) does not close it — so the dialog needs no handler. */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events */}
      <div className={scrimClassName} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div
          ref={ref}
          tabIndex={-1}
          className={`${className}${showClose ? ' modal--has-close' : ''}`}
          role="dialog"
          aria-modal="true"
          aria-label={label}
          aria-busy={loading ? 'true' : undefined}
        >
          {showClose ? (
            <IconButton label={t('close')} icon={<XIcon size={16} />} className="modal-close icon-button" onClick={onClose} />
          ) : null}
          {error ? (
            <div className="u-mb-2">
              <Notice variant="error">{error}</Notice>
            </div>
          ) : null}
          {loading ? (
            <div
              className="modal-loading"
              role="status"
              aria-live="polite"
            >
              {/* Content-shaped placeholder via the shared Skeleton primitive,
                  matching how list/detail loads degrade elsewhere. */}
              <Skeleton width="40%" height={18} />
              <Skeleton width="100%" />
              <Skeleton width="90%" />
              <Skeleton width="65%" />
              <span className="sr-only">{t('loading')}</span>
            </div>
          ) : (
            children
          )}
        </div>
      </div>
    </ModalPortal>
  );
}
