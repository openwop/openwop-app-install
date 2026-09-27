/**
 * App-builder full-screen editor route (ADR 0153 Phase 2b + ADR 0305 Phase B;
 * chassis extracted to the canvas framework in ADR 0310 Phase A). The whole
 * editor — palette, screen management, drag-and-drop, outline, catalog-driven
 * properties, bounded undo/redo, optimistic-concurrency saves, version
 * history, share — is the framework's `CanvasEditorPage`, driven by the typed
 * `appBuilderDefinition` (screens + components traits, export/publish extras).
 *
 * Reached at `/app-builder/:canvasId`, or `/app-builder/new?fromArtifact=<runId:nodeId>`
 * to seed an editable copy from a chat artifact and edit it.
 */
import { CanvasEditorPage } from '../../canvas/CanvasEditorPage.js';
import { appBuilderDefinition } from './definition.js';

export function AppBuilderEditorPage(): JSX.Element {
  return <CanvasEditorPage definition={appBuilderDefinition} />;
}
