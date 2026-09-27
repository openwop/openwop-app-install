/**
 * Drawings canvas (ADR 0153 Phase 4). The Illustrator agent or a run emits a structured
 * `canvas.drawing` vector scene that renders inline in the chat artifact workbench as
 * safe inline SVG — no new surface. Toggle `drawings`, OFF by default, per-tenant.
 *
 * @see docs/adr/0153-canvas-projects-program.md
 */
import type { BackendFeature } from '../types.js';
import { registerDrawingArtifactType } from './artifactTypes.js';
import { registerDrawingsEditorRoutes } from './routes.js';
import { registerDrawingsAgentTools } from './agentTools.js';

export const drawingsFeature: BackendFeature = {
  id: 'drawings',
  registerRoutes: (deps) => {
    registerDrawingArtifactType();
    registerDrawingsEditorRoutes(deps);
    // CFP-1 repair — the Illustrator's real chat tools (get-design + render),
    // the ADR 0308 D2 feature-registered-builtin seam. Registration is
    // process-wide + inert until the agent allowlists the ids; per-tenant
    // toggle honesty lives inside each tool's run().
    registerDrawingsAgentTools();
  },
  // ONE toggle per canvas type (ADR 0319): generation + the full-screen editor +
  // creation are a single feature, not two (the former `drawings-editor` split is retired).
  toggleDefault: {
    id: 'drawings',
    label: 'Drawings',
    description:
      'Vector illustrations and diagrams — generate them with the AI chat (the Illustrator agent emits a structured drawing rendered inline as safe SVG) AND create/edit them full-screen: a shape list with per-kind adders (rectangle, circle, ellipse, line, polyline, polygon, text), direct-manipulation move/resize/rotate, numeric geometry and paint, undo/redo, and version history. Constrained typed JSON, never executable code or raw markup. ON by default.',
    category: 'Documents',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'drawings',
  },
  requiredPacks: [
    { name: 'feature.drawings.nodes', version: '1.0.0' },
    { name: 'feature.drawings.agents', version: '1.0.1' },
  ],
};
