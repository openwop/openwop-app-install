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

/** For tests — reset the module singleton. Not for production paths. */
export function __resetShellIdentityForTest(): void {
  mountedAs = undefined;
}
