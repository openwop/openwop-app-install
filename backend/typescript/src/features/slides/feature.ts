/**
 * Slides canvas (ADR 0153 Phase 1 — the pilot). A chat agent or workflow run emits
 * a structured `canvas.slides` deck that renders inline in the existing chat artifact
 * workbench (ADR 0069) — NOT a new surface. Registration installs the artifact TYPE
 * (so an emitted deck validates + persists); the producer node + Slide Designer agent
 * packs generate it, driven through the one chat (ADR 0058 "agent + nodes"). Toggle
 * `slides`, OFF by default, per-tenant — it ships gated like a new feature.
 *
 * @see docs/adr/0153-canvas-projects-program.md
 */
import type { BackendFeature } from '../types.js';
import { registerSlidesArtifactType } from './artifactTypes.js';

export const slidesFeature: BackendFeature = {
  id: 'slides',
  // Install the `canvas.slides` artifact type so an emitted deck validates and the
  // schema is served at /schemas/artifacts/canvas.slides.schema.json.
  registerRoutes: () => { registerSlidesArtifactType(); },
  toggleDefault: {
    id: 'slides',
    label: 'Slides',
    description:
      'Generate structured slide decks from the AI chat or a workflow. The Slide Designer agent (or any run) emits a typed `canvas.slides` deck that renders inline in the chat artifact workbench and exports via Documents (pptx/pdf). Constrained typed JSON — never executable code. OFF by default.',
    category: 'Canvases',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'slides',
  },
  // PRODUCER — the node emits a typed `canvas.slides` artifact (carried to the
  // workbench by the ADR 0083 run-output producer); the Slide Designer agent drives
  // it through the existing chat (ADR 0058) — no new chat surface.
  requiredPacks: [
    { name: 'feature.slides.nodes', version: '1.0.0' },
    { name: 'feature.slides.agents', version: '1.0.0' },
  ],
};
