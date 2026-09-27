import { useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { confirm } from './confirm.js';
import i18n from '../i18n/index.js';

/**
 * Warn the user before they lose unsaved edits via a browser-level navigation
 * (tab close, refresh, external link). While `dirty` is true a `beforeunload`
 * listener triggers the native "Leave site?" prompt.  UX CONT-6.
 *
 * FORM-UX-2 (ADR 0584) — THE HALF THIS DOES NOT COVER, and why that mattered.
 * This docblock used to end "(In-app react-router navigation is not blocked —
 * this is the lightweight guard for the most common data-loss path.)" The
 * parenthesis was accurate and the conclusion was wrong: on a page that renders
 * its own in-app "Back to …" links, the browser-level path is not the most
 * common one, it is the one nobody takes. `FormDetailPage` renders TWO such
 * links plus the whole sidebar, so ONE CLICK discarded an entire form build —
 * every field, key, option list, help text, number constraint and destination
 * mapping — with no confirm and no draft persistence, on a page that was
 * simultaneously rendering an "unsaved changes" chip proving it knew.
 *
 * `react-router`'s `useBlocker` is not available here (the app mounts a
 * `BrowserRouter`, not a data router), so the in-app guard is an explicit
 * `confirmLeave()` a caller awaits before navigating. That is narrower than a
 * router-level block — it covers the exits the PAGE renders, not the sidebar —
 * and saying so plainly is better than a hook that implies more than it does.
 */
export function useUnsavedChangesWarning(dirty: boolean): void {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);
}

/**
 * FORM-UX-2 — the IN-APP half. Returns a predicate a client-side navigation must
 * clear first: `true` when there is nothing to lose or the user chose to
 * discard, `false` when they want to stay. Pairs with the hook above (which
 * still owns tab-close / reload); a builder wires both.
 */
export function useConfirmDiscardUnsaved(dirty: boolean): () => Promise<boolean> {
  return useCallback(async () => {
    if (!dirty) return true;
    return confirm({
      title: i18n.t('ui:unsavedLeaveTitle'),
      body: i18n.t('ui:unsavedLeaveBody'),
      danger: true,
      confirmLabel: i18n.t('ui:unsavedLeaveConfirm'),
    });
  }, [dirty]);
}

/** Complete BrowserRouter guard for an editing page. Browser exits use the
 * native prompt; same-origin anchor navigation is intercepted before React
 * Router handles it. Modifier/new-window/download/external links are untouched. */
export function useUnsavedRouteGuard(dirty: boolean): () => Promise<boolean> {
  useUnsavedChangesWarning(dirty);
  const confirmLeave = useConfirmDiscardUnsaved(dirty);
  const navigate = useNavigate();
  const pending = useRef(false);

  useEffect(() => {
    if (!dirty) return;
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(target instanceof HTMLAnchorElement) || target.target || target.download) return;
      const url = new URL(target.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const destination = `${url.pathname}${url.search}${url.hash}`;
      if (destination === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
      event.preventDefault();
      event.stopPropagation();
      if (pending.current) return;
      pending.current = true;
      void confirmLeave().then((leave) => { if (leave) navigate(destination); }).finally(() => { pending.current = false; });
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [confirmLeave, dirty, navigate]);

  return confirmLeave;
}
