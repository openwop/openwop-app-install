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

import { storeMediaAsset, deleteMediaAsset } from '../../host/inMemorySurfaces.js';

/** ~100 years — "durable" for the demo tier. A real backend ignores this and
 *  applies its own lifecycle/quota policy (ADR 0007 open question). */
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

/** The relative serve URL for a stored asset's capability token. */
export function serveUrl(serveToken: string): string {
  return `/v1/host/openwop-app/assets/${serveToken}`;
}

/** Free an asset's bytes (tenant-checked). Best-effort — a missing ref is a no-op. */
export async function remove(tenantId: string, storageRef: string): Promise<void> {
  await deleteMediaAsset(tenantId, storageRef);
}
