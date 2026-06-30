/**
 * Media library (ADR 0007) — org-scoped collections + searchable asset metadata.
 * Bytes live in the storage adapter (`mediaStorage`); this owns the metadata
 * only, so `list()`/search never load content. Tenant + org scoped throughout
 * (CTI-1) — every read/write verifies the row's tenantId AND orgId, so a foreign
 * collection/asset reads as not-found (IDOR guard).
 *
 * @see docs/adr/0007-media-library.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, cleanTagList } from '../../host/boundedStrings.js';
import * as mediaStorage from './mediaStorage.js';

export interface MediaCollection {
  collectionId: string;
  tenantId: string;
  orgId: string;
  name: string;
  createdBy: string;
  createdAt: string;
}

export interface MediaAsset {
  assetId: string;
  tenantId: string;
  orgId: string;
  collectionId?: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  storageRef: string;
  serveToken: string;
  tags: string[];
  uploadedBy: string;
  usageCount: number;
  lastUsedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A view adds the (derived) serve URL — the metadata never persists a URL. */
export interface MediaAssetView extends MediaAsset {
  serveUrl: string;
}

const collections = new DurableCollection<MediaCollection>('media:collection', (c) => c.collectionId);
const assets = new DurableCollection<MediaAsset>('media:asset', (a) => a.assetId);

const MAX = { name: 120, tag: 48, tags: 24, perOrgAssets: 1000, perOrgCollections: 200, perOrgBytes: 256 * 1024 * 1024 } as const;

/** Sentinel `?collectionId=` value selecting UNCATEGORIZED assets (those with no
 *  collection) — so the filter happens server-side, not over the wire. */
export const UNCATEGORIZED = 'none';

/**
 * Capacity gate (ADR 0007 code-review #2): reject a new asset that would push the
 * org past its count OR total-bytes limit. Called BEFORE bytes are stored, so an
 * over-cap upload never orphans bytes. 409 (the same status the count cap used).
 */
export async function assertOrgCapacity(tenantId: string, orgId: string, addBytes: number): Promise<void> {
  const orgAssets = (await assets.list()).filter((a) => a.tenantId === tenantId && a.orgId === orgId);
  if (orgAssets.length >= MAX.perOrgAssets) {
    throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrgAssets} assets.`, 409, { max: MAX.perOrgAssets });
  }
  const totalBytes = orgAssets.reduce((sum, a) => sum + a.sizeBytes, 0);
  if (totalBytes + addBytes > MAX.perOrgBytes) {
    throw new OpenwopError('validation_error', `This org has reached its media storage limit (${Math.round(MAX.perOrgBytes / (1024 * 1024))} MiB).`, 409, { maxBytes: MAX.perOrgBytes });
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

const cleanName = (raw: string, fallback: string): string => cleanString(raw, MAX.name, fallback);
const cleanTags = (raw: unknown): string[] => cleanTagList(raw, { maxTags: MAX.tags, maxLen: MAX.tag });

export function viewAsset(a: MediaAsset): MediaAssetView {
  return { ...a, serveUrl: mediaStorage.serveUrl(a.serveToken) };
}

// ── Collections ─────────────────────────────────────────────────────────────

export async function createCollection(tenantId: string, orgId: string, name: string, createdBy: string): Promise<MediaCollection> {
  const existing = (await collections.list()).filter((c) => c.tenantId === tenantId && c.orgId === orgId);
  if (existing.length >= MAX.perOrgCollections) {
    throw new OpenwopError('validation_error', `This org has the maximum ${MAX.perOrgCollections} collections.`, 409, { max: MAX.perOrgCollections });
  }
  const c: MediaCollection = {
    collectionId: `mcol:${randomUUID()}`,
    tenantId,
    orgId,
    name: cleanName(name, 'Untitled collection'),
    createdBy,
    createdAt: nowIso(),
  };
  await collections.put(c);
  return c;
}

export async function listCollections(tenantId: string, orgId: string): Promise<MediaCollection[]> {
  return (await collections.list()).filter((c) => c.tenantId === tenantId && c.orgId === orgId);
}

export async function getCollection(tenantId: string, orgId: string, collectionId: string): Promise<MediaCollection | null> {
  const c = await collections.get(collectionId);
  return c && c.tenantId === tenantId && c.orgId === orgId ? c : null;
}

/** Delete a collection, RE-HOMING its assets to uncategorized (never orphan the
 *  bytes). Returns the counts touched. */
export async function deleteCollection(tenantId: string, orgId: string, collectionId: string): Promise<{ rehomed: number } | null> {
  const c = await getCollection(tenantId, orgId, collectionId);
  if (!c) return null;
  const orphans = (await assets.list()).filter((a) => a.tenantId === tenantId && a.orgId === orgId && a.collectionId === collectionId);
  await Promise.all(
    orphans.map((a) => {
      const next: MediaAsset = { ...a, updatedAt: nowIso() };
      delete next.collectionId;
      return assets.put(next);
    }),
  );
  await collections.delete(collectionId);
  return { rehomed: orphans.length };
}

// ── Assets ──────────────────────────────────────────────────────────────────

export async function createAsset(input: {
  tenantId: string;
  orgId: string;
  collectionId?: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  storageRef: string;
  serveToken: string;
  tags?: unknown;
  uploadedBy: string;
}): Promise<MediaAsset> {
  // Capacity (count + bytes) is asserted in the route BEFORE bytes are stored —
  // see assertOrgCapacity — so no over-cap upload reaches here with orphaned bytes.
  // A supplied collectionId MUST belong to this org (else uncategorized).
  let collectionId: string | undefined;
  if (input.collectionId) {
    const c = await getCollection(input.tenantId, input.orgId, input.collectionId);
    if (!c) throw new OpenwopError('not_found', 'Collection not found in this org.', 404, { collectionId: input.collectionId });
    collectionId = c.collectionId;
  }
  const ts = nowIso();
  const a: MediaAsset = {
    assetId: `masset:${randomUUID()}`,
    tenantId: input.tenantId,
    orgId: input.orgId,
    ...(collectionId ? { collectionId } : {}),
    name: cleanName(input.name, 'untitled'),
    contentType: input.contentType,
    sizeBytes: input.sizeBytes,
    storageRef: input.storageRef,
    serveToken: input.serveToken,
    tags: cleanTags(input.tags),
    uploadedBy: input.uploadedBy,
    usageCount: 0,
    createdAt: ts,
    updatedAt: ts,
  };
  await assets.put(a);
  return a;
}

/** All assets in a tenant, ACROSS orgs — for the cross-source artifact Library (ADR 0083).
 *  Access is enforced PER-ORG by the caller (artifactProjection.listArtifacts).
 *  NOTE: the `media:asset` collection name is ALSO used by the host byte-store
 *  (`inMemorySurfaces._mediaAssets`, token-keyed raw bytes) — a pre-existing namespace
 *  overlap. `listAssets(tenant,org)` is shielded by its org filter; this tenant-wide scan is
 *  not, so we filter to real library assets (those carrying an `assetId` + `orgId`); the
 *  byte-store rows have neither. */
export async function listAssetsForTenant(tenantId: string): Promise<MediaAsset[]> {
  return (await assets.list()).filter((a) => a.tenantId === tenantId && typeof a.assetId === 'string' && typeof a.orgId === 'string');
}

export async function listAssets(
  tenantId: string,
  orgId: string,
  filter: { collectionId?: string; q?: string; tag?: string } = {},
): Promise<MediaAsset[]> {
  const q = filter.q?.trim().toLowerCase();
  const tag = filter.tag?.trim().toLowerCase();
  const collectionMatch = (a: MediaAsset): boolean => {
    if (filter.collectionId === undefined) return true;
    if (filter.collectionId === UNCATEGORIZED) return a.collectionId === undefined; // server-side uncategorized
    return a.collectionId === filter.collectionId;
  };
  return (await assets.list()).filter(
    (a) =>
      a.tenantId === tenantId &&
      a.orgId === orgId &&
      collectionMatch(a) &&
      (!q || a.name.toLowerCase().includes(q)) &&
      (!tag || a.tags.includes(tag)),
  );
}

export async function getAsset(tenantId: string, orgId: string, assetId: string): Promise<MediaAsset | null> {
  const a = await assets.get(assetId);
  return a && a.tenantId === tenantId && a.orgId === orgId ? a : null;
}

/** Tenant-scoped point lookup (ADR 0069) — resolves an asset by id without the
 *  caller knowing its org; the artifact workbench derives org FROM the record
 *  then authorizes against it. Tenant-isolated; never returns a foreign tenant's
 *  asset. */
export async function getAssetByIdForTenant(tenantId: string, assetId: string): Promise<MediaAsset | null> {
  const a = await assets.get(assetId);
  return a && a.tenantId === tenantId ? a : null;
}

export async function updateAsset(
  tenantId: string,
  orgId: string,
  assetId: string,
  patch: { name?: string; tags?: unknown; collectionId?: string | null },
): Promise<MediaAsset | null> {
  const a = await getAsset(tenantId, orgId, assetId);
  if (!a) return null;
  const next: MediaAsset = { ...a, updatedAt: nowIso() };
  if (patch.name !== undefined) next.name = cleanName(patch.name, a.name);
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.collectionId !== undefined) {
    if (patch.collectionId === null) {
      delete next.collectionId;
    } else {
      const c = await getCollection(tenantId, orgId, patch.collectionId);
      if (!c) throw new OpenwopError('not_found', 'Collection not found in this org.', 404, { collectionId: patch.collectionId });
      next.collectionId = c.collectionId;
    }
  }
  await assets.put(next);
  return next;
}

/** Delete an asset AND free its bytes (no orphaned storage). */
export async function deleteAsset(tenantId: string, orgId: string, assetId: string): Promise<boolean> {
  const a = await getAsset(tenantId, orgId, assetId);
  if (!a) return false;
  await mediaStorage.remove(tenantId, a.storageRef);
  await assets.delete(assetId);
  return true;
}

/** Usage tracking (Phase 2): a consumer marks an asset used. */
export async function markUsed(tenantId: string, orgId: string, assetId: string): Promise<MediaAsset | null> {
  const a = await getAsset(tenantId, orgId, assetId);
  if (!a) return null;
  const next: MediaAsset = { ...a, usageCount: a.usageCount + 1, lastUsedAt: nowIso() };
  await assets.put(next);
  return next;
}

// ── Test-only reset ─────────────────────────────────────────────────────────
export async function __resetMedia(): Promise<void> {
  await collections.__clear();
  await assets.__clear();
}
