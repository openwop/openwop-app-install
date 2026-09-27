/**
 * ADR 0328 Phase 4 — the public phone-remote route matcher (`/present-remote/:token`),
 * a pure function like the share viewer's `matchSharedToken` so the precedence
 * (App.tsx renders it in the bare PublicShell above AppGate) is unit-testable.
 * The token is dotted (`v1.<claims>.<exp>.<sig>` — base64url segments), so the
 * charset admits `.` alongside base64url; anchored to never over-match.
 */

/** Returns the present-remote token for a `/present-remote/:token` path, or null. */
export function matchPresentRemoteToken(pathname: string): string | null {
  const m = pathname.match(/^\/present-remote\/([A-Za-z0-9_.-]+)$/);
  return m ? m[1]! : null;
}
