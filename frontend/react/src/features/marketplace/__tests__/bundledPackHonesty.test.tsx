/**
 * UX_UPGRADE-marketplace R2 — MKT2-B2 on the screen.
 *
 * `installed` means "has a registry install marker". The console rendered its
 * negation as "Not installed", which is a different and false claim for every
 * pack mounted from the host checkout: the executor loads and runs them.
 * MEASURED on a dev host when this landed — 172 symlinked packs with 0 markers
 * against 64 real directories with 64 markers — so the majority of the catalog
 * carried the false label, behind a primary Install button that could not
 * succeed (`installPackFromRegistry` fetches the pack's registry manifest
 * first, and a pack that was never published necessarily 404s there).
 *
 * Both origins are asserted in every case. A fixture carrying only `local`
 * would pass against a component hard-coded to say "Bundled".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

vi.mock('../marketplaceClient.js', () => ({}));

import { ListingCard } from '../MarketplaceViews.js';
import type { Listing } from '../marketplaceClient.js';

const base: Listing = {
  packName: 'feature.example.nodes',
  version: '1.0.0',
  title: 'feature.example.nodes',
  category: 'Node pack',
  installed: false,
  origin: 'local',
};

const noop = () => undefined;
const show = (l: Listing) =>
  render(
    <ListingCard
      listing={l}
      busy={false}
      wsDisabled={false}
      curationUnknown={false}
      onReviews={noop}
      onInstall={noop}
      onToggleAvailability={noop}
      onRemove={noop}
      onRestore={noop}
      onPurge={noop}
      onPurchase={noop}
    />,
  );

afterEach(cleanup);

describe('MKT2-B2 — a bundled pack is not described as missing', () => {
  it('a checkout-mounted pack reads as bundled, and Install is not offered', () => {
    show(base);

    expect(screen.getByText(/^Bundled$/), 'the chip states what is true').toBeTruthy();
    expect(screen.queryByText(/not installed/i), 'it is loaded and running, not absent').toBeNull();

    // The action could never succeed for this pack — it was never published.
    const install = screen.getByRole('button', { name: /bundled with this host/i });
    expect((install as HTMLButtonElement).disabled, 'an action that cannot succeed is not offered').toBe(true);
  });

  it('a registry pack that is genuinely absent still says so, and CAN be installed', () => {
    // The negative control, and the half a one-origin fixture would miss: the
    // fix must not erase the real "not installed" state or disable a working
    // Install everywhere.
    show({ ...base, packName: 'vendor.example.pack', origin: 'registry' });

    expect(screen.getByText(/not installed/i), 'a registry pack with no marker IS absent').toBeTruthy();
    expect(screen.queryByText(/^Bundled$/)).toBeNull();

    const install = screen.getByRole('button', { name: /^install$/i });
    expect((install as HTMLButtonElement).disabled, 'this one can actually be installed').toBe(false);
  });

  it('an INSTALLED registry pack is unchanged by any of this', () => {
    show({ ...base, packName: 'vendor.example.pack', origin: 'registry', installed: true });
    expect(screen.getAllByText(/installed/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/not installed/i)).toBeNull();
    expect(screen.queryByText(/^Bundled$/)).toBeNull();
  });
});
