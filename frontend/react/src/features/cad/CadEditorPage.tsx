/**
 * CAD full-screen editor route (ADR 0310 Phase C — elements-trait consumer).
 * Solid list + per-kind adders + properties panel over the shared
 * `CanvasEditorPage`; the model renders through the ONE `CadContentView`
 * orthographic projection. Reached at `/cad/:canvasId`, or
 * `/cad/new?fromArtifact=<runId:nodeId>` from a CAD chat card.
 */
import { CanvasEditorPage } from '../../canvas/CanvasEditorPage.js';
import { cadDefinition } from './definition.js';

export function CadEditorPage(): JSX.Element {
  return <CanvasEditorPage definition={cadDefinition} />;
}
