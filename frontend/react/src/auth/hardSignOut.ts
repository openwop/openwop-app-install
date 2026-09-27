/**
 * hardSignOut — the client half of ADR 0621 D5 (`USERS-UX-13`).
 *
 * When the backend REFUSES a live session (`401 account_disabled |
 * account_erased | session_revoked`, cookie cleared on the same response) —
 * or when the user signs themselves out of every device (the self revoke
 * route clears the caller's own cookie too) — the SPA must:
 *
 *   1. drop the cached Firebase ID token and sign out of the IdP, otherwise the
 *      very next request re-promotes (D1 (c) refuses that server-side, but the
 *      client would loop on it);
 *   2. settle the shared backend-session store to "no user" so every mounted
 *      `SignInButton` flips to the signed-out state at once;
 *   3. fire the auth-change listeners so tenant-keyed caches drop;
 *   4. publish the REASON, which the sign-in modal renders as an announced
 *      `<Notice variant="error">` — a silent lockout is the state this exists
 *      to prevent.
 *
 * ONE action, deduped: a page that fans out N reads gets N refusals at once,
 * and they must collapse into a single sign-out + a single announcement.
 *
 * Registers itself with `client/sessionRefusal.ts` at import time — the auth
 * layer imports the client layer, never the reverse (the `onAuthChange` rule).
 * `SignInButton` (mounted in every shell) imports this module, so the
 * registration is live wherever a sign-in modal can open.
 */
import { useSyncExternalStore } from 'react';
import { fireAuthChanged, setCurrentIdToken } from '../client/config.js';
import { registerSessionRefusalHandler, type SessionRefusalCode } from '../client/sessionRefusal.js';
import { setBackendSessionUser } from './backendSession.js';
import { signOut } from './firebase.js';

/** The three server refusals + the self-service "sign out everywhere". */
export type HardSignOutReason = SessionRefusalCode | 'self_revoked';

let reason: HardSignOutReason | null = null;
let inflight: Promise<void> | null = null;
/** The ONE SignInButton instance presenting the reason (several are mounted —
 *  Sidebar, AccessHub, invite pages — and each would otherwise open a modal). */
let presenter: symbol | null = null;
const listeners = new Set<() => void>();

function publish(next: HardSignOutReason | null): void {
  reason = next;
  if (next === null) presenter = null;
  for (const fn of listeners) fn();
}

/** Run the hard sign-out. Never throws; concurrent calls share one run. */
export function hardSignOut(why: HardSignOutReason): Promise<void> {
  if (inflight) return inflight;
  // Publish FIRST so the UI reacts even if the IdP sign-out is slow/offline.
  publish(why);
  setCurrentIdToken(null);
  setBackendSessionUser(null);
  inflight = signOut()
    .catch(() => { /* IdP unreachable — the token is already dropped */ })
    .then(() => { fireAuthChanged(); })
    .finally(() => { inflight = null; });
  return inflight;
}

/** The pending reason to show in the sign-in modal, or null. */
export function useHardSignOutReason(): HardSignOutReason | null {
  return useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    () => reason,
  );
}

/** Called when the user dismisses the reason or signs back in. */
export function clearHardSignOutReason(): void {
  if (reason !== null) publish(null);
}

/** Claim the right to present the reason. True for the first claimant (and for
 *  that same claimant on re-render); false for every other instance. */
export function claimHardSignOutPresenter(id: symbol): boolean {
  if (presenter === null) presenter = id;
  return presenter === id;
}

/** Release a claim (instance unmounted) so another instance can present. */
export function releaseHardSignOutPresenter(id: symbol): void {
  if (presenter === id) presenter = null;
}

registerSessionRefusalHandler((code) => { void hardSignOut(code); });
