/**
 * `demo-media` seeder round-trip (app-seeding-strategy.md §4 Phase 2, ADR 0007).
 *
 * Verifies: the manifest renders to VALID PNG bytes (never SVG — the upload
 * allowlist blocks it), the library seeds idempotently across three collections,
 * a live count that matches, product slugs resolve to serve tokens (the Phase-4
 * bridge), the ADR 0352 marketing facets land on the campaign-relevant subset
 * (SEED-3 — so `assets/select` matches on facets instead of the terminal
 * fallback), retrofit onto a pre-facet library, and a clean seed → clear →
 * seed round-trip.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoMedia, clearDemoMedia, countDemoMedia, mediaServeTokenByKey } from '../src/host/demoMediaSeed.js';
import { listCollections, listAssets, selectAssets, updateAsset } from '../src/features/media/mediaService.js';
import { renderMediaPng } from '../src/host/seed-data/media/solsticeArt.js';
import { SOLSTICE_MEDIA, SOLSTICE_MEDIA_MARKETING, SOLSTICE_MEDIA_INDUSTRY, PRODUCT_PHOTO_KEYS } from '../src/host/seed-data/solsticeDemo.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-demo-media-')) });
});

describe('demo-media seeder', () => {
  it('renders every manifest asset to valid PNG bytes', () => {
    for (const asset of SOLSTICE_MEDIA) {
      const { contentBase64, contentType } = renderMediaPng(asset.spec);
      expect(contentType).toBe('image/png');
      const bytes = Buffer.from(contentBase64, 'base64');
      expect(bytes.subarray(0, 8)).toEqual(PNG_SIG); // real PNG, not SVG
      expect(bytes.length).toBeGreaterThan(50);
    }
  });

  it('seeds a 3-collection library, idempotent; product slugs resolve to tokens; clears clean', async () => {
    const tenantId = 'demo-media-t1';
    // demo-media requires an org (fail-honest guard, review #1348) — seed people first.
    const { seedDemoPeople } = await import('../src/host/demoPeopleSeed.js');
    await seedDemoPeople(tenantId);
    const { listOrgs } = await import('../src/host/accessControlService.js');
    const orgId = (await listOrgs(tenantId))[0]!.orgId;

    const first = await seedDemoMedia(tenantId);
    expect(first.created).toBe(SOLSTICE_MEDIA.length + 3); // assets + 3 collections
    expect(await countDemoMedia(tenantId)).toBe(SOLSTICE_MEDIA.length);
    expect((await listCollections(tenantId, orgId)).map((c) => c.name).sort())
      .toEqual(['Blog', 'Brand', 'Product Photos']);

    // Every product-photo key resolves to a servable token (the Phase-4 bridge).
    for (const key of PRODUCT_PHOTO_KEYS) {
      const token = await mediaServeTokenByKey(tenantId, orgId, key);
      expect(token, key).toBeTruthy();
    }

    // SEED-3: the campaign-relevant subset carries the ADR 0352 marketing facet.
    const FACET_KEYS = Object.keys(SOLSTICE_MEDIA_MARKETING);
    expect(FACET_KEYS.length).toBeGreaterThanOrEqual(8);
    expect(first.details?.marketingFacets).toBe(FACET_KEYS.length);
    const faceted = (await listAssets(tenantId, orgId)).filter((a) => a.uploadedBy === 'demo:media' && a.marketing);
    expect(faceted).toHaveLength(FACET_KEYS.length);
    const subBox = (await listAssets(tenantId, orgId, { tag: 'subscription-box' }))[0]!;
    // The subscription hero matches the showcase brief's productName + industryVertical.
    expect(subBox.marketing).toMatchObject({
      product: 'Solstice Subscription',
      industry: SOLSTICE_MEDIA_INDUSTRY,
      useCase: 'subscription-promo',
    });

    // `assets/select` with campaign-shaped criteria scores a FACET match at
    // level 0 — not the terminal fallback (fallbackLevel 4, matched: []).
    const sel = await selectAssets(tenantId, orgId, {
      product: 'Ethiopia Yirgacheffe',
      industry: SOLSTICE_MEDIA_INDUSTRY,
      useCase: 'product-launch',
    });
    expect(sel.fallbackLevel).toBe(0);
    expect(sel.needsAsset).toBeUndefined();
    expect(sel.assets[0]!.asset.name).toBe('Ethiopia Yirgacheffe.png');
    expect(sel.assets[0]!.matched).toEqual(expect.arrayContaining(['product', 'industry', 'useCase']));

    // Idempotent re-seed (facets already present ⇒ no rewrites either).
    const second = await seedDemoMedia(tenantId);
    expect(second.created).toBe(0);
    expect(second.details?.marketingFacets).toBe(0);
    expect(await countDemoMedia(tenantId)).toBe(SOLSTICE_MEDIA.length);

    // Retrofit: a library row missing its facet (pre-facet seed) gets it
    // stamped back on re-seed, through the real update path.
    await updateAsset(tenantId, orgId, subBox.assetId, { marketing: null });
    const retro = await seedDemoMedia(tenantId);
    expect(retro.created).toBe(0);
    expect(retro.details?.marketingFacets).toBe(1);
    const restored = (await listAssets(tenantId, orgId, { tag: 'subscription-box' }))[0]!;
    expect(restored.marketing?.product).toBe('Solstice Subscription');

    // Clear removes assets + collections; count back to zero.
    const cleared = await clearDemoMedia(tenantId);
    expect(cleared.cleared).toBe(SOLSTICE_MEDIA.length + 3);
    expect(await countDemoMedia(tenantId)).toBe(0);
    expect((await listAssets(tenantId, orgId)).filter((a) => a.uploadedBy === 'demo:media')).toHaveLength(0);

    // Round-trips.
    const third = await seedDemoMedia(tenantId);
    expect(third.created).toBe(SOLSTICE_MEDIA.length + 3);
  });
});
