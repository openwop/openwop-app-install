/**
 * CAD canvas (ADR 0153 Phase 4). The CAD Modeler agent or a run emits a structured
 * `canvas.cad` parametric model that renders inline in the chat workbench as an
 * orthographic SVG projection — no new surface. Toggle `cad`, OFF by default, per-tenant.
 *
 * @see docs/adr/0153-canvas-projects-program.md
 */
import type { BackendFeature } from '../types.js';
import { registerCadArtifactType } from './artifactTypes.js';
import { registerCadEditorRoutes } from './routes.js';
import { registerCadAgentTools } from './agentTools.js';
import { buildCadSurface } from './surface.js';

export const cadFeature: BackendFeature = {
  id: 'cad',
  registerRoutes: (deps) => {
    registerCadArtifactType();
    registerCadEditorRoutes(deps);
    // CFP-1 repair — the CAD Modeler's real chat tools (get-design + render),
    // the ADR 0308 D2 feature-registered-builtin seam. Registration is
    // process-wide + inert until the agent allowlists the ids; per-tenant
    // toggle honesty lives inside each tool's run().
    registerCadAgentTools();
  },
  // ADR 0388 P1 — ctx.features.cad (meshImport/meshExport for the pack nodes).
  surface: { id: 'cad', build: buildCadSurface },
  // ONE toggle per canvas type (ADR 0319): generation + the full-screen editor +
  // creation are a single feature, not two (the former `cad-editor` split is retired).
  toggleDefault: {
    id: 'cad',
    label: 'CAD',
    description:
      'Parametric 3D models — generate them with the AI chat (the CAD Modeler agent emits a structured model rendered inline as an orthographic projection) AND create/edit them full-screen: a solid list with per-kind adders (box, cylinder, sphere, cone), on-canvas move/resize/rotate, numeric dimensions, undo/redo, and version history. Constrained typed JSON, never executable code. ON by default.',
    category: 'Documents',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'cad',
  },
  requiredPacks: [
    { name: 'feature.cad.nodes', version: '1.6.0' }, // R2 CAD2-B1 — render preserves rotation/metallic/roughness
    { name: 'feature.cad.agents', version: '1.5.1' }, // ADR 0388 P5 — +materials allowlist/prompt
  ],
};
