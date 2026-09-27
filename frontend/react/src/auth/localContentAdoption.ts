/**
 * Local `content` adoption on sign-in (ADR 0434 Phase 3) — the client-side half
 * of the backend's anon-sandbox adoption.
 *
 * The backend already does this server-side: an anonymous tenant's rows are
 * folded into the user tenant by `reassignTenant` when `/migrate-tenant` runs
 * (ADR 0003 Phase 4c). But the browser holds its own copies of user-authored
 * content — the chat thread, prompts, and builder drafts — under localStorage
 * keys that were NOT subject-scoped, so they were per-device and, on a shared
 * machine, visible to whoever used the browser next.
 *
 * Phase 3 scopes those keys (`<key>:<uid>` signed in, the bare key anonymously)
 * and this module moves anonymous content across at the moment of sign-in, so a
 * visitor who drafts a workflow and then signs up does not lose it.
 *
 * The invariant every merge here honors: **union, never destroy, and prefer the
 * signed-in copy on a true collision.** `adoptAnonScoped` only removes the
 * anonymous source after the merged write is CONFIRMED, so a quota failure
 * leaves the work recoverable instead of dropping it.
 */

import { getStorageSubject, isStorageSubjectResolved, setStorageSubject } from '../platform/storage.js';
import { fireAuthChanged } from '../client/config.js';

/**
 * Point every `content` key at `subject` and, when this is a transition from
 * anonymous to signed-in, adopt the anonymous content into the new scope.
 *
 * Safe to call on every `onAuthChanged` emission: it always RESOLVES the subject
 * (IDN-3), skips the adoption work when the value is unchanged, and adoption
 * itself is idempotent (the anonymous key is gone after the first pass).
 *
 * Setting the subject is SYNCHRONOUS (it must land before anything re-renders);
 * only the anon→user merge is async, because it is lazy-imported. The returned
 * promise resolves once that merge has completed.
 */
export function adoptLocalContentForSubject(subject: string | null): Promise<void> {
  const previous = getStorageSubject();
  const wasResolved = isStorageSubjectResolved();

  // ADR 0434 / IDN-3 — ALWAYS resolve, even on a no-op value. `setStorageSubject`
  // flips `subjectResolved` and notifies subscribers; skipping it here (as an
  // earlier version did on `previous === subject`) left the subject stuck
  // `pending` FOREVER for the two commonest first-calls — a no-auth deploy and a
  // configured-but-anonymous visitor both first-call `adoptLocalContentForSubject(null)`
  // from the initial `currentSubject = null`, so `null === null` short-circuited
  // before resolution. `setStorageSubject` is internally a no-op broadcast when
  // nothing changed AND it was already resolved, so calling it unconditionally is
  // cheap.
  setStorageSubject(subject);

  // Nothing further to do when the identity did not actually change — but note
  // the FIRST settle (pending → same value) still needed the resolve above.
  if (previous === subject && wasResolved) return Promise.resolve();

  // Identity changed: drop tenant-scoped caches so nothing renders the previous
  // subject's data. This broadcast already exists for the workspace-switch case;
  // omitting it here would leave the UI showing stale content until a reload.
  // Fired BEFORE the (async) adoption so the UI never paints the old subject.
  fireAuthChanged();

  // Only anonymous → signed-in adopts. Signing OUT must not drag the user's
  // content back down to the anonymous key, where the next visitor would see it.
  //
  // LAZY-IMPORTED on purpose: this runs at most once per session, on a
  // transition most page loads never make, so it has no business in the entry
  // chunk (it pushed the app over its gzip budget). Setting the subject above
  // stays synchronous — that MUST land before anything re-renders.
  if (previous === null && subject !== null) {
    // Returned (not fire-and-forget) so callers CAN await it — the auth
    // subscription deliberately does not, since adoption must never delay
    // render, but tests and any future caller need a completion signal.
    return import('./adoptAnonContent.js')
      .then((m) => { m.adoptAnonContent(subject); fireAuthChanged(); })
      .catch(() => { /* adoption is best-effort; the anon payload stays put */ });
  }
  return Promise.resolve();
}
