/**
 * Slides present mode (ADR 0328 Phase 4) — the chassis CanvasPresentPage bound
 * to the slides definition. All behavior (presenter window, phone remote,
 * kiosk, blanking) is core; slides supplies only `present.renderFrame`.
 */
import { CanvasPresentPage } from '../../canvas/CanvasPresentPage.js';
import { slidesDefinition } from './definition.js';

export function SlidesPresentPage(): JSX.Element {
  return <CanvasPresentPage definition={slidesDefinition} />;
}
