/**
 * Document editor canvas (ADR 0334). A rich-text `canvas.document` — a linear
 * ProseMirror/TipTap flow — created and edited full-screen through the shared
 * ADR 0310 canvas chassis, stored as ProseMirror JSON on `host.canvas`. This is
 * the sixth canvas type; it coexists with the markdown business-document store
 * (`documents` feature, ADR 0053) — see the ADR 0334 single-owner-per-store
 * rule. Single-writer in v1 (CAS + version history); real-time co-editing is a
 * later cross-cutting program (ADR 0334 Phase 7).
 *
 * @see docs/adr/0334-canvas-document-rich-text-editor.md
 */
import type { BackendFeature } from '../types.js';
import { registerDocumentEditorRoutes } from './routes.js';

export const documentEditorFeature: BackendFeature = {
  id: 'document-editor',
  registerRoutes: (deps) => {
    registerDocumentEditorRoutes(deps);
  },
  // ONE toggle per canvas type (ADR 0319). Default OFF — a new editor surface
  // plus a new engine dependency, gated rollout (ADR 0334 §Feature matrix).
  toggleDefault: {
    id: 'document-editor',
    label: 'Documents (rich text)',
    description:
      'A rich-text document editor — headings, styled text, lists, and quotes in a WYSIWYG flow, edited full-screen through the shared canvas chassis (undo/redo, autosave with version history). Stored as structured document JSON, never executable code or raw markup. Distinct from the markdown Documents store; single-writer in v1 (real-time co-editing is a later program). OFF by default.',
    category: 'Documents',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'document-editor',
  },
};
