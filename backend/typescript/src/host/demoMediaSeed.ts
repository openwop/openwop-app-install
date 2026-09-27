/**
 * `demo-media` seeder (app-seeding-strategy.md §4 Phase 2, ADR 0007 media).
 *
 * A brand-consistent media library — 34 self-authored PNG assets across three
 * collections (Product Photos, Brand, Blog). Commerce (Phase 4) and CMS (Phase 9)
 * reference these by serve token, resolved from the deterministic asset tag via
 * {@link mediaServeTokenByKey}, so it precedes both.
 *
 * Mechanics (app-seeding-strategy.md §2):
 * - Real services only: bytes go through `mediaStorage.put` (base64), metadata
 *   through `mediaService.createAsset` — the same two-step the upload route uses,
 *   so serve tokens work and the library renders.
 * - PNG, never SVG: the upload allowlist blocks `image/svg+xml` as a stored-XSS
 *   guard (`host/allowedUploadMime.ts`); seeding SVG would contradict that. The
 *   imagery is generated as real PNG bytes (see `seed-data/media/`).
 * - Deterministic + idempotent: assets are keyed by name + the `demo:media`
 *   `uploadedBy` marker; collections by name + `createdBy`. `clear()` removes only
 *   marked entities. No external fetches, no toggle gate (media is always-on).
 */
import { createLogger } from '../observability/logger.js';
import { listOrgs } from './accessControlService.js';
import {
  createCollection, listCollections, deleteCollection,
  createAsset, listAssets, deleteAsset, updateAsset, assertOrgCapacity, cleanMarketing,
} from '../features/media/mediaService.js';
import * as mediaStorage from '../features/media/mediaStorage.js';
import { renderMediaPng } from './seed-data/media/solsticeArt.js';
import { SOLSTICE_MEDIA, SOLSTICE_MEDIA_MARKETING, DEMO_MEDIA_ACTOR } from './seed-data/solsticeDemo.js';

const log = createLogger('seed.demoMedia');

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

/** Demo assets present for a tenant (the `demo:media` uploadedBy marker). */
async function demoAssets(tenantId: string, orgId: string): Promise<Awaited<ReturnType<typeof listAssets>>> {
  return (await listAssets(tenantId, orgId)).filter((a) => a.uploadedBy === DEMO_MEDIA_ACTOR);
}

export async function countDemoMedia(tenantId: string): Promise<number> {
  const orgId = await orgIdFor(tenantId);
  return (await demoAssets(tenantId, orgId)).length;
}

export async function seedDemoMedia(tenantId: string): Promise<{ created: number; details?: Record<string, unknown> }> {
  // Fail honest when the tenant has no org yet (review #1348 HIGH): seeding the
  // library under the `?? tenantId` fallback org would strand it once demo-people
  // later mints the real org — count/clear/token-resolution would all resolve the
  // new org and miss every existing asset. `runExampleDataSeed` auto-includes the
  // `demo-people` dependsOn ancestor (#1362), so this only trips on a direct
  // misuse — skip cleanly, matching the toggle-gated skip pattern.
  if ((await listOrgs(tenantId)).length === 0) {
    return { created: 0, details: { skipped: 'no org yet — seed demo-people first' } };
  }
  const orgId = await orgIdFor(tenantId);
  let created = 0;

  // Collections — guarded by name + our marker.
  const existingCols = (await listCollections(tenantId, orgId)).filter((c) => c.createdBy === DEMO_MEDIA_ACTOR);
  const colIdByName = new Map<string, string>(existingCols.map((c) => [c.name, c.collectionId]));
  const wantedCollections = [...new Set(SOLSTICE_MEDIA.map((m) => m.collection))];
  for (const name of wantedCollections) {
    if (colIdByName.has(name)) continue;
    const c = await createCollection(tenantId, orgId, name, DEMO_MEDIA_ACTOR);
    colIdByName.set(name, c.collectionId);
    created += 1;
  }

  // Assets — render PNG bytes, store, then persist metadata. Idempotent by name.
  // SEED-3 (DATA-ASSESSMENT campaign-studio-parity): the campaign-relevant
  // subset carries the ADR 0352 marketing facet from the manifest, so
  // `assets/select` scores real facet matches on demo data instead of always
  // landing on the terminal fallback. Facets flow through the same sanitizer
  // (`cleanMarketing`) as the upload route.
  const existingByName = new Map((await demoAssets(tenantId, orgId)).map((a) => [a.name, a]));
  let facetsStamped = 0;
  for (const asset of SOLSTICE_MEDIA) {
    const manifestMkt = SOLSTICE_MEDIA_MARKETING[asset.key];
    const existing = existingByName.get(asset.name);
    if (existing) {
      // Retrofit (idempotent): a library seeded before facets shipped gets the
      // manifest facet's MISSING keys filled in — existing values (including a
      // showcase-stamped `personaIds`) always win; a no-op write is skipped.
      if (manifestMkt) {
        const merged = { ...manifestMkt, ...(existing.marketing ?? {}) };
        // FU-DATA-6 — idempotency compares the POST-SANITIZER value against the
        // stored one (both sides are `cleanMarketing` output, which builds its
        // fields in a fixed order, so JSON deep-equal is stable). A key-count
        // compare would re-write EVERY run if the sanitizer rejected a merged
        // key (per-run churn masquerading as a retrofit).
        const sanitized = cleanMarketing(merged);
        if (JSON.stringify(sanitized ?? null) !== JSON.stringify(existing.marketing ?? null)) {
          await updateAsset(tenantId, orgId, existing.assetId, { marketing: merged });
          facetsStamped += 1;
        }
      }
      continue;
    }
    const { contentBase64, contentType } = renderMediaPng(asset.spec);
    const bytes = Buffer.byteLength(contentBase64, 'base64');
    await assertOrgCapacity(tenantId, orgId, bytes);
    const stored = await mediaStorage.put(tenantId, { contentBase64, contentType });
    await createAsset({
      tenantId, orgId,
      collectionId: colIdByName.get(asset.collection),
      name: asset.name, contentType,
      sizeBytes: stored.sizeBytes,
      storageRef: stored.storageRef, serveToken: stored.serveToken,
      tags: [DEMO_MEDIA_ACTOR, asset.key],
      uploadedBy: DEMO_MEDIA_ACTOR,
      ...(manifestMkt ? { marketing: manifestMkt } : {}),
    });
    created += 1;
    if (manifestMkt) facetsStamped += 1;
  }

  log.info('demo_media_seeded', { tenantId, created, assets: SOLSTICE_MEDIA.length, collections: colIdByName.size, facetsStamped });
  return { created, details: { assets: SOLSTICE_MEDIA.length, collections: colIdByName.size, marketingFacets: facetsStamped } };
}

export async function clearDemoMedia(tenantId: string): Promise<{ cleared: number; details?: Record<string, unknown> }> {
  const orgId = await orgIdFor(tenantId);
  let cleared = 0;
  // MED2-R3 — one asset that refuses to delete must not abort the sweep.
  // `deleteAsset` can now throw (a tenant-mismatched byte row), and this loop
  // had no guard: a single throw would skip every remaining asset AND the whole
  // collection loop below, turning a clean-up into a PARTIAL cascade reported
  // to the operator as a 500. Count what failed instead of losing the rest.
  const failed: string[] = [];
  for (const a of await demoAssets(tenantId, orgId)) {
    try {
      if (await deleteAsset(tenantId, orgId, a.assetId)) cleared += 1;
    } catch (err) {
      failed.push(a.assetId);
      log.warn('demo_media_clear_asset_failed', { tenantId, assetId: a.assetId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const c of (await listCollections(tenantId, orgId)).filter((x) => x.createdBy === DEMO_MEDIA_ACTOR)) {
    if (await deleteCollection(tenantId, orgId, c.collectionId)) cleared += 1;
  }
  log.info('demo_media_cleared', { tenantId, cleared, failed: failed.length });
  // Report the failures rather than letting `cleared` imply a complete sweep.
  return { cleared, ...(failed.length ? { details: { failedAssetIds: failed } } : {}) };
}

/** Resolve a demo asset's serve token by its manifest key (e.g. a product slug).
 *  Phase 4 (commerce) and Phase 9 (CMS) call this to wire image tokens without
 *  importing the media manifest internals. Returns null when absent (feature
 *  degrades to no image rather than failing). */
export async function mediaServeTokenByKey(tenantId: string, orgId: string, key: string): Promise<string | null> {
  const a = (await listAssets(tenantId, orgId, { tag: key })).find((x) => x.uploadedBy === DEMO_MEDIA_ACTOR);
  return a?.serveToken ?? null;
}
