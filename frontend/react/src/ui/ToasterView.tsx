import { useEffect, useSyncExternalStore } from 'react';
import i18n from '../i18n/index.js';
import { CheckIcon, AlertIcon, InfoIcon, XIcon } from './icons/index.js';
import { Button } from './Button.js';
import { dismiss, getToasts, setToastsPaused, subscribeToasts, type ToastItem, type ToastVariant } from './toast.js';

/**
 * The toast stack's VIEW — lazy-loaded by `Toaster` in `./toast.tsx`, which
 * owns the store, the timers and the announcement contract (read it there).
 */

/** Resume unless the pointer is still over the stack or focus is still in it.
 *  Deferred from blur so focus that moved to another toast (or was dropped to
 *  <body> by a dismissed toast's close button unmounting) is settled first —
 *  a pause with no way to end would freeze every later toast on screen. */
function release(stack: HTMLElement): void {
  if (!stack.contains(document.activeElement) && !stack.matches(':hover')) setToastsPaused(false);
}

function VariantIcon({ variant }: { variant: ToastVariant }): JSX.Element {
  if (variant === 'success') return <CheckIcon size={15} />;
  if (variant === 'info') return <InfoIcon size={15} />;
  return <AlertIcon size={15} />; // error + warning
}

/** One toast. Exported for the design-system gallery's static specimen (DSGC-01);
 *  the live stack below is the only runtime renderer. */
export function ToastCard({ item, onDismiss }: { item: ToastItem; onDismiss: (e: React.MouseEvent<HTMLButtonElement>) => void }): JSX.Element {
  return (
    <div className={`toast alert ${item.variant}`}>
      <span className="toast-icon" aria-hidden><VariantIcon variant={item.variant} /></span>
      <span className="toast-message">{item.message}</span>
      <button type="button" className="toast-close" aria-label={i18n.t('ui:toastDismiss')} onClick={onDismiss}>
        <XIcon size={13} />
      </button>
    </div>
  );
}

/** Errors persist, so a run of failures could otherwise wall off the page:
 *  show the newest few (older ones surface as these are dismissed). */
const MAX_VISIBLE = 4;

export function ToasterView(): JSX.Element {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  // A shell swap can unmount the stack mid-hover, and no mouseleave follows —
  // without this the clocks would stay paused for the next shell's toasts.
  useEffect(() => () => setToastsPaused(false), []);
  return (
    // A LABELLED LANDMARK, not a live region — the two are different jobs and the
    // container does only the second one.
    //
    // Announcement is ephemeral: a screen-reader user who is mid-sentence when a
    // toast fires, or who arrives late, has no way back to it. React Aria solves
    // this by making the toast container a landmark, so it is reachable on demand
    // via landmark navigation (F6 in most screen readers) instead of only being
    // heard once. That is the part of the state of the art we were missing, and
    // it costs two attributes.
    //
    // Still NO live role here: a container region PLUS per-item roles is what made
    // errors announce twice (DS-8). Landmark ≠ live region, so this does not
    // reintroduce it.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- the handlers do not ACT, they only pause the dismiss clocks (WCAG 2.2.1); the controls inside stay the buttons
    <div
      className="toast-stack"
      role="region"
      aria-label={i18n.t('ui:toastRegionLabel')}
      onMouseEnter={() => setToastsPaused(true)}
      onMouseLeave={(e) => release(e.currentTarget)}
      onFocus={() => setToastsPaused(true)}
      onBlur={(e) => { const stack = e.currentTarget; setTimeout(() => release(stack)); }}
    >
      {toasts.length > 1 ? (
        <Button variant="secondary" size="sm" className="u-self-end" onClick={(e) => { const stack = e.currentTarget.closest<HTMLElement>('.toast-stack'); toasts.forEach((t) => dismiss(t.id)); if (stack) setTimeout(() => release(stack)); }}>
          {i18n.t('ui:toastDismissAll', { count: toasts.length })}
        </Button>
      ) : null}
      {toasts.slice(-MAX_VISIBLE).map((t) => (
        // NO live role on any variant (PROF-UX-20): every toast is announced
        // through the shell's primed region by `push()`. A `role="status"` here
        // would be a region that never fires, and a `role="alert"` would be a
        // second region for the same message (DS-8) — so they get none.
        <ToastCard key={t.id} item={t} onDismiss={(e) => { const stack = e.currentTarget.closest<HTMLElement>('.toast-stack'); dismiss(t.id); if (stack) setTimeout(() => release(stack)); }} />
      ))}
    </div>
  );
}
