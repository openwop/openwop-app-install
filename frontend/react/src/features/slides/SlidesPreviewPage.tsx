/**
 * Interactive preview route for a slides canvas (ADR 0310 Phase B). The
 * framework's `CanvasPreviewPage` with the deck's own theme override and the
 * slide tab strip as navigation (slides have no tap-through actions).
 *
 * Reached at `/slides/:canvasId/preview` (the editor's Preview button).
 */
import { CanvasPreviewPage } from '../../canvas/CanvasPreviewPage.js';
import { slidesDefinition } from './definition.js';

export function SlidesPreviewPage(): JSX.Element {
  return <CanvasPreviewPage definition={slidesDefinition} />;
}
