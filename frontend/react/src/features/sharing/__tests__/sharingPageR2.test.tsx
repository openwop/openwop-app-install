/**
 * UX_UPGRADE-sharing ROUND 2 — the management page (SH2) honesty batch.
 *
 *  - SR-4: an invalid expiry gets a NAMED field error and no mint — it used to
 *    be silently dropped, so '7 days' minted a never-expiring link + success
 *    toast (a silent state change on a security-relevant input).
 *  - SR-6: a failed links read gets a designed retryable card — it used to be
 *    a raw `e.message` notice over an eternal skeleton.
 *  - SR-7: viewCount/maxViews/createdAt (always on the wire) finally render.
 *  - SR-5: app-minted capability links (booking/sign/order) are split out and
 *    labeled instead of reading as mystery rows; long lists page.
 *  - SR-9: revoke announces its success (the only feedback was a row quietly
 *    vanishing).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';

const { listOrgs, listLinks, listResources, createLink, revokeLink } = vi.hoisted(() => ({
  listOrgs: vi.fn(), listLinks: vi.fn(), listResources: vi.fn(), createLink: vi.fn(), revokeLink: vi.fn(),
}));
vi.mock('../sharingClient.js', async (orig) => ({
  ...(await orig<typeof import('../sharingClient.js')>()),
  listOrgs, listLinks, listResources, createLink, revokeLink,
}));

const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError } }));
// SHARE-UX-3 — the mock must RESOLVE A RESULT, not `undefined`. The mint path
// now branches on `res.ok` to decide whether it may claim a copy, so a bare
// `vi.fn()` would send every mint down the catch and quietly make these
// assertions test the failure path.
vi.mock('../../../ui/copyToClipboard.js', () => ({ copyToClipboard: vi.fn(async () => ({ ok: true })) }));
const confirmFn = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/confirm.js', () => ({ confirm: confirmFn, ConfirmRoot: () => null }));

import { SharingPage } from '../SharingPage.js';

const ORG = { orgId: 'o1', name: 'Acme' };
const RESOURCE = { id: 'r1', label: 'Q3 deck' };
const LINK = {
  tokenHash: 'hash-1', resourceType: 'cms_page', resourceId: 'p1', label: 'Preview',
  createdAt: '2026-08-01T09:00:00.000Z', revoked: false, viewCount: 3, maxViews: 5,
};

const mount = async (): Promise<void> => {
  render(<SharingPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([ORG]);
  listLinks.mockResolvedValue([LINK]);
  listResources.mockResolvedValue([RESOURCE]);
});

describe('SR-4 — invalid expiry is a NAMED error, never a silent drop', () => {
  it("'7 days' blocks the mint with a field error; createLink is never called", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText(/resource$/i), { target: { value: 'r1' } });
    fireEvent.change(screen.getByLabelText(/expires in days/i), { target: { value: '7 days' } });
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));
    await screen.findByText(/whole number of days/i);
    expect(createLink).not.toHaveBeenCalled();
  });

  it("a valid '7' mints with expiresInDays: 7; empty mints with none", async () => {
    createLink.mockResolvedValue({ ...LINK, token: 'raw-tok' });
    await mount();
    fireEvent.change(screen.getByLabelText(/resource$/i), { target: { value: 'r1' } });
    fireEvent.change(screen.getByLabelText(/expires in days/i), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));
    await waitFor(() => expect(createLink).toHaveBeenCalledWith('o1', expect.objectContaining({ expiresInDays: 7 })));

    fireEvent.change(screen.getByLabelText(/resource$/i), { target: { value: 'r1' } });
    fireEvent.change(screen.getByLabelText(/expires in days/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));
    await waitFor(() => expect(createLink).toHaveBeenCalledTimes(2));
    expect(createLink.mock.calls[1]![1]).not.toHaveProperty('expiresInDays');
  });
});

describe('SR-6 — a failed links read is not an eternal skeleton (or "no links")', () => {
  it('renders the retryable card; Retry re-reads', async () => {
    listLinks.mockRejectedValueOnce(new Error('http 500')).mockResolvedValueOnce([LINK]);
    await mount();
    await screen.findByText(/couldn.t load this workspace.s links/i);
    expect(screen.queryByText(/no active links/i)).toBeNull();
    // The raw server string must not reach the page.
    expect(screen.queryByText(/http 500/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('Preview');
    expect(listLinks).toHaveBeenCalledTimes(2);
  });
});

describe('SR-7 — view counts, cap and created date finally render', () => {
  it('shows "Seen 3 times", the view cap, and the created date', async () => {
    await mount();
    await screen.findByText('Preview');
    expect(screen.getByText(/seen 3 times/i)).toBeTruthy();
    expect(screen.getByText(/view cap 5/i)).toBeTruthy();
    expect(screen.getByText(/created/i)).toBeTruthy();
  });
});

describe('SR-5 — app-minted links are split out and labeled; long lists page', () => {
  it('a booking_manage link is NOT in the main list; the labeled toggle reveals it', async () => {
    listLinks.mockResolvedValue([
      LINK,
      { tokenHash: 'hash-sys', resourceType: 'booking_manage', resourceId: 'bk1', createdAt: '2026-08-02T09:00:00.000Z', revoked: false, viewCount: 0 },
    ]);
    await mount();
    await screen.findByText('Preview');
    expect(screen.queryByText('bk1')).toBeNull();

    const toggle = screen.getByRole('button', { name: /app-minted links \(1\)/i });
    fireEvent.click(toggle);
    await screen.findByText('bk1');
    expect(screen.getByText(/booking \(app-minted\)/i)).toBeTruthy();
  });

  it('caps the visible list at 30 and Show-more reveals the rest', async () => {
    listLinks.mockResolvedValue(Array.from({ length: 35 }, (_, i) => ({
      tokenHash: `h${i}`, resourceType: 'cms_page', resourceId: `p${i}`, label: `Link ${i + 1}`,
      createdAt: '2026-08-01T09:00:00.000Z', revoked: false, viewCount: 0,
    })));
    await mount();
    await screen.findByText('Link 1');
    expect(screen.queryByText('Link 31')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show 5 more/i }));
    await screen.findByText('Link 35');
  });
});

describe('SR-9 — revoke announces its success', () => {
  it('confirms, revokes, and toasts the success', async () => {
    confirmFn.mockResolvedValue(true);
    revokeLink.mockResolvedValue(undefined);
    await mount();
    await screen.findByText('Preview');
    fireEvent.click(screen.getByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(revokeLink).toHaveBeenCalledWith('o1', 'hash-1'));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(expect.stringMatching(/revoked/i)));
  });
});

describe('review F3 — a system-only list is not an unlabeled void', () => {
  it('says no person-minted links exist when everything is app-minted', async () => {
    listLinks.mockResolvedValue([
      { tokenHash: 'hash-sys', resourceType: 'booking_manage', resourceId: 'bk1', createdAt: '2026-08-02T09:00:00.000Z', revoked: false, viewCount: 0 },
    ]);
    await mount();
    await screen.findByText(/no links minted by people yet/i);
    expect(screen.getByRole('button', { name: /app-minted links \(1\)/i })).toBeTruthy();
  });
});
