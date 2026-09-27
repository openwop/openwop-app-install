/**
 * Media byte-storage adapter (ADR 0007). The ONE file a production deployer
 * swaps for S3 / GCS — `mediaService` and the routes are storage-agnostic and
 * only ever see an opaque `storageRef` + a `serveToken` (the capability used to
 * render bytes).
 *
 * The in-memory reference impl delegates to the RFC 0055 media-asset surface
 * (`storeMediaAsset` / `deleteMediaAsset`), which already gives tenant-scoped
 * byte storage + capability-token serving via `GET /v1/host/openwop-app/assets/
 * {token}` (the same path avatars use, so a library thumbnail renders in a plain
 * `<img>`). The library is durable, so bytes are stored with a long retention
 * horizon rather than the 7-day scratch TTL.
 */

import { storeMediaAsset, deleteMediaAsset, resolveMediaAsset, listMediaAssetTokens, extendMediaAssetExpiry, capMediaAssetExpiry } from '../../host/inMemorySurfaces.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';

/** ~100 years — the OUTER BACKSTOP, not the lifecycle. ADR 0579 owns the real
 *  lifecycle: bytes live while an asset row references them; the orphan sweep
 *  (a `media` retention purger, 7-day grace) reclaims refs no row references.
 *  This TTL only catches refs that escape both halves. */
const DURABLE_TTL_SECONDS = 100 * 365 * 24 * 60 * 60;

export interface StoredBytes {
  /** Opaque handle the metadata record persists; pass back to `remove`. */
  storageRef: string;
  /** RFC 0055 capability token — the `<img>`-renderable serve handle. */
  serveToken: string;
  sizeBytes: number;
}

/** Persist bytes for a tenant; returns the refs the asset metadata stores. */
export async function put(
  tenantId: string,
  input: { contentBase64: string; contentType: string },
): Promise<StoredBytes> {
  const stored = await storeMediaAsset(tenantId, {
    contentBase64: input.contentBase64,
    contentType: input.contentType,
    ttlSeconds: DURABLE_TTL_SECONDS,
  });
  // In this impl the storage ref IS the capability token; a real backend would
  // return a bucket key for `storageRef` and mint a separate signed serve URL.
  return { storageRef: stored.token, serveToken: stored.token, sizeBytes: stored.bytes };
}

/** ADR 0579 — tenant-scoped ref enumeration for the orphan sweep. */
export async function listRefs(tenantId: string): Promise<Array<{ storageRef: string; bytes: number; storedAtMs: number | null }>> {
  return (await listMediaAssetTokens(tenantId)).map((e) => ({ storageRef: e.token, bytes: e.bytes, storedAtMs: e.storedAtMs }));
}

/**
 * PROF-1 — promote a scratch-lane token (the 7-day `/media/upload` TTL) onto the
 * durable lane IN PLACE: same token, expiry extended to the ~100-year backstop.
 * The token stays stable so token-keyed idempotency (a re-POST of the same
 * token) and remove-by-token routes keep working. Tenant-checked; returns false
 * for an unknown/expired/foreign token (fail-closed — the caller 404s honestly
 * instead of persisting a reference to bytes that are already gone).
 *
 * A feature that persists a promoted token long-term MUST also register the
 * reference via `registerExternalByteRefProvider` below, or the ADR 0579 orphan
 * sweep (which only knows `media:asset` library rows) would reclaim the bytes
 * as unreferenced once the operator arms an `internal` retention window.
 */
export async function promoteToDurable(tenantId: string, token: string): Promise<boolean> {
  return extendMediaAssetExpiry(tenantId, token, Date.now() + DURABLE_TTL_SECONDS * 1000);
}

/** Mirrors `UPLOADED_ASSET_TTL_SECONDS` (routes/mediaAssets.ts) — the scratch
 *  window an un-referenced upload lives for. */
const SCRATCH_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Review F1 — the inverse of `promoteToDurable`: cap the token's expiry back
 *  to the scratch window (documented demote exception to the monotonic rule —
 *  see `capMediaAssetExpiry`). Chosen over hard delete because profile tokens
 *  are NOT provably single-referent: `requireImageToken` accepts any resolvable
 *  tenant-scoped image token, so the same token can be avatar + portfolio item,
 *  another co-tenant profile's image, or a media-library storageRef. A demoted
 *  still-wanted ref has a 7-day window to be re-promoted; a hard delete would
 *  break it instantly. */
export async function demoteToScratch(tenantId: string, token: string): Promise<boolean> {
  return capMediaAssetExpiry(tenantId, token, Date.now() + SCRATCH_TTL_SECONDS * 1000);
}

/** Read-only view of the media-library metadata rows for the referent check
 *  below. Shape-matches the collections in `erasure.ts`/`mediaService.ts`
 *  (same name + idOf + tenantOf, so the self-registration slot is equivalent —
 *  constructing a second instance of an existing collection is established
 *  practice for this namespace). */
const _libraryRowsForRefCheck = new DurableCollection<{ assetId: string; tenantId: string; storageRef: string }>(
  'media:asset', (a) => a.assetId, undefined, (a) => a.tenantId,
);

/** Review F1 — release a byte ref a feature no longer holds: demote it to the
 *  scratch window UNLESS something still references it — a media-library row
 *  (the sweep's own referenced set) or any registered external byte-ref
 *  provider (post-write state: call this AFTER the row update commits, so the
 *  caller's own surviving references count). Returns what happened. */
export async function releaseByteRef(tenantId: string, token: string): Promise<'demoted' | 'still-referenced' | 'absent'> {
  if ((await collectExternalByteRefs(tenantId)).has(token)) return 'still-referenced';
  const library = await _libraryRowsForRefCheck.listForTenantIndexed(tenantId);
  if (library.some((a) => a.storageRef === token)) return 'still-referenced';
  return (await demoteToScratch(tenantId, token)) ? 'demoted' : 'absent';
}

/**
 * PROF-1 — byte refs held by features OUTSIDE the media library (profile
 * avatars/portfolio today; the same seam is open to CAD meshes, document
 * renders, and production vendor portfolios, which share the exposure). The
 * ADR 0579 orphan sweep treats "no `media:asset` row references it" as
 * orphanhood; these providers extend the referenced set so a feature-held
 * durable token is never reclaimed out from under a live reference.
 */
export type ExternalByteRefProvider = (tenantId: string) => Promise<string[]>;
const externalByteRefProviders: ExternalByteRefProvider[] = [];

export function registerExternalByteRefProvider(provider: ExternalByteRefProvider): void {
  externalByteRefProviders.push(provider);
}

/** Union of every registered provider's refs for a tenant. THROWS if any
 *  provider throws — the sweep must fail CLOSED (skip deletion) when it cannot
 *  enumerate the full referenced set, never delete on partial knowledge. */
export async function collectExternalByteRefs(tenantId: string): Promise<Set<string>> {
  const out = new Set<string>();
  for (const provider of externalByteRefProviders) {
    for (const ref of await provider(tenantId)) out.add(ref);
  }
  return out;
}

/** The relative serve URL for a stored asset's capability token. */
export function serveUrl(serveToken: string): string {
  return `/v1/host/openwop-app/assets/${serveToken}`;
}

/**
 * Free an asset's bytes (tenant-checked). Returns whether the byte row was
 * actually removed — `false` when it is absent OR belongs to another tenant.
 *
 * UX_UPGRADE-media R2 (MED2-B1) — this used to return `void` and DISCARD that
 * boolean, under a comment calling it "best-effort", while its caller's own
 * docstring promised "Delete an asset AND free its bytes (no orphaned
 * storage)". The stronger claim was the false one, and the consequence is not a
 * leaked blob: `deleteAsset` then removed the METADATA ROW, which is the only
 * handle the app has to those bytes. So a failed byte-delete produced a 204,
 * an asset that vanished from the library, and bytes that stay fetchable —
 * through a capability token with a ~100-year TTL on a route that is globally
 * auth-exempt — with nothing left in the product able to locate or re-delete
 * them. Deleting the row is precisely "the cleanup removed the thing that was
 * protecting the data".
 */
export async function remove(tenantId: string, storageRef: string): Promise<'removed' | 'absent' | 'forbidden'> {
  // MED2-R3 — three states, not two. The first cut returned the raw boolean, and
  // the caller threw on `false` — which conflates "the bytes are already gone"
  // with "they belong to someone else". That made an asset whose row survived a
  // partial delete PERMANENTLY undeletable: every retry threw, no admin path
  // and no sweeper removes a metadata row, so the asset sat in the library
  // broken and unremovable. Strictly worse than the orphan it prevents, and
  // unrecoverable — which is this programme's bar.
  //
  // `absent` means there is nothing left to leak, so the row MUST be deletable;
  // only `forbidden` (a tenant mismatch — bytes that are someone else's and
  // stay reachable) justifies refusing.
  const entry = await resolveMediaAsset(storageRef);
  if (!entry) return 'absent';
  if (entry.tenantId !== tenantId) return 'forbidden';
  return (await deleteMediaAsset(tenantId, storageRef)) ? 'removed' : 'absent';
}
