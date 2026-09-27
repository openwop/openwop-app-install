/**
 * FRMUX-1 / ADR 0646 — the public shell MUST host the one live region.
 *
 * `GlobalLiveRegion` was mounted only inside the authed tree, below `App.tsx`'s
 * `showPublic` early return. Every public surface (the hosted form, funnels, the
 * storefront, booking, e-sign) therefore had an `announce` path that wrote to an
 * empty listener set — and `ui/Notice.tsx` strips its own `role` when delegating,
 * so the public submit outcome was announced by NOTHING. BORN RED against the
 * shell without the mount.
 */
import { describe, expect, it } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PublicShell } from '../PublicShell.js';
import { announce } from '../../ui/announce.js';

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
    // Non-vacuity: the region is not just present, it is WIRED — a message
    // announced after mount must appear in it.
    // `announce` is a React state update on the region — wrap it in `act` and
    // wait for the flush, or the assertion reads the pre-render DOM.
    await act(async () => { announce('submission refused', { assertive: true }); });
    await waitFor(() => expect(assertive!.textContent).toContain('submission refused'));
  });
});
