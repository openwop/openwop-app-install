/**
 * Slides editor routes (host-extension, ADR 0310 Phase B) — a pure call into
 * the shared canvas-editor route factory: catalog (empty component list — a
 * fixed-schema type — plus the layout templates) / from-artifact / get / patch
 * (validate + snapshot) / delete / versions / restore over `host.canvas`,
 * toggle-gated (`slides-editor`) + `authorizeOrgScope`-gated and type-pinned
 * to `canvas.slides`. No extra verbs and no share resource type this phase.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { authorizeOrgScope } from '../featureRoute.js';
import { registerCanvasEditorRoutes } from '../canvasEditorRoutes.js';
import { SLIDE_TEMPLATES } from './slideTemplates.js';
import { validateSlidesDoc } from './validateSlidesDoc.js';
import { exportSlides, isSlidesExportFormat, SLIDES_EXPORT_FORMATS } from './export/slidesExport.js';
import { parsePptx } from './import/pptxImport.js';
import { createCanvasForTenant } from '../../host/canvasSurface.js';

const SLIDES_FEATURE = { toggleId: 'slides', label: 'Slides' };
// GC-SL-6 — import/export are the feature's heaviest operations (CPU-bound
// document rendering + untrusted-zip parsing); their outcomes carry an
// info/warn signal so throughput and abuse are visible in prod logs.
const log = createLogger('slides.io');

export function registerSlidesEditorRoutes(deps: RouteDeps): void {
  registerCanvasEditorRoutes(deps, {
    basePath: '/v1/host/openwop-app/slides',
    feature: SLIDES_FEATURE,
    canvasTypeId: 'canvas.slides',
    // ADR 0359 Phase 5 — collab-capable (both toggles enforced at the socket).
    collab: true,
    // ADR 0359 Phase 6 — the doc↔Y shape (drift-pinned against the FE traits
    // in canvas/__tests__/collabTypes.test.ts + collab-authboundary registry test).
    collabShape: { collections: [{ key: 'slides', nested: { field: 'blocks', childrenKey: 'children' } }] },
    // ADR 0328 P7 — public share links for decks (the sharing feature owns
    // links; the shared viewer is the notes-free one-frame pager).
    templates: SLIDE_TEMPLATES,
    validate: validateSlidesDoc,
    // ADR 0314 — the Documents creation gallery's blank deck: one title slide.
    blankState: (name) => ({ title: name, slides: [{ id: 'slide-1', name: 'Slide 1', layout: 'title', title: name }] }),
    // ADR 0328 Phase 0+1 — the REAL export the `['slides','pdf']` facets
    // promise: deck → .pptx / .pdf as a downloadable Media asset (capability
    // token; the code-export delivery pattern). Rides the `slides` toggle —
    // export is the product's table-stakes output, not a separate capability.
    extraRoutes: ({ app }, { org, loadCanvas }) => {
      // ADR 0328 P7 — TEXT-FIDELITY .pptx import: titles/paragraphs/notes only
      // (images/charts/tables recorded as skipped — honesty over lookalike).
      // Creates a NEW canvas; ~15 MB base64 cap (≈11 MB file).
      app.post(`${org}/canvases/import`, async (req, res, next) => {
        try {
          const { tenantId } = await authorizeOrgScope(req, SLIDES_FEATURE, 'workspace:write');
          const body = (req.body ?? {}) as { fileBase64?: unknown; name?: unknown };
          if (typeof body.fileBase64 !== 'string' || body.fileBase64.length === 0) {
            throw new OpenwopError('validation_error', '`fileBase64` (the .pptx content) is required.', 400, { field: 'fileBase64' });
          }
          if (body.fileBase64.length > 15 * 1024 * 1024) {
            throw new OpenwopError('validation_error', 'file too large (max ~11 MB).', 413, { field: 'fileBase64' });
          }
          let parsed;
          const startedAt = Date.now();
          try {
            parsed = await parsePptx(Buffer.from(body.fileBase64, 'base64'));
          } catch (e) {
            // Rejected uploads (incl. the zip-bomb budget refusals) log at warn
            // — this is the abuse-visible signal, not just a 422 to the caller.
            log.warn('pptx_import_rejected', { tenantId, inputChars: body.fileBase64.length, ms: Date.now() - startedAt, reason: e instanceof Error ? e.message : 'unreadable' });
            throw new OpenwopError('validation_error', `could not read the .pptx: ${e instanceof Error ? e.message : 'unreadable file'}`, 422, { field: 'fileBase64' });
          }
          log.info('pptx_import_parsed', { tenantId, inputChars: body.fileBase64.length, slides: parsed.slides.length, skipped: parsed.skipped.length, ms: Date.now() - startedAt });
          const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 120) : (parsed.slides[0]?.title ?? 'Imported deck');
          const state = { title: name, theme: 'default', slides: parsed.slides };
          const validation = validateSlidesDoc(state);
          if (validation.errors.length) {
            throw new OpenwopError('validation_error', `imported deck failed validation: ${validation.errors[0]!.message}`, 422, { errors: validation.errors });
          }
          const canvas = await createCanvasForTenant(tenantId, {
            canvasTypeId: 'canvas.slides',
            name,
            initialState: state,
          });
          // SL-G8 — dual-emit: coded reasons (client-localized) + the derived
          // legacy strings for older clients. Same source, cannot drift.
          res.status(201).json({ ...canvas, skipped: parsed.skipped, skippedCoded: parsed.skippedCoded });
        } catch (err) { next(err); }
      });

      app.post(`${org}/canvases/:canvasId/export`, async (req, res, next) => {
        try {
          const { user, tenantId } = await authorizeOrgScope(req, SLIDES_FEATURE, 'workspace:read');
          const body = (req.body ?? {}) as Record<string, unknown>;
          if (!isSlidesExportFormat(body.format)) {
            throw new OpenwopError('validation_error', `\`format\` must be one of: ${SLIDES_EXPORT_FORMATS.join(', ')}.`, 400, { field: 'format' });
          }
          const canvas = await loadCanvas(tenantId, req.params.canvasId, user.userId);
          const startedAt = Date.now();
          const result = await exportSlides(tenantId, canvas.state, body.format);
          log.info('deck_exported', { tenantId, format: body.format, bytes: result.sizeBytes, ms: Date.now() - startedAt });
          res.status(201).json(result);
        } catch (err) { next(err); }
      });
    },
  });
}
