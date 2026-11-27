/**
 * `VITE_BRAND_SITE_PUBLIC_MENU` — the public site's grouped menu in the site-tier
 * product header (ADR 0641, extension note of 2026-11-24; decktalk-4a).
 *
 * Claims:
 *  1. OFF (the default) makes NO public-nav read and renders no menu. The off
 *     case leaves `fetch` unstubbed, so the ADR 0661 no-live-fetch guard
 *     (`src/test/no-live-fetch.ts`) fails the test if anything is fetched. That
 *     was the red decktalk-4a hit with an always-on menu.
 *  2. ON, grouped site: the grouped (mega) menu renders first in the header
 *     actions, without its utilities row and with Legal kept out. Its only reads
 *     are the public published-pages, blog and docs endpoints.
 *  3. ON, ungrouped site: nothing renders. The site nav strip already covers it.
 *  4. ON, signed-out visitor: the shell and the menu still render (the reads
 *     need no session).
 *  5. The build key reaches SiteShell's default; `sitePublicMenu()` accepts
 *     exactly `true` / `1`.
 *
 * Sabotage that turns it red: the default flipped on, or the off branch still
 * mounting the menu (case 1); the `utilities` prop ignored (case 2); the
 * grouped guard dropped (case 3); the parser accepting other values (case 5).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ComponentType } from 'react';
import { KNOWN_BRAND_ENV_VARS, resolveBrandFromEnv, sitePublicMenu } from '../../brand/defaults.js';

const Icon: ComponentType<{ size?: number }> = () => <svg aria-hidden="true" />;
const items = [{ to: '/app/projects', label: 'Projects', icon: Icon, hint: '' }];

const authState = vi.hoisted(() => ({ signedIn: true }));
vi.mock('../navConfig/NavConfigProvider.js', () => ({
  useResolvedNav: () => ({ workspace: [], admin: [], site: [{ id: 'Acme', label: 'Acme', items }] }),
}));
vi.mock('../../brand/BrandProvider.js', () => ({
  useBrand: () => ({ productName: 'Acme', logoSrc: '/mark.svg', markSrcDark: '', footerText: '' }),
}));
vi.mock('../../brand/BrandLogo.js', () => ({ BrandLogo: () => <svg aria-hidden="true" /> }));
vi.mock('../../auth/SignInButton.js', () => ({
  SignInButton: () => <button type="button">{authState.signedIn ? 'Account' : 'Sign in'}</button>,
}));
vi.mock('../../ui/ThemeToggle.js', () => ({ ThemeToggle: () => <button type="button">Theme</button> }));
vi.mock('../../i18n/LanguageSwitcher.js', () => ({ LanguageSwitcher: () => <select aria-label="Language" /> }));

const GROUPED = [
  { slug: 'for-agencies', title: 'For agencies', nav: { group: 'audience', label: 'Agencies', order: 10 } },
  { slug: 'about', title: 'About us', nav: { group: 'company', label: 'About', order: 10 } },
  { slug: 'terms', title: 'Terms', nav: { group: 'legal', label: 'Terms', order: 10 } },
];
const UNGROUPED = [{ slug: 'about', title: 'About us' }];

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answer the public nav reads only; record every URL asked for. */
function stubPublicNav(pages: unknown[]): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const u = String(input);
    urls.push(u);
    if (u.endsWith('/public/host-site/pages')) return Promise.resolve(json(200, { pages }));
    if (u.includes('/public/host-site/blog')) return Promise.resolve(json(200, { posts: [] }));
    return Promise.resolve(json(404, { error: 'not_found' }));
  }));
  return urls;
}

/** Fresh modules per case: the nav reads are cached once per page load. */
async function mount(publicMenu?: boolean): Promise<HTMLElement> {
  vi.resetModules();
  const { SiteShell } = await import('../SiteShell.js');
  const { container } = render(
    <MemoryRouter initialEntries={['/app/projects']}>
      {publicMenu === undefined ? <SiteShell><p>Desk</p></SiteShell> : <SiteShell publicMenu={publicMenu}><p>Desk</p></SiteShell>}
    </MemoryRouter>,
  );
  // Wait until the lazy menu module has LOADED (the same module promise React's
  // lazy() awaits), then flush, so a menu that mounted has rendered and made its
  // reads INSIDE the case. MEASURED: a few microtask flushes alone end the case
  // before the chunk resolves, and an always-mounted menu then read nothing in
  // time, so the OFF case stayed green on that bug.
  await act(async () => { await import('../PublicShell.js'); });
  for (let i = 0; i < 5; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.doUnmock('../../brand/brand.js'); authState.signedIn = true; });

describe('SiteShell public menu (VITE_BRAND_SITE_PUBLIC_MENU)', () => {
  it('OFF: no public-nav read, no menu (fetch left unstubbed: the live-fetch guard would fail this case)', async () => {
    const container = await mount(false);
    expect(screen.getByText('Desk')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
    expect(container.querySelector('.public-menu')).toBeNull();
  });

  it('ON, grouped: the grouped menu leads the header actions, with no utilities row and no Legal', async () => {
    const urls = stubPublicNav(GROUPED);
    const container = await mount(true);
    const btn = await screen.findByRole('button', { name: 'Menu' });
    const actions = container.querySelector('.public-shell-actions')!;
    expect(actions.firstElementChild?.classList.contains('public-menu--mega')).toBe(true);
    fireEvent.click(btn);
    const panel = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(Array.from(panel.querySelectorAll('.public-menu__heading')).map((h) => h.textContent)).toEqual(['Product', 'Who it’s for', 'Company']); // Product carries the /pricing app route; Legal (Terms) stays out
    expect(panel.querySelector('.public-menu__footer')).toBeNull();
    // The header's own theme toggle is the only one: the menu did not bring a second.
    expect(screen.getAllByRole('button', { name: 'Theme' })).toHaveLength(1);
    // Only the public, session-free nav reads.
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((u) => /\/host\/openwop-app\/public\/host-site\//.test(u) || /\/docs/.test(u))).toBe(true);
    expect(urls.some((u) => u.endsWith('/public/host-site/pages'))).toBe(true);
  });

  it('ON, ungrouped: nothing renders (the site nav strip covers an ungrouped site)', async () => {
    stubPublicNav(UNGROUPED);
    const container = await mount(true);
    expect(screen.getByText('Desk')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
    expect(container.querySelector('.public-menu')).toBeNull();
  });

  it('ON, signed-out visitor: the shell and the menu still render', async () => {
    authState.signedIn = false;
    stubPublicNav(GROUPED);
    await mount(true);
    expect(screen.getByText('Desk')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Menu' })).toBeTruthy();
  });

  it('the build key reaches the shell: brand.sitePublicMenu on renders the menu with no prop', async () => {
    stubPublicNav(GROUPED);
    vi.doMock('../../brand/brand.js', async (orig) => {
      const real = await orig<typeof import('../../brand/brand.js')>();
      return { ...real, brand: { ...real.brand, sitePublicMenu: true } };
    });
    await mount();
    expect(await screen.findByRole('button', { name: 'Menu' })).toBeTruthy();
  });
});

describe('sitePublicMenu(): exactly `true` or `1`', () => {
  it.each([['true', true], ['1', true], [' true ', true], [undefined, false], ['', false], ['TRUE', false], ['yes', false], ['0', false], ['false', false]] as const)(
    '%j → %s', (raw, want) => expect(sitePublicMenu(raw)).toBe(want),
  );
  it('the Vite resolver reads it, and it is a known build variable (the compose pack forwards it)', () => {
    expect(resolveBrandFromEnv({}).sitePublicMenu).toBe(false);
    expect(resolveBrandFromEnv({ VITE_BRAND_SITE_PUBLIC_MENU: '1' }).sitePublicMenu).toBe(true);
    expect(KNOWN_BRAND_ENV_VARS).toContain('VITE_BRAND_SITE_PUBLIC_MENU');
  });
});
