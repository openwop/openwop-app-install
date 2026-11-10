/**
 * Finalize a Firebase sign-in into a backend session (ADR 0026 / ADR 0003).
 *
 * After ANY Firebase auth succeeds — OAuth redirect (Google/GitHub) OR in-page
 * email/password — the SAME backend handshake runs:
 *   1. push the fresh Firebase ID token into the shared client cache so
 *      `authedHeaders()` attaches it on the next fetch;
 *   2. `/migrate-tenant` — adopt the visitor's anon sandbox into their user
 *      tenant (must run while the anon cookie is still present);
 *   3. `/oidc/bind` (Phase 4a) — bind the OIDC identity to a durable `User` so
 *      every later request resolves the canonical `user:<userId>`.
 *
 * Best-effort: a 404 (the `users` toggle off) or a transient error must never
 * block sign-in.
 *
 * WHY THE RETURN TYPE IS A RESULT AND NOT `User | null`. The final step reads
 * `/me`, and that read can fail for reasons that have nothing to do with whether
 * a durable user exists. It previously returned `null` on failure, and the
 * caller fed that straight into `setBackendSessionUser` — publishing
 * `{ user: null, resolved: true }` into the store `SignInButton` itself calls
 * "the canonical signed-in truth". So an unreadable `/me` was recorded as the
 * SETTLED FACT that the account has no durable user, which also clobbers a good
 * user a previous refresh had already resolved. `ok: false` keeps "we could not
 * read" distinct from "there is no user"; callers must not conflate them.
 *
 * The OAuth redirect path in `SignInButton` and the email/password path in
 * `AuthCard` both call this — one handshake, no duplication.
 */
import { getCurrentIdToken, getCurrentUser } from './firebase.js';
import { setCurrentIdToken } from '../client/config.js';
import { migrateAnonToUser } from './migrateTenant.js';
import { bindOidc, getMe, type User } from '../features/users/usersClient.js';

/** `ok: false` = `/me` was unreadable — NOT evidence that no durable user exists. */
export type FinalizeResult = { readonly ok: true; readonly user: User | null } | { readonly ok: false };

/**
 * KT-AUTH-2 — one handshake per sign-in, not one per caller.
 *
 * Two callers used to run it at the same moment on one page load: the OAuth redirect
 * arm in `SignInButton` and `reconcileRestoredSession` (fired by the SDK's user
 * emission), and on an MFA sign-in `AuthCard` and `reconcileRestoredSession`. So the
 * page sent `/migrate-tenant` twice while the anon cookie was still present, and the
 * backend ran two full adoptions at once. MEASURED in production: both heap OOMs
 * (2026-11-02 08:13Z, 2026-11-03 13:29Z) had exactly that pair in flight. That link is
 * a suspicion, not a proof (four other pairs did not crash), but the pair was never
 * wanted.
 *
 * A call made while a run for the same user is IN FLIGHT shares it. A finished run is
 * reused only when the caller says so (`reuseCompleted`): the redirect arm and the
 * restored-session reconcile want "has this page load done it", while an explicit
 * sign-in (`AuthCard`) needs a fresh run, because a sign-in after a hard sign-out
 * must bind again.
 */
let current: { uid: string | null; done: boolean; promise: Promise<FinalizeResult> } | null = null;

export function finalizeFirebaseSession(opts: { reuseCompleted?: boolean } = {}): Promise<FinalizeResult> {
  const uid = getCurrentUser()?.uid ?? null;
  if (current && current.uid === uid && (!current.done || opts.reuseCompleted)) return current.promise;
  const run = { uid, done: false, promise: runHandshake() };
  run.promise = run.promise.finally(() => { run.done = true; });
  current = run;
  return run.promise;
}

/** For tests: forget the page-load state. Not for production paths. */
export function __resetFinalizeForTest(): void {
  current = null;
  reconciled = false;
}

async function runHandshake(): Promise<FinalizeResult> {
  const token = await getCurrentIdToken();
  if (token) setCurrentIdToken(token);

  const migrated = await migrateAnonToUser();
  if (migrated?.migrated) console.warn('openwop: anon → user migration', migrated);

  try {
    const bound = await bindOidc();
    if (bound) console.warn('openwop: OIDC identity bound', { userId: bound.user.userId, rekeyed: bound.rekeyed });
  } catch {
    /* best-effort — sign-in completes regardless */
  }

  return getMe().then((user) => ({ ok: true, user } as const)).catch(() => ({ ok: false } as const));
}

/** Guards the per-page-load reconciliation below. */
let reconciled = false;

/**
 * ADR 0434 Phase 2 — run the same handshake on a RESTORED session, once per
 * page load.
 *
 * The handshake above only ever ran on an explicit sign-in click. A user who
 * closes the tab and returns (Firebase restores the session from
 * IndexedDB persistence, no click involved) therefore never re-attempted
 * adoption or OIDC binding — so a sign-in whose `/migrate-tenant` or
 * `/oidc/bind` failed stayed broken forever, and the unbound case silently
 * degraded the RBAC subject to a per-device `session:<sid>` (the ADR 0015
 * "lost access to my own org" class).
 *
 * Both underlying calls are idempotent: adoption answers `migrated: false`
 * when there is nothing to fold, and binding is a find-or-create. So the
 * honest fix is simply to stop treating the click as the only trigger.
 */
export async function reconcileRestoredSession(): Promise<void> {
  if (reconciled) return;
  reconciled = true;
  try {
    // KT-AUTH-2 — the redirect arm may already be running (or have run) it.
    await finalizeFirebaseSession({ reuseCompleted: true });
  } catch {
    /* never block app boot on reconciliation */
  }
}
