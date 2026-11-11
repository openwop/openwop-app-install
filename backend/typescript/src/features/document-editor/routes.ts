/**
 * Document editor routes (host-extension, ADR 0334 Phase 1) — a pure call into
 * the shared canvas-editor route factory, type-pinned to `canvas.document` and
 * gated by the `document-editor` toggle. A rich-text document is a `flow`-trait
 * canvas: its state is `{ title, content }` where `content` is ProseMirror JSON
 * (the TipTap engine's canonical form) stored verbatim on `host.canvas`. No
 * component catalog, no frame templates; the editor engine lives entirely in the
 * frontend definition.
 */
import type { RouteDeps } from '../../routes/registerAllRoutes.js';
import { OpenwopError } from '../../types.js';
import { registerCanvasEditorRoutes } from '../canvasEditorRoutes.js';
import { deriveDocumentState } from './pmFromY.js';
import { renderMarkdownToPdf } from '../documents/render.js';
import { pmToDocx } from './pmToDocx.js';
import { validateDocumentDoc } from './validateDocumentDoc.js';
import { pmToMarkdown, type PMNode } from './pmToMarkdown.js';
import { openZipWithinBudget, ZipBudgetError } from '../../host/zipBudget.js';
import { createLogger } from '../../observability/logger.js';

const log = createLogger('document-editor.import');

/** Cap the base64 DOCX upload (~7.5 MB decoded). This bounds the WIRE only; the
 *  zip budget below bounds what it inflates to (ADR 1055 D3). */
const MAX_IMPORT_B64 = 10 * 1024 * 1024;

/** ADR 1055 D3 — the decompression budget, over EVERY part of the archive.
 *  mammoth reads parts whatever they are named (the main part's path comes from
 *  `_rels/.rels`, and it always reads `mammoth/style-map`), so filtering by
 *  extension left a way round the budget (DE87CD-1). MEASURED: process RSS grew
 *  ~15x the size of the XML parsed, against a 1 GiB instance, with 2 imports in
 *  flight: 8 MB a part bounds one parse near 120 MB. Images barely compress, so
 *  a real document's total stays near its upload size, under the 20 MB total. */
export const DOCX_IMPORT_BUDGET = { maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024, maxEntries: 5_000 } as const;
/** The HTML handed back to the editor. Bounds the response, not memory. */
export const MAX_IMPORT_HTML = 5 * 1024 * 1024;
/** Imports in flight on this instance; a third waits for one to finish. */
export const MAX_IMPORTS_IN_FLIGHT = 2;
let importsInFlight = 0;

/** Inflate every part through the counted budget BEFORE mammoth runs, so a zip
 *  bomb (including one whose directory lies about its sizes) stops at the cap.
 *  mammoth then inflates what it reads again, inside the caps. */
async function assertDocxWithinBudget(buf: Buffer): Promise<void> {
  try {
    const archive = await openZipWithinBudget(buf, DOCX_IMPORT_BUDGET);
    for (const name of Object.keys(archive.zip.files)) await archive.measure(name);
  } catch (err) {
    if (err instanceof ZipBudgetError) {
      if (err.code === 'unreadable') throw new OpenwopError('validation_error', 'This file is not a readable .docx document.', 422, { field: 'docxBase64' });
      throw new OpenwopError('validation_error', 'This document expands past the import limit. Split it into smaller files, or remove large embedded content, and try again.', 413, { field: 'docxBase64', reason: err.code });
    }
    throw err;
  }
}

/** A blank rich-text document — one empty paragraph (the minimal valid PM doc,
 *  so the editor opens on a live caret, not an empty stage). */
export function blankDocumentState(name: string): Record<string, unknown> {
  return { title: name, content: { type: 'doc', content: [{ type: 'paragraph' }] } };
}

/** ADR 0334 4b — the export formats served by the document export verb. */
export const DOC_EXPORT_FORMATS = ['markdown', 'pdf', 'docx'] as const;

/** A filesystem/header-safe base name from the doc title (strips control/quote/
 *  path chars → no Content-Disposition header injection). */
function safeFileName(title: string): string {
  const s = title.replace(/[^\w.\- ]+/g, '').trim().slice(0, 80);
  return s || 'document';
}

export function registerDocumentEditorRoutes(deps: RouteDeps): void {
  registerCanvasEditorRoutes(deps, {
    basePath: '/host/openwop-app/document-editor',
    feature: { toggleId: 'document-editor', label: 'Documents (rich text)' },
    canvasTypeId: 'canvas.document',
    // ADR 0359 D1 — collab-capable (the transport enforces realtime-collab AND
    // this feature's own toggle at the socket). Phase 6: no generic shape (the
    // model is a Y.XmlFragment) — external writes 409 while a room is live;
    // the derive is model-specific (fragment → ProseMirror JSON, title kept).
    collab: true,
    collabDerive: deriveDocumentState,
    validate: validateDocumentDoc,
    // ADR 1055 D1 — the from-artifact seed is model output too; without this the
    // chassis seeds a canvas.document with no validation at all.
    validateSeed: validateDocumentDoc,
    blankState: blankDocumentState,
    // No share resource type this phase — public share links + the read-only
    // shared view are Phase 7/8 (research §5), matching the drawings Phase-C
    // posture; wiring one requires extending the sharing ResourceType enum.

    // ADR 0334 4b — server-authoritative export. Serializes the SAVED canvas
    // (of-record, no client-content trust) to Markdown, then streams Markdown or
    // (reusing the ADR 0057 pdfkit renderer, no Chromium) PDF. Authz = read;
    // toggle + type-pin inherited via loadCanvas. docx export + DOCX import are
    // the recorded 4b-2 follow-up (a docx.js dep + a mammoth→PM-JSON converter).
    extraRoutes: (d, { org, authz, loadCanvas }) => {
      d.app.post(`${org}/canvases/:canvasId/export`, async (req, res, next) => {
        try {
          // The ACTIVE workspace's tenant, not `user.tenantId` (the caller's HOME
          // tenant): in a shared workspace the canvas lives under the former, so
          // the export 404'd for every member there (DE87CD-15).
          const { user, tenantId } = await authz(req, 'workspace:read');
          const canvas = await loadCanvas(tenantId, req.params.canvasId, user.userId, 'read');
          const format = String((req.body ?? {}).format ?? 'markdown');
          if (!(DOC_EXPORT_FORMATS as readonly string[]).includes(format)) {
            throw new OpenwopError('validation_error', `Unsupported export format \`${format}\` — one of: ${DOC_EXPORT_FORMATS.join(', ')}.`, 400, { field: 'format' });
          }
          const state = canvas.state as Record<string, unknown>;
          const content = (state.content && typeof state.content === 'object' && !Array.isArray(state.content)) ? (state.content as PMNode) : { type: 'doc', content: [] };
          const title = typeof state.title === 'string' && state.title ? state.title : 'Document';
          const markdown = pmToMarkdown(content);
          const name = safeFileName(title);
          if (format === 'markdown') {
            res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="${name}.md"`);
            res.send(markdown);
            return;
          }
          if (format === 'docx') {
            const buf = await pmToDocx(content, { title });
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            res.setHeader('Content-Disposition', `attachment; filename="${name}.docx"`);
            res.send(buf);
            return;
          }
          const pdf = await renderMarkdownToPdf(markdown, { title });
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `attachment; filename="${name}.pdf"`);
          res.send(pdf);
        } catch (err) { next(err); }
      });

      // ADR 0334 4b-3 — DOCX import. Accepts a base64 .docx, converts to HTML via
      // mammoth (semantic-first — fonts/colours are dropped; warnings returned),
      // and hands the HTML back for the FE to parse THROUGH THE SCHEMA
      // (`generateJSON` — script/unknown HTML is dropped, no XSS). Authz = write,
      // tenant + type-pinned via loadCanvas, size-capped, and inflated only
      // within the ADR 1055 D3 zip budget.
      d.app.post(`${org}/import`, async (req, res, next) => {
        let tenantId = '';
        const b64 = String((req.body ?? {}).docxBase64 ?? '');
        try {
          // toggle + org-scope gate (stateless conversion); the ACTIVE tenant, so
          // the refusal log names the workspace (DE87CD-21).
          ({ tenantId } = await authz(req, 'workspace:write'));
          if (!b64) throw new OpenwopError('validation_error', '`docxBase64` is required.', 400, { field: 'docxBase64' });
          if (b64.length > MAX_IMPORT_B64) throw new OpenwopError('validation_error', 'The document is too large to import.', 413, { field: 'docxBase64' });
          if (importsInFlight >= MAX_IMPORTS_IN_FLIGHT) {
            res.setHeader('Retry-After', '5');
            throw new OpenwopError('rate_limited', 'Another import is still running. Try again in a few seconds.', 429, {});
          }
          importsInFlight += 1;
          try {
            const buffer = Buffer.from(b64, 'base64');
            await assertDocxWithinBudget(buffer);
            // Loaded on first import, not at module load (ADR 0863 D7).
            const mammoth = (await import('mammoth')).default;
            // Images are dropped at the source (never read, so never inflated): the
            // editor refuses data-URI images (`allowBase64: false`), so inlining
            // them only bloated the response. The empty <img> stubs go too.
            const result = await mammoth.convertToHtml({ buffer }, { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) });
            let images = 0;
            const html = result.value.replace(/<img\b[^>]*>/gi, () => { images += 1; return ''; });
            if (html.length > MAX_IMPORT_HTML) {
              throw new OpenwopError('validation_error', 'This document expands past the import limit. Split it into smaller files, or remove large embedded content, and try again.', 413, { field: 'docxBase64', reason: 'html_too_large' });
            }
            const warnings = result.messages.map((m) => m.message);
            if (images > 0) warnings.push(`${images} image(s) were not imported. Insert them from the media library.`);
            res.json({ html, warnings });
          } finally {
            importsInFlight -= 1;
          }
        } catch (err) {
          // The abuse-visible signal (the slides importer's `pptx_import_rejected`).
          if (tenantId && err instanceof OpenwopError && (err.httpStatus === 413 || err.httpStatus === 429 || err.httpStatus === 422)) {
            const reason = err.details?.reason;
            log.warn('docx_import_rejected', { tenantId, status: err.httpStatus, reason: typeof reason === 'string' ? reason : err.code, inputChars: b64.length });
          }
          next(err);
        }
      });
    },
  });
}
