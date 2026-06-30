/**
 * CAD canvas (ADR 0153 Phase 4). The CAD Modeler agent or a run emits a structured
 * `canvas.cad` parametric model that renders inline in the chat workbench as an
 * orthographic SVG projection — no new surface. Toggle `cad`, OFF by default, per-tenant.
 *
 * @see docs/adr/0153-canvas-projects-program.md
 */
import type { BackendFeature } from '../types.js';
import { registerCadArtifactType } from './artifactTypes.js';

export const cadFeature: BackendFeature = {
  id: 'cad',
  registerRoutes: () => { registerCadArtifactType(); },
  toggleDefault: {
    id: 'cad',
    label: 'CAD',
    description:
      'Generate parametric 3D models with the AI chat: the CAD Modeler agent emits a structured model (primitive solids with numeric dimensions) rendered inline as an orthographic projection. Constrained typed JSON, never executable code. OFF by default.',
    category: 'Canvases',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'cad',
  },
  requiredPacks: [
    { name: 'feature.cad.nodes', version: '1.0.0' },
    { name: 'feature.cad.agents', version: '1.0.0' },
  ],
};
