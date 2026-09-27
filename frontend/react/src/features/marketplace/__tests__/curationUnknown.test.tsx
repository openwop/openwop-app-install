/**
 * ADR 0194 P3 — the availability control when the workspace curation read failed.
 *
 * `fetchDisabledPacks` says which packs the workspace has HIDDEN. On failure it
 * fell back to `[]`, which is not neutral here: `wsDisabled` drives
 * `checked={!wsDisabled}` on an "Available in workspace" checkbox and the
 * "Hidden in workspace" chip, so an empty set renders EVERY pack as available —
 * including ones deliberately hidden — and `toggleAvailability` computed its
 * write from that same fabricated set.
 *
 * Tested at the VIEW level rather than through `MarketplacePage`: the guarantee
 * is user-visible (an inert control that says it does not know), and a page-level
 * harness needs the whole client + orgs + reviews + access surface mocked. I tried
 * that first and every assertion failed on fixture completeness rather than on the
 * behaviour under test — which is the trap, not the bug.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ListingCard } from '../MarketplaceViews.js';
import type { Listing } from '../marketplaceClient.js';

const listing: Listing = {
  packName: 'community.demo.pack',
  version: '1.0.0',
  title: 'Demo',
  category: 'node',
  installed: true,
  // MKT2-B2 — a listing carries provenance as well as install state. This
  // fixture is about the CURATION-unknown state, so it stays a plain
  // registry-installed pack; the origin split has its own coverage in
  // `bundledPackHonesty.test.tsx`.
  origin: 'registry',
};

const props = (curationUnknown: boolean, wsDisabled = false) => ({
  listing,
  busy: false,
  wsDisabled,
  curationUnknown,
  onReviews: vi.fn(),
  onInstall: vi.fn(),
  onToggleAvailability: vi.fn(),
  onRemove: vi.fn(),
  onRestore: vi.fn(),
  onPurge: vi.fn(),
  onPurchase: vi.fn(),
});

const view = (p: ReturnType<typeof props>) =>
  render(<MemoryRouter><ListingCard {...p} /></MemoryRouter>);

afterEach(cleanup);

describe('availability control when curation is unknown', () => {
  it('is INERT and says so — a checkbox reflecting a fabricated set is worse than none', () => {
    view(props(true));
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.disabled).toBe(true);
    expect(screen.getByText(/Availability unknown/i)).toBeTruthy();
    // And it must NOT present the confident label as though the state were read.
    expect(screen.queryByText(/^Available in this workspace$/)).toBeNull();
  });

  it('does not fire the write when clicked while unknown', () => {
    const p = props(true);
    view(p);
    screen.getByRole('checkbox').click();
    // `disabled` blocks the DOM event; the page-level `if (curationUnknown) return`
    // is the second line of defence. Either way no write is attempted from a set
    // that was never read.
    expect(p.onToggleAvailability).not.toHaveBeenCalled();
  });

  it('stays LIVE when curation IS known — the fix must not disable it for everyone', () => {
    // The other arm. Without it, "always inert" would satisfy both tests above
    // while breaking workspace curation for every healthy tenant.
    const p = props(false);
    view(p);
    const box = screen.getByRole('checkbox') as HTMLInputElement;
    expect(box.disabled).toBe(false);
    expect(screen.getByText(/^Available in this workspace$/)).toBeTruthy();
    expect(screen.queryByText(/Availability unknown/i)).toBeNull();
  });

  it('still flags a pack the workspace HAS hidden, when that is actually known', () => {
    view(props(false, true));
    expect(screen.getByText(/Hidden in this workspace/i)).toBeTruthy();
    expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
  });
});
