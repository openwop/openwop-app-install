/**
 * CAD mesh assets (ADR 0388 P1, architect ruling R1) — durable, tenant-scoped,
 * CONTENT-ADDRESSED storage for imported meshes.
 *
 * Bytes ride `features/media/mediaStorage` — the ONE storage adapter a
 * deployer swaps for S3/GCS (durable TTL, tenant-scoped, capability-token
 * served via the existing `/v1/host/openwop-app/assets/:token` route). CAD
 * deliberately does NOT use the media LIBRARY (mesh blobs are canvas-internal
 * geometry, not user-catalog media); it owns only this thin metadata layer.
 *
 * Content addressing (matrix row 9): meshId = `${tenantId}:${sha256(canonical
 * bytes)}` — same bytes ⇒ same meshId, structurally (a re-import is a `get`
 * hit, never a duplicate row or double byte-store).
 *
 * The server NEVER trusts client-claimed geometry stats: the canonical bytes
 * are re-parsed here (the backend meshCodec twin) and triangleCount/bbox are
 * derived server-side.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import * as mediaStorage from '../media/mediaStorage.js';
import { parseStl, MeshCodecError, type ParsedMesh } from './meshCodec.js';

/** Honest ceiling (architect R5): decoded canonical bytes per mesh asset.
 *  Derived from MAX_MESH_TRIANGLES (50k tris x 50 B/tri = 2.5 MB canonical) and
 *  sized to bind INSIDE the cad route family's 8 MB JSON parser envelope
 *  (index.ts — 4 MB decoded = ~5.4 MB base64 + wrapper < 8 MB), so the typed
 *  413 is ours, never a raw body-parser error. */
export const MAX_MESH_BYTES = 4 * 1024 * 1024;
/** Per-tenant distinct-mesh count cap (grade-pass CAD-G1 — quota half). */
export const MAX_MESHES_PER_TENANT = 100;

export interface CadMeshAsset {
  /** `${tenantId}:${sha256hex}` — the content address. */
  meshId: string;
  tenantId: string;
  sha256: string;
  /** Storage-adapter handle for the canonical binary-STL bytes. */
  storageRef: string;
  /** Capability token for `/v1/host/openwop-app/assets/:token`. */
  serveToken: string;
  bytes: number;
  triangleCount: number;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  sourceFormat: 'stl' | 'obj' | 'gltf';
  /** Source features NOT representable in P1 (disclosed import — architect R3). */
  dropped: string[];
  name: string;
  createdBy: string;
  createdAt: string;
}

const meshes = new DurableCollection<CadMeshAsset>('cad:mesh', (m) => m.meshId, undefined, (m) => m.tenantId);

/** Map a codec failure to the canonical envelope (typed, never a lookalike). */
export function codecErrorToHttp(err: unknown): never {
  if (err instanceof MeshCodecError) {
    const status = err.code === 'too_many_triangles' ? 413 : 422;
    throw new OpenwopError('validation_error', err.message, status, { code: err.code });
  }
  throw err;
}

/**
 * Store canonical mesh bytes (client-normalized binary STL) as a durable,
 * content-addressed asset. Re-validates server-side; dedupes on content hash.
 */
export async function createMeshAsset(input: {
  tenantId: string;
  contentBase64: string;
  sourceFormat: 'stl' | 'obj' | 'gltf';
  dropped: string[];
  name: string;
  createdBy: string;
}): Promise<{ asset: CadMeshAsset; mesh: ParsedMesh; deduped: boolean }> {
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (bytes.byteLength > MAX_MESH_BYTES) {
    throw new OpenwopError('validation_error', `Mesh exceeds the ${Math.floor(MAX_MESH_BYTES / (1024 * 1024))} MB cap.`, 413, {
      bytes: bytes.byteLength,
      cap: MAX_MESH_BYTES,
    });
  }
  // Server-side truth: parse the canonical STL (typed failure on malformed).
  let mesh: ParsedMesh;
  try {
    mesh = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch (err) {
    codecErrorToHttp(err);
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const meshId = `${input.tenantId}:${sha256}`;
  const existing = await meshes.get(meshId);
  if (existing && existing.tenantId === input.tenantId) {
    return { asset: existing, mesh, deduped: true };
  }
  // GRADE-PASS CAD-G1 (quota half): mesh blobs are durable (100y TTL) with no
  // delete path yet — cap the per-tenant COUNT so one tenant can't grow
  // host_ext_kv without bound (each row ≤4 MB; 100 × 4 MB = a bounded 400 MB
  // worst case per tenant, swept only by tenant teardown). Dedupe above means
  // the cap counts DISTINCT meshes. GC (refcount/sweep) stays the recorded
  // follow-up in docs/steward/DATA-ASSESSMENT-adr0388-0389-batch.md.
  const tenantMeshes = await meshes.listByPrefix(`${input.tenantId}:`);
  if (tenantMeshes.length >= MAX_MESHES_PER_TENANT) {
    throw new OpenwopError('validation_error', `This workspace already stores ${tenantMeshes.length} meshes — the cap is ${MAX_MESHES_PER_TENANT}.`, 413, {
      cap: MAX_MESHES_PER_TENANT,
    });
  }
  const stored = await mediaStorage.put(input.tenantId, {
    contentBase64: input.contentBase64,
    contentType: 'model/stl',
  });
  const asset: CadMeshAsset = {
    meshId,
    tenantId: input.tenantId,
    sha256,
    storageRef: stored.storageRef,
    serveToken: stored.serveToken,
    bytes: stored.sizeBytes,
    triangleCount: mesh.triangleCount,
    bbox: mesh.bbox,
    sourceFormat: input.sourceFormat,
    dropped: [...new Set(input.dropped)].sort(),
    name: input.name.trim().slice(0, 120) || 'Imported mesh',
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  // CAS-from-null: a concurrent identical import converges on one row (the
  // loser's stored bytes are freed — content address makes this safe).
  const won = await meshes.compareAndSwap(null, asset);
  if (!won) {
    await mediaStorage.remove(input.tenantId, stored.storageRef);
    const raced = await meshes.get(meshId);
    if (raced && raced.tenantId === input.tenantId) return { asset: raced, mesh, deduped: true };
  }
  return { asset, mesh, deduped: false };
}

/** Tenant-guarded point read (a cross-tenant meshId reads as absent). */
export async function getMeshAsset(tenantId: string, meshId: string): Promise<CadMeshAsset | null> {
  const rec = await meshes.get(meshId);
  return rec && rec.tenantId === tenantId ? rec : null;
}

/** The public projection a route/surface returns (serveUrl derived; storage
 *  internals stay internal). */
export function projectMeshAsset(a: CadMeshAsset): Record<string, unknown> {
  return {
    meshId: a.meshId,
    serveUrl: mediaStorage.serveUrl(a.serveToken),
    bytes: a.bytes,
    triangleCount: a.triangleCount,
    bbox: a.bbox,
    sourceFormat: a.sourceFormat,
    dropped: a.dropped,
    name: a.name,
    createdAt: a.createdAt,
  };
}
