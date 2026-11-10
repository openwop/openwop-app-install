/**
 * ADR 1056 — the grouped footer's brand column + bottom bar. In grouped mode
 * (ADR 1049) the footer leads with a brand column (the home link with the
 * brand's mark + name, the footer text, the call to action of the first page
 * that sets `siteNav.cta`) and closes with a bottom bar (copyright + the pages
 * flagged `siteNav.utility`, under their own nav landmark). Legal stays a group
 * column, marked for its two-column split. An ungrouped site keeps the
 * ADR 0486 flat footer even when its pages carry `cta`/`utility`.
 *
 * Sabotage-witnessed (w88 probes): ranking the CTA in page order or without the
 * group rank, dropping the footer CTA, showing the grouped footer on an
 * ungrouped site, dropping the privacy fallback into the bottom bar, rendering
 * an empty bottom-bar nav, losing the footer nav's or the extras nav's
 * accessible name, unmarking Legal, or a hard-coded copyright year reds a case.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function renderWith(pages: unknown[]): Promise<HTMLElement> {
  vi.resetModules(); // the nav list is memoised per module graph
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    if (String(input).includes('/public/host-site/blog')) return Promise.resolve(json(200, { posts: [{ slug: 'hello', title: 'Hello' }] }));
    if (String(input).endsWith('/public/host-site/pages')) return Promise.resolve(json(200, { pages }));
    return Promise.resolve(json(404, { error: 'not_found' }));
  }));
  const { PublicShell } = await import('../PublicShell.js');
  render(<MemoryRouter><PublicShell><div>body</div></PublicShell></MemoryRouter>);
  return screen.getByRole('contentinfo');
}

const hrefs = (el: Element): string[] => Array.from(el.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '');

// The fixture is asymmetric on purpose: by order alone Agencies (1) would win
// the CTA and Subprocessors (70) would lead the bottom bar ahead of Talk (80);
// only the group rank gives the asserted answers. Apply (product, order 9)
// would win on label inside Product; only the order keeps Start (5) first.
const SITE = [
  { slug: 'about', title: 'About us', nav: { group: 'company', label: 'About', order: 10 } },
  { slug: 'talk', title: 'Talk to us', nav: { group: 'company', label: 'Let’s chat', order: 80, cta: 'Book a call', utility: true } },
  { slug: 'agencies', title: 'Agencies', nav: { group: 'audience', order: 1, cta: 'Not me — Audience ranks after Product' } },
  { slug: 'apply', title: 'Apply', nav: { group: 'product', order: 9, cta: 'Apply now' } },
  { slug: 'start', title: 'Start here', nav: { group: 'product', order: 5, cta: 'Start free' } },
  { slug: 'subprocessors', title: 'Subprocessors', nav: { group: 'legal', order: 70, utility: true } },
  { slug: 'terms', title: 'Terms', nav: { group: 'legal', order: 10 } },
];

describe('PublicShell grouped footer brand column + bottom bar (ADR 1056)', () => {
  it('leads with a brand column whose CTA is the first page by group, then order', async () => {
    const footer = await renderWith(SITE);
    const cta = await within(footer).findByRole('link', { name: 'Start free' });
    expect(cta.getAttribute('href')).toBe('/p/start');
    expect(cta.classList.contains('btn')).toBe(true);
    const brandCol = footer.querySelector('.app-footer__brand-col')!;
    // The home link carries the brand name as its accessible name (logo art is decorative).
    expect(within(brandCol as HTMLElement).getByRole('link', { name: 'OpenWOP' }).getAttribute('href')).toBe('/');
    expect(hrefs(brandCol)).toEqual(['/', '/p/start']);
    // Only one CTA renders, even though three pages set one.
    expect(within(footer).queryByRole('link', { name: 'Book a call' })).toBeNull();
    expect(within(footer).queryByRole('link', { name: 'Not me — Audience ranks after Product' })).toBeNull();
    expect(within(footer).queryByRole('link', { name: 'Apply now' })).toBeNull();
  });

  it('keeps the Footer nav landmark with list semantics and marks Legal for its split', async () => {
    const footer = await renderWith(SITE);
    await within(footer).findByRole('link', { name: 'Start free' });
    const nav = within(footer).getByRole('navigation', { name: 'Footer' });
    const legal = nav.querySelector('.app-footer__group--legal')!;
    expect(legal.querySelector('h2')?.textContent).toBe('Legal');
    expect(hrefs(legal)).toEqual(['/p/terms', '/p/subprocessors', '/privacy']);
    expect(within(legal as HTMLElement).getAllByRole('listitem')).toHaveLength(3);
    // The CTA page still appears in its own group column.
    expect(within(nav).getByRole('link', { name: 'Let’s chat' }).getAttribute('href')).toBe('/p/talk');
    // The brand column sits outside the nav landmark.
    expect(nav.contains(footer.querySelector('.app-footer__brand-col'))).toBe(false);
  });

  it('closes with a copyright line and the utility pages in their own nav', async () => {
    // Fake only Date, so the copyright year is a literal the product must read from the clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2031-06-15T12:00:00Z'));
      const footer = await renderWith(SITE);
      await within(footer).findByRole('link', { name: 'Start free' });
      const bottom = footer.querySelector('.app-footer__bottom')!;
      expect(bottom.querySelector('.app-footer__copyright')?.textContent).toBe('© 2031 OpenWOP');
      const extras = within(bottom as HTMLElement).getByRole('navigation', { name: 'Footer extras' });
      // Group order (Company before Legal), then order; each keeps its nav label.
      expect(within(extras).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]))
        .toEqual([['Let’s chat', '/p/talk'], ['Subprocessors', '/p/subprocessors']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('moves the privacy link into the bottom bar when the site has no Legal column', async () => {
    const footer = await renderWith([{ slug: 'about', title: 'About', nav: { group: 'company' } }]);
    await within(footer).findByRole('link', { name: 'About' });
    expect(footer.querySelector('.app-footer__cta')).toBeNull();
    const extras = within(footer).getByRole('navigation', { name: 'Footer extras' });
    expect(hrefs(extras)).toEqual(['/privacy']);
    expect(footer.querySelector('ul.app-footer__links')).toBeNull();
  });

  it('renders no bottom-bar nav when there is nothing to list', async () => {
    const footer = await renderWith([{ slug: 'terms', title: 'Terms', nav: { group: 'legal' } }]);
    await within(footer).findByRole('link', { name: 'Terms' });
    expect(within(footer).queryByRole('navigation', { name: 'Footer extras' })).toBeNull();
    expect(footer.querySelector('.app-footer__copyright')).not.toBeNull();
  });

  it('ignores cta + utility on an ungrouped site and keeps the flat footer', async () => {
    const footer = await renderWith([
      { slug: 'about', title: 'About Us', nav: { cta: 'Book a call', utility: true } },
      { slug: 'features', title: 'Features' },
    ]);
    await within(footer).findByRole('link', { name: 'About Us' });
    expect(footer.className).toBe('app-footer');
    expect(within(footer).queryByRole('link', { name: 'Book a call' })).toBeNull();
    expect(footer.querySelector('.app-footer__brand-col, .app-footer__bottom')).toBeNull();
    expect(within(footer).getAllByRole('navigation').map((n) => n.getAttribute('aria-label'))).toEqual(['Footer']);
    expect(hrefs(footer)).toEqual(['/p/features', '/pricing', '/blog', '/p/about', '/privacy']);
  });
});
