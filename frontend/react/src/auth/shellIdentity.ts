/**
 * KT-AUTH-1 — the identity this page's shell MOUNTED as.
 *
 * `onAuthed` needs to know whether an in-page sign-in actually changed who the
 * shell belongs to, and the current user cannot answer that: the SDK reports the
 * new user before the handshake ends, so by then "current" already matches. What
 * it needs is fixed at boot, so this records the FIRST settled value and ignores
 * every later one. `null` = mounted anonymous.
 *
 * The same person signing back in after a hard sign-out must NOT reload. The
 * builder tells them "Sign in again, then retry", and that retry needs the canvas
 * in memory: a reload takes the server's definition, so an edit the backend
 * refused is gone from the canvas and the first autosave overwrites the local
 * copy too. MEASURED against `loadWorkflowWithHead` + `loadFromSaved`.
 */

/** `undefined` until the auth layer has settled once. */
let mountedAs: string | null | undefined;

/** First call wins. Called on every auth emission, and by the boot watchdog when
 *  the SDK never answers (the shell then really did mount anonymous). */
export function recordShellIdentity(uid: string | null): void {
  if (mountedAs === undefined) mountedAs = uid;
}

/** True only when `uid` is PROVEN to be who the shell mounted as. Anything
 *  unknown is false, so the caller reloads rather than risk the stale shell. */
export function isShellIdentity(uid: string | null): boolean {
  return uid !== null && mountedAs === uid;
}

/**
 * Issue 5842 — a sign-in in ANOTHER tab. The auth SDK reports it to every open tab,
 * but only a same-tab sign-in reached `reloadIntoSession` (`SignInButton.onAuthed`),
 * so a tab already open kept its mount-time reads: the previous account's workspace
 * list, until a manual reload.
 *
 * While this tab is running its own sign-in (the dialog is open), `onAuthed` owns the
 * exit and the change is not foreign. Otherwise, when the shell mounted SIGNED IN as
 * one account and the SDK now reports a different signed-in account, someone signed
 * in elsewhere, and the tab reloads into it. Deliberately not foreign:
 *  - the same person signing in again (the builder's retry needs its canvas);
 *  - a shell that mounted anonymous. The boot watchdog records `null` when the SDK is
 *    slow, so a late real answer would read as foreign and a slow SDK would reload
 *    the page on every visit. That case already re-points the storage subject;
 *  - a sign-out elsewhere, which the session refusal path handles.
 */
let inPageSignIns = 0;

/** Mark this tab's own sign-in as running; returns the matching end. */
export function beginInPageSignIn(): () => void {
  inPageSignIns += 1;
  let ended = false;
  return () => { if (!ended) { ended = true; inPageSignIns = Math.max(0, inPageSignIns - 1); } };
}

/** True when `uid` is a different signed-in identity that this tab did not sign in. */
export function isForeignSignIn(uid: string | null): boolean {
  return typeof mountedAs === 'string' && uid !== null && uid !== mountedAs && inPageSignIns === 0;
}

/**
 * Issue 6043 — a sign-OUT in another tab. The cookie is shared, so the session is
 * gone here too, but this tab's mount-time reads still show the signed-out account,
 * which matters on a shared computer. A plain 401 `sign_in_required` is deliberately
 * not a sign-out (`sessionRefusalOf`), so the tab learns of it from the auth SDK
 * reporting null, or from the backend session going from a user to none.
 *
 * Every sign-out THIS tab starts runs through `firebase.ts` `signOut`, which marks
 * it here first, so the tab's own sign-out keeps its own exit (its navigation, a
 * hard sign-out's notice) and never reloads under it.
 */
let ownSignOut = false;

/** Called by `firebase.ts` `signOut`, before anything else changes. */
export function noteOwnSignOut(): void { ownSignOut = true; }

/** Whether this tab has signed itself out (the backend-session half asks). */
export function isOwnSignOut(): boolean { return ownSignOut; }

/** True when the shell mounted SIGNED IN, nobody is signed in now, and this tab did
 *  not sign itself out. A shell that mounted anonymous never qualifies, so the boot
 *  watchdog's `null` (a slow SDK) cannot turn into a reload loop. */
export function isForeignSignOut(uid: string | null): boolean {
  return typeof mountedAs === 'string' && uid === null && !ownSignOut;
}

/** For tests — reset the module singleton. Not for production paths. */
export function __resetShellIdentityForTest(): void {
  mountedAs = undefined;
  inPageSignIns = 0;
  ownSignOut = false;
}
