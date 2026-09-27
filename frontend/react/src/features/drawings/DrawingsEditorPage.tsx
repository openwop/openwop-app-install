/**
 * Drawings full-screen editor route (ADR 0310 Phase C — elements-trait
 * consumer). Shape list + per-kind adders + properties panel over the shared
 * `CanvasEditorPage`; the scene renders through the ONE `DrawingContentView`.
 * Reached at `/drawings/:canvasId`, or `/drawings/new?fromArtifact=<runId:nodeId>`
 * from a drawing chat card's "Open in editor".
 */
import { CanvasEditorPage } from '../../canvas/CanvasEditorPage.js';
import { drawingsDefinition } from './definition.js';

export function DrawingsEditorPage(): JSX.Element {
  return <CanvasEditorPage definition={drawingsDefinition} />;
}
