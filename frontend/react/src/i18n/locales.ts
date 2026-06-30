/**
 * Locale registry + negotiation (ADR 0065).
 *
 * The declared-locale list is a CONTRACT: advertising a UI language whose
 * catalog is incomplete or unreviewed erodes trust. `SUPPORTED_LOCALES` holds
 * only locales whose UI catalog is complete AND native-reviewed; drafts pending
 * review live in `PREVIEW_LOCALES` (loadable for QA, never auto-negotiated or
 * advertised). Promoting a reviewed locale is a one-line move between the two.
 *
 * The FRONTEND owns the *UI display locale* (a client preference, like the theme
 * toggle) and forwards it as `Accept-Language`; the BACKEND stays authority over
 * which *content* locale to serve (ADR 0064 negotiation). This module is the
 * single source of truth for the active UI locale only.
 */

/** UI locales with a complete catalog — advertised + auto-negotiated + shown in the
 *  switcher without `?preview=1`. Each has key-parity with `en` (enforced by check-i18n).
 *  - en: source of truth.
 *  - pt-BR: promoted 2026-06-18, native-speaker reviewed (ADR 0065 Phase 4).
 *  - fr (France) / es (Spain): promoted 2026-06-20 at the owner's direction. Catalogs are
 *    complete but MACHINE-TRANSLATED — native-speaker review is still OUTSTANDING (tracked
 *    as a follow-up). This knowingly relaxes the "native-reviewed before advertise" part of
 *    the declared-locale contract for fr/es; tighten by reverting to PREVIEW if review fails. */
export const SUPPORTED_LOCALES = ['en', 'pt-BR', 'fr', 'es'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Source-of-truth locale + graceful fallback target. */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/** localStorage key for the user's explicit UI-locale choice. */
export const LOCALE_STORAGE_KEY = 'openwop.uiLocale';

/**
 * Fully-drafted UI locales PENDING review. Loadable via the switcher in dev /
 * `?preview=1`, but NOT in `SUPPORTED_LOCALES`: not auto-negotiated, not advertised.
 * Promote once ready (a one-line move to `SUPPORTED_LOCALES`). Currently empty —
 * fr/es were promoted to SUPPORTED 2026-06-20 (native review still pending).
 */
export const PREVIEW_LOCALES = [] as const;

/** Show preview locales in the switcher: on in dev, opt-in via `?preview=1`. */
export const PREVIEW_ENABLED: boolean =
  (typeof import.meta !== 'undefined' && import.meta.env?.DEV === true) ||
  (typeof location !== 'undefined' && new URLSearchParams(location.search).has('preview'));

/** Base languages written right-to-left (drives `<html dir>` + logical-CSS mirroring). */
const RTL_LANGUAGES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'dv']);

/** The base language of a BCP-47 tag (`en-US` → `en`), lower-cased. */
function baseLanguage(locale: string): string {
  return locale.toLowerCase().split('-')[0] ?? locale.toLowerCase();
}

/** `'rtl'` for right-to-left scripts, else `'ltr'`. */
export function directionFor(locale: string): 'ltr' | 'rtl' {
  return RTL_LANGUAGES.has(baseLanguage(locale)) ? 'rtl' : 'ltr';
}

/**
 * Resolve an arbitrary BCP-47 candidate to a supported locale: exact match,
 * then base-language match (`fr-CA` → `fr`), then the default. Never returns an
 * undeclared locale.
 */
export function resolveLocale(candidate: string | null | undefined): SupportedLocale {
  if (!candidate) return DEFAULT_LOCALE;
  const lower = candidate.toLowerCase();
  const exact = SUPPORTED_LOCALES.find((l) => l.toLowerCase() === lower);
  if (exact) return exact;
  const base = baseLanguage(candidate);
  const byBase = SUPPORTED_LOCALES.find((l) => baseLanguage(l) === base);
  return byBase ?? DEFAULT_LOCALE;
}

/**
 * Negotiate the active UI locale at boot: an explicit stored choice wins, then
 * `navigator.language`, then the default — always a declared locale.
 */
export function detectLocale(): SupportedLocale {
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored) return resolveLocale(stored);
  }
  if (typeof navigator !== 'undefined' && navigator.language) {
    return resolveLocale(navigator.language);
  }
  return DEFAULT_LOCALE;
}
