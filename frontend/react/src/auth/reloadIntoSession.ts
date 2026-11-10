/**
 * KT-AUTH-1 — the one exit from an IN-PAGE sign-in, once the backend handshake
 * has finished.
 *
 * Most sign-ins never need this. On a page reload or a plain OAuth redirect the
 * auth SDK's first emission is already the user, and `useAuth.loading` holds the
 * app until then, so the shell mounts as the real identity. An in-page sign-in is
 * different: an email/password sign-in, or an MFA challenge (the redirect-back
 * throws, so the first emission is null), starts from a shell that has already
 * mounted ANONYMOUS and read everything as `anon:<sid>`. That shell survives the
 * sign-in, so mount-time reads (the workspace switcher, the KickTodo pages) keep
 * showing the sandbox until something reloads. MEASURED on kicktodo.com 00067-tn9.
 *
 * WHY A RELOAD AND NOT A BROADCAST. `fireAuthChanged()` reaches only registered
 * caches and subscribers, and most surfaces load on mount and subscribe to
 * nothing. The SSE-bound stores and the builder canvas have no tenant-reset path
 * at all, so an in-app reset would leave a half-reset page (PLAN-DEFERRED D.1).
 * This is the same call `WorkspaceSwitcher` and `OperatorAccessPanel` make after
 * a tenant change. Patching each surface would have to be repeated forever.
 *
 * Safe across a reload: the SDK has persisted the session, a failed handshake is
 * retried by `reconcileRestoredSession`, and anon content adoption is idempotent.
 * NOT safe for unsaved builder edits, so it runs only when the identity really
 * changed. `shellIdentity.ts` has the same-user case and why.
 */
export function reloadIntoSession(): void {
  window.location.reload();
}
