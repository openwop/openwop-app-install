/**
 * CMS-R2-3 — the "Edit this page" affordance on a published public page.
 * Invariants:
 *   - ANONYMOUS: no link AND no probe request (the rate-limit rule — public
 *     pages are the highest-traffic surface)
 *   - signed in + authorized: the link renders and deep-links the editor at
 *     the resolved pageId
 *   - signed in + NOT authorized (probe returns null): no link, no error —
 *     absence makes no claim
 *
 * DOUBLE GUARD (recorded /grade-tests w50, a ceiling): the request is gated by
 * `loading || !user` (EditThisPageLink.tsx). The real `useAuth` only reports
 * `loading: true` while `user === null` (auth/useAuth.ts — the initial state is
 * `configured && user === null`, and the callback sets both together), so no
 * reachable hook state witnesses the `loading` clause alone: dropping it is a
 * no-op (probe w50g2-etp-loading, vacuous by construction). The "still
 * loading" case therefore pins the SHARED state both guards read — no user
 * yet — and reds when both clauses go (probe w50g2-etp-guards-r2).
 *
 * Other sabotages that red it: dropping `!user` (anonymous), an unencoded
 * pageId in the href, a fallback pageId on a null probe answer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { UseAuth } from '../../../auth/useAuth.js';
import type { AuthUser } from '../../../auth/firebase.js';
import type { Page, getAuthoredPageBySlug } from '../../cms/cmsClient.js';

const auth = vi.hoisted(() => ({ useAuth: vi.fn<() => UseAuth>() }));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: auth.useAuth }));
const cms = vi.hoisted(() => ({ getAuthoredPageBySlug: vi.fn<typeof getAuthoredPageBySlug>() }));
vi.mock('../../cms/cmsClient.js', () => cms);

import { EditThisPageLink } from '../EditThisPageLink.js';

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

const USER: AuthUser = { uid: 'u1', email: 'u1@example.test', displayName: 'U One', photoURL: null, providerIds: ['google.com'] };
function authState(user: AuthUser | null, loading: boolean): UseAuth {
  return {
    user, loading, isConfigured: true,
    signIn: { google: async () => {}, github: async () => {} },
    signOut: async () => {},
  };
}
const PAGE: Page = {
  pageId: 'page:abc', title: 'About', slug: 'about', status: 'published', sections: [],
  version: 3, publishedVersion: 3, updatedAt: '2026-10-01T00:00:00.000Z',
};

const view = (): void => {
  render(<MemoryRouter><EditThisPageLink orgId="host-site" slug="about" /></MemoryRouter>);
};

describe('CMS-R2-3 — Edit this page', () => {
  it('ANONYMOUS: no link and NO probe request (rate-limit discipline)', async () => {
    auth.useAuth.mockReturnValue(authState(null, false));
    view();
    await waitFor(() => expect(cms.getAuthoredPageBySlug).not.toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /Edit this page/i })).toBeNull();
  });

  it('still loading: no probe yet (no request on an unsettled session)', async () => {
    // The hook's only loading state: no user yet (see the header's double guard).
    auth.useAuth.mockReturnValue(authState(null, true));
    view();
    await waitFor(() => expect(cms.getAuthoredPageBySlug).not.toHaveBeenCalled());
  });

  it('signed in + authorized: links to the editor at the resolved pageId', async () => {
    auth.useAuth.mockReturnValue(authState(USER, false));
    cms.getAuthoredPageBySlug.mockResolvedValue(PAGE);
    view();
    const link = await screen.findByRole('link', { name: /Edit this page/i });
    expect(link.getAttribute('href')).toBe('/cms/host-site/page%3Aabc');
    expect(cms.getAuthoredPageBySlug).toHaveBeenCalledWith('host-site', 'about');
  });

  it('signed in but NOT authorized: no link, no error (absence claims nothing)', async () => {
    auth.useAuth.mockReturnValue(authState(USER, false));
    cms.getAuthoredPageBySlug.mockResolvedValue(null); // 403/404 → null
    view();
    await waitFor(() => expect(cms.getAuthoredPageBySlug).toHaveBeenCalledTimes(1));
    // Absence only counts once the probe's answer has landed.
    await act(async () => { await cms.getAuthoredPageBySlug.mock.results[0]?.value; });
    expect(screen.queryByRole('link', { name: /Edit this page/i })).toBeNull();
  });
});
