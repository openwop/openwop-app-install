/**
 * UX_UPGRADE-media ROUND 3 — MED2-M4.
 *
 * A failed asset list used to render as a PERMANENT skeleton (the catch set
 * `error` and never touched `assets`), and the error banner outlived the
 * failure (nothing cleared it when a later search succeeded). Failure is its
 * own state now, with retry; success clears the banner. Both polarities.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { listOrgs, listCollections, listAssets, deleteAsset } = vi.hoisted(() => ({
  listOrgs: vi.fn(), listCollections: vi.fn(), listAssets: vi.fn(), deleteAsset: vi.fn(),
}));
vi.mock('../mediaClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs, listCollections, listAssets, deleteAsset,
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));

import { MediaLibraryPage } from '../MediaLibraryPage.js';

const mount = async (): Promise<void> => {
  render(<MemoryRouter initialEntries={['/media']}><MediaLibraryPage /></MemoryRouter>);
  await act(async () => {});
};

beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([{ orgId: 'org1', name: 'Org One' }]);
  listCollections.mockResolvedValue([]);
});
afterEach(cleanup);

describe('MED2-M4 — a failed asset read is a designed state, and success clears the banner', () => {
  it('failure shows the failed-read card (not a skeleton), and Retry re-reads', async () => {
    listAssets.mockRejectedValueOnce(new Error('assets down'));
    listAssets.mockResolvedValue([]);
    await mount();
    expect(await screen.findByText(/assets could not be loaded/i)).toBeTruthy();
    expect(screen.getByText(/failed read, not an empty library/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.queryByText(/assets could not be loaded/i)).toBeNull());
    expect(await screen.findByText(/no assets/i)).toBeTruthy(); // the DESIGNED empty state, post-retry
  });

  it('a later successful search clears the stale error banner', async () => {
    listAssets.mockRejectedValueOnce(new Error('assets down'));
    listAssets.mockResolvedValue([]);
    await mount();
    await screen.findByText(/assets could not be loaded/i);
    // A new search triggers the load effect; success must clear the banner.
    fireEvent.change(screen.getByPlaceholderText(/search/i), { target: { value: 'logo' } });
    await waitFor(() => expect(screen.queryByText('assets down')).toBeNull());
    expect(screen.queryByText(/assets could not be loaded/i)).toBeNull();
  });
});

describe('admin resilience — organization and collection reads remain distinct from empty', () => {
  it('a failed organization read terminates with Retry instead of a permanent skeleton', async () => {
    listOrgs.mockRejectedValueOnce(new Error('orgs down')).mockResolvedValueOnce([{ orgId: 'org1', name: 'Org One' }]);
    listAssets.mockResolvedValue([]);
    await mount();
    const title = await screen.findByText(/organizations could not be loaded/i);
    const card = title.closest('.state-card');
    expect(card).toBeTruthy();
    fireEvent.click(card!.querySelector('button')!);
    expect(await screen.findByText(/no assets/i)).toBeTruthy();
  });

  it('a failed collection read is disclosed and retryable without claiming no collections', async () => {
    listCollections.mockRejectedValueOnce(new Error('collections down')).mockResolvedValueOnce([]);
    listAssets.mockResolvedValue([]);
    await mount();
    const title = await screen.findByText(/collections could not be loaded/i);
    const card = title.closest('.state-card');
    fireEvent.click(card!.querySelector('button')!);
    await waitFor(() => expect(screen.queryByText(/collections could not be loaded/i)).toBeNull());
    expect(listCollections).toHaveBeenCalledTimes(2);
  });
});

describe('destructive-action focus recovery', () => {
  it('moves focus to the stable asset-results region after deletion removes the trigger', async () => {
    listAssets.mockResolvedValue([{
      assetId: 'asset-1', orgId: 'org1', name: 'Brand mark', contentType: 'image/png',
      sizeBytes: 1024, tags: [], usageCount: 0, serveUrl: '/asset-1',
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    }]);
    deleteAsset.mockResolvedValue(undefined);
    await mount();
    const deleteButton = await screen.findByRole('button', { name: /delete asset/i });
    fireEvent.click(deleteButton);
    const results = screen.getByRole('region', { name: /media assets/i });
    await waitFor(() => expect(document.activeElement).toBe(results));
    expect(screen.queryByText('Brand mark')).toBeNull();
  });
});
