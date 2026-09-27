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
import { registerToggleDefault } from '../../host/featureToggles/registry.js';
import { registerAppBuilderArtifactType } from './artifactTypes.js';
import { registerAppBuilderComponents } from './componentCatalog.js';
import { registerAppBuilderRoutes } from './routes.js';
import { buildAppBuilderSurface } from './surface.js';
import { registerDesignChainWorkflow } from './designWorkflow.js';
import { registerAppBuilderAgentTools } from './agentTools.js';
import { registerAppBuilderCanvasRetention } from './canvasRetention.js';
import { registerSyncBindingCleanup, registerAppBuilderErasure } from './syncBinding.js';
import { registerAppBuilderMcpNodes } from './mcpControlNodes.js';

export const appBuilderFeature: BackendFeature = {
  id: 'app-builder',
  // ADR 0173 Phase 2 — the first `ctx.features['app-builder']` surface: `export`.
  surface: { id: 'app-builder', build: buildAppBuilderSurface },
  // Install the artifact type + the closed-world component catalog (the single
  // source for the agent prompt, the palette, and validation) + the editor routes.
  registerRoutes: (deps) => {
    registerAppBuilderArtifactType();
    registerAppBuilderComponents();
    // ADR 0346 4a — `app-builder.design` registers FROM the workflows chain
    // pack (the portable single source); the static builtinWorkflows copy is
    // retired. Chain packs are boot-loaded before features register.
    registerDesignChainWorkflow();
    // ADR 0358 — the App Architect's real tools (catalog / get-design /
    // render), the ADR 0308 D2 feature-registered-builtin seam. Registration
    // is process-wide + inert until an agent allowlists the ids; per-tenant
    // toggle honesty lives inside each tool's run().
    registerAppBuilderAgentTools();
    // DATA-AB-1 (ADR 0382) — age out abandoned app-builder canvases (opt-in own window,
    // survive-conditions: project-linked or live-shared are kept). Rides the internal
    // sweep tick; dormant until OPENWOP_APPBUILDER_CANVAS_RETENTION_DAYS is set.
    registerAppBuilderCanvasRetention();
    // Code export (ADR 0173) — its OWN toggle, gating the export route/UI; the
    // app-builder editor is unchanged. Registered here (a second toggle beside the
    // feature's own) since code-export extends app-builder rather than being a
    // separate package.
    registerToggleDefault({
      id: 'code-export',
      label: 'Code Export',
      description:
        'Export an App Builder design as downloadable framework-native source — React+Tailwind, React+styled-components, Vue+Tailwind, or HTML/CSS. Generated server-side (secret-scrubbed, size-capped) and delivered as a ZIP via a capability-token download. ON by default.',
      category: 'Canvases',
      status: 'on',
      bucketUnit: 'tenant',
      salt: 'code-export',
    });
    // GitHub publish (ADR 0306) — a third toggle: a vendor WRITE ships on an
    // explicit opt-in, independent of the read-only ZIP export.
    registerToggleDefault({
      id: 'code-publish',
      label: 'Code Publish (GitHub)',
      description:
        'Publish an App Builder design as a GitHub repository — create-only content pushes through the governed `github` connection (fine-grained PAT, write scope consented per user; the token never reaches the browser or any workflow node). Requires Code Export-style generation; ON by default.',
      category: 'Canvases',
      status: 'on',
      bucketUnit: 'tenant',
      salt: 'code-publish',
    });
    // Two-way GitHub sync (ADR 0393) — OFF by default: an inbound webhook can
    // mutate tenant state, so the lane ships on an explicit admin opt-in.
    registerToggleDefault({
      id: 'code-sync',
      label: 'Code Sync (GitHub)',
      description:
        'Two-way GitHub sync for App Builder designs — an admin binds a canvas to one repo branch; saves push a single [openwop-sync] commit (app.model.json + regenerated source), and pushes to the branch sync the model back into the builder. OFF by default: the inbound webhook mutates tenant state.',
      category: 'Canvases',
      status: 'off',
      bucketUnit: 'tenant',
      salt: 'code-sync',
    });
    registerSyncBindingCleanup();
    // AB2-M1 — the boundBy eraser (the one identifier the host canvas eraser
    // cannot reach). Registered here so a test can assert it was WIRED.
    registerAppBuilderErasure();
    // ADR 0393 Lane B — the MCP control tools' backing nodes (thin in-tree
    // adapters over existing owners). The expose-tool workflows are the
    // `appBuilderMcpControlWorkflows` array (mcpControlWorkflows.ts), registered
    // chain-backed via `registerMcpProjectionWorkflows` → `registerChainBackedWorkflow`
    // (features/index.ts) and inheriting the ADR 0087 gate verbatim from the source —
    // NOT the retired `BackendFeature.builtinWorkflows` seam (that field is gone;
    // ADR 0472 P4).
    registerAppBuilderMcpNodes({ storage: deps.storage, hostSuite: deps.hostSuite });
    registerAppBuilderRoutes(deps);
  },
  toggleDefault: {
    id: 'app-builder',
    label: 'App Builder',
    description:
      'Design multi-screen apps with the AI chat: the App Architect agent emits a structured app design (screens, a component tree per screen, and the connectors between them) that renders inline in chat and opens full-screen for drag-and-drop editing. Components come from a closed host catalog — constrained typed JSON, never executable code. ON by default.',
    category: 'Canvases',
    status: 'on',
    bucketUnit: 'tenant',
    salt: 'app-builder',
  },
  extraToggleDefaults: [
    {
      id: 'app-builder.deploy',
      label: 'Governed app deployment',
      description:
        'Deploy exported apps to the operator-configured provider (Cloud Run, ADR 0424) through the approval-gated deploy verbs. Requires operator provider configuration (OPENWOP_APP_DEPLOY_PROVIDER) and stays honest-off without it. A sub-capability of App Builder.',
      category: 'Studio',
      status: 'off',
      bucketUnit: 'tenant',
      salt: 'app-builder-deploy',
    },
  ],
  requiredPacks: [
    { name: 'feature.app-builder.nodes', version: '1.9.0' }, // 1.9.0 adds the canvas-to-generic-Kanban proposal adapter; core Kanban still owns materialization
    { name: 'feature.app-builder.agents', version: '1.3.1' }, // ADR 0358 C tool-first prompt; 1.3.1 adds nav-container guidance (5b exemplar pass)
    { name: 'feature.app-builder.artifact-types', version: '1.1.1' }, // ADR 0346 4c/4d — app.research + app.audit (types ship WITH producers)
  ],
  // ADR 0305 Phase F — the PRD → plan → render → per-screen-review design chain
  // (restart-safe builtin, the ADR 0157/0072 seam; real BYOK AI, never mock).

};
