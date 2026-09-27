/**
 * ADR 0544 P3 — the public `/verify/:token` route matcher.
 *
 * A SIBLING of the app's other public matchers (`/shared/:token`,
 * `/f/:formId`), deliberately NOT nested under `/job-search`. The backend half
 * makes the same call: an anonymous surface living inside an otherwise-
 * authenticated namespace is how a public hole opens by accident, and a reader
 * scanning either route table should be able to see at a glance which paths a
 * stranger can reach.
 *
 * The charset is the capability-token alphabet plus `%`, with a GUARDED decode:
 * a malformed percent sequence is a NON-MATCH, never a render-crashing
 * `URIError` (the `fillRoute` precedent). Length is capped here as well as at
 * the route — an unbounded segment on an anonymous path is free work for anyone,
 * and the client should not spend a request to learn that.
 */

/** The backend caps at 200; matching that here keeps the two ends honest. */
const MAX_TOKEN = 200;

/** Returns the decoded token for a `/verify/:token` path, or null otherwise. */
export function matchVerifyToken(pathname: string): string | null {
  const m = pathname.match(/^\/verify\/([A-Za-z0-9%_-]+)\/?$/);
  if (!m) return null;
  let token: string;
  try {
    token = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  return token.length > 0 && token.length <= MAX_TOKEN ? token : null;
}
