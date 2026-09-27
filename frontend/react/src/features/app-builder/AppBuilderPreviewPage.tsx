/**
 * Interactive device preview route for an app-builder canvas (ADR 0305 Phase D;
 * chassis extracted to the canvas framework in ADR 0310 Phase A). Device frames,
 * doc/light/dark theme override, fullscreen, and the tap-through walkthrough are
 * the framework's `CanvasPreviewPage`, driven by `appBuilderDefinition.preview`.
 *
 * Reached at `/app-builder/:canvasId/preview` (the editor's Preview button).
 */
import { CanvasPreviewPage } from '../../canvas/CanvasPreviewPage.js';
import { appBuilderDefinition } from './definition.js';

export function AppBuilderPreviewPage(): JSX.Element {
  return <CanvasPreviewPage definition={appBuilderDefinition} />;
}
