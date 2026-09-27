import { Suspense, lazy, useSyncExternalStore } from 'react';
import i18n from '../i18n/index.js';
import { announce } from './announce.js';
import { Button } from './Button.js';

/**
 * Toast — the app's ephemeral async-feedback layer (gap #9). Distinct from
 * <Notice> (inline, persistent, in-flow): toasts stack bottom-right and never
 * block. success/info/warning auto-dismiss (paused on hover/focus); an error
 * stays until dismissed (WCAG 2.2.1 — see `toast.error`). Imperative `toast.success(...)` from anywhere;
 * <Toaster> is mounted once at the app shell. Token-only `.toast-*` styling,
 * reuses the `.alert.*` colour families.
 *
 * ANNOUNCEMENT — every variant is spoken EXPLICITLY through ADR 0363's
 * GlobalLiveRegion (mounted EMPTY at the shell and populated later — the "prime
 * the container first" pattern). The toast node itself carries NO live role.
 *
 * A live region that is INSERTED into the DOM already holding its text is not
 * reliably announced: the spec only defines live regions in terms of CONTENT
 * CHANGES, so a region that arrives pre-populated has not "changed" and screen
 * readers were not yet watching it. Every toast is inserted that way.
 *
 * PROF-UX-20 (2026-09-02) — `error` used to be the one exception, resting on
 * `role="alert"`-on-insertion: the ARIA spec says a user agent SHOULD fire a
 * system alert event "when the WAI-ARIA alert is created". That is a SHOULD,
 * and `ui/Notice.tsx` says in as many words that it "is NOT verified here and
 * MUST NOT be treated as established — assuming it is exactly the mistake that
 * shipped #2615". Every failure toast in the app rested on that unverified
 * premise while every success was explicitly announced. Errors now ride the
 * same mechanism as the other three, into the ASSERTIVE shell region (a failed
 * action must not queue behind polite chatter), and the inline role is gone so
 * the two mechanisms are mutually exclusive by construction.
 *
 * Never both for one message: a container region plus per-item roles is what
 * made errors announce twice (DS-8).
 */

export type ToastVariant = 'success' | 'error' | 'info' | 'warning';
export interface ToastItem { id: number; variant: ToastVariant; message: string }

let items: ToastItem[] = [];
const listeners = new Set<() => void>();
const dismissTimers = new Map<number, ReturnType<typeof setTimeout>>();
/** When each timed toast is due (epoch ms) — or, while paused, how long it has LEFT. */
const dueAt = new Map<number, number>();
let paused = false;
let seq = 0;

function emit() {
  // New array identity so useSyncExternalStore sees the change.
  items = items.slice();
  listeners.forEach((l) => l());
}

function armDismiss(id: number, ttlMs: number): void {
  if (ttlMs <= 0) return;
  const prev = dismissTimers.get(id);
  if (prev) clearTimeout(prev);
  dismissTimers.delete(id);
  // While paused the clock does not run: park the full TTL, armed on resume.
  if (paused) { dueAt.set(id, ttlMs); return; }
  // setTimeout is non-deterministic but this is pure UI chrome.
  dueAt.set(id, Date.now() + ttlMs);
  dismissTimers.set(id, setTimeout(() => dismiss(id), ttlMs));
}

/**
 * WCAG 2.2.1 (Timing Adjustable) — a timed toast must not vanish while the
 * user is reading or acting on it. The stack pauses every clock while the
 * pointer is over it or focus is inside it, and resumes each with the time it
 * had LEFT (not a fresh TTL, and not zero — leaving must not dismiss at once).
 * @internal — called by `ToasterView`.
 */
export function setToastsPaused(next: boolean): void {
  if (next === paused) return;
  paused = next;
  const now = Date.now();
  for (const [id, v] of dueAt) {
    if (next) {
      const timer = dismissTimers.get(id);
      if (timer) clearTimeout(timer);
      dismissTimers.delete(id);
      dueAt.set(id, Math.max(v - now, 1000));
    } else {
      armDismiss(id, v);
    }
  }
}

function push(variant: ToastVariant, message: string, ttlMs: number): number {
  // UI-4: coalesce an identical (variant + message) toast that is already
  // showing instead of stacking duplicates — a bulk op that fires the same
  // "Saved"/"Failed" N times shows ONE toast, not a wall of them. Refresh the
  // dismiss timer so a repeated toast stays visible for its full TTL rather
  // than vanishing on the first instance's clock.
  // SPEAK IT HERE, not in the render. A toast node inserted already holding its
  // text does not "change", so an inline live role on it is silent — without
  // this line every toast is unheard (315 of the 693 call sites in the app
  // were, before #2632). `error` is ASSERTIVE (interrupts; a failed action must
  // not be missed behind a polite queue — the `ui/Notice` rule); the other three
  // are polite. The render below carries NO live role for any variant, so this
  // is the ONE mechanism per message (DS-8: two regions = spoken twice).
  //
  // Announced on the coalesced path too: an identical toast firing again is a
  // real second event, and `announce()` flips an invisible marker so a repeat
  // re-announces rather than being swallowed as an unchanged string.
  announce(message, { assertive: variant === 'error' });

  const existing = items.find((t) => t.variant === variant && t.message === message);
  if (existing) {
    armDismiss(existing.id, ttlMs);
    return existing.id;
  }
  const id = ++seq;
  items = [...items, { id, variant, message }];
  emit();
  armDismiss(id, ttlMs);
  return id;
}

export function dismiss(id: number): void {
  const timer = dismissTimers.get(id);
  if (timer) { clearTimeout(timer); dismissTimers.delete(id); }
  dueAt.delete(id);
  items = items.filter((t) => t.id !== id);
  emit();
}

export const toast = {
  success: (m: string, ttlMs = 4000) => push('success', m, ttlMs),
  // An error PERSISTS until dismissed (ttl 0). It is the one variant that asks
  // the user to do something ("copy it manually", "retry"), and six seconds is
  // a time limit on reading an instruction (WCAG 2.2.1). A caller may still
  // pass a TTL for a purely informational failure.
  error: (m: string, ttlMs = 0) => push('error', m, ttlMs),
  info: (m: string, ttlMs = 4000) => push('info', m, ttlMs),
  warning: (m: string, ttlMs = 5000) => push('warning', m, ttlMs),
};

/** @internal — the store seam `ToasterView` renders from. */
export function subscribeToasts(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
/** @internal */
export function getToasts(): ToastItem[] { return items; }

// The VIEW is code-split: the store + `announce()` above are what every caller
// needs synchronously (a toast fired during boot is SPOKEN at once and shown the
// moment the view lands), while the stack's markup, icons and pause handling
// stay off the entry chunk every user downloads first.
//
// A spoken toast must never be INVISIBLE (RFCW-UX-9): if the chunk fails to load
// (offline, or pruned by a deploy the tab has not reloaded across), retry once,
// then fall back to the minimal in-entry stack below. That fallback has no
// icons and no pause-on-hover, but every toast is visible and dismissible.
const ToasterView = lazy(() => import('./ToasterView.js')
  .catch(() => new Promise((r) => { setTimeout(r, 2000); }).then(() => import('./ToasterView.js')))
  .then((m) => ({ default: m.ToasterView }), () => ({ default: ToasterFallback })));

function ToasterFallback(): JSX.Element {
  const list = useSyncExternalStore(subscribeToasts, getToasts, getToasts);
  return (
    <div className="toast-stack" role="region" aria-label={i18n.t('ui:toastRegionLabel')}>
      {list.map((t) => (
        <div key={t.id} className={`toast alert ${t.variant}`}>
          <span className="toast-message">{t.message}</span>
          <Button variant="quiet" size="sm" className="toast-close" aria-label={i18n.t('ui:toastDismiss')} onClick={() => dismiss(t.id)}>×</Button>
        </div>
      ))}
    </div>
  );
}

/** Mount once at a shell. */
export function Toaster(): JSX.Element {
  return <Suspense fallback={null}><ToasterView /></Suspense>;
}
