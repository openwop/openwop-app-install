/**
 * ADR 0818 §5 — the library tells the truth before a delete, and renders the
 * alt text it records.
 *
 * Delete used to ask "Delete this asset?" with no word about the pages showing
 * it, though the usage graph was one read away. Alt text (ADR 0363) was stored
 * and shown as a compliance chip, but no thumbnail rendered it (MED2-M1).
 *
 * Sabotage: label a creative render as a CMS page → case 1; map a failed usage
 * read to `[]` → case 2; fall back to the file name for alt → the alt case;
 * render the confirm body in a <p> → the last case.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as Client from '../mediaClient.js';
import type { MediaAsset } from '../mediaClient.js';
import type * as SiteClient from '../../site/siteConfigClient.js';
import type { confirm as realConfirm } from '../../../ui/confirm.js';

const { listOrgs, listCollections, listAssets, deleteAsset, listAssetUsage, confirm, getSiteConfig } = vi.hoisted(() => ({
  listOrgs: vi.fn<typeof Client.listOrgs>(),
  listCollections: vi.fn<typeof Client.listCollections>(),
  listAssets: vi.fn<typeof Client.listAssets>(),
  deleteAsset: vi.fn<typeof Client.deleteAsset>(),
  listAssetUsage: vi.fn<typeof Client.listAssetUsage>(),
  confirm: vi.fn<typeof realConfirm>(),
  getSiteConfig: vi.fn<typeof SiteClient.getSiteConfig>(),
}));
vi.mock('../mediaClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs, listCollections, listAssets, deleteAsset, listAssetUsage,
}));
vi.mock('../../site/siteConfigClient.js', () => ({ getSiteConfig }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../../../ui/confirm.js', () => ({ confirm }));

import { MediaLibraryPage } from '../MediaLibraryPage.js';
import { ConfirmDialog } from '../../../ui/ConfirmDialog.js';

const asset = (over: Partial<MediaAsset> = {}): MediaAsset => ({
  assetId: 'asset-1', orgId: 'org1', name: 'brand-mark.png', contentType: 'image/png',
  sizeBytes: 1024, tags: [], usageCount: 0, serveUrl: '/asset-1',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', ...over,
});

const mount = async (): Promise<void> => {
  render(<MemoryRouter initialEntries={['/media']}><MediaLibraryPage /></MemoryRouter>);
  await act(async () => {});
};

/** Render the `body` the page handed to confirm(), to read it as a user would. */
const confirmBodyText = (): string => {
  const opts = confirm.mock.calls[0]![0];
  if (!opts.body) return '';
  const { container } = render(<>{opts.body}</>);
  return container.textContent ?? '';
};

beforeEach(() => {
  vi.resetAllMocks();
  confirm.mockResolvedValue(true);
  getSiteConfig.mockRejectedValue(new Error('403')); // a normal user (ADR 0817 probe)
  listOrgs.mockResolvedValue([{ orgId: 'org1', name: 'Org One' }]);
  listCollections.mockResolvedValue([]);
  deleteAsset.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('ADR 0818 §5 — usage-aware delete', () => {
  it('names the pages that will break', async () => {
    listAssets.mockResolvedValue([asset()]);
    listAssetUsage.mockResolvedValue([
      { assetId: 'asset-1', refKind: 'cms-page', refId: 'p1', refLabel: 'Pricing page', lastSeenAt: '2026-09-02T00:00:00Z' },
      { assetId: 'asset-1', refKind: 'creative-render', refId: 'r1', refLabel: 'Spring launch', lastSeenAt: '2026-09-02T00:00:00Z' },
    ]);
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: /delete asset/i }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    const text = confirmBodyText();
    expect(text).toMatch(/used in 2 places/i);
    expect(text).toContain('CMS page: Pricing page');
    expect(text).toContain('Creative render: Spring launch'); // not mislabelled "CMS page" (MEDUX-3)
    expect(confirm.mock.calls[0]![0].title).toContain('brand-mark.png');
  });

  it('a failed usage read says it could not check, never that nothing uses it', async () => {
    listAssets.mockResolvedValue([asset()]);
    listAssetUsage.mockRejectedValue(new Error('usage down'));
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: /delete asset/i }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirmBodyText()).toMatch(/couldn't check where this file is used/i);
  });

  it('an unused asset asks the plain question', async () => {
    listAssets.mockResolvedValue([asset()]);
    listAssetUsage.mockResolvedValue([]);
    await mount();
    fireEvent.click(await screen.findByRole('button', { name: /delete asset/i }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirmBodyText()).toBe('');
  });
});

describe('ADR 0818 §5 — alt text renders (MED2-M1)', () => {
  it('a thumbnail carries the asset alt text; a decorative image carries alt=""', async () => {
    listAssets.mockResolvedValue([
      asset({ altText: 'Blue circular logo', altTextSource: 'human' }),
      asset({ assetId: 'asset-2', name: 'divider.png', altText: '', altTextSource: 'decorative' }),
    ]);
    listAssetUsage.mockResolvedValue([]);
    await mount();
    expect(await screen.findByAltText('Blue circular logo')).toBeTruthy();
    const alts = Array.from(document.querySelectorAll('img.media-thumb-img')).map((i) => i.getAttribute('alt'));
    // In render order: the described logo, then the decorative divider (never its file name).
    expect(alts).toEqual(['Blue circular logo', '']);
  });
});

describe('ADR 0818 §5 — the real confirm dialog carries the warning', () => {
  it('renders a list body as valid markup and describes the dialog with it', () => {
    render(
      <ConfirmDialog
        title="Delete it?"
        body={<><p>Used in 1 place:</p><ul><li>Pricing page</li></ul></>}
        confirmLabel="Delete"
        danger
        onConfirm={() => undefined}
        onCancel={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog');
    const id = dialog.getAttribute('aria-describedby');
    expect(id).toBeTruthy();
    const described = document.getElementById(id!)!;
    expect(described.tagName).toBe('DIV'); // a <p> cannot hold a <ul>
    expect(described.textContent).toContain('Pricing page');
  });
});
