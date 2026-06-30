/**
 * App-builder canvas (ADR 0153 Phase 2 — the flagship). The App Architect agent or a
 * run emits a structured `canvas.app-builder` design (screens + component tree +
 * connectors) that renders inline in the chat artifact workbench and opens full-screen
 * over `host.canvas` (Phase 2b editor). Registration installs the artifact TYPE + the
 * component catalog; the producer node + App Architect agent packs generate it through
 * the one chat (ADR 0058). Toggle `app-builder`, OFF by default, per-tenant.
 *
 * @see docs/adr/0153-canvas-projects-program.md
 */
import type { BackendFeature } from '../types.js';
import { registerAppBuilderArtifactType } from './artifactTypes.js';
import { registerAppBuilderComponents } from './componentCatalog.js';
import { registerAppBuilderRoutes } from './routes.js';

export const appBuilderFeature: BackendFeature = {
  id: 'app-builder',
  // Install the artifact type + the closed-world component catalog (the single
  // source for the agent prompt, the palette, and validation) + the editor routes.
  registerRoutes: (deps) => {
    registerAppBuilderArtifactType();
    registerAppBuilderComponents();
    registerAppBuilderRoutes(deps);
  },
  toggleDefault: {
    id: 'app-builder',
    label: 'App Builder',
    description:
      'Design multi-screen apps with the AI chat: the App Architect agent emits a structured app design (screens, a component tree per screen, and the connectors between them) that renders inline in chat and opens full-screen for drag-and-drop editing. Components come from a closed host catalog — constrained typed JSON, never executable code. OFF by default.',
    category: 'Canvases',
    status: 'off',
    bucketUnit: 'tenant',
    salt: 'app-builder',
  },
  requiredPacks: [
    { name: 'feature.app-builder.nodes', version: '1.0.0' },
    { name: 'feature.app-builder.agents', version: '1.0.0' },
  ],
};
