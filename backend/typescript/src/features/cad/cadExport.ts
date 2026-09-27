/**
 * CAD interchange export (ADR 0388 P1) — deterministic model → STL / GLB via
 * the ONE meshCodec twin. Parametric solids tessellate with fixed segment
 * counts; referenced meshes resolve host-side (opaque token → canonical bytes,
 * zero network — the ADR 0328 SSRF posture) and are posed by pure math.
 * Delivery mirrors slides export: bytes land as a short-TTL Media asset and
 * the capability URL is returned.
 */
import { OpenwopError } from '../../types.js';
import { resolveMaterial } from './cadMaterials.js';
import { storeMediaAsset, resolveMediaAsset } from '../../host/inMemorySurfaces.js';
import {
  emitCanonicalStl,
  emitGlb,
  parseStl,
  poseMesh,
  tessellateSolid,
  type TessellatableSolid,
} from './meshCodec.js';
import { getMeshAsset, codecErrorToHttp } from './meshAssets.js';

export const CAD_EXPORT_FORMATS = ['stl', 'gltf'] as const;
export type CadExportFormat = (typeof CAD_EXPORT_FORMATS)[number];

export function isCadExportFormat(v: unknown): v is CadExportFormat {
  return typeof v === 'string' && (CAD_EXPORT_FORMATS as readonly string[]).includes(v);
}

interface ExportPart {
  label: string;
  positions: Float32Array;
  color?: string;
  metallic?: number;
  roughness?: number;
}

/** Resolve every solid in doc order to true triangles (deterministic). A mesh
 *  solid whose asset is missing is a typed error — never silently skipped. */
/** Aggregate export ceiling (grade-pass CAD-C2): the per-ASSET cap is 50k
 *  triangles, but a doc may reference the same asset from many solids — the
 *  merged export must not amplify one import into hundreds of MB. 500k tris
 *  ≈ 25 MB STL, comfortably inside one response. Typed 413, checked BEFORE
 *  each allocation grows the merge. */
export const MAX_EXPORT_TRIANGLES = 500_000;

export async function collectExportParts(tenantId: string, state: Record<string, unknown>): Promise<ExportPart[]> {
  const solids = Array.isArray(state.solids) ? (state.solids as TessellatableSolid[]) : [];
  if (solids.length === 0) {
    throw new OpenwopError('validation_error', 'The model has no solids to export.', 422, {});
  }
  const parts: ExportPart[] = [];
  let totalTriangles = 0;
  for (let i = 0; i < solids.length; i += 1) {
    const s = solids[i];
    if (!s || typeof s !== 'object') continue;
    const label = (typeof s.label === 'string' && s.label.trim() ? s.label.trim() : `${s.kind}-${i + 1}`).slice(0, 80);
    let positions: Float32Array;
    if (s.kind === 'mesh') {
      const asset = typeof s.assetRef === 'string' ? await getMeshAsset(tenantId, s.assetRef) : null;
      if (!asset) {
        throw new OpenwopError('validation_error', `Mesh solid ${i + 1} references a missing asset.`, 422, {
          solid: i,
          assetRef: s.assetRef ?? null,
        });
      }
      const entry = await resolveMediaAsset(asset.serveToken);
      if (!entry || entry.tenantId !== tenantId) {
        throw new OpenwopError('validation_error', `Mesh solid ${i + 1}'s stored bytes are unavailable.`, 422, { solid: i });
      }
      const bytes = Buffer.from(entry.contentBase64, 'base64');
      let parsed;
      try {
        parsed = parseStl(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      } catch (err) {
        codecErrorToHttp(err); // typed 422, never a raw 500 (stored bytes are import-validated, but fail closed)
      }
      positions = poseMesh(parsed, s);
    } else {
      positions = tessellateSolid(s);
    }
    if (positions.length === 0) continue;
    totalTriangles += positions.length / 9;
    if (totalTriangles > MAX_EXPORT_TRIANGLES) {
      throw new OpenwopError('validation_error', `Export exceeds the ${MAX_EXPORT_TRIANGLES}-triangle aggregate cap.`, 413, {
        cap: MAX_EXPORT_TRIANGLES,
      });
    }
    // Grade-pass (CAD-C8): a doc styled via `materialId` must export with the
    // SAME paint the viewer resolves — library material wins over inline.
    const mat = resolveMaterial(s);
    parts.push({
      label,
      positions,
      ...(typeof mat.color === 'string' && mat.color ? { color: mat.color } : {}),
      ...(typeof mat.metallic === 'number' ? { metallic: mat.metallic } : {}),
      ...(typeof mat.roughness === 'number' ? { roughness: mat.roughness } : {}),
    });
  }
  if (parts.length === 0) {
    throw new OpenwopError('validation_error', 'No exportable geometry in the model.', 422, {});
  }
  return parts;
}

export interface CadExportResult {
  format: CadExportFormat;
  url: string;
  sizeBytes: number;
  filename: string;
  triangleCount: number;
}

/** Export a `canvas.cad` state as STL or GLB; bytes delivered as a short-TTL
 *  Media capability URL (the slides pattern). Deterministic bytes per state. */
export async function exportCad(
  tenantId: string,
  state: Record<string, unknown>,
  format: CadExportFormat,
): Promise<CadExportResult> {
  const parts = await collectExportParts(tenantId, state);
  const name = (typeof state.name === 'string' && state.name.trim() ? state.name.trim() : 'cad-model')
    .replace(/[^\w.-]+/g, '-')
    .slice(0, 60);
  let bytes: Uint8Array;
  let contentType: string;
  let filename: string;
  if (format === 'stl') {
    let total = 0;
    for (const p of parts) total += p.positions.length;
    const merged = new Float32Array(total);
    let off = 0;
    for (const p of parts) { merged.set(p.positions, off); off += p.positions.length; }
    bytes = emitCanonicalStl(merged);
    contentType = 'model/stl';
    filename = `${name}.stl`;
  } else {
    bytes = emitGlb(parts);
    contentType = 'model/gltf-binary';
    filename = `${name}.glb`;
  }
  const triangleCount = parts.reduce((acc, p) => acc + Math.floor(p.positions.length / 9), 0);
  const stored = await storeMediaAsset(tenantId, {
    contentBase64: Buffer.from(bytes).toString('base64'),
    contentType,
  });
  return { format, url: stored.url, sizeBytes: stored.bytes, filename, triangleCount };
}
