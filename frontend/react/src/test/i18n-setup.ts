/**
 * Vitest setup (ADR 0065) — bootstraps the i18n framework before any test
 * renders. Component tests use `useTranslation(...)` / `t(...)`; without an
 * initialized i18next instance those calls return raw keys instead of the
 * English copy, so assertions on visible text would break. Importing the
 * bootstrap for its side effect registers every catalog (core + per-feature)
 * via `import.meta.glob`, exactly as the app does at runtime.
 *
 * ADR 0490 — the app now defers FEATURE `en` catalogs out of the eager bundle
 * and loads each with its (already lazy) page, which halves the eager i18n
 * chunk. In the app that is invisible: `useSuspense` waits inside the route's
 * <Suspense>. In TESTS it is not — `render()` returns synchronously, the
 * component suspends, and an assertion on copy sees the fallback.
 *
 * The alternative was making ~112 existing assertions await their namespace.
 * That would push a bundling concern onto every test author forever, and tests
 * do not measure bundle size — so the catalogs are preloaded here instead. The
 * SPLIT is verified by `i18nNamespaceSplit.test.ts` + the bundle budget, not by
 * making the suite live with it.
 */
import '../i18n/index.js';
import i18n from '../i18n/index.js';
import { LAZY_EN_NAMESPACES, loadEnNamespace } from '../i18n/resources.js';
import { assertNamespacesPopulated } from './lazyNamespacePreload.js';
import { installUnhandledRejectionAttribution } from './unhandled-rejection-attribution.js';

await Promise.all(
  LAZY_EN_NAMESPACES.map(async (ns) => {
    const messages = await loadEnNamespace(ns);
    if (messages) i18n.addResourceBundle('en', ns, messages, true, true);
  }),
);

/**
 * Assert the preload actually landed, naming any namespace that did not.
 *
 * NOT a fix for a known bug — this is an INSTRUMENT. `ProjectMembersTab.access`
 * failed once in a 479-file run with:
 *
 *     Unable to find a label with the text of: Remove Alice
 *
 * That label is `t('removeMemberAria', { name })` from the LAZY `projects`
 * namespace, so a missing bundle and a missing table row produce the identical
 * message — and the failure surfaces at whichever assertion happens to read copy
 * first, which may be in an unrelated file. I could not reproduce it: a clean
 * 480-file run passed, and so did a targeted run under four-core contention.
 *
 * `loadEnNamespace` THROWS on a failed import (checked, not assumed), so a hard
 * load failure would already fail this file loudly. What it cannot catch is a
 * bundle that never registered — `addResourceBundle` is skipped silently when
 * `messages` is null. This closes that gap: if a namespace is absent, the suite
 * says WHICH ONE, once, at setup, instead of leaving a copy assertion somewhere
 * to fail for an unrelated-looking reason.
 *
 * Same rule this programme applies to the product: a failure must not be able to
 * present as an ordinary answer.
 */
// The check itself lives in `lazyNamespacePreload.ts` so it has its own tests —
// a guard with no guard of its own is the asymmetry this change was written to
// criticise. It checks CONTENT, not registration: see the note there on why
// `hasResourceBundle` would have passed the exact failure this catches.
assertNamespacesPopulated(i18n, LAZY_EN_NAMESPACES);

// An unhandled rejection fails the RUN while every test still reports passing —
// the exit code and the counts disagree, and nothing names the running test.
// This adds that coordinate without swallowing the failure. See the module.
installUnhandledRejectionAttribution();
