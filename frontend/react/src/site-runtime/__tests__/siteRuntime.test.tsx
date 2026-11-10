/**
 * ADR 1015 — the tenant site visitor runtime.
 *
 *   - Its EAGER import graph never reaches React, the SPA's `client/config`
 *     (session, auth headers) or the SPA i18n bootstrap: those must not load on a
 *     customer's page just to read the consent posture.
 *   - It calls its own hostname (base `''`), measures only once the visitor's
 *     decision allows it, sends nothing after a refusal, and starts measuring the
 *     moment a visitor accepts in the banner.
 *   - The banner mounts in a shadow root with the shared component and the `site`
 *     catalog in the page's language, and links only the workspace's own privacy
 *     page.
 *   - The runtime's button rules use only tokens the SPA's button rule uses.
 *
 * Red on the old code: none of `site-runtime/` existed, and the visitor modules
 * read `client/config` (so the graph check failed through every one of them).
 *
 * Sabotage-checked (w83 probes): an eager `react` or `client/config` import; the
 * runtime not setting base `''`; dropping the measure-once latch; an opt-in
 * regime read as allowed; a stored refusal not honoured; no consent subscription;
 * the banner never offered; a `//host` privacy path admitted; the slug left
 * encoded; the page language ignored; the stylesheet installed without the
 * `:root` → `:host` rewrite, or with a bare `:host.x` compound; no live region; focus
 * not returned; a privacy link with no workspace page; a button token renamed.
 *
 * The measure-once latch is held by the opt-out case alone (it re-runs consent
 * after the pageview and asserts it is not sent again); the opt-in case sends its
 * one pageview on the single decision change and cannot see the latch.
 *
 * Copy is pinned as literals (not imported from the catalogs), and the
 * stylesheet `mountBanner` installs is the real `runtime.css` with its
 * `@import`s inlined as the build inlines them (vitest does not process CSS, so
 * the bare `?inline` import is empty here). Every runtime and banner a case
 * starts is stopped in `finally`: the consent listeners are module state that
 * `__resetVisitorConsentForTests` does not clear (SITE-LISTENER-RESET-1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { __resetVisitorConsentForTests, recordChoice } from '../../features/site/visitorConsent.js';
import { setVisitorApiBase } from '../../features/site/visitorApi.js';
import { pageSlugOf, readTarget, startSiteRuntime } from '../main.js';
import { catalogLocale, mountBanner, shadowCss } from '../mountBanner.js';

// The build inlines runtime.css's `@import`s; vitest returns '' for a CSS
// `?inline` import, so hand mountBanner the same inlined text.
vi.mock('../runtime.css?inline', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const url = await import('node:url');
  const dir = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
  const css = fs.readFileSync(path.resolve(dir, 'runtime.css'), 'utf8')
    .replace(/@import '([^']+)';/g, (_m: string, file: string) => fs.readFileSync(path.resolve(dir, file), 'utf8'));
  return { default: css };
});

const ES_TITLE = 'Analítica en este sitio';
const ES_PRIVACY = 'Política de privacidad';
const EN_TITLE = 'Analytics on this site';
const EN_ACCEPT = 'Accept analytics';
const EN_SAVED_ON = 'Analytics turned on.';
const drain = async (): Promise<void> => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '../..');

/** Static imports only (`import … from`, `export … from`, bare `import '…'`); a
 *  dynamic `import()` is a lazy chunk and is deliberately not followed. */
function staticImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const out: string[] = [];
  for (const m of text.matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/gm)) {
    if (/^\s*(?:import|export)\s+type\s/.test(m[0])) continue;
    out.push(m[1]!);
  }
  return out;
}
function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec.replace(/\.js$/, ''));
  for (const c of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) if (existsSync(c) && !c.endsWith('/')) return c;
  return null;
}
function eagerGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>(); const packages = new Set<string>(); const queue = [entry];
  while (queue.length) {
    const f = queue.pop()!;
    if (files.has(f)) continue;
    files.add(f);
    for (const spec of staticImports(f)) {
      if (!spec.startsWith('.')) { packages.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/')); continue; }
      const r = resolveLocal(f, spec);
      if (r && /\.(?:ts|tsx)$/.test(r)) queue.push(r);
    }
  }
  return { files, packages };
}

type Route = (url: string, init?: RequestInit) => { status: number; body?: unknown };
const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
function stubFetch(route: Route): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = route(url, init);
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }));
}
const site = (regime: 'opt-in' | 'opt-out'): Route => (url, init) => {
  if (url.endsWith('/posture')) return { status: 200, body: { regime } };
  if (url.includes('/public-consent/') && init?.method === 'POST') return { status: 201, body: { ok: true, subjectToken: 'tok-1' } };
  if (url.endsWith('/capture-config')) return { status: 200, body: { heatmaps: false } };
  return { status: 202, body: { recorded: true } };
};
const ORG = 'org-rt';
const analyticsCalls = (): typeof calls => calls.filter((c) => c.url.includes('/public-analytics/'));
const noBanner = async (): Promise<void> => undefined;

beforeEach(() => { localStorage.clear(); calls.length = 0; __resetVisitorConsentForTests(); });
afterEach(() => {
  cleanup(); vi.unstubAllGlobals(); setVisitorApiBase('/api');
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('lang');
});

describe('ADR 1015 — the eager runtime graph', () => {
  it('never reaches React, client/config or the SPA i18n bootstrap', () => {
    const { files, packages } = eagerGraph(resolve(SRC, 'site-runtime/main.ts'));
    const rel = [...files].map((f) => f.slice(SRC.length + 1));
    expect(rel).toContain('features/site/visitorConsent.ts');
    // `client/baseUrlDefault.ts` is the one dependency-free constant allowed in.
    expect(rel.filter((f) => (f.startsWith('client/') && f !== 'client/baseUrlDefault.ts') || f.startsWith('i18n/') || f.startsWith('ui/') || f.startsWith('chrome/'))).toEqual([]);
    expect([...packages].filter((p) => p.startsWith('react') || p === 'i18next')).toEqual([]);
  });
});

describe('ADR 1015 — measuring', () => {
  it('opt-out: one same-origin pageview on load; the banner is offered', async () => {
    stubFetch(site('opt-out'));
    const mount = vi.fn(noBanner);
    const stop = await startSiteRuntime({ orgId: ORG, privacyHref: null }, { mountBanner: mount });
    try {
      const pv = analyticsCalls().filter((c) => c.url.endsWith('/collect'));
      expect(pv).toHaveLength(1);
      expect(pv[0]!.url).toBe(`/host/openwop-app/public-analytics/${ORG}/collect`);
      expect(JSON.parse(String(pv[0]!.init!.body))).toMatchObject({ type: 'pageview', path: '/', sessionKey: expect.stringMatching(/^vk-/) });
      expect(mount).toHaveBeenCalledTimes(1);
      // A later consent change re-runs the decision; the pageview is not sent again.
      await act(async () => { await recordChoice(ORG, true); });
      await drain();
      expect(analyticsCalls().filter((c) => c.url.endsWith('/collect'))).toHaveLength(1);
    } finally { stop(); }
  });

  it('opt-in with no choice: nothing is measured until Accept, then it starts at once', async () => {
    stubFetch(site('opt-in'));
    const stop = await startSiteRuntime({ orgId: ORG, privacyHref: null }, { mountBanner: noBanner });
    try {
      expect(analyticsCalls()).toEqual([]);
      expect(localStorage.getItem(`owp:vk:${ORG}`)).toBeNull();
      await act(async () => { await recordChoice(ORG, true); });
      await waitFor(() => expect(analyticsCalls().filter((c) => c.url.endsWith('/collect'))).toHaveLength(1));
      expect(localStorage.getItem(`owp:vk:${ORG}`)).toMatch(/^vk-/);
    } finally { stop(); }
  });

  it('a stored refusal sends no analytics call at all', async () => {
    stubFetch(site('opt-out'));
    localStorage.setItem('owp:consent', JSON.stringify({ [ORG]: { analytics: false, at: '2026-10-31T00:00:00.000Z' } }));
    const stop = await startSiteRuntime({ orgId: ORG, privacyHref: null }, { mountBanner: noBanner });
    try {
      expect(analyticsCalls()).toEqual([]);
    } finally { stop(); }
  });

  it('maps custom-domain paths to page slugs and reads its own tag', () => {
    expect(pageSlugOf('/')).toBe('home');
    expect(pageSlugOf('/p/about%20us')).toBe('about us');
    expect(pageSlugOf('/blog/launch')).toBe('launch');
    expect(pageSlugOf('/pricing')).toBe('pricing');
    expect(pageSlugOf('/pod/show')).toBeNull();
    document.body.innerHTML = '<script type="module" data-owp-org="org-x" data-owp-privacy="/p/privacy"></script>';
    expect(readTarget()).toEqual({ orgId: 'org-x', privacyHref: '/p/privacy' });
    document.body.innerHTML = '<script type="module" data-owp-org="org-x" data-owp-privacy="//evil.test/x"></script>';
    expect(readTarget()).toEqual({ orgId: 'org-x', privacyHref: null });
  });
});

describe('ADR 1015 — the banner on a customer page', () => {
  it('mounts the shared banner in a shadow root, in the page language, with the workspace privacy link', async () => {
    stubFetch(site('opt-in'));
    setVisitorApiBase('');
    document.documentElement.setAttribute('lang', 'es');
    const stop = await mountBanner({ orgId: ORG, privacyHref: '/p/privacy' });
    try {
      const host = document.querySelector('[data-owp-consent]');
      const shadow = host?.shadowRoot;
      expect(shadow).toBeTruthy();
      await waitFor(() => expect(shadow!.textContent).toContain(ES_TITLE));
      expect(shadow!.querySelector('a[href="/p/privacy"]')?.textContent).toBe(ES_PRIVACY);
      // The installed sheet is the tokens + banner rules, rewritten for a shadow
      // root: `:root` matches nothing there, and the dark-mode compounds keep working.
      const css = shadow!.querySelector('style')!.textContent ?? '';
      expect(css).toContain('--clay-strong');
      expect(css).toContain(':host(.theme-dark)');
      expect(css).toContain(':host(:not(.theme-light))');
      expect(css).not.toMatch(/:root\b/);
      // The page outside the shadow root gets nothing but the host element.
      expect(document.body.textContent).not.toContain(ES_TITLE);
    } finally { stop(); }
  });

  it('a choice is announced and focus returns to where the visitor was', async () => {
    stubFetch(site('opt-in'));
    setVisitorApiBase('');
    const before = document.createElement('button');
    before.textContent = 'Page action';
    document.body.appendChild(before);
    const stop = await mountBanner({ orgId: ORG, privacyHref: null });
    try {
      const shadow = document.querySelector('[data-owp-consent]')!.shadowRoot!;
      const accept = await waitFor(() => {
        const b = [...shadow.querySelectorAll('button')].find((x) => x.textContent === EN_ACCEPT);
        expect(b).toBeTruthy();
        return b!;
      });
      before.focus();
      accept.focus(); // focus moves from the page into the shadow root
      await act(async () => { fireEvent.click(accept); });
      // The banner's own live region is mounted with it (there is no app shell here).
      await waitFor(() => expect(shadow.querySelector('[data-owp-live="polite"]')?.textContent).toBe(EN_SAVED_ON));
      await waitFor(() => expect(document.activeElement).toBe(before));
    } finally { stop(); }
  });

  it('shows no privacy link when the workspace has none', async () => {
    stubFetch(site('opt-in'));
    setVisitorApiBase('');
    const stop = await mountBanner({ orgId: ORG, privacyHref: null });
    try {
      const shadow = document.querySelector('[data-owp-consent]')!.shadowRoot!;
      await waitFor(() => expect(shadow.textContent).toContain(EN_TITLE));
      expect(shadow.querySelector('a')).toBeNull();
    } finally { stop(); }
  });

  it('picks a shipped catalog for the page language', () => {
    expect(catalogLocale('es-MX')).toBe('es');
    expect(catalogLocale('pt')).toBe('pt-BR');
    expect(catalogLocale('pt-BR')).toBe('pt-BR');
    expect(catalogLocale('de')).toBe('en');
    expect(catalogLocale(null)).toBe('en');
    // A compound `:root` moves INSIDE `:host(…)`: a bare `:host` takes no further
    // class or pseudo-class, so `:host:not(…)` would match nothing (no dark mode).
    expect(shadowCss(':root{--a:1}:root.theme-dark{--a:2}:root:not(.theme-light){--a:3}'))
      .toBe(':host{--a:1}:host(.theme-dark){--a:2}:host(:not(.theme-light)){--a:3}');
    expect(shadowCss('@media (prefers-color-scheme: dark) { :root:not(.theme-light) { --paper: x } }'))
      .toBe('@media (prefers-color-scheme: dark) { :host(:not(.theme-light)) { --paper: x } }');
  });
});

describe('ADR 1015 — the copied button rules', () => {
  it('use only tokens the SPA button rule uses', () => {
    const runtime = readFileSync(resolve(SRC, 'site-runtime/runtime.css'), 'utf8');
    const block = /\nbutton \{([^}]*)\}/.exec(runtime)![1]!;
    const global = readFileSync(resolve(SRC, 'styles/global.css'), 'utf8');
    // The primary-button rule: the `button, a.btn` block that sets the clay fill.
    // (Matched to the closing line: its comments contain braces.)
    const spa = [...global.matchAll(/\nbutton,\na\.btn \{\n([\s\S]*?)\n\}\n/g)].map((m) => m[1]!).find((b) => b.includes('--clay-strong'))!;
    expect(spa, 'the SPA primary button rule').toBeTruthy();
    const vars = (s: string): string[] => [...new Set([...s.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!))].sort();
    expect(vars(block)).toEqual(vars(spa));
  });
});
