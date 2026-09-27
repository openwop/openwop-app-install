/**
 * CAD editor routes (host-extension, ADR 0310 Phase C) — a pure call into the
 * shared canvas-editor route factory, type-pinned to `canvas.cad` and gated by
 * the `cad` toggle. No catalog/templates (elements-trait type — the solid
 * adders live in the FE definition); no share.
 *
 * ADR 0388 P1 adds three extra routes beside the factory (the slides import/
 * export precedent): mesh IMPORT (client-normalized canonical STL → a
 * content-addressed host mesh asset + a NEW canvas), interchange EXPORT
 * (STL/GLB via the meshCodec twin → short-TTL Media capability URL), and a
 * mesh-asset META read (serveUrl + stats — bytes ride the existing
 * capability-token route).
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { registerCanvasEditorRoutes } from '../canvasEditorRoutes.js';
import { createCanvasForTenant } from '../../host/canvasSurface.js';
import { validateCadDoc } from './validateCadDoc.js';
import { createMeshAsset, getMeshAsset, projectMeshAsset, MAX_MESH_BYTES } from './meshAssets.js';
import { exportCad, isCadExportFormat, CAD_EXPORT_FORMATS } from './cadExport.js';
import { generateBom, bomCsv } from './bom.js';
import { storeMediaAsset } from '../../host/inMemorySurfaces.js';

const CAD_FEATURE = { toggleId: 'cad', label: 'CAD' };
const log = createLogger('features.cad');

/** Base64 request cap: canonical bytes cap × 4/3 headroom. */
const MAX_IMPORT_BASE64 = Math.ceil((MAX_MESH_BYTES * 4) / 3) + 1024;

export function registerCadEditorRoutes(deps: RouteDeps): void {
  registerCanvasEditorRoutes(deps, {
    basePath: '/v1/host/openwop-app/cad',
    feature: CAD_FEATURE,
    canvasTypeId: 'canvas.cad',
    // ADR 0359 Phase 5 — collab-capable (both toggles enforced at the socket).
    collab: true,
    // ADR 0359 Phase 6 — the doc↔Y shape (drift-pinned against the FE traits
    // in canvas/__tests__/collabTypes.test.ts + collab-authboundary registry test).
    collabShape: { collections: [{ key: 'solids' }, { key: 'dimensions' }] }, // P3: dims join collab
    validate: validateCadDoc,
    // ADR 0314 — blank model: one box (the FE adder's exact defaults).
    blankState: (name) => ({ name, units: 'mm', solids: [{ kind: 'box', x: 0, y: 0, z: 0, width: 40, height: 30, depth: 20 }] }),
    extraRoutes: ({ app }, { org, loadCanvas }) => {
      // ADR 0388 P1 — mesh import. The CLIENT parses STL/OBJ/GLTF and
      // normalizes to canonical binary STL (architect R1/R2 — no server-side
      // mesh compute); the server re-validates the canonical bytes (never
      // trusts client stats), stores them content-addressed, and creates a
      // NEW canvas holding one `mesh` solid.
      app.post(`${org}/canvases/import`, async (req, res, next) => {
        try {
          const { user, tenantId } = await authorizeOrgScope(req, CAD_FEATURE, 'workspace:write');
          const body = (req.body ?? {}) as {
            contentBase64?: unknown; name?: unknown; sourceFormat?: unknown; dropped?: unknown;
          };
          if (typeof body.contentBase64 !== 'string' || body.contentBase64.length === 0) {
            throw new OpenwopError('validation_error', '`contentBase64` (canonical binary STL) is required.', 400, { field: 'contentBase64' });
          }
          if (body.contentBase64.length > MAX_IMPORT_BASE64) {
            throw new OpenwopError('validation_error', `mesh too large (max ${Math.floor(MAX_MESH_BYTES / (1024 * 1024))} MB).`, 413, { field: 'contentBase64' });
          }
          const sourceFormat = body.sourceFormat === 'obj' || body.sourceFormat === 'gltf' ? body.sourceFormat : 'stl';
          const dropped = Array.isArray(body.dropped) ? body.dropped.map((d) => String(d)).slice(0, 8) : [];
          const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : 'Imported mesh';
          const startedAt = Date.now();
          const { asset, deduped } = await createMeshAsset({
            tenantId,
            contentBase64: body.contentBase64,
            sourceFormat,
            dropped,
            name,
            createdBy: user.userId,
          });
          const state = {
            name,
            units: 'mm',
            solids: [{ kind: 'mesh', assetRef: asset.meshId, x: 0, y: 0, z: 0, label: name.slice(0, 80) }],
          };
          const validation = validateCadDoc(state);
          if (validation.errors.length) {
            throw new OpenwopError('validation_error', `imported model failed validation: ${validation.errors[0]!.message}`, 422, { errors: validation.errors });
          }
          const canvas = await createCanvasForTenant(tenantId, {
            canvasTypeId: 'canvas.cad',
            name,
            initialState: state,
          });
          log.info('cad_mesh_imported', {
            tenantId, triangles: asset.triangleCount, bytes: asset.bytes,
            sourceFormat, deduped, ms: Date.now() - startedAt,
          });
          res.status(201).json({ ...canvas, mesh: projectMeshAsset(asset) });
        } catch (err) { next(err); }
      });

      // ADR 0388 P1 — interchange export (STL/GLB). Deterministic bytes per
      // state; delivered as a short-TTL Media capability URL (slides pattern).
      app.post(`${org}/canvases/:canvasId/export`, async (req, res, next) => {
        try {
          const { user, tenantId } = await authorizeOrgScope(req, CAD_FEATURE, 'workspace:read');
          const body = (req.body ?? {}) as { format?: unknown };
          if (!isCadExportFormat(body.format)) {
            throw new OpenwopError('validation_error', `\`format\` must be one of: ${CAD_EXPORT_FORMATS.join(', ')}.`, 400, { field: 'format' });
          }
          const canvas = await loadCanvas(tenantId, req.params.canvasId, user.userId);
          const startedAt = Date.now();
          const result = await exportCad(tenantId, canvas.state as Record<string, unknown>, body.format);
          log.info('cad_exported', { tenantId, format: body.format, bytes: result.sizeBytes, triangles: result.triangleCount, ms: Date.now() - startedAt });
          res.status(201).json(result);
        } catch (err) { next(err); }
      });

      // ADR 0388 P2 — deterministic BOM: { bom (the canvas.cad.bom payload),
      // csvUrl (short-TTL capability) }. Computed, never model-authored.
      app.post(`${org}/canvases/:canvasId/bom`, async (req, res, next) => {
        try {
          const { user, tenantId } = await authorizeOrgScope(req, CAD_FEATURE, 'workspace:read');
          const canvas = await loadCanvas(tenantId, req.params.canvasId, user.userId);
          const bom = await generateBom(tenantId, canvas.state as Record<string, unknown>);
          const csv = bomCsv(bom);
          const stored = await storeMediaAsset(tenantId, {
            contentBase64: Buffer.from(csv, 'utf8').toString('base64'),
            contentType: 'text/csv; charset=utf-8',
          });
          res.status(201).json({ bom, csvUrl: stored.url });
        } catch (err) { next(err); }
      });

      // ADR 0388 P1 — mesh-asset META (the FE viewer resolves assetRef →
      // serveUrl + stats; the BYTES ride the existing /assets/:token
      // capability route). Cross-tenant ids read as absent (404).
      app.get(`${org}/meshes/:meshId`, async (req, res, next) => {
        try {
          const { tenantId } = await authorizeOrgScope(req, CAD_FEATURE, 'workspace:read');
          const asset = await getMeshAsset(tenantId, req.params.meshId);
          if (!asset) throw new OpenwopError('not_found', 'Mesh asset not found.', 404, { meshId: req.params.meshId });
          res.json(projectMeshAsset(asset));
        } catch (err) { next(err); }
      });
    },
  });
}
