/**
 * Slides full-screen editor route (ADR 0310 Phase B — the canvas framework's
 * contract proof). The whole editor — slide strip, layout templates, per-slide
 * property panel, bounded undo/redo, optimistic-concurrency saves, version
 * history — is the framework's `CanvasEditorPage`, driven by the typed
 * `slidesDefinition` (frames trait only; no component tree).
 *
 * Reached at `/slides/:canvasId`, or `/slides/new?fromArtifact=<runId:nodeId>`
 * from a slides chat card's "Open in editor".
 */
import { CanvasEditorPage } from '../../canvas/CanvasEditorPage.js';
import { slidesDefinition } from './definition.js';

export function SlidesEditorPage(): JSX.Element {
  return <CanvasEditorPage definition={slidesDefinition} />;
}
