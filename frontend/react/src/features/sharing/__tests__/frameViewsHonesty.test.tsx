/**
 * SH-R2-1 (sharing, ADR 0328 P7 frame-view analytics) — a failed frame-views
 * read must not claim "no views yet".
 *
 * Sabotage-witnessed (w7 grade-tests): `catch { setFrames([]) }` reds the
 * FAILED leg; rendering the unavailable copy for `[]` reds the empty leg.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as C from '../sharingClient.js';

const listFrameViews = vi.hoisted(() => vi.fn<typeof C.listFrameViews>());
vi.mock('../sharingClient.js', async (orig) => ({
  ...(await orig<typeof import('../sharingClient.js')>()),
  listFrameViews,
}));

import { FrameViewsRow } from '../SharingPage.js';

beforeEach(() => vi.resetAllMocks());
afterEach(cleanup);

function open_(): void {
  render(<MemoryRouter><FrameViewsRow orgId="o1" token="tk1" /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button'));
}

describe('SH-R2-1 — frame views honesty', () => {
  it('FAILED read: unavailable label, never "no views yet"', async () => {
    listFrameViews.mockRejectedValue(new Error('views_500'));
    open_();
    expect(await screen.findByText(/couldn.t be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/no slide views/i)).toBeNull();
  });
  it('TRUTHFUL empty keeps its claim', async () => {
    listFrameViews.mockResolvedValue([]);
    open_();
    expect(await screen.findByText(/no slide views/i)).toBeTruthy();
    expect(screen.queryByText(/couldn.t be loaded/i)).toBeNull();
  });
});
