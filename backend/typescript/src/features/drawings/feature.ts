/**
 * Drawings canvas (ADR 0153 Phase 4). The Illustrator agent or a run emits a structured
 * `canvas.drawing` vector scene that renders inline in the chat artifact workbench as
 * safe inline SVG — no new surface. Toggle `drawings`, OFF by default, per-tenant.
 *
 * @see docs/adr/0153-canvas-projects-program.md
 */
import type { BackendFeature } from '../types.js';
import { registerDrawingArtifactType } from './artifactTypes.js';

export const drawingsFeature: BackendFeature = {
  id: 'drawings',
  registerRoutes: () => { registerDrawingArtifactType(); },
  toggleDefault: {
    id: 'drawings',
    label: 'Drawings',
    description:
      'Generate vector illustrations and diagrams with the AI chat: the Illustrator agent emits a structured drawing (typed shapes with numeric geometry) rendered inline as safe SVG. Constrained typed JSON, never executable code or raw markup. OFF by default.',
    category: 'Canvases',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'drawings',
  },
  requiredPacks: [
    { name: 'feature.drawings.nodes', version: '1.0.0' },
    { name: 'feature.drawings.agents', version: '1.0.0' },
  ],
};
