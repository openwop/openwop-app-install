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
