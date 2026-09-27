/**
 * MPL-6 / MPL-13 / MPL-16 — the tail of the marketplace batch.
 *
 * MPL-6. The free lane's ownership claim was ungated AND irreversible: for
 * `lane:'free'` `upsertPaidListing` sets no `approvalState`, so
 * `syncCommerceListingApproval` queues NO approval row, and there was no
 * seller-side delete (only the superadmin `dissolveListing`, which tombstones
 * with a 90-day cooldown). A `PUT …/listings/<any pack> {lane:'free'}` was
 * therefore an invisible, permanent claim on the name: the real publisher got a
 * 409 forever and no operator ever saw it queued.
 *
 * MPL-13. `agentTools.project()` dropped `pricing`, so the Marketplace
 * Recommender described a $99 pack and a free one in the same words — while `GET
 * /listings` had always annotated it and the SPA client type had always carried it.
 *
 * MPL-16. Two readers of `paidListings` disagreed about the lifecycle:
 * `listingPricingFor` and `createCheckout` both drop a non-`active` row, while
 * `listPaidListings` filtered on APPROVAL alone and returned suspended and
 * tombstoned rows to every viewer.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import {
  __resetCommerceConnect, upsertPaidListing, releaseOwnListing, listPaidListings,
  listOwnListings, setListingApproval, setListingState, dissolveListing,
} from '../src/features/commerce-connect/connectService.js';
import { listPendingCommerceListingApprovals } from '../src/host/approvalService.js';

const SELLER = 'user:tail-seller';
const SQUATTER = 'user:tail-squatter';

let server: http.Server;
beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
  await saveConfig({ id: 'commerce-connect', label: 'Commerce Connect', description: 'test', category: 'Admin', status: 'on', bucketUnit: 'tenant', salt: 'commerce-connect' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(async () => { await __resetCommerceConnect(); });

describe('MPL-6 — a claimed pack name is RELEASABLE by its seller', () => {
  it('the squat scenario, end to end: claim blocks the publisher; release unblocks them', async () => {
    // A squatter takes the name on the ungated free lane.
    await upsertPaidListing(SQUATTER, { packName: 'vendor.contested.nodes', lane: 'free' });
    // The real publisher is refused — and the 409 names the escalation path.
    await expect(upsertPaidListing(SELLER, { packName: 'vendor.contested.nodes', lane: 'free' }))
      .rejects.toMatchObject({ httpStatus: 409 });

    // BEFORE this change that was the end of the story from the seller side.
    await releaseOwnListing(SQUATTER, 'vendor.contested.nodes');

    const now = await upsertPaidListing(SELLER, { packName: 'vendor.contested.nodes', lane: 'free' });
    expect(now.sellerTenantId).toBe(SELLER);
  });

  it('a release WITHDRAWS the pending approval — no orphan card in the operator queue', async () => {
    await upsertPaidListing(SELLER, { packName: 'vendor.withdrawn.nodes', lane: 'native-paid', priceMajorUnits: 10, currency: 'usd' });
    expect((await listPendingCommerceListingApprovals()).some((a) => a.commerceListing?.packName === 'vendor.withdrawn.nodes')).toBe(true);

    await releaseOwnListing(SELLER, 'vendor.withdrawn.nodes');

    expect(
      (await listPendingCommerceListingApprovals()).some((a) => a.commerceListing?.packName === 'vendor.withdrawn.nodes'),
      'an operator must not be asked to decide a listing that no longer exists',
    ).toBe(false);
    expect(await listOwnListings(SELLER)).toHaveLength(0);
  });

  it('you cannot release ANOTHER seller\'s listing, and the refusal does not leak that it exists', async () => {
    await upsertPaidListing(SQUATTER, { packName: 'vendor.theirs.nodes', lane: 'free' });
    // 404, not 403: a 403 would confirm the name is taken and by implication tell
    // a prober which pack names other workspaces hold.
    await expect(releaseOwnListing(SELLER, 'vendor.theirs.nodes')).rejects.toMatchObject({ httpStatus: 404 });
    await expect(releaseOwnListing(SELLER, 'vendor.never-existed.nodes')).rejects.toMatchObject({ httpStatus: 404 });
    expect(await listOwnListings(SQUATTER)).toHaveLength(1);
  });

  it('an OPERATOR-DISSOLVED listing is not the seller\'s to release (it would clear the cooldown)', async () => {
    await upsertPaidListing(SELLER, { packName: 'vendor.dissolved.nodes', lane: 'free' });
    await dissolveListing('vendor.dissolved.nodes', 'superadmin', 'Payout URL was a phishing domain');
    await expect(releaseOwnListing(SELLER, 'vendor.dissolved.nodes')).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('a voluntary release imposes NO cooldown on the seller who released it', async () => {
    // The cooldown is an ENFORCEMENT consequence, not a consequence of changing
    // your mind. If release tombstoned, a seller would lock themselves out of
    // their own pack name for 90 days by unlisting it.
    await upsertPaidListing(SELLER, { packName: 'vendor.rethink.nodes', lane: 'free' });
    await releaseOwnListing(SELLER, 'vendor.rethink.nodes');
    const back = await upsertPaidListing(SELLER, { packName: 'vendor.rethink.nodes', lane: 'free' });
    expect(back.sellerTenantId).toBe(SELLER);
  });
});

describe('MPL-16 — the browse read honours the lifecycle, like its two sibling readers', () => {
  it('a SUSPENDED listing leaves browse but stays visible to its own seller', async () => {
    await upsertPaidListing(SELLER, { packName: 'vendor.held.nodes', lane: 'native-paid', priceMajorUnits: 10, currency: 'usd' });
    await setListingApproval('vendor.held.nodes', 'approved');
    expect((await listPaidListings('user:viewer')).map((l) => l.packName)).toContain('vendor.held.nodes');

    await setListingState('vendor.held.nodes', 'suspended', 'superadmin', 'Dispute under review');

    expect(
      (await listPaidListings('user:viewer')).map((l) => l.packName),
      'a held listing must not read as purchasable to a viewer',
    ).not.toContain('vendor.held.nodes');
    // ADR 0574 P3: "visible to the seller, never purchasable, not a 404".
    expect((await listOwnListings(SELLER)).map((l) => l.packName)).toContain('vendor.held.nodes');
  });

  it('a TOMBSTONED listing leaves browse too', async () => {
    await upsertPaidListing(SELLER, { packName: 'vendor.gone.nodes', lane: 'free' });
    await dissolveListing('vendor.gone.nodes', 'superadmin', 'r');
    expect((await listPaidListings('user:viewer')).map((l) => l.packName)).not.toContain('vendor.gone.nodes');
  });

  it('an ACTIVE listing is still returned (the filter is not simply closed)', async () => {
    await upsertPaidListing(SELLER, { packName: 'vendor.live.nodes', lane: 'free' });
    expect((await listPaidListings('user:viewer')).map((l) => l.packName)).toContain('vendor.live.nodes');
  });
});
