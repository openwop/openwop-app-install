/**
 * Ecommerce gap plan §5C C2 / ADR 0225 — the public `/store/:orgId` route
 * matcher, extracted as a pure zero-dependency function (the shareRoute
 * precedent) so it is unit-testable and stays in lockstep with
 * `storefrontPath` in commerceClient.ts, which percent-encodes the org id
 * (`user:…` → `user%3A…`) — the charset here MUST therefore accept `%`.
 * Anchored so it never over-matches a nested path.
 */

/** Returns the decoded org id for a `/store/:orgId` path, or null otherwise. */
export function matchStoreOrgId(pathname: string): string | null {
  const m = pathname.match(/^\/store\/([A-Za-z0-9%:_-]+)$/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    // Malformed percent-encoding (e.g. a stray `%`) — not a store link.
    return null;
  }
}
