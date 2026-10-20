/**
 * Where the app's own "Privacy" links point. A white-label distribution whose
 * policy is a CMS page sets `VITE_BRAND_PRIVACY_URL` (an app path such as
 * `/p/privacy`); unset, the links go to the built-in `/privacy` page as before.
 * An app path, not an absolute URL: the links are router `<Link>`s. It lives in
 * `brand/`, not `features/site/`, because the shell chrome links it and chrome
 * may not import a feature module (ADR 0630).
 */
export const PRIVACY_HREF: string = privacyHref(import.meta.env.VITE_BRAND_PRIVACY_URL as string | undefined);

/** Exported for tests: a value that is not an app path falls back to `/privacy`. */
export function privacyHref(raw: string | undefined): string {
  const v = raw?.trim();
  return v && v.startsWith('/') && !v.startsWith('//') ? v : '/privacy';
}
