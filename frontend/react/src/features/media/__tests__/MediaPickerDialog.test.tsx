/**
 * CMSGAP-4 — component coverage for the shared media picker (ADR 0206 B4):
 * loads + renders the org's assets, debounced search re-queries, selecting an
 * asset hands it back, and upload flows through `uploadAsset` → `onSelect`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const listAssets = vi.hoisted(() => vi.fn());
const uploadAsset = vi.hoisted(() => vi.fn());
vi.mock('../mediaClient.js', () => ({
  listAssets,
  uploadAsset,
  absoluteServeUrl: (u: string) => u,
}));

import { MediaPickerDialog } from '../MediaPickerDialog.js';

const asset = (id: string, name: string) => ({
  assetId: id, orgId: 'o1', name, contentType: 'image/png', sizeBytes: 10,
  tags: [], usageCount: 0, serveUrl: `/assets/${id}`, serveToken: `tok-${id}`,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

beforeEach(() => {
  listAssets.mockReset().mockResolvedValue([asset('a1', 'hero.png'), asset('a2', 'logo.png')]);
  uploadAsset.mockReset();
});
afterEach(cleanup);

describe('MediaPickerDialog', () => {
  it('lists the org assets and returns the chosen one', async () => {
    const onSelect = vi.fn();
    render(<MediaPickerDialog orgId="o1" onSelect={onSelect} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('hero.png')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /hero\.png/i }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'a1', serveToken: 'tok-a1' }));
  });

  it('re-queries with the debounced search term', async () => {
    render(<MediaPickerDialog orgId="o1" onSelect={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(listAssets).toHaveBeenCalledWith('o1', {}));
    fireEvent.change(screen.getByLabelText(/search assets/i), { target: { value: 'logo' } });
    await waitFor(() => expect(listAssets).toHaveBeenCalledWith('o1', { q: 'logo' }), { timeout: 2000 });
  });

  it('shows the empty state when nothing matches', async () => {
    listAssets.mockResolvedValue([]);
    render(<MediaPickerDialog orgId="o1" onSelect={() => undefined} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText(/no assets found/i)).toBeTruthy());
  });

  it('uploads a file and immediately selects the new asset', async () => {
    const fresh = asset('a3', 'new.png');
    uploadAsset.mockResolvedValue(fresh);
    const onSelect = vi.fn();
    render(<MediaPickerDialog orgId="o1" onSelect={onSelect} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('hero.png')).toBeTruthy());
    // The Modal renders through a portal — query the document, not the container.
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();
    const file = new File(['x'], 'new.png', { type: 'image/png' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    await waitFor(() => expect(uploadAsset).toHaveBeenCalledWith('o1', file));
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(fresh));
  });
});

describe('MED-G1 — a failed read must not render as "no assets"', () => {
  it('failure shows the retryable failure card; healed retry lists assets', async () => {
    listAssets.mockRejectedValue(new Error('503'));
    render(<MediaPickerDialog orgId="o1" onSelect={() => undefined} onClose={() => undefined} />);
    await screen.findByText(/couldn’t load your media/i);
    expect(screen.queryByText(/no assets found/i)).toBeNull();
    listAssets.mockResolvedValue([asset('a1', 'hero.png')]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await screen.findByText('hero.png');
  });

  it('a genuinely empty library still shows the real empty state', async () => {
    listAssets.mockResolvedValue([]);
    render(<MediaPickerDialog orgId="o1" onSelect={() => undefined} onClose={() => undefined} />);
    await screen.findByText(/no assets found/i);
    expect(screen.queryByText(/couldn’t load your media/i)).toBeNull();
  });
});
