/**
 * Interactive artifacts canvas (ADR 0128, backlog B). Live HTML/React/Mermaid/chart
 * artifacts in the EXISTING chat artifact workbench (ADR 0069) — NOT a new surface.
 * Phase 1 registers the artifact TYPES (no renderer yet — the CSP-sandboxed canvas
 * is Phase 2). An `interactive-artifacts` toggle, off by default, per tenant (the
 * sandbox is load-bearing, so it ships gated).
 *
 * @see docs/adr/0128-interactive-artifacts-canvas.md
 */
import type { BackendFeature } from '../types.js';
import { registerInteractiveArtifactTypes } from './artifactTypes.js';

export const interactiveArtifactsFeature: BackendFeature = {
  id: 'interactive-artifacts',
  // Registration installs the artifact TYPES so an emitted interactive artifact
  // validates + persists; the renderer ships in the chat workbench (Phases 2–5).
  registerRoutes: () => { registerInteractiveArtifactTypes(); },
  // Phase 6 PRODUCER — the node + agent packs: the `render` node emits a typed
  // `interactive.*` artifact (carried to the workbench by the ADR 0083 run-output
  // producer, which now surfaces `artifactTypeId`), driven through the existing
  // chat by the Visualizer agent (ADR 0058) — no new chat surface.
  requiredPacks: [
    { name: 'feature.interactive-artifacts.nodes', version: '1.0.0' },
    { name: 'feature.interactive-artifacts.agents', version: '1.0.0' },
  ],
  // No toggleDefault → always-on (ADR 0010/0024 graduation; toggle removed, gates open).
};
