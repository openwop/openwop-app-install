/**
 * ADR 0486 — the public hamburger menu. One disclosure at all viewports that
 * opens a GROUPED panel reaching main functionality (curated Product links) +
 * every published child page (the dynamic Pages group, fetched from the
 * `/public/host-site/pages` nav list). Asserts: closed by default; the button
 * toggles `aria-expanded`; the panel groups curated + dynamic links; a curated
 * page (Compare) is NOT duplicated into the dynamic group; Escape closes it; page-owned
 * actions portal into the header / the disclosure.
 *
 * The nav-list and docs probes are cached ONCE per module (`pagesProbe`/`docsProbe`).
 * Every case stubs the same payload, so case order does not matter.
 *
 * Sabotage that turns it red (re-probed wave 115): render the panel un-hidden; a menu
 * button that never toggles; ignore Escape; drop `compare` or `features` from the
 * curated slugs (each then lands in the Pages group, which the per-group lists catch);
 * always list White label; promote Compare to the primary nav; move the theme /
 * language utilities out of the panel; render PublicHeaderActions / PublicMenuActions
 * inline instead of portalling.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { PublicHeaderActions, PublicMenuActions, PublicShell } from '../PublicShell.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    const u = String(input);
    // The ADR 0486 nav list: three published pages — two curated (features,
    // compare), one purely dynamic (about).
    if (u.endsWith('/public/host-site/pages')) {
      return Promise.resolve(json(200, { pages: [
        { slug: 'about', title: 'About Us' },
        { slug: 'features', title: 'Features' },
        { slug: 'compare', title: 'Compare' },
      ] }));
    }
    // Everything else (the docs-availability probe, sign-in state, …) → 404 so
    // the menu resolves deterministically to "no docs".
    return Promise.resolve(json(404, { error: 'not_found' }));
  }));
}

function renderShell(children: ReactNode = <div>body</div>): void {
  render(
    <MemoryRouter>
      <PublicShell>{children}</PublicShell>
    </MemoryRouter>,
  );
}

describe('PublicShell hamburger menu (ADR 0486)', () => {
  it('is closed by default and the menu button reports collapsed', () => {
    stubFetch();
    renderShell();
    const btn = screen.getByRole('button', { name: 'Menu' });
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(btn.getAttribute('aria-controls')!)?.hidden).toBe(true);
  });

  it('opens a grouped panel with main functionality + every published page, no duplicates', async () => {
    stubFetch();
    renderShell();
    const btn = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    const panel = document.getElementById(btn.getAttribute('aria-controls')!)!;
    expect(panel).toBeTruthy();
    expect(panel.hidden).toBe(false);
    // Dynamic "child pages" group (resolves after the nav-list fetch).
    expect(await within(panel).findByText('Pages')).toBeTruthy();
    // Each group's links, read from inside that group. Since ADR 0486's
    // published-only curation every page yields ONE entry, so a page-wide count of
    // "Compare" stays 1 even when Compare falls out of the curated set into Pages.
    // The claim is WHERE each page lands, so it is asserted per group.
    const linksIn = (heading: string): [string | null, string | null][] => {
      const group = within(panel).getByText(heading).closest<HTMLElement>('.public-menu__group');
      expect(group).not.toBeNull();
      return within(group!).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);
    };
    // Curated "main functionality" group: the published curated pages, in curated
    // order, then the app's Pricing route.
    expect(linksIn('Product')).toEqual([['Features', '/p/features'], ['Compare', '/p/compare'], ['Pricing', '/pricing']]);
    // Every other published page, and no curated one.
    expect(linksIn('Pages')).toEqual([['About Us', '/p/about']]);
    // A curated page (Compare) appears ONCE in the whole panel.
    expect(within(panel).getAllByText('Compare')).toHaveLength(1);
    // White label is curated only when that page is published (it is not here).
    expect(within(panel).queryByRole('link', { name: 'White label' })).toBeNull();
    // Phone CSS moves utilities into the disclosure instead of letting the
    // header action cluster widen the document past the viewport.
    expect(within(panel).queryAllByRole('group', { name: 'Theme' })).toHaveLength(1);
    expect(within(panel).queryAllByRole('combobox', { name: 'Language' })).toHaveLength(1);
  });

  it('keeps the two first-visit decision links visible outside the disclosure', async () => {
    stubFetch();
    renderShell();
    // Settle on the nav read itself (its dynamic page renders in the closed panel;
    // the footer lists it too, so the wait is scoped to the panel), then read the
    // primary links as an exact list: a missing Features or a promoted Compare fails
    // on the value, not on a `findBy` running out of time.
    const panelId = screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-controls')!;
    expect(await within(document.getElementById(panelId)!).findByText('About Us')).toBeTruthy();
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(primary).getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]))
      .toEqual([['Features', '/p/features'], ['Pricing', '/pricing']]);
  });

  it('closes on Escape and returns collapsed state', () => {
    stubFetch();
    renderShell();
    const btn = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('places page-owned actions inside the header command bar, never in page content', async () => {
    stubFetch();
    renderShell(
      <PublicHeaderActions>
        <a href="/dashboard">Open app</a>
      </PublicHeaderActions>,
    );

    const action = await screen.findByRole('link', { name: 'Open app' });
    expect(action.closest('header')).toBe(screen.getByRole('banner'));
    expect(action.closest('main')).toBeNull();
  });

  it('places lower-frequency page actions inside the navigation disclosure', async () => {
    stubFetch();
    renderShell(
      <PublicMenuActions>
        <a href="/cms/host-site/page-1">Edit this page</a>
      </PublicMenuActions>,
    );

    expect(screen.queryByRole('link', { name: 'Edit this page' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Menu' }));
    const action = await screen.findByRole('link', { name: 'Edit this page' });
    const panelId = screen.getByRole('button', { name: 'Menu' }).getAttribute('aria-controls')!;
    expect(action.closest(`[id="${panelId}"]`)).toBeTruthy();
    expect(action.closest('header')).toBe(screen.getByRole('banner'));
  });
});
