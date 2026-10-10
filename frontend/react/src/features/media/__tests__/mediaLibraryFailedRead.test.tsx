/**
 * UX_UPGRADE-media ROUND 3 — MED2-M4.
 *
 * A failed asset list used to render as a PERMANENT skeleton (the catch set
 * `error` and never touched `assets`), and the error banner outlived the
 * failure (nothing cleared it when a later search succeeded). Failure is its
 * own state now, with retry; success clears the banner. Both polarities.
 *
 * The org/collection resilience and the post-delete focus cases are ADR 0363
 * Phase 1 (70aee16ef, "harden accessibility and failure states").
 *
 * Sabotage: swallow the asset-read error → case 1 and 2; stop reloading on a
 * search → case 2; a no-op org Retry → case 3; a collection Retry that does not
 * re-read → case 4; drop the post-delete focus → case 5.
 *
 * Ceiling (double guard): `assetsFailed` is cleared both by the load effect and
 * by the read's success handler, so removing either one alone is a no-op.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as Client from '../mediaClient.js';
import type { MediaAsset } from '../mediaClient.js';
import type * as SiteClient from '../../site/siteConfigClient.js';
import type { confirm as realConfirm } from '../../../ui/confirm.js';

const { listOrgs, listCollections, listAssets, deleteAsset, listAssetUsage, getSiteConfig, confirm } = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof Client.listOrgs>(),
  listCollections: vi.fn<typeof Client.listCollections>(),
  listAssets: vi.fn<typeof Client.listAssets>(),
  deleteAsset: vi.fn<typeof Client.deleteAsset>(),
  listAssetUsage: vi.fn<typeof Client.listAssetUsage>(),
  getSiteConfig: vi.fn<typeof SiteClient.getSiteConfig>(),
  confirm: vi.fn<typeof realConfirm>(),
}));
vi.mock('../mediaClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs, listCollections, listAssets, deleteAsset, listAssetUsage,
}));
// ADR 0817: the page probes the super-admin site config; a normal user's 403.
vi.mock('../../site/siteConfigClient.js', () => ({ getSiteConfig }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({ confirm }));

import { MediaLibraryPage } from '../MediaLibraryPage.js';

const mount = async (): Promise<void> => {
  render(<MemoryRouter initialEntries={['/media']}><MediaLibraryPage /></MemoryRouter>);
  await act(async () => {});
};

beforeEach(() => {
  // reset, not clear: a `…Once` value a failed case left unconsumed must not leak.
  vi.resetAllMocks();
  listAssetUsage.mockResolvedValue([]);
  getSiteConfig.mockRejectedValue(new Error('403'));
  confirm.mockResolvedValue(true);
  deleteAsset.mockResolvedValue(undefined);
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
    // The SUCCESSFUL read landed (the designed no-match state) — not merely the
    // load effect's own reset of the flag, which happens before the read.
    expect(await screen.findByText(/no matching assets/i)).toBeTruthy();
    expect(screen.queryByText(/assets could not be loaded/i)).toBeNull();
    expect(listAssets).toHaveBeenLastCalledWith('org1', { q: 'logo' });
  });
});

describe('admin resilience — organization and collection reads remain distinct from empty', () => {
  it('a failed organization read terminates with Retry instead of a permanent skeleton', async () => {
    listOrgs.mockRejectedValueOnce(new Error('orgs down')).mockResolvedValueOnce([{ orgId: 'org1', name: 'Org One' }]);
    listAssets.mockResolvedValue([]);
    await mount();
    await screen.findByText(/organizations could not be loaded/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/no assets/i)).toBeTruthy();
  });

  it('a failed collection read is disclosed and retryable without claiming no collections', async () => {
    listCollections.mockRejectedValueOnce(new Error('collections down')).mockResolvedValueOnce([]);
    listAssets.mockResolvedValue([]);
    await mount();
    await screen.findByText(/collections could not be loaded/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.queryByText(/collections could not be loaded/i)).toBeNull());
    expect(listCollections).toHaveBeenCalledTimes(2);
  });
});

describe('destructive-action focus recovery', () => {
  it('moves focus to the stable asset-results region after deletion removes the trigger', async () => {
    const brand: MediaAsset = {
      assetId: 'asset-1', orgId: 'org1', name: 'Brand mark', contentType: 'image/png',
      sizeBytes: 1024, tags: [], usageCount: 0, serveUrl: '/asset-1',
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    };
    listAssets.mockResolvedValue([brand]);
    await mount();
    const deleteButton = await screen.findByRole('button', { name: /delete asset/i });
    fireEvent.click(deleteButton);
    const results = screen.getByRole('region', { name: /media assets/i });
    await waitFor(() => expect(document.activeElement).toBe(results));
    expect(screen.queryByText('Brand mark')).toBeNull();
  });
});
