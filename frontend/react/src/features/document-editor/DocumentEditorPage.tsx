/**
 * Rich-text document full-screen editor route (ADR 0334 Phase 1) — the TipTap
 * EditorSurface over the shared `CanvasEditorPage`. Reached at
 * `/document-editor/:canvasId`, or `/document-editor/new` (blank create via the
 * Documents creation gallery). This module is the ONLY importer of the
 * definition, so TipTap loads lazily with this route's chunk.
 */
import { CanvasEditorPage } from '../../canvas/CanvasEditorPage.js';
import { documentDefinition } from './definition.js';

export function DocumentEditorPage(): JSX.Element {
  return <CanvasEditorPage definition={documentDefinition} />;
}
