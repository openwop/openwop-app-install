/**
 * SH-R2-1 (sharing) — a failed frame-views read must not claim "no views yet".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const api = vi.hoisted(() => ({ listFrameViews: vi.fn(), listShares: vi.fn() }));
vi.mock('../sharingClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, listFrameViews: api.listFrameViews, listShares: api.listShares };
});

import { FrameViewsRow } from '../SharingPage.js';

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function open_(): void {
  render(<MemoryRouter><FrameViewsRow orgId="o1" token="tk1" /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button'));
}

describe('SH-R2-1 — frame views honesty', () => {
  it('FAILED read: unavailable label, never "no views yet"', async () => {
    api.listFrameViews.mockRejectedValue(new Error('views_500'));
    open_();
    expect(await screen.findByText(/couldn.t be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/no slide views/i)).toBeNull();
  });
  it('TRUTHFUL empty keeps its claim', async () => {
    api.listFrameViews.mockResolvedValue([]);
    open_();
    expect(await screen.findByText(/no slide views/i)).toBeTruthy();
  });
});
