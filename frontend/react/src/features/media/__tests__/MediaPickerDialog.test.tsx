/**
 * CMSGAP-4 — component coverage for the shared media picker (ADR 0206 B4):
 * loads + renders the org's assets, debounced search re-queries, selecting an
 * asset hands it back, and upload flows through `uploadAsset` → `onSelect`.
 *
 * Sabotage: drop the 250 ms debounce (`q ? 250 : 0` → `0`) → the search case
 * (one read per pause is the rate-limit fan-out discipline); render a failed
 * read as `[]` → MED-G1 case 1.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type * as Client from '../mediaClient.js';
import type { MediaAsset } from '../mediaClient.js';

const listAssets = vi.hoisted(() => vi.fn<typeof Client.listAssets>());
const uploadAsset = vi.hoisted(() => vi.fn<typeof Client.uploadAsset>());
vi.mock('../mediaClient.js', () => ({
  listAssets,
  uploadAsset,
  absoluteServeUrl: (u: string) => u,
}));

import { MediaPickerDialog } from '../MediaPickerDialog.js';

const asset = (id: string, name: string): MediaAsset => ({
  assetId: id, orgId: 'o1', name, contentType: 'image/png', sizeBytes: 10,
  tags: [], usageCount: 0, serveUrl: `/assets/${id}`, serveToken: `tok-${id}`,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
});

beforeEach(() => {
  listAssets.mockReset().mockResolvedValue([asset('a1', 'hero.png'), asset('a2', 'logo.png')]);
  uploadAsset.mockReset();
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

describe('MediaPickerDialog', () => {
  it('lists the org assets and returns the chosen one', async () => {
    const onSelect = vi.fn();
    render(<MediaPickerDialog orgId="o1" onSelect={onSelect} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('hero.png')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /hero\.png/i }));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ assetId: 'a1', serveToken: 'tok-a1' }));
  });

  it('re-queries with the debounced search term — one read per pause, not per keystroke', async () => {
    // Fake timers, advanced by hand: RTL's waitFor only auto-advances JEST timers.
    vi.useFakeTimers();
    render(<MediaPickerDialog orgId="o1" onSelect={() => undefined} onClose={() => undefined} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(listAssets).toHaveBeenCalledWith('o1', {});
    const box = screen.getByLabelText(/search assets/i);
    fireEvent.change(box, { target: { value: 'lo' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    fireEvent.change(box, { target: { value: 'logo' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(listAssets, 'still inside the pause — no read yet').toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(listAssets).toHaveBeenCalledTimes(2);
    expect(listAssets).toHaveBeenLastCalledWith('o1', { q: 'logo' });
    expect(listAssets).not.toHaveBeenCalledWith('o1', { q: 'lo' });
  });

  it('uploads a file and immediately selects the new asset', async () => {
    const fresh = asset('a3', 'new.png');
    uploadAsset.mockResolvedValue(fresh);
    const onSelect = vi.fn();
    render(<MediaPickerDialog orgId="o1" onSelect={onSelect} onClose={() => undefined} />);
    await waitFor(() => expect(screen.getByText('hero.png')).toBeTruthy());
    // The Modal renders through a portal — query the document, not the container.
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    const file = new File(['x'], 'new.png', { type: 'image/png' });
    fireEvent.change(fileInput!, { target: { files: [file] } });
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
