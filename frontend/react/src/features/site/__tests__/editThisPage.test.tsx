/**
 * CMS-R2-3 — the "Edit this page" affordance on a published public page.
 * Invariants:
 *   - ANONYMOUS: no link AND no probe request (the rate-limit rule — public
 *     pages are the highest-traffic surface)
 *   - signed in + authorized: the link renders and deep-links the editor at
 *     the resolved pageId
 *   - signed in + NOT authorized (probe returns null): no link, no error —
 *     absence makes no claim
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const auth = vi.hoisted(() => ({ useAuth: vi.fn() }));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: auth.useAuth }));
const cms = vi.hoisted(() => ({ getAuthoredPageBySlug: vi.fn() }));
vi.mock('../../cms/cmsClient.js', () => cms);

import { EditThisPageLink } from '../EditThisPageLink.js';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

const view = (): void => {
  render(<MemoryRouter><EditThisPageLink orgId="host-site" slug="about" /></MemoryRouter>);
};

describe('CMS-R2-3 — Edit this page', () => {
  it('ANONYMOUS: no link and NO probe request (rate-limit discipline)', async () => {
    auth.useAuth.mockReturnValue({ user: null, loading: false });
    view();
    await waitFor(() => expect(cms.getAuthoredPageBySlug).not.toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /Edit this page/i })).toBeNull();
  });

  it('still loading: no probe yet (no request on an unsettled session)', async () => {
    auth.useAuth.mockReturnValue({ user: null, loading: true });
    view();
    await waitFor(() => expect(cms.getAuthoredPageBySlug).not.toHaveBeenCalled());
  });

  it('signed in + authorized: links to the editor at the resolved pageId', async () => {
    auth.useAuth.mockReturnValue({ user: { uid: 'u1' }, loading: false });
    cms.getAuthoredPageBySlug.mockResolvedValue({ pageId: 'page:abc', slug: 'about' });
    view();
    const link = await screen.findByRole('link', { name: /Edit this page/i });
    expect(link.getAttribute('href')).toBe('/cms/host-site/page%3Aabc');
    expect(cms.getAuthoredPageBySlug).toHaveBeenCalledWith('host-site', 'about');
  });

  it('signed in but NOT authorized: no link, no error (absence claims nothing)', async () => {
    auth.useAuth.mockReturnValue({ user: { uid: 'u1' }, loading: false });
    cms.getAuthoredPageBySlug.mockResolvedValue(null); // 403/404 → null
    view();
    await waitFor(() => expect(cms.getAuthoredPageBySlug).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /Edit this page/i })).toBeNull();
  });
});
