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
import { enResources, NAMESPACES, resourcesByLocale, loadLocaleResources, LAZY_EN_NAMESPACES, loadEnNamespace, isLazyLocaleNamespace, loadLocaleNamespace } from './resources.js';
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

/** Reflect the active locale onto the document + formatters.
 *
 * There is no listener set here any more. `onLocaleChange` was its only adder and was
 * swept as dead (Phase D); the Set survived it as a provably-empty collection whose
 * docblock still claimed `client/config.ts` depended on it. It does not —
 * `client/config.ts:207` calls `getRequestLocale()` per request inside `authedHeaders()`,
 * reading `localStorage` fresh, so Accept-Language is a PULL per call rather than a PUSH
 * on change. Strictly fresher, and one fewer thing to keep in sync. */
function syncLocale(locale: string): void {
  setFormatLocale(locale);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = locale;
    document.documentElement.dir = directionFor(locale);
  }
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

/**
 * ADR 0490 — the on-demand namespace backend.
 *
 * Feature `en` catalogs are no longer in the eager bundle (see resources.ts), so
 * i18next needs a way to fetch one when a feature page asks for it. A BACKEND is
 * used rather than wiring the load into each route because it covers EVERY
 * consumer of a namespace, wherever it renders — including any future
 * cross-feature use, which today measures zero but is not structurally
 * prevented. `react-i18next`'s default `useSuspense: true` then does the waiting,
 * and every feature page already sits inside the shell's route <Suspense>.
 *
 * `partialBundledLanguages` is what lets inline resources and the backend
 * coexist: the shell catalogs stay inline and never touch this.
 */
const lazyNsBackend = {
  type: 'backend' as const,
  init: (): void => {},
  read: (
    lng: string,
    ns: string,
    callback: (err: unknown, data?: Record<string, unknown> | false) => void,
  ): void => {
    // Feature catalogs are split per namespace for `en` AND for every lazy
    // locale (ADR 0490 + its locale follow-up). A lazy locale's SHELL catalogs
    // still arrive as one chunk via `ensureLocaleLoaded`; only its feature
    // namespaces come through here. Anything not deferred resolves empty and
    // falls back rather than 404-ing forever.
    const load =
      lng === DEFAULT_LOCALE && LAZY_EN_NAMESPACES.includes(ns)
        ? loadEnNamespace(ns)
        : (isLazyLocaleNamespace(lng, ns) ? loadLocaleNamespace(lng, ns) : null);
    if (!load) { callback(null, {}); return; }
    void load
      .then((messages) => callback(null, messages ?? {}))
      // A failed chunk must not brick the page: resolve empty so i18next falls
      // back to the key's defaultValue — and for a lazy locale that means the
      // `en` fallback, which is already loaded.
      .catch(() => callback(null, {}));
  },
};

void i18n.use(lazyNsBackend).use(initReactI18next).init({
  partialBundledLanguages: true,
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

/**
 * Resolves once the negotiated INITIAL locale's catalog is active (grade-ux
 * CHV-UX-1 / ADR 0329): a persisted/auto-negotiated lazy locale (pt-BR/fr/es,
 * or a preview locale) isn't in the eager bundle, so boot awaits this before
 * first render — a French user paints French, never an English flash that
 * swaps mid-read (with `<html lang="fr">` contradicting the visible text).
 * Guard-railed: a slow or failed chunk resolves the gate after 1.5 s and the
 * app paints `en`, swapping when (if) the chunk lands — the pre-gate behavior
 * as the degraded path, so i18n can never brick boot.
 */
export const i18nReady: Promise<void> = (() => {
  if (resourcesByLocale[initialLocale] || i18n.hasResourceBundle(initialLocale, 'common')) {
    return Promise.resolve();
  }
  const load = ensureLocaleLoaded(initialLocale)
    .then(() => i18n.changeLanguage(initialLocale))
    .then(() => undefined)
    .catch(() => undefined);
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 1500));
  return Promise.race([load, timeout]);
})();

/**
 * Switch the active UI locale and persist it. A preview/pseudo locale passes
 * through when its QA gate is on; any other candidate resolves to the nearest
 * declared locale. A lazy preview locale is fetched before the switch — the
 * returned promise settles once the switch is live, so pickers can show a
 * pending state (CHV-UX-4).
 */
export async function setLocale(candidate: string): Promise<void> {
  const next = specialAllowed(candidate) ? candidate : resolveLocale(candidate);
  if (typeof localStorage !== 'undefined') localStorage.setItem(LOCALE_STORAGE_KEY, next);
  await ensureLocaleLoaded(next).catch(() => undefined);
  await i18n.changeLanguage(next);
}

export { i18n };
export default i18n;
