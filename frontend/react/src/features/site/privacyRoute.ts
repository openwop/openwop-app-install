/**
 * The public `/privacy` route matcher. A privacy disclosure is read by visitors
 * who have no account, so it renders in the bare PublicShell like `/pricing`,
 * not inside the signed-in workspace shell (whose sidebar exposes the app's
 * own navigation to a reader who only wanted the policy). A trailing slash is
 * tolerated.
 */
export function matchPrivacyRoute(pathname: string): boolean {
  return pathname === '/privacy' || pathname === '/privacy/';
}


/**
 * Where `/privacy` should send the visitor instead of rendering the built-in
 * page, or null to render it. A white-label distribution that adopted its own
 * policy (`VITE_BRAND_PRIVACY_URL`, e.g. `/p/privacy`) must not ALSO serve the
 * generic one at `/privacy`: typed URLs, old links and crawlers would land on a
 * policy the operator never adopted. The href is passed in (not imported from
 * `brand/`) so the decision stays pure and testable.
 */
export function privacyRedirect(pathname: string, privacyHref: string): string | null {
  return matchPrivacyRoute(pathname) && privacyHref !== '/privacy' ? privacyHref : null;
}
