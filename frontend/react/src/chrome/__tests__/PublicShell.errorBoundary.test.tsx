/**
 * Public-surface hardening (C1): a render throw in ANY public page is contained
 * to an error card INSIDE the PublicShell chrome — NOT a full white screen for an
 * anonymous visitor. This is the boundary the public shell was missing (the
 * authed shell already had one), which is why the pricing '*' crash blanked the
 * whole page instead of showing a card.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicShell } from '../PublicShell.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function Boom(): JSX.Element {
  throw new Error('kaboom-public-crash');
}

describe('PublicShell error boundary (C1)', () => {
  it('contains a child render crash to a card, and keeps the shell chrome alive', () => {
    // PublicShell fires nav/docs probes on mount — stub so they resolve quietly.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(404, { error: 'not_found' }))));
    // React logs the caught error to console.error — silence it for a clean run.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // If the boundary were absent, this render() would THROW (the crash would
    // propagate) — so a successful render is itself the containment assertion.
    const { container } = render(
      <MemoryRouter>
        <PublicShell><Boom /></PublicShell>
      </MemoryRouter>,
    );

    // The crash surfaced as the boundary's error card, not a blank page.
    expect(screen.getByText('kaboom-public-crash')).toBeTruthy();
    // The shell chrome (brand link in the header) survived the content crash.
    expect(container.querySelector('.public-shell-brand')).toBeTruthy();
  });
});
