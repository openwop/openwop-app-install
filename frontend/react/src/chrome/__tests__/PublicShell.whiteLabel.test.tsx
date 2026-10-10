/**
 * ADR 0843 — the white-label page is curated under Product when it is
 * published. It is seeded only on the OpenWOP showcase (demo mode), so a
 * white-label install never lists it; the not-published case is asserted in
 * PublicShell.menu.test.tsx. Its own file because the nav list is fetched once
 * per module.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicShell } from '../PublicShell.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PublicShell white-label link (ADR 0843)', () => {
  it('lists White label under Product, once, when that page is published', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      if (String(input).endsWith('/public/host-site/pages')) {
        return Promise.resolve(json(200, { pages: [
          { slug: 'about', title: 'About Us' },
          { slug: 'white-label', title: 'Run the OpenWOP app under your own brand' },
        ] }));
      }
      return Promise.resolve(json(404, { error: 'not_found' }));
    }));
    render(<MemoryRouter><PublicShell><div>body</div></PublicShell></MemoryRouter>);
    const btn = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(btn);
    const panel = document.getElementById(btn.getAttribute('aria-controls')!)!;
    const link = await within(panel).findByRole('link', { name: 'White label' });
    expect(link.getAttribute('href')).toBe('/p/white-label');
    // Curated, so its CMS title never repeats in the dynamic Pages group.
    expect(within(panel).getByText('About Us')).toBeTruthy();
    expect(within(panel).queryByText('Run the OpenWOP app under your own brand')).toBeNull();
    // Not promoted to the header: Features and Pricing stay the only primary links.
    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(primary).queryByRole('link', { name: 'White label' })).toBeNull();
  });
});
