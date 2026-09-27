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
import { validateDocumentDoc } from './validateDocumentDoc.js';
import { pmToMarkdown, type PMNode } from './pmToMarkdown.js';
import { pmToDocx } from './pmToDocx.js';
import mammoth from 'mammoth';

/** Cap the base64 DOCX upload (~7.5 MB decoded) — the import-DoS guard. */
const MAX_IMPORT_B64 = 10 * 1024 * 1024;

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
    basePath: '/v1/host/openwop-app/document-editor',
    feature: { toggleId: 'document-editor', label: 'Documents (rich text)' },
    canvasTypeId: 'canvas.document',
    // ADR 0359 D1 — collab-capable (the transport enforces realtime-collab AND
    // this feature's own toggle at the socket). Phase 6: no generic shape (the
    // model is a Y.XmlFragment) — external writes 409 while a room is live;
    // the derive is model-specific (fragment → ProseMirror JSON, title kept).
    collab: true,
    collabDerive: deriveDocumentState,
    validate: validateDocumentDoc,
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
          const { user } = await authz(req, 'workspace:read');
          const canvas = await loadCanvas(user.tenantId, req.params.canvasId, user.userId);
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
      // tenant + type-pinned via loadCanvas, size-capped.
      d.app.post(`${org}/import`, async (req, res, next) => {
        try {
          await authz(req, 'workspace:write'); // toggle + org-scope gate (stateless conversion)
          const b64 = String((req.body ?? {}).docxBase64 ?? '');
          if (!b64) throw new OpenwopError('validation_error', '`docxBase64` is required.', 400, { field: 'docxBase64' });
          if (b64.length > MAX_IMPORT_B64) throw new OpenwopError('validation_error', 'The document is too large to import.', 413, { field: 'docxBase64' });
          const result = await mammoth.convertToHtml({ buffer: Buffer.from(b64, 'base64') });
          res.json({ html: result.value, warnings: result.messages.map((m) => m.message) });
        } catch (err) { next(err); }
      });
    },
  });
}
