/**
 * ADR 0486 — an adopter site that does not publish the seeded `features` /
 * `compare` CMS pages gets no curated link to them. Those are content, not
 * routes: a white-label install that archives `compare` (kicktodo.com did) was
 * still shown a "Compare" link into a 404. The published case is asserted in
 * PublicShell.menu.test.tsx; this is its own file because the nav list is
 * fetched once per module.
 *
 * Sabotage-witnessed: curating Features or Compare unconditionally reds this
 * case (both in the disclosure and, for Features, in the primary nav).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicShell } from '../PublicShell.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PublicShell curated links on an adopter site (ADR 0486)', () => {
  it('omits Features and Compare when the site org does not publish them; keeps the app routes', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
    if (String(input).includes('/public/host-site/blog')) return Promise.resolve(json(200, { posts: [{ slug: 'hello', title: 'Hello' }] }));
      if (String(input).endsWith('/public/host-site/pages')) {
        return Promise.resolve(json(200, { pages: [{ slug: 'about', title: 'About Us' }] }));
      }
      return Promise.resolve(json(404, { error: 'not_found' }));
    }));
    render(<MemoryRouter><PublicShell><div>body</div></PublicShell></MemoryRouter>);
    const btn = screen.getByRole('button', { name: 'Menu' });
    fireEvent.click(btn);
    const panel = document.getElementById(btn.getAttribute('aria-controls')!)!;
    // The nav read has landed once its dynamic page is listed.
    expect(await within(panel).findByRole('link', { name: 'About Us' })).toBeTruthy();

    expect(within(panel).queryByRole('link', { name: 'Features' })).toBeNull();
    expect(within(panel).queryByRole('link', { name: 'Compare' })).toBeNull();
    // `/pricing` and `/blog` are app routes, present on every install.
    expect(within(panel).getByRole('link', { name: 'Pricing' }).getAttribute('href')).toBe('/pricing');
    expect(within(panel).getByRole('link', { name: 'Blog' }).getAttribute('href')).toBe('/blog');

    const primary = screen.getByRole('navigation', { name: 'Primary' });
    expect(within(primary).queryByRole('link', { name: 'Features' })).toBeNull();
    expect(within(primary).getByRole('link', { name: 'Pricing' })).toBeTruthy();
  });
});
