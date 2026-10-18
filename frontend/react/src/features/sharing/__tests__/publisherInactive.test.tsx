/**
 * ADR 0887 D2 + D5 — the owner list says when a link is dark because the person
 * who shared it lost access, offers Adopt on that row, and withholds a title the
 * reader may not see (instead of falling back to the raw id, which reads as
 * "deleted").
 *
 * Not covered here: the server deciding `publisherInactive` / `cardRedacted`
 * (backend `adr0887-sharing-probes.test.ts` owns that).
 *
 * Sabotage-witnessed (wave 52): dropping the `publisherInactive` status rank,
 * the `status === 'publisher-inactive'` row block, the `canAdopt` gate, the
 * post-adopt reload, the refusal-reason map, the in-flight `setAdopting`, or the
 * redaction branch each turn a case red.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import type * as C from '../sharingClient.js';

const { listOrgs, listLinks, listResources, adoptLink } = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof C.listOrgs>(), listLinks: vi.fn<typeof C.listLinks>(), listResources: vi.fn<typeof C.listResources>(),
  adoptLink: vi.fn<typeof C.adoptLink>(),
}));
vi.mock('../sharingClient.js', async (orig) => ({
  ...(await orig<typeof import('../sharingClient.js')>()),
  listOrgs, listLinks, listResources, adoptLink,
}));
const { toastSuccess, toastError } = vi.hoisted(() => ({ toastSuccess: vi.fn(), toastError: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError, warning: vi.fn(), info: vi.fn() } }));

import { SharingPage } from '../SharingPage.js';
import { AdoptError, isLinkLive, linkStatus, type ShareLink } from '../sharingClient.js';

const ORG: Awaited<ReturnType<typeof C.listOrgs>>[number] = { orgId: 'o1', name: 'Acme' };
const link = (over: Partial<ShareLink> = {}): ShareLink => ({
  tokenHash: 'h1', resourceType: 'cms_page', resourceId: 'page-raw-id', createdAt: '2026-08-01T09:00:00.000Z', revoked: false, ...over,
});

afterEach(() => { cleanup(); });
beforeEach(() => {
  vi.resetAllMocks();
  listOrgs.mockResolvedValue([ORG]);
  listResources.mockResolvedValue([]);
});

describe('ADR 0887 D2 — status', () => {
  it('a publisher-inactive link is its own status, below feature-off, and stays in the visible list', () => {
    expect(linkStatus(link({ publisherInactive: true }))).toBe('publisher-inactive');
    expect(linkStatus(link({ publisherInactive: true, featureDisabled: true }))).toBe('feature-off');
    expect(linkStatus(link({ publisherInactive: true, revoked: true }))).toBe('revoked');
    expect(isLinkLive(link({ publisherInactive: true })), 'actionable on the row, so not collapsed away').toBe(true);
  });
});

describe('ADR 0887 D5 — adopt from the row', () => {
  it('names the state, adopts with the row token, reloads and announces it', async () => {
    listLinks.mockResolvedValueOnce([link({ cardTitle: 'Handbook', publisherInactive: true, canAdopt: true })])
      .mockResolvedValue([link({ cardTitle: 'Handbook' })]);
    adoptLink.mockResolvedValue(link({ cardTitle: 'Handbook', adoptedAt: '2026-10-14T00:00:00.000Z' }));
    render(<SharingPage />);
    await act(async () => {});
    await screen.findByText('Handbook');
    expect(screen.getByText(/^Needs a new owner$/)).toBeTruthy();
    expect(screen.getByText(/no longer has access/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Adopt link' }));
    await waitFor(() => expect(adoptLink).toHaveBeenCalledWith('o1', 'h1'));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Link adopted — it works again at the same address.'));
    expect(listLinks).toHaveBeenCalledTimes(2);
  });

  it('a refused adopt names the server’s REASON in the reader’s language, never a success', async () => {
    listLinks.mockResolvedValue([link({ cardTitle: 'Handbook', publisherInactive: true, canAdopt: true })]);
    adoptLink.mockRejectedValue(new AdoptError('publisher-active'));
    render(<SharingPage />);
    await act(async () => {});
    fireEvent.click(await screen.findByRole('button', { name: 'Adopt link' }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringMatching(/still has access/)));
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it('one adopt per row at a time: a double-click sends one request (SH2UX-1)', async () => {
    listLinks.mockResolvedValue([link({ cardTitle: 'Handbook', publisherInactive: true, canAdopt: true })]);
    let release: (v: ShareLink) => void = () => undefined;
    adoptLink.mockReturnValue(new Promise<ShareLink>((r) => { release = r; }));
    render(<SharingPage />);
    await act(async () => {});
    const btn = await screen.findByRole('button', { name: 'Adopt link' });
    // DOUBLE GUARD (named): `adopt()` returns early while `adopting` is set AND the
    // button is `disabled={adopting !== null}`. Either alone stops the second
    // click, so removing only one stays green by design; the shared piece both
    // read — `setAdopting(token)` — is the one a sabotage can see.
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(adoptLink).toHaveBeenCalledTimes(1);
    await act(async () => { release(link()); });
  });

  it('a reader who cannot adopt is not offered the button, and is told who can (SH2UX-2)', async () => {
    listLinks.mockResolvedValue([link({ cardTitle: 'Handbook', publisherInactive: true })]);
    render(<SharingPage />);
    await act(async () => {});
    await screen.findByText('Handbook');
    expect(screen.queryByRole('button', { name: 'Adopt link' })).toBeNull();
    expect(screen.getByText(/workspace editor can adopt/i)).toBeTruthy();
  });

  it('a live link offers no Adopt', async () => {
    // `canAdopt: true` — so ONLY the publisher-inactive status gate can keep the
    // button away (without it, the absence was a fixture fact).
    listLinks.mockResolvedValue([link({ cardTitle: 'Live one', canAdopt: true })]);
    render(<SharingPage />);
    await act(async () => {});
    await screen.findByText('Live one');
    expect(screen.queryByRole('button', { name: 'Adopt link' })).toBeNull();
    expect(screen.queryByText(/no longer has access/i)).toBeNull();
  });
});

describe('ADR 0887 D2 — a title the reader may not see is withheld', () => {
  it('shows "title hidden", never the raw id', async () => {
    listLinks.mockResolvedValue([link({ cardRedacted: true })]);
    render(<SharingPage />);
    await act(async () => {});
    expect(await screen.findByText(/title hidden/i)).toBeTruthy();
    expect(screen.queryByText('page-raw-id')).toBeNull();
  });
});
