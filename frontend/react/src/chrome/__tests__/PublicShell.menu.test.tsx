/**
 * ADR 0486 — the public hamburger menu. One disclosure at all viewports that
 * opens a GROUPED panel reaching main functionality (curated Product links) +
 * every published child page (the dynamic Pages group, fetched from the
 * `/public/host-site/pages` nav list). Asserts: closed by default; the button
 * toggles `aria-expanded`; the panel groups curated + dynamic links; a curated
 * page (Compare) is NOT duplicated into the dynamic group; Escape closes it.
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
    // The ADR 0486 nav list: two published pages — one curated (compare),
    // one purely dynamic (about).
    if (u.endsWith('/public/host-site/pages')) {
      return Promise.resolve(json(200, { pages: [
        { slug: 'about', title: 'About Us' },
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
    // Curated "main functionality" group.
    expect(within(panel).getByText('Product')).toBeTruthy();
    expect(within(panel).getByText('Features')).toBeTruthy();
    // Dynamic "child pages" group (resolves after the nav-list fetch).
    expect(await within(panel).findByText('Pages')).toBeTruthy();
    expect(within(panel).getByText('About Us')).toBeTruthy();
    // A curated page (Compare) appears ONCE — never duplicated into the dynamic group.
    expect(within(panel).getAllByText('Compare')).toHaveLength(1);
    // Phone CSS moves utilities into the disclosure instead of letting the
    // header action cluster widen the document past the viewport.
    expect(within(panel).getByRole('group', { name: 'Theme' })).toBeTruthy();
    expect(within(panel).getByRole('combobox', { name: 'Language' })).toBeTruthy();
  });

  it('keeps the two first-visit decision links visible outside the disclosure', () => {
    stubFetch();
    renderShell();
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(primary).getByRole('link', { name: 'Features' })).toBeTruthy();
    expect(within(primary).getByRole('link', { name: 'Pricing' })).toBeTruthy();
    expect(within(primary).queryByRole('link', { name: 'Compare' })).toBeNull();
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
    expect(action.closest('.public-shell-header')).toBeTruthy();
    expect(action.closest('#public-main')).toBeNull();
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
    expect(action.closest('.public-menu__panel')).toBeTruthy();
    expect(action.closest('.public-shell-header')).toBeTruthy();
  });
});
