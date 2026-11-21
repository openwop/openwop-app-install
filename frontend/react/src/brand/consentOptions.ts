/**
 * Two brand options for the visitor-consent banner (ADR 0860), build-time like
 * `VITE_BRAND_PRIVACY_URL`. Unset, the banner behaves exactly as before.
 *
 *  - `VITE_BRAND_CONSENT_CLEARANCE=off` (#6150): while the banner shows, the
 *    page gets NO bottom padding, so the document height does not change; the
 *    banner lies over the foot of the page until it is closed. The stock
 *    behaviour pads `<body>` by the banner's height so the end of the page can
 *    scroll clear of it. `scroll-padding-bottom` stays either way, so a focused
 *    control is never hidden behind the banner (WCAG 2.2 SC 2.4.11).
 *  - `VITE_BRAND_CONSENT_FOOTER=link` (#6155): the footer's "Privacy choices"
 *    is a plain link to the privacy page's choice section
 *    (`PRIVACY_HREF#privacy-choices`) instead of a button that reopens the
 *    banner. The first-visit banner still shows wherever the regime asks. It
 *    applies only while the privacy link is the built-in `/privacy` page, which
 *    renders that section; a policy elsewhere (a CMS page, the site runtime's
 *    workspace page) keeps the button, so the footer never links to a page that
 *    cannot change the choice. An adopter page renders `VisitorConsentChoices`.
 *
 * Lives in `brand/` beside `privacyHref.ts`: the options are brand config.
 */
export type ConsentClearance = 'pad' | 'off';
export type ConsentFooterMode = 'panel' | 'link';

/** The built-in privacy page, the one page known to render the choice section. */
export const BUILTIN_PRIVACY_PATH = '/privacy';

/** The id of the privacy page's choice section, which the footer link targets. */
export const PRIVACY_CHOICES_ANCHOR = 'privacy-choices';

export const CONSENT_CLEARANCE: ConsentClearance = consentClearance(import.meta.env.VITE_BRAND_CONSENT_CLEARANCE as string | undefined);
export const CONSENT_FOOTER: ConsentFooterMode = consentFooter(import.meta.env.VITE_BRAND_CONSENT_FOOTER as string | undefined);

/** Exported for tests: anything but `off` keeps the stock padding. */
export function consentClearance(raw: string | undefined): ConsentClearance {
  return raw?.trim().toLowerCase() === 'off' ? 'off' : 'pad';
}

/** Exported for tests: anything but `link` keeps the stock footer button. */
export function consentFooter(raw: string | undefined): ConsentFooterMode {
  return raw?.trim().toLowerCase() === 'link' ? 'link' : 'panel';
}
