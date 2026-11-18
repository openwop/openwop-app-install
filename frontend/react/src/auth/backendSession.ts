/**
 * Shared backend-session (durable User) store — grade-pass fix for the
 * accountPresence split-brain: every mounted `SignInButton` (Sidebar,
 * AccessHub, PublicShell, invite pages) used to fetch and hold its OWN
 * `/me` result, so a password sign-in through one instance updated the
 * module-level presence signal while the other instances kept stale state
 * (the Sidebar showed "Sign in" with its fallback controls gone).
 *
 * One module-level cache + subscribers (the `useEffectiveAccess` pattern):
 * all instances render from the same snapshot, and a session change made
 * through any of them re-renders them all.
 */
import { useSyncExternalStore } from 'react';
import { getMeIfSignedIn, type User as DurableUser, UsersApiError } from '../features/users/usersClient.js';
import { isOwnSignOut } from './shellIdentity.js';
import { reloadIntoSession } from './reloadIntoSession.js';

interface BackendSession {
  user: DurableUser | null;
  /** false until the first /me round-trip settles (either way). */
  resolved: boolean;
}

let state: BackendSession = { user: null, resolved: false };
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function publish(next: BackendSession): void {
  state = next;
  for (const fn of listeners) fn();
}

/**
 * Issue 6043 — the cookie-session half of "signed out in another tab". A password or
 * bound session has no auth-SDK emission to hear, so the tab re-checks `/me` when it
 * comes back into view, and a move from a user to a DEFINITIVE "no user" that this
 * tab did not cause reloads into the signed-out shell. It cannot loop: after the
 * reload the previous user is null, so the transition never fires again.
 */
function settledSignedOut(): void {
  const wasSignedIn = state.resolved && state.user !== null;
  publish({ user: null, resolved: true });
  if (wasSignedIn && !isOwnSignOut()) reloadIntoSession();
}

const RECHECK_MIN_MS = 15_000;
let lastRecheck = 0;
let recheckWired = false;
function wireRecheckOnReturn(): void {
  if (recheckWired || typeof window === 'undefined') return;
  recheckWired = true;
  const recheck = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!state.resolved || state.user === null) return; // only a signed-in tab can be signed out
    const now = Date.now();
    if (now - lastRecheck < RECHECK_MIN_MS) return;
    lastRecheck = now;
    void refreshBackendSession();
  };
  window.addEventListener('focus', recheck);
  document.addEventListener('visibilitychange', recheck);
}

/** For tests — reset the module state. */
export function __resetBackendSessionForTest(): void {
  state = { user: null, resolved: false };
  inflight = null;
  lastRecheck = 0;
}

/** Set the session directly (post-OIDC finalize, logout). */
export function setBackendSessionUser(user: DurableUser | null): void {
  publish({ user, resolved: true });
}

/**
 * Re-resolve `/me` — deduped, shared by every caller. Never throws.
 *
 * AN UNREADABLE READ IS NOT "NO USER" (grade-data FRD-1). This used to settle
 * every failure to `{ user: null, resolved: true }` — publishing, into the store
 * `SignInButton` calls "the canonical signed-in truth", the SETTLED FACT that
 * the account has no durable record. ADR 0026's finalize path was fixed for
 * exactly this in #2910; this one runs on EVERY SignInButton mount, so it was
 * the wider hole, and its old doc comment ("a 401/404 settles to null") was
 * unenforceable while `getMe` threw an untyped Error — 404 and 503 arrived
 * identically.
 *
 * Now: only a definitive answer from the server (401/403/404 — no session, or
 * the users feature off) settles to null. A transport failure or a 5xx leaves
 * the previous snapshot alone, so a signed-in user is not shown "Sign in"
 * because the network blinked, and a later refresh can still resolve it.
 */
export function refreshBackendSession(): Promise<void> {
  if (!inflight) {
    // Issue 5991 — the probe form: no user is a 204 (null), not a logged 401.
    // Issue 6043 — a null after a signed-in snapshot is a sign-out elsewhere.
    inflight = getMeIfSignedIn()
      .then((u) => (u === null ? settledSignedOut() : publish({ user: u, resolved: true })))
      .catch((err: unknown) => {
        const status = err instanceof UsersApiError ? err.status : 0;
        const definitive = status === 401 || status === 403 || status === 404;
        if (definitive) settledSignedOut();
        // else: keep whatever we last knew; unreadable is not an answer.
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function useBackendSession(): BackendSession {
  return useSyncExternalStore(
    (fn) => { wireRecheckOnReturn(); listeners.add(fn); return () => listeners.delete(fn); },
    () => state,
  );
}
