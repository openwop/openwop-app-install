/**
 * i18n bootstrap (ADR 0065) — wires i18next + react-i18next, negotiates the
 * active UI locale, keeps the formatting layer + `<html lang|dir>` in sync, and
 * forwards the active locale as the request `Accept-Language` (ADR 0064 seam).
 *
 * Import once for its side effect before rendering (see `main.tsx`). Components
 * use `useTranslation('<ns>')` for strings and `useFormat()` for numbers/dates.
 *
 * Plurals resolve via `Intl.PluralRules` (`_one`/`_other` …). Keys are validated
 * at build by `scripts/check-i18n.mjs`, not by TS types — so `t()` is loosely
 * typed and cross-namespace `t('common:x')` works without ceremony.
 */

import i18n, { type Resource, type ResourceLanguage } from 'i18next';
import { initReactI18next } from 'react-i18next';
import { enResources, NAMESPACES, resourcesByLocale, loadLocaleResources } from './resources.js';
import {
  DEFAULT_LOCALE,
  detectLocale,
  directionFor,
  LOCALE_STORAGE_KEY,
  PREVIEW_ENABLED,
  PREVIEW_LOCALES,
  resolveLocale,
  SUPPORTED_LOCALES,
} from './locales.js';
import { setFormatLocale } from './format.js';
import { PSEUDO_LOCALE, PSEUDO_LOCALE_ENABLED, pseudoLocalize } from './pseudo.js';

/** Notified on every locale change so `client/config.ts` can forward Accept-Language. */
const localeListeners = new Set<(locale: string) => void>();
/** Subscribe to active-UI-locale changes. Returns an unsubscribe fn. */
export function onLocaleChange(fn: (locale: string) => void): () => void {
  localeListeners.add(fn);
  return () => localeListeners.delete(fn);
}
/** The active UI locale right now (for the initial Accept-Language read). */
export function getActiveLocale(): string {
  return i18n.language || DEFAULT_LOCALE;
}

/** Reflect the active locale onto the document + formatters + header listeners. */
function syncLocale(locale: string): void {
  setFormatLocale(locale);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    document.documentElement.dir = directionFor(locale);
  }
  for (const fn of localeListeners) fn(locale);
}

// Eager bundle: the locales in `resourcesByLocale` (the default + the supported
// locales that fit the chunk budget — en + pt-BR), plus the pseudo-locale when QA
// mode is on. Other locales (fr/es — supported but lazy, and any preview locale)
// load on demand via `ensureLocaleLoaded`, keeping the i18n chunk under budget;
// an auto-negotiated lazy locale paints `en` first, then swaps once its chunk loads.
const resources: Resource = {};
for (const [loc, res] of Object.entries(resourcesByLocale)) {
  resources[loc] = res as ResourceLanguage;
}
if (PSEUDO_LOCALE_ENABLED) {
  resources[PSEUDO_LOCALE] = pseudoLocalize(enResources) as ResourceLanguage;
}

function specialAllowed(loc: string): boolean {
  return (
    (PREVIEW_ENABLED && (PREVIEW_LOCALES as readonly string[]).includes(loc)) ||
    (PSEUDO_LOCALE_ENABLED && loc === PSEUDO_LOCALE)
  );
}

const storedLocale =
  typeof localStorage !== 'undefined' ? localStorage.getItem(LOCALE_STORAGE_KEY) : null;
const initialLocale = storedLocale && specialAllowed(storedLocale) ? storedLocale : detectLocale();

void i18n.use(initReactI18next).init({
  resources,
  ns: NAMESPACES,
  defaultNS: 'common',
  lng: initialLocale,
  fallbackLng: DEFAULT_LOCALE,
  supportedLngs: [
    ...SUPPORTED_LOCALES,
    ...(PREVIEW_ENABLED ? PREVIEW_LOCALES : []),
    ...(PSEUDO_LOCALE_ENABLED ? [PSEUDO_LOCALE] : []),
  ],
  interpolation: { escapeValue: false }, // React escapes
  returnNull: false,
});

i18n.on('languageChanged', syncLocale);
syncLocale(initialLocale);

/** Lazy (preview) locales already merged into i18next this session. */
const lazyLoaded = new Set<string>();

/**
 * Ensure a locale's catalog is in i18next before switching to it. Eager locales
 * (default + SUPPORTED + pseudo) are already present and no-op; a lazy preview
 * locale (e.g. `fr`) is fetched as its own chunk and merged on first use.
 */
async function ensureLocaleLoaded(locale: string): Promise<void> {
  if (
    lazyLoaded.has(locale) ||
    resourcesByLocale[locale] ||
    i18n.hasResourceBundle(locale, 'common')
  ) {
    return;
  }
  const res = await loadLocaleResources(locale);
  if (!res) return;
  for (const [ns, messages] of Object.entries(res)) {
    i18n.addResourceBundle(locale, ns, messages, true, true);
  }
  lazyLoaded.add(locale);
}

// A persisted/auto-negotiated initial locale may be a lazy locale (e.g. fr/es for a
// French/Spanish browser, or a preview locale): it isn't in the eager bundle, so
// load it then switch (i18next falls back to `en` for the first paint).
if (!resourcesByLocale[initialLocale] && !i18n.hasResourceBundle(initialLocale, 'common')) {
  void ensureLocaleLoaded(initialLocale).then(() => i18n.changeLanguage(initialLocale));
}

/**
 * Switch the active UI locale and persist it. A preview/pseudo locale passes
 * through when its QA gate is on; any other candidate resolves to the nearest
 * declared locale. A lazy preview locale is fetched before the switch.
 */
export function setLocale(candidate: string): void {
  const next = specialAllowed(candidate) ? candidate : resolveLocale(candidate);
  if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_STORAGE_KEY, next);
  void ensureLocaleLoaded(next).then(() => i18n.changeLanguage(next));
}

export { i18n };
export default i18n;
