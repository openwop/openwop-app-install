/**
 * `ctx.features.cad` (ADR 0388 P1 — the ADR 0014 face for the new mesh
 * interchange nodes). Two ops:
 *
 * - `meshImport` — canonical binary-STL bytes → a content-addressed,
 *   tenant-scoped mesh asset + a ready-to-emit `canvas.cad` payload holding
 *   one `mesh` solid. Content addressing makes it replay/fork-safe: a re-run
 *   with the same bytes converges on the SAME meshId (matrix row 9) — no
 *   deterministic-id plumbing needed.
 * - `meshExport` — a `canvas.cad` model → STL/GLB bytes as a short-TTL Media
 *   capability URL (deterministic bytes per model).
 *
 * Tenant comes from the run scope, never node args (CTI-1). Failures are
 * typed (`OpenwopError`/`MeshCodecError` → the node surfaces them) — never
 * success-with-empty.
 */
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { surfaceStr as str, surfaceOptStr as optStr, type FeatureSurface } from '../../host/featureSurfaces.js';
import { createMeshAsset, projectMeshAsset } from './meshAssets.js';
import { exportCad, isCadExportFormat } from './cadExport.js';
import { generateBom, bomCsv, CAD_BOM_TYPE_ID } from './bom.js';
import { suggestDimensions, type CadDimension } from './cadDims.js';
import { solveSketch, SketchError, type Sketch } from './cadSketch.js';
import { recommendMaterial, CAD_MATERIALS } from './cadMaterials.js';
import { OpenwopError } from '../../types.js';

export function buildCadSurface(scope: BundleScope): FeatureSurface {
  const tenantId = scope.tenantId;
  const actor = `run:${scope.runId ?? 'unknown'}`;
  return {
    meshImport: async (args) => {
      const contentBase64 = str(args.contentBase64);
      const name = optStr(args.name) ?? 'Imported mesh';
      const sourceFormat = args.sourceFormat === 'obj' || args.sourceFormat === 'gltf' ? args.sourceFormat : 'stl';
      const dropped = Array.isArray(args.dropped) ? args.dropped.map((d) => String(d)).slice(0, 8) : [];
      const { asset, deduped } = await createMeshAsset({
        tenantId,
        contentBase64,
        sourceFormat,
        dropped,
        name,
        createdBy: actor,
      });
      return {
        mesh: projectMeshAsset(asset),
        deduped,
        // A ready-to-emit artifact payload (the render-node envelope shape).
        payload: {
          name,
          units: 'mm',
          solids: [{ kind: 'mesh', assetRef: asset.meshId, x: 0, y: 0, z: 0, label: name.slice(0, 80) }],
        },
      };
    },
    // ADR 0388 P2 — deterministic BOM over a model payload (zero-AI; the
    // artifact envelope is ready to emit).
    bomGenerate: async (args) => {
      if (args.model === null || typeof args.model !== 'object' || Array.isArray(args.model)) {
        throw new OpenwopError('validation_error', '`model` must be a canvas.cad payload object.', 400, { field: 'model' });
      }
      const bom = await generateBom(tenantId, args.model as Record<string, unknown>);
      return {
        bom,
        csv: bomCsv(bom),
        artifact: { artifactTypeId: CAD_BOM_TYPE_ID, payload: bom, ...(bom.modelName ? { title: `${bom.modelName} — BOM` } : {}) },
      };
    },
    // ADR 0388 P3 — deterministic dimension proposals for un-dimensioned
    // solids (pure; the agent APPLIES them via render — closed-world).
    dimensionSuggest: async (args) => {
      if (args.model === null || typeof args.model !== 'object' || Array.isArray(args.model)) {
        throw new OpenwopError('validation_error', '`model` must be a canvas.cad payload object.', 400, { field: 'model' });
      }
      const model = args.model as Record<string, unknown>;
      const solids = Array.isArray(model.solids) ? model.solids : [];
      const existing = Array.isArray(model.dimensions) ? (model.dimensions as CadDimension[]) : [];
      const docUnits = typeof model.units === 'string' ? model.units : 'mm';
      return { dimensions: suggestDimensions(solids as never, existing, docUnits) };
    },
    // ADR 0388 P4 — the deterministic solver is a CLOSED-WORLD host op:
    // model output reaches durable geometry only through it.
    sketchSolve: async (args) => {
      if (args.sketch === null || typeof args.sketch !== 'object' || Array.isArray(args.sketch)) {
        throw new OpenwopError('validation_error', '`sketch` must be a sketch object.', 400, { field: 'sketch' });
      }
      try {
        const result = solveSketch(args.sketch as unknown as Sketch);
        return { ...result };
      } catch (err) {
        if (err instanceof SketchError) {
          throw new OpenwopError('validation_error', err.message, 422, { code: err.code, ...(err.detail ?? {}) });
        }
        throw err;
      }
    },
    // ADR 0388 P5 — deterministic library-material suggestions (assignment is
    // closed-world by id — never free material JSON).
    materialRecommend: async (args) => {
      if (args.model === null || typeof args.model !== 'object' || Array.isArray(args.model)) {
        throw new OpenwopError('validation_error', '`model` must be a canvas.cad payload object.', 400, { field: 'model' });
      }
      const solids = Array.isArray((args.model as Record<string, unknown>).solids)
        ? ((args.model as Record<string, unknown>).solids as Array<Record<string, unknown>>) : [];
      const suggestions = solids.map((s, i) => ({
        solid: i,
        materialId: typeof s.materialId === 'string' ? s.materialId : recommendMaterial(
          typeof s.label === 'string' ? s.label : undefined,
          typeof s.kind === 'string' ? s.kind : undefined,
        ),
        current: typeof s.materialId === 'string',
      }));
      return { suggestions, library: CAD_MATERIALS.map((m) => ({ ...m })) };
    },
    meshExport: async (args) => {
      const format = args.format;
      if (!isCadExportFormat(format)) {
        throw new OpenwopError('validation_error', '`format` must be `stl` or `gltf`.', 400, { field: 'format' });
      }
      if (args.model === null || typeof args.model !== 'object' || Array.isArray(args.model)) {
        throw new OpenwopError('validation_error', '`model` must be a canvas.cad payload object.', 400, { field: 'model' });
      }
      const result = await exportCad(tenantId, args.model as Record<string, unknown>, format);
      return { ...result };
    },
  };
}
