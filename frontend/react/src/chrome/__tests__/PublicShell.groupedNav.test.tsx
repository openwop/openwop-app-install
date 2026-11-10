/**
 * ADR 1049 — grouped public site navigation. A published page that names a
 * `siteNav.group` switches the public shell into GROUPED mode: the menu panel
 * becomes a mega menu (Product, Who it's for, Trust, Company, Pages — never
 * Legal), each link shows its description, Blog moves to Company, flagged
 * pages join Pricing in the primary nav, and the footer renders one column per
 * group with Legal (plus the privacy link) last. A site with no group renders
 * exactly the ADR 0486 menu + flat footer.
 *
 * The nav list is cached once per module (`pagesProbe`), so each case imports
 * a FRESH module graph (`vi.resetModules`) with its own payload.
 *
 * Sabotage-witnessed (w88 probes): showing Legal in the menu, dropping the
 * order sort, keeping Blog in Product, ignoring `primary`, dropping the `group`
 * check from the grouped-mode switch, hiding descriptions, reordering the
 * groups, leaving privacy out of the Legal column, rendering the grouped footer
 * for an ungrouped site, or dropping the group rank from the primary-nav sort
 * each reds a named case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function renderWith(pages: unknown[], posts: unknown[] = [{ slug: 'hello', title: 'Hello' }]): Promise<HTMLElement> {
  vi.resetModules();
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    if (String(input).includes('/public/host-site/blog')) return Promise.resolve(json(200, { posts }));
    if (String(input).endsWith('/public/host-site/pages')) return Promise.resolve(json(200, { pages }));
    return Promise.resolve(json(404, { error: 'not_found' }));
  }));
  const { PublicShell } = await import('../PublicShell.js');
  render(<MemoryRouter><PublicShell><div>body</div></PublicShell></MemoryRouter>);
  const btn = screen.getByRole('button', { name: 'Menu' });
  fireEvent.click(btn);
  return document.getElementById(btn.getAttribute('aria-controls')!)!;
}

const headingsIn = (el: Element, selector: string): string[] =>
  Array.from(el.querySelectorAll(selector)).map((h) => h.textContent ?? '');
const groupLinks = (el: Element, groupSelector: string, headingSelector: string, heading: string): string[] => {
  const group = Array.from(el.querySelectorAll(groupSelector)).find((g) => g.querySelector(headingSelector)?.textContent === heading);
  return group ? Array.from(group.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '') : [];
};

const GROUPED_SITE = [
  { slug: 'about', title: 'About us', nav: { group: 'company', label: 'About', order: 10 } },
  { slug: 'compare', title: 'Compare' },
  { slug: 'features', title: 'Features' },
  { slug: 'for-agencies', title: 'For agencies', nav: { group: 'audience', label: 'Agencies', description: 'Run client work in one place', order: 20 } },
  { slug: 'for-startups', title: 'For startups', nav: { group: 'audience', label: 'Startups', order: 10 } },
  { slug: 'misc', title: 'Miscellany' },
  // order 5 < Pricing's 40: only the group rank (Product before Trust) keeps Pricing first in the primary nav.
  { slug: 'security', title: 'Security', nav: { group: 'trust', description: 'How we protect data', primary: true, order: 5 } },
  { slug: 'terms', title: 'Terms of service', nav: { group: 'legal', label: 'Terms', order: 20 } },
];

describe('PublicShell grouped site navigation (ADR 1049)', () => {
  it('renders a mega menu with ordered groups, descriptions, and Legal kept out', async () => {
    const panel = await renderWith(GROUPED_SITE);
    expect(await within(panel).findByRole('link', { name: /^Agencies/ })).toBeTruthy();
    expect(panel.classList.contains('public-menu__panel--mega')).toBe(true);

    expect(headingsIn(panel, '.public-menu__heading')).toEqual(['Product', 'Who it’s for', 'Trust', 'Company', 'Pages']);
    // Ordered by `order` then label inside a group; curated defaults hold.
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'Product')).toEqual(['/p/features', '/p/compare', '/pricing']);
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'Who it’s for')).toEqual(['/p/for-startups', '/p/for-agencies']);
    // Blog moves from Product to Company once the site is grouped.
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'Company')).toEqual(['/p/about', '/blog']);
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'Pages')).toEqual(['/p/misc']);

    // The label leads the accessible name; the description is text inside the link.
    const agencies = within(panel).getByRole('link', { name: /^Agencies/ });
    expect(agencies.querySelector('.public-menu__desc')?.textContent).toBe('Run client work in one place');
    // A page with no nav label keeps its title.
    expect(within(panel).getByRole('link', { name: /^Security/ }).getAttribute('href')).toBe('/p/security');

    // Legal is footer-only.
    expect(within(panel).queryByRole('link', { name: /Terms/ })).toBeNull();
  });

  it('lists Blog only when the site has published a post (ADR 1080 D13)', async () => {
    const panel = await renderWith(GROUPED_SITE, []);
    expect(await within(panel).findByRole('link', { name: /^Agencies/ })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'Company')).toEqual(['/p/about']);
  });

  it('promotes flagged pages next to Pricing in the primary nav', async () => {
    await renderWith(GROUPED_SITE);
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(await within(primary).findByRole('link', { name: 'Security' })).toBeTruthy();
    // Group order (Product before Trust), then order.
    expect(within(primary).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/pricing', '/p/security']);
  });

  it('renders the footer as one column per group, Legal last with the privacy link', async () => {
    const panel = await renderWith(GROUPED_SITE);
    await within(panel).findByRole('link', { name: /^Agencies/ });
    const footer = screen.getByRole('navigation', { name: 'Footer' });
    expect(headingsIn(footer, 'h2.app-footer__heading')).toEqual(['Product', 'Who it’s for', 'Trust', 'Company', 'Pages', 'Legal']);
    expect(groupLinks(footer, '.app-footer__group', '.app-footer__heading', 'Legal')).toEqual(['/p/terms', '/privacy']);
    expect(groupLinks(footer, '.app-footer__group', '.app-footer__heading', 'Company')).toEqual(['/p/about', '/blog']);
    expect(footer.querySelector('ul.app-footer__links')).toBeNull();
  });

  it('keeps an ungrouped site exactly on the ADR 0486 menu and flat footer', async () => {
    const panel = await renderWith([
      { slug: 'about', title: 'About Us' },
      { slug: 'features', title: 'Features' },
    ]);
    expect(await within(panel).findByRole('link', { name: 'About Us' })).toBeTruthy();
    expect(panel.classList.contains('public-menu__panel--mega')).toBe(false);
    expect(headingsIn(panel, '.public-menu__heading')).toEqual(['Product', 'Pages']);
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'Product')).toEqual(['/p/features', '/pricing', '/blog']);
    const footer = screen.getByRole('navigation', { name: 'Footer' });
    expect(footer.querySelector('h2')).toBeNull();
    expect(Array.from(footer.querySelectorAll('ul.app-footer__links a')).map((a) => a.getAttribute('href')))
      .toEqual(['/p/features', '/pricing', '/blog', '/p/about', '/privacy']);
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(primary).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/p/features', '/pricing']);
  });

  it('honours primary flags without groups and stays in the ungrouped layout', async () => {
    const panel = await renderWith([
      { slug: 'about', title: 'About Us', nav: { primary: true, label: 'About' } },
      { slug: 'features', title: 'Features' },
    ]);
    expect(await within(panel).findByRole('link', { name: 'About' })).toBeTruthy();
    expect(panel.classList.contains('public-menu__panel--mega')).toBe(false);
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(primary).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/pricing', '/p/about']);
  });
});
