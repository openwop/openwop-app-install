/**
 * ADR 0122 Phase 6 — the public share-viewer route matcher, extracted as a pure
 * zero-dependency function so the `/shared/:token` precedence is unit-testable
 * (App.tsx renders it above AppGate, like `/p/:slug`). Token charset is base64url-
 * safe; the match is anchored so it never over-matches a nested path.
 */

/** Returns the share token for a `/shared/:token` path, or null otherwise. */
export function matchSharedToken(pathname: string): string | null {
  const m = pathname.match(/^\/shared\/([A-Za-z0-9_-]+)$/);
  return m ? m[1]! : null;
}
