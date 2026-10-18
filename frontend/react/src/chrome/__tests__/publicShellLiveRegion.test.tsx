/**
 * FRMUX-1 / ADR 0646 — the public shell MUST host the one live region.
 *
 * `GlobalLiveRegion` was mounted only inside the authed tree, below `App.tsx`'s
 * `showPublic` early return. Every public surface (the hosted form, funnels, the
 * storefront, booking, e-sign) therefore had an `announce` path that wrote to an
 * empty listener set — and `ui/Notice.tsx` strips its own `role` when delegating,
 * so the public submit outcome was announced by NOTHING. BORN RED against the
 * shell without the mount.
 *
 * The regions must be the right ones (polite = `status`, assertive = `alert`) and
 * mounted EMPTY: a live region only speaks on mutation, so a region that arrives
 * already holding its text is silent (repo lesson: live-region-mounted-with-content).
 *
 * Sabotage that turns it red: remove `<GlobalLiveRegion />` from PublicShell; give the
 * assertive region `role="status"`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, act, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicShell } from '../PublicShell.js';
import { announce } from '../../ui/announce.js';

beforeEach(() => {
  // `announce` keeps module-level state; clear it so the region mounts empty.
  announce('');
  announce('', { assertive: true });
  // PublicShell fires nav/docs probes on mount — stub so nothing goes live.
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ error: 'not_found' }), {
    status: 404, headers: { 'content-type': 'application/json' },
  }))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PublicShell hosts the global live region', () => {
  it('mounts BOTH polite and assertive regions, and an announce() lands in one', async () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/f/form:1']}>
        <PublicShell><p>public body</p></PublicShell>
      </MemoryRouter>,
    );
    const polite = container.querySelector('[data-owp-live="polite"]');
    const assertive = container.querySelector('[data-owp-live="assertive"]');
    expect(polite, 'polite region must be mounted on the public shell').toBeTruthy();
    expect(assertive, 'assertive region must be mounted on the public shell').toBeTruthy();
    expect(polite!.getAttribute('role')).toBe('status');
    expect(assertive!.getAttribute('role')).toBe('alert');
    // Mounted EMPTY, before any message — the precondition for the mutation to be spoken.
    expect(assertive!.textContent).toBe('');
    // Non-vacuity: the region is not just present, it is WIRED — a message
    // announced after mount must appear in it.
    // `announce` is a React state update on the region — wrap it in `act` and
    // wait for the flush, or the assertion reads the pre-render DOM.
    await act(async () => { announce('submission refused', { assertive: true }); });
    await waitFor(() => expect(assertive!.textContent).toContain('submission refused'));
  });
});
