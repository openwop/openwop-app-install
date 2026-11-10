/**
 * Auth hook for the SPA. Wraps `firebase.ts` in a React-friendly
 * subscription model so components can re-render on sign-in / sign-
 * out / token refresh.
 *
 * Returns:
 *   user      — AuthUser | null
 *   loading   — true until first onAuthChanged fires
 *   signIn    — { google, github } popup launchers
 *   signOut   — drops local session
 *
 * `useAuth()` is safe to call when Firebase isn't configured —
 * `user` stays null and `loading` flips false immediately.
 */

import { useCallback, useEffect, useState } from 'react';
import { reconcileRestoredSession } from './finalizeSession.js';
import { adoptLocalContentForSubject } from './localContentAdoption.js';
import { recordShellIdentity } from './shellIdentity.js';
import { isStorageSubjectResolved } from '../platform/storage.js';
import {
  type AuthUser,
  getCurrentUser,
  isAuthConfigured,
  onAuthChanged,
  signInWithGithub,
  signInWithGoogle,
  signOut as signOutImpl,
} from './firebase.js';

/** GRADE-DELTA CODE-3 — how long to wait for the auth SDK to resolve the storage
 *  subject before settling it anonymous. Long enough that a slow-but-working
 *  restore wins the race; short enough that a broken one does not look like a
 *  hung page. */
const SUBJECT_WATCHDOG_MS = 5000;

export interface UseAuth {
  user: AuthUser | null;
  loading: boolean;
  isConfigured: boolean;
  signIn: {
    google: () => Promise<void>;
    github: () => Promise<void>;
  };
  signOut: () => Promise<void>;
}

export function useAuth(): UseAuth {
  const configured = isAuthConfigured();
  const [user, setUser] = useState<AuthUser | null>(() => getCurrentUser());
  const [loading, setLoading] = useState<boolean>(configured && user === null);

  useEffect(() => {
    if (!configured) {
      setLoading(false);
      // ADR 0434 / IDN-3 — with no auth provider the subject is settled-anonymous
      // immediately. Resolve it so content components never sit in the `pending`
      // skeleton forever on a no-auth (white-label / local-dev) deploy.
      adoptLocalContentForSubject(null);
      return;
    }
    const unsubscribe = onAuthChanged((u) => {
      // KT-AUTH-1 — first emission only: who this page's shell mounted as.
      recordShellIdentity(u?.uid ?? null);
      // ADR 0434 Phase 3 — ONE writer for the storage subject. Every `content`
      // key (chat thread, prompts, builder drafts) reads it, so it must be set
      // BEFORE anything re-renders off the new identity, and it must go back to
      // null on sign-out or the previous user's content stays readable.
      adoptLocalContentForSubject(u?.uid ?? null);
      setUser(u);
      setLoading(false);
      // ADR 0434 Phase 2 — a RESTORED session (returning tab, no sign-in click)
      // must run the same backend handshake a fresh sign-in does. Otherwise an
      // adoption or OIDC bind that failed at sign-in stays broken forever, and
      // the unbound case keeps a per-device `session:<sid>` RBAC subject.
      // Idempotent + guarded to once per page load; never blocks render.
      if (u) void reconcileRestoredSession();
    });
    // GRADE-DELTA CODE-3 — watchdog for the storage subject.
    //
    // On this branch the subject resolves ONLY inside the callback above. If the
    // SDK never fires it — a blocked auth script, a failed init, an extension
    // interfering — it stays `pending` forever. That used to be survivable: the
    // content surfaces read the anonymous key and rendered SOMETHING. Since
    // IDN-11 they hold a skeleton while `pending`, so the same failure now
    // presents as a permanently-loading page, which reads as "the app is broken"
    // rather than "you are signed out". That is a worse failure, and it is one
    // this fix introduced.
    //
    // So bound it: if nothing has resolved the subject in 5s, settle it
    // anonymous — the state the page would have shown anyway. A real resolution
    // arriving later still wins, because `adoptLocalContentForSubject` re-points
    // the subject and fires `authChanged`, which drops the stale caches.
    //
    // `loading` is bounded by the same watchdog. It used NOT to be, and that was
    // the first-visit splash hang (2026-11-05): when the SDK never emits — the
    // lazy `firebase-*.js` chunk fails to fetch, or the SDK's first IndexedDB
    // open never completes — `loading` stayed true for the life of the page, and
    // `/` (App.tsx) and every AppGate showed their "still resolving" state
    // forever, even after the warning below had fired. A reload fetched the
    // chunk from the HTTP cache (or reopened the now-created database) and
    // worked, which is why it presented as "first visit only". A late real
    // answer still wins: the callback above calls setUser/setLoading again.
    const watchdog = setTimeout(() => {
      if (!isStorageSubjectResolved()) {
        console.warn(`[auth] storage subject unresolved after ${SUBJECT_WATCHDOG_MS}ms — settling anonymous so content surfaces stop waiting`);
        recordShellIdentity(null);
        adoptLocalContentForSubject(null);
      }
      setLoading(false); // idempotent if the SDK already answered
    }, SUBJECT_WATCHDOG_MS);
    return () => { clearTimeout(watchdog); unsubscribe(); };
  }, [configured]);

  const signInGoogle = useCallback(async () => {
    await signInWithGoogle();
  }, []);
  const signInGithub = useCallback(async () => {
    await signInWithGithub();
  }, []);
  const handleSignOut = useCallback(async () => {
    await signOutImpl();
    // ADR 0487: '/' is unconditionally the public marketing home for a logged-out
    // visitor, so there is no `app-entered` marker to clear on sign-out.
  }, []);

  return {
    user,
    loading,
    isConfigured: configured,
    signIn: { google: signInGoogle, github: signInGithub },
    signOut: handleSignOut,
  };
}
