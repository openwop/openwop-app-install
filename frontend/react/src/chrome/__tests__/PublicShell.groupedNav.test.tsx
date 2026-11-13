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
 * each reds a named case. ADR 1105 D11: ignoring `groupLabel`, or letting a
 * later page's heading win over the first, reds the authored-heading case.
 * ADR 1113: dropping `readLinks`, not expanding links into entries, skipping
 * the duplicate check, resolving a fragment off the owning page, or leaving
 * links out of the grouped-mode switch each reds an authored-links case.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

  // ADR 1105 D11 — an authored group heading names the group in BOTH the menu
  // and the footer; the first page in the group (by order) that sets it wins;
  // a group nobody names keeps its stock heading.
  it('uses an authored group heading in the menu and the footer', async () => {
    const site = [
      ...GROUPED_SITE.filter((p) => p.slug !== 'for-startups' && p.slug !== 'for-agencies'),
      { slug: 'simulator', title: 'Simulator', nav: { group: 'audience', label: 'Simulator', order: 10, groupLabel: 'Try it' } },
      { slug: 'catalog', title: 'Catalog', nav: { group: 'audience', label: 'Catalog', order: 20, groupLabel: 'Ignored, not first' } },
    ];
    const panel = await renderWith(site);
    expect(await within(panel).findByRole('link', { name: /^Simulator/ })).toBeTruthy();
    expect(headingsIn(panel, '.public-menu__heading')).toEqual(['Product', 'Try it', 'Trust', 'Company', 'Pages']);
    const footer = screen.getByRole('navigation', { name: 'Footer' });
    expect(headingsIn(footer, 'h2.app-footer__heading')).toEqual(['Product', 'Try it', 'Trust', 'Company', 'Pages', 'Legal']);
    expect(groupLinks(footer, '.app-footer__group', '.app-footer__heading', 'Try it')).toEqual(['/p/simulator', '/p/catalog']);
    // An authored heading may be one long word: both headings wrap anywhere, like the links beside them.
    const css = readFileSync(join(__dirname, '..', '..', 'styles', 'global.css'), 'utf8');
    for (const sel of ['.public-shell .app-footer__heading {', '.public-menu__heading {']) {
      const at = css.indexOf(sel);
      expect(css.slice(at, css.indexOf('}', at)), sel).toContain('overflow-wrap: anywhere');
    }
  });

  it('adds a page\'s authored links (ADR 1113) as entries in their own groups, in the menu and the footer', async () => {
    // Two published pages fill four columns: the links carry their own groups,
    // headings and order. The pricing page's fragment lands on /pricing; a link
    // to an already-listed destination is dropped; an unsafe one never renders.
    const site = [
      { slug: 'features', title: 'How it works', nav: { group: 'product', label: 'The whole loop', order: 10, groupLabel: 'How it works', links: [
        { label: 'Today', href: '/p/features#today', group: 'product', order: 20, description: 'One useful action' },
        { label: 'Discover', href: '/discover', group: 'audience', order: 10, groupLabel: 'Challenges' },
        { label: 'Circles', href: '/circles', group: 'trust', order: 20, groupLabel: 'Support' },
        { label: 'Guide', href: '/guide', group: 'trust', order: 10 },
        { label: 'Duplicate of the page', href: '/p/features', group: 'company' },
        { label: 'Off site', href: 'https://evil.example', group: 'company' },
        { label: 'No group', href: '/plan' },
      ] } },
      { slug: 'pricing', title: 'Pricing', nav: { group: 'company', order: 10, groupLabel: 'Get started', links: [
        { label: 'Watch the film', href: '#film', group: 'company', order: 20 },
      ] } },
    ];
    const panel = await renderWith(site, []);
    expect(await within(panel).findByRole('link', { name: /^Discover/ })).toBeTruthy();
    expect(panel.classList.contains('public-menu__panel--mega')).toBe(true);
    expect(headingsIn(panel, '.public-menu__heading')).toEqual(['How it works', 'Challenges', 'Support', 'Get started']);
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'How it works')).toEqual(['/p/features', '/p/features#today']);
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'Challenges')).toEqual(['/discover']);
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'Support')).toEqual(['/guide', '/circles']);
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'Get started')).toEqual(['/pricing', '/pricing#film']);
    expect(within(panel).getByRole('link', { name: /^Today/ }).textContent).toContain('One useful action');
    expect(panel.querySelector('a[href^="https:"]')).toBeNull();
    expect(panel.querySelector('a[href="/plan"]')).toBeNull();
    const footer = screen.getByRole('navigation', { name: 'Footer' });
    expect(groupLinks(footer, '.app-footer__group', '.app-footer__heading', 'Challenges')).toEqual(['/discover']);
  });

  it('switches to grouped mode on authored links alone (ADR 1113)', async () => {
    const panel = await renderWith([{ slug: 'features', title: 'Features', nav: { links: [{ label: 'Discover', href: '/discover', group: 'audience' }] } }], []);
    expect(await within(panel).findByRole('link', { name: /^Discover/ })).toBeTruthy();
    expect(panel.classList.contains('public-menu__panel--mega')).toBe(true);
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

  it('a Resources page adds the Resources group after Who it’s for, and Blog joins it (DeckTalk, 2026-11-10)', async () => {
    const site = [...GROUPED_SITE, { slug: 'guides', title: 'Guides', nav: { group: 'resources', label: 'Guides', description: 'How-tos', order: 10 } }];
    const panel = await renderWith(site);
    expect(await within(panel).findByRole('link', { name: /^Guides/ })).toBeTruthy();
    expect(headingsIn(panel, '.public-menu__heading')).toEqual(['Product', 'Who it’s for', 'Resources', 'Trust', 'Company', 'Pages']);
    // Blog is a resource: with a Resources group it moves there, out of Company.
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'Resources')).toEqual(['/p/guides', '/blog']);
    expect(groupLinks(panel, '.public-menu__group', '.public-menu__heading', 'Company')).toEqual(['/p/about']);
    const footer = screen.getByRole('navigation', { name: 'Footer' });
    expect(headingsIn(footer, 'h2.app-footer__heading')).toEqual(['Product', 'Who it’s for', 'Resources', 'Trust', 'Company', 'Pages', 'Legal']);
    expect(groupLinks(footer, '.app-footer__group', '.app-footer__heading', 'Resources')).toEqual(['/p/guides', '/blog']);
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
