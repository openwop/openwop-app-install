/**
 * The `canvas.document` CanvasTypeDefinition (ADR 0334) — the sixth canvas type,
 * a rich-text document that fits NONE of frames/tree/elements/graph (the ADR
 * 0310 "supplies its own center panel" case). It declares the `flow` trait
 * (headings → the outline pane) and an `EditorSurface` (the TipTap editor); the
 * chassis supplies everything else (shell, toolbar name field, save/CAS/version,
 * preview, delete). Content is ProseMirror JSON on `host.canvas`.
 *
 * Import boundary: this feature imports `canvas/` + `ui/` (never the reverse).
 * TipTap enters only THIS chunk, reached lazily via `DocumentEditorPage`, so it
 * never touches the entry bundle (ADR 0334 Phase-1 bundle-budget rule).
 */
import type { CanvasTypeDefinition } from '../../canvas/types.js';
import { DocumentEditorSurface } from './DocumentEditorSurface.js';
import { DocumentRenderer } from './DocumentRenderer.js';
import { DocumentToolbarExtras } from './DocumentToolbarExtras.js';
import { coerceDocument, documentHeadings } from './documentDoc.js';
import type { DocumentDoc } from './documentDoc.js';

export const documentDefinition: CanvasTypeDefinition<DocumentDoc> = {
  canvasTypeId: 'canvas.document',
  touchSupport: 'light-edit', // text editing works on touch; structural ops are keyboard/pointer
  toggleId: 'document-editor',
  clientBasePath: '/host/openwop-app/document-editor',
  editorPath: '/document-editor',
  i18nNamespace: 'document-editor',
  Renderer: DocumentRenderer,
  EditorSurface: DocumentEditorSurface,
  // ADR 0359 D2 — collab-capable (chassis provisions; mirrors the backend
  // registerCanvasEditorRoutes `collab: true` registration).
  collab: 'document',
  coerceDoc: coerceDocument,
  docNameKey: 'title',
  flow: { headings: documentHeadings },
  ToolbarExtras: DocumentToolbarExtras,
};
