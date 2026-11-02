/**
 * ADR 1015 D3 — the shared `VisitorConsentBanner`, mounted by the tenant site
 * runtime on a customer's page. Lazy: only a page that needs the banner loads
 * React, i18next and this stylesheet.
 *
 * It renders inside a shadow root, so the customer's page and our styles never
 * touch each other. The banner has no PublicShell footer to portal into here,
 * so its "Privacy choices" control renders inline with it (the banner's own
 * no-footer path). Copy comes from the same `site` catalog the SPA uses, in the
 * page's `<html lang>` (English when it isn't one we ship).
 */
import { createRoot } from 'react-dom/client';
import { createInstance, type Resource } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { VisitorConsentBanner } from '../features/site/VisitorConsentBanner.js';
import { GlobalLiveRegion } from '../ui/announce.js';
import runtimeCss from './runtime.css?inline';
import type { RuntimeTarget } from './main.js';

type Catalog = { messages: Record<string, string> };
const CATALOGS: Record<string, () => Promise<Catalog>> = {
  en: () => import('../features/site/i18n/en.js'),
  es: () => import('../features/site/i18n/es.js'),
  fr: () => import('../features/site/i18n/fr.js'),
  'pt-BR': () => import('../features/site/i18n/pt-BR.js'),
};

/** The shipped locale for a `<html lang>` value: exact, then by language. */
export function catalogLocale(lang: string | null | undefined): string {
  const v = (lang ?? '').trim();
  if (Object.hasOwn(CATALOGS, v)) return v;
  const base = v.split('-')[0]!.toLowerCase();
  if (base === 'pt') return 'pt-BR';
  return Object.hasOwn(CATALOGS, base) ? base : 'en';
}

/** In a shadow root `:root` matches nothing; the tokens must land on the host.
 *  A compound selector moves inside `:host(…)` (`:root:not(.theme-light)` →
 *  `:host(:not(.theme-light))`), because a bare `:host` takes no further
 *  pseudo-class or class and would otherwise match nothing (no dark mode). */
export function shadowCss(css: string): string {
  return css
    .replace(/:root((?:\.[\w-]+|\[[^\]]*\]|:not\([^)]*\))+)/g, ':host($1)')
    .replace(/:root\b/g, ':host');
}

export async function mountBanner(target: RuntimeTarget): Promise<() => void> {
  const lng = catalogLocale(document.documentElement.getAttribute('lang'));
  const [{ messages }, en] = await Promise.all([CATALOGS[lng]!(), lng === 'en' ? null : CATALOGS.en!()]);
  const resources: Resource = { [lng]: { site: messages } };
  if (en) resources.en = { site: en.messages };
  const i18n = createInstance();
  await i18n.use(initReactI18next).init({
    lng, fallbackLng: 'en', ns: ['site'], defaultNS: 'site', resources,
    interpolation: { escapeValue: false }, returnNull: false,
  });

  const host = document.createElement('div');
  host.setAttribute('data-owp-consent', '');
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = shadowCss(runtimeCss);
  shadow.appendChild(style);
  const mount = document.createElement('div');
  shadow.appendChild(mount);
  const root = createRoot(mount);
  root.render(
    <I18nextProvider i18n={i18n}>
      <VisitorConsentBanner orgId={target.orgId} privacyHref={target.privacyHref} />
      {/* The banner speaks through the app's one live region (its saved and
          failed messages); there is no app shell here, so mount it with the
          banner or a screen reader hears nothing. */}
      <GlobalLiveRegion />
    </I18nextProvider>,
  );
  return () => { root.unmount(); host.remove(); };
}
