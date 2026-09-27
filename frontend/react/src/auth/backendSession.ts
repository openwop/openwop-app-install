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
import { getMe, type User as DurableUser, UsersApiError } from '../features/users/usersClient.js';

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
    inflight = getMe()
      .then((u) => publish({ user: u, resolved: true }))
      .catch((err: unknown) => {
        const status = err instanceof UsersApiError ? err.status : 0;
        const definitive = status === 401 || status === 403 || status === 404;
        if (definitive) publish({ user: null, resolved: true });
        // else: keep whatever we last knew; unreadable is not an answer.
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

export function useBackendSession(): BackendSession {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => state,
  );
}
