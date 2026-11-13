/**
 * A visitor whose saved locale is a lazy one (es, fr, pt-BR) boots with that locale's
 * SHELL catalogs (nav, chrome, common), not English.
 *
 * Found live 2026-11-13 (CT-NAV-1): with `openwop.uiLocale = es`, app.openwop.dev drew
 * every nav label, the rail and the shell banner in English while feature pages were
 * Spanish. The lazy-namespace backend answers a lazy locale's shell namespaces with `{}`;
 * i18next stores that as an empty bundle, and the boot guard asked `hasResourceBundle`,
 * which was then true, so the shell chunk was never fetched.
 *
 * Sabotage, restored, red: put `i18n.hasResourceBundle(initialLocale, 'common')` back in
 * `i18nReady`'s guard and in `ensureLocaleLoaded`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCALE_STORAGE_KEY } from '../locales.js';

afterEach(() => { localStorage.removeItem(LOCALE_STORAGE_KEY); vi.resetModules(); });

describe('a saved lazy locale boots with its shell catalogs', () => {
  it.each([['es', 'Panel'], ['fr', null], ['pt-BR', null]] as const)('%s', async (locale, dashboard) => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    vi.resetModules();
    const { i18n, i18nReady } = await import('../index.js');
    await i18nReady;
    expect(i18n.language).toBe(locale);
    const nav = i18n.getResourceBundle(locale, 'nav') as Record<string, string> | undefined;
    const enNav = i18n.getResourceBundle('en', 'nav') as Record<string, string>;
    expect(Object.keys(nav ?? {}).length).toBe(Object.keys(enNav).length);
    expect(Object.keys(i18n.getResourceBundle(locale, 'common') ?? {}).length).toBeGreaterThan(0);
    const label = i18n.getFixedT(null, 'nav')('dashboardLabel');
    if (dashboard) expect(label).toBe(dashboard);
    expect(label).not.toBe(enNav.dashboardLabel);
  });
});
