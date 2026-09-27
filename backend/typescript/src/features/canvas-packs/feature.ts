/**
 * Canvas packs (ADR 0310 Phase D — Tier-1 FE-less canvas types). An
 * artifact-type pack that carries the `x-openwop-app.canvas` vendor extension
 * gets a full generic editor with ZERO frontend code: the loader registered
 * its catalog + elements-trait editor hints at boot; this feature registers
 * one canvas-editor factory route family per pack type
 * (`/v1/host/openwop-app/canvas-packs/<canvasTypeId>/…`), with the pack's OWN
 * artifact JSON Schema as the save validator (no second validation language).
 * The FE serves them all through one generic route (`/canvas/:typeId/:canvasId`)
 * that synthesizes a definition from the catalog response's `editor` hints.
 *
 * One toggle (`canvas-packs`, OFF, per-tenant) gates every pack editor — the
 * pack surface is a unit, like the ADR 0300 ui-plugins loader. A pack type
 * whose artifact type was reclaimed by a HOST feature (the loader's host-wins
 * rule runs at pack-load time, before features register) is skipped here with
 * a warning — no parallel editor can shadow a first-party one.
 */
import type { BackendFeature } from '../types.js';
import { createLogger } from '../../observability/logger.js';
import { getArtifactType, validateArtifact } from '../../host/artifactTypes.js';
import { registerCanvasComponents } from '../../host/canvasComponentCatalog.js';
import { listPackCanvasTypes, type PackCanvasEditorHints } from '../../host/canvasPackTypes.js';
import { registerCanvasEditorRoutes } from '../canvasEditorRoutes.js';
import { authorizeOrgScope } from '../featureRoute.js';

const log = createLogger('features.canvasPacks');

/** ADR 0314 — a pack type's blank document, derived from its editor hints: the
 *  name field plus each collection seeded to its `min` floor with the FIRST
 *  adder's defaults. The pack's own schema then validates it on the create
 *  route — a schema the derived blank can't satisfy fails closed with 422. */
function blankFromHints(editor: PackCanvasEditorHints): (name: string) => Record<string, unknown> {
  return (name) => {
    const doc: Record<string, unknown> = { [editor.docNameKey ?? 'name']: name };
    for (const col of editor.collections) {
      const floor = Math.max(0, Math.min(col.min ?? 0, col.max));
      const defaults = col.adders[0]?.defaults ?? {};
      doc[col.key] = Array.from({ length: floor }, () => ({ ...defaults }));
    }
    return doc;
  };
}

export const canvasPacksFeature: BackendFeature = {
  id: 'canvas-packs',
  registerRoutes: (deps) => {
    // ADR 0314 — enumerate the editable pack types for the Documents creation
    // gallery: `{ canvasTypeId, title }` rows, same toggle gate as the editors.
    // `orgs` cannot collide with the per-type base paths below — their next
    // segment always matches `canvas.<slug>` (the loader's strict id regex).
    const servedTypes: { canvasTypeId: string; title: string }[] = [];
    deps.app.get('/v1/host/openwop-app/canvas-packs/orgs/:orgId/types', async (req, res, next) => {
      try {
        await authorizeOrgScope(req, { toggleId: 'canvas-packs', label: 'Canvas Packs' }, 'workspace:read');
        res.json({ types: servedTypes });
      } catch (err) { next(err); }
    });

    for (const packType of listPackCanvasTypes()) {
      // ONE host-wins ownership check for BOTH halves of the extension. The
      // loader only STASHES the parsed data — first-party features register
      // their artifact types in this same boot pass (after the loader), so
      // ownership is only decidable here, and this feature runs LAST. A pack
      // claiming a host id (e.g. canvas.app-builder) is skipped whole:
      // applying its catalog at load time would have silently poisoned the
      // first-party closed world (code-review HIGH).
      const at = getArtifactType(packType.canvasTypeId);
      if (!at || at.registrationSource !== 'pack') {
        log.warn('pack canvas type skipped — artifact type is not pack-owned', { canvasTypeId: packType.canvasTypeId, pack: packType.packName });
        continue;
      }
      if (packType.catalog) {
        registerCanvasComponents(packType.canvasTypeId, packType.catalog);
      }
      if (!packType.editor) continue; // catalog-only pack — no editor surface
      const editor = packType.editor;
      servedTypes.push({ canvasTypeId: packType.canvasTypeId, title: at.title });
      registerCanvasEditorRoutes(deps, {
        basePath: `/v1/host/openwop-app/canvas-packs/${packType.canvasTypeId}`,
        feature: { toggleId: 'canvas-packs', label: 'Canvas Packs' },
        canvasTypeId: packType.canvasTypeId,
        editorHints: editor,
        blankState: blankFromHints(editor),
        // The pack's artifact schema IS the editor-doc validator: elements are
        // positional (pure mirror), so the working copy and the artifact share
        // one shape and one schema. A schema ajv can't compile is a pack
        // defect — surface it as a validation error (422), never a 500.
        validate: (state) => {
          try {
            const v = validateArtifact(packType.canvasTypeId, state);
            return { errors: v.valid ? [] : (v.errors ?? ['invalid document']).map((message) => ({ path: '', message })), warnings: [] };
          } catch (err) {
            log.warn('pack schema failed to compile', { canvasTypeId: packType.canvasTypeId, error: err instanceof Error ? err.message : String(err) });
            return { errors: [{ path: '', message: 'the pack schema for this canvas type is invalid — the document cannot be validated' }], warnings: [] };
          }
        },
      });
      log.info('canvas_pack_editor_routes_registered', { canvasTypeId: packType.canvasTypeId, pack: packType.packName });
    }
  },
  toggleDefault: {
    id: 'canvas-packs',
    label: 'Canvas Packs',
    description:
      'Serve full-screen generic editors for canvas types declared by installed artifact-type packs (the `x-openwop-app.canvas` vendor extension): element lists with pack-defined adders and property fields, undo/redo, and version history — over an editable `host.canvas` working copy validated by the pack’s own artifact schema. One toggle gates all pack editors. Data-only packs — never executable code. OFF by default.',
    category: 'Canvases',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'canvas-packs',
  },
};
