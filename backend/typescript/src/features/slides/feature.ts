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
import { registerSlideBlocks } from './blockCatalog.js';
import { registerSlidesEditorRoutes } from './routes.js';
import { registerSlidesDesignWorkflow } from './designWorkflow.js';
import { registerSlidesPresentOutline } from './presentOutline.js';
import { buildSlidesSurface } from './surface.js';
import { registerSlidesAgentTools } from './agentTools.js';

export const slidesFeature: BackendFeature = {
  id: 'slides',
  // XCH-SLIDES-1 (Wave 3) — the live catalog projection the pack nodes read
  // instead of a hand-copied BLOCK_TYPES literal (the ADR 0358 pattern).
  surface: { id: 'slides', build: buildSlidesSurface },
  // Install the `canvas.slides` artifact type so an emitted deck validates and the
  // schema is served at /schemas/artifacts/canvas.slides.schema.json, plus the
  // full-screen editor routes (ADR 0310 Phase B — the shared canvas-editor factory).
  registerRoutes: (deps) => {
    registerSlidesDesignWorkflow(); // ADR 0472 P4 — slides.design migrated to chain-backed
    registerSlidesArtifactType();
    registerSlideBlocks(); // ADR 0328 P3 — the closed block catalog (palette + validation)
    registerSlidesPresentOutline(); // ADR 0328 P4 — the phone remote's outline projection
    registerSlidesEditorRoutes(deps);
    registerSlidesAgentTools(); // XCH-SLIDES-1 — openwop:slides.catalog (ADR 0308 seam)
  },
  // ONE toggle per canvas type (ADR 0319): generation + the full-screen editor +
  // creation are a single feature, not two (the former `slides-editor` split is retired).
  toggleDefault: {
    id: 'slides',
    label: 'Slides',
    description:
      'Slide decks — generate them from the AI chat or a workflow (the Slide Designer agent emits a typed `canvas.slides` deck inline in chat) AND create/edit them full-screen: slide strip with reorder/rename/duplicate, layout starters, a per-slide property panel, undo/redo, and version history. Constrained typed JSON — never executable code; exports via Documents (pptx/pdf). ON by default.',
    category: 'Documents',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'slides',
  },
  // PRODUCER — the node emits a typed `canvas.slides` artifact (carried to the
  // workbench by the ADR 0083 run-output producer); the Slide Designer agent drives
  // it through the existing chat (ADR 0058) — no new chat surface.
  requiredPacks: [
    { name: 'feature.slides.nodes', version: '1.1.1' },
    { name: 'feature.slides.agents', version: '1.1.1' },
  ],
};
