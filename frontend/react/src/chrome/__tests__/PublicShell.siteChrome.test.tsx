/**
 * ADR 1062 — the public-site chrome additions, all driven by content:
 *
 *   - D1 the current page's top link carries `aria-current="page"`; the site's
 *     `siteNav.cta` page is also an always-visible header button (grouped mode);
 *     the theme / language / page actions close the menu panel;
 *   - D2 the mega menu's featured card comes from the nav read's top-level
 *     `featured`; a `#fragment` href lands on the owning page (`/` for home);
 *   - D3 the CMS `pricing` page's `siteNav` places the ONE `/pricing` entry
 *     (its description, its primary flag), never a second `/p/pricing` link;
 *   - D5 the brand's `chromePolicy.customCopyright` replaces the generated
 *     copyright line.
 * An ungrouped site gets none of the new chrome.
 *
 * Sabotage witnesses: rendering primary links with `Link` (no aria-current),
 * dropping the header CTA, resolving a fragment against `/p/home`, listing
 * `/p/pricing`, ignoring the pricing nav, or ignoring customCopyright reds a
 * case. So does dropping the theme toggle or the page-actions slot from the
 * panel's footer row, and dropping every non-fragment href (the safe internal
 * path is the positive control for the off-site drop).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function renderWith(body: unknown, opts: { path?: string; copyright?: string } = {}): Promise<void> {
  vi.resetModules(); // the nav list is memoised per module graph
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    if (String(input).endsWith('/public/host-site/pages')) return Promise.resolve(json(200, body));
    return Promise.resolve(json(404, { error: 'not_found' }));
  }));
  if (opts.copyright !== undefined) {
    const { hydrateBrandSingleton } = await import('../../brand/applyBrand.js');
    hydrateBrandSingleton({ chromePolicy: { customCopyright: opts.copyright } });
  }
  const { PublicShell } = await import('../PublicShell.js');
  render(<MemoryRouter initialEntries={[opts.path ?? '/']}><PublicShell><div>body</div></PublicShell></MemoryRouter>);
}

const PAGES = [
  { slug: 'how-it-works', title: 'How it works', nav: { group: 'product', order: 10, primary: true } },
  { slug: 'pricing', title: 'Pricing page', nav: { group: 'product', order: 30, description: 'Free, launch, or we run it', primary: true } },
  { slug: 'book', title: 'Book a call', nav: { group: 'company', order: 90, cta: 'Book a free call' } },
  { slug: 'terms', title: 'Terms', nav: { group: 'legal' } },
];
const FEATURED = { slug: 'home', eyebrow: 'New film', title: 'Whose agent is it?', meta: '3:57', href: '#whose-agent' };

describe('PublicShell site chrome (ADR 1062)', () => {
  it('marks the current top link and shows the site CTA in the header (D1)', async () => {
    await renderWith({ pages: PAGES }, { path: '/p/how-it-works' });
    const header = screen.getByRole('banner');
    const cta = await within(header).findByRole('link', { name: 'Book a free call' });
    expect(cta.getAttribute('href')).toBe('/p/book');
    const primary = within(header).getByRole('navigation', { name: /primary/i });
    expect(within(primary).getByRole('link', { name: 'How it works' }).getAttribute('aria-current')).toBe('page');
    expect(within(primary).getByRole('link', { name: 'Pricing' }).getAttribute('aria-current')).toBeNull();
  });

  it('renders the featured card, resolving a fragment against home (D2)', async () => {
    await renderWith({ pages: PAGES, featured: FEATURED });
    await screen.findAllByRole('link', { name: 'Book a free call' }); // header + footer
    const card = document.querySelector('.public-menu__featured');
    expect(card?.getAttribute('href')).toBe('/#whose-agent');
    expect(card?.textContent).toBe('New filmWhose agent is it?3:57');
    // The utilities close the panel, after the groups and the card: the theme
    // control and the page-actions slot live in the panel's last row.
    const panel = card!.closest('nav')!;
    const footerRow = panel.lastElementChild as HTMLElement;
    expect(footerRow.className).toBe('public-menu__footer');
    expect(within(footerRow).getByRole('group', { name: 'Theme', hidden: true })).toBeTruthy();
    expect(footerRow.querySelector('.public-menu__page-actions')).not.toBeNull();
    expect(card!.compareDocumentPosition(footerRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('resolves a fragment against a non-home owner and drops an off-site href (D2)', async () => {
    await renderWith({ pages: PAGES, featured: { slug: 'film', title: 'Film', href: '#cut' } });
    await screen.findAllByRole('link', { name: 'Book a free call' }); // header + footer
    expect(document.querySelector('.public-menu__featured')?.getAttribute('href')).toBe('/p/film#cut');
    // Positive control: a safe internal path is kept as written.
    cleanup();
    await renderWith({ pages: PAGES, featured: { slug: 'film', title: 'Film', href: '/p/pricing-guide' } });
    await screen.findAllByRole('link', { name: 'Book a free call' }); // header + footer
    expect(document.querySelector('.public-menu__featured')?.getAttribute('href')).toBe('/p/pricing-guide');
    for (const bad of ['//evil.example', '/\\evil.example', '/\t/evil.example', '#a b', 'javascript:alert(1)']) {
      cleanup();
      await renderWith({ pages: PAGES, featured: { slug: 'film', title: 'Film', href: bad } });
      await screen.findAllByRole('link', { name: 'Book a free call' }); // header + footer
      expect(document.querySelector('.public-menu__featured')?.getAttribute('href'), JSON.stringify(bad)).toBe('/p/film');
    }
  });

  it('places the one /pricing entry from the CMS pricing page (D3)', async () => {
    await renderWith({ pages: PAGES });
    await screen.findAllByRole('link', { name: 'Book a free call' }); // header + footer
    const links = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(links).not.toContain('/p/pricing');
    const menuPricing = Array.from(document.querySelectorAll('.public-menu__link')).find((a) => a.getAttribute('href') === '/pricing');
    expect(menuPricing?.querySelector('.public-menu__desc')?.textContent).toBe('Free, launch, or we run it');
  });

  it('uses the brand copyright line when set (D5)', async () => {
    await renderWith({ pages: PAGES }, { copyright: '© 2026 Acme Inc. Built on OpenWOP.' });
    const footer = screen.getByRole('contentinfo');
    await within(footer).findByRole('link', { name: 'Terms' });
    expect(footer.querySelector('.app-footer__copyright')?.textContent).toBe('© 2026 Acme Inc. Built on OpenWOP.');
  });

  it('adds none of it to an ungrouped site', async () => {
    await renderWith({ pages: [{ slug: 'about', title: 'About', nav: { cta: 'Talk' } }], featured: FEATURED });
    await screen.findAllByRole('link', { name: 'About' });
    expect(document.querySelector('.public-menu__featured')).toBeNull();
    expect(document.querySelector('.public-shell-cta')).toBeNull();
  });
});
