/**
 * Tutorials backend feature-package (ADR 0488 P1) — the tutorials surface's FIRST
 * backend. Until now `/tutorials` was frontend-only: a hard-coded in-tree
 * `registry.ts` of ordered steps that drive the app, which is the deprecated
 * ADR 0072 `builtinWorkflows` anti-pattern wearing a content hat — invisible to
 * the builder, not tenant-editable, not localizable, not AI-authorable.
 *
 * NO TOGGLE, deliberately. ADR 0490 put `/tutorials` under the access-hub
 * posture (always-on, because tutorials teach features a workspace may not have
 * enabled yet). Untoggled backend packages are the norm here — `accessibility`,
 * `analytics`, `assistant`, `billing`, `brand`, `cad` and others carry no
 * `toggleDefault` either.
 *
 * The one dependency worth naming: this reads the ENTITIES content kernel, which
 * defaults OFF. That edge is deliberately NOT declared in `dependsOn` — per
 * `feature-dependency-parity.test.ts`, `dependsOn` is a DISABLE-LOCK, not
 * documentation, and entities does not gate its service layer, so a lock would
 * be fiction. ADR 0488 D3's seed floor is what actually handles the off case.
 *
 * @see docs/adr/0488-interactive-tutorials-narrative-kernel-and-chain-binding.md
 */
import type { BackendFeature } from '../types.js';
import { registerTutorialsRoutes } from './routes.js';
import { registerTutorialsAgentTools } from './agentTools.js';
import { buildTutorialsSurface } from './surface.js';
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { listChains } from '../../host/workflowChainPackLoader.js';

/** The id prefix every tutorial phase/parent chain ships under. */
const TUTORIAL_CHAIN_PREFIX = 'tutorial.';

/**
 * ADR 0488 D2 §Correction (grade-code `TUT-1`) — REGISTER THE TUTORIAL CHAINS
 * CHAIN-BACKED, or every "Show me this phase" button launches nothing.
 *
 * The phase chains shipped as a pack and were LOADED at boot, which made them
 * gallery-reachable — and that is all it made them. Run resolution
 * (`host/index.ts` catalog source A) asks `getChainBackedWorkflow(workflowId)`,
 * which reads the REGISTERED set, and nothing registered these ids. So
 * `createRun({ workflowId: 'tutorial.connect-your-ai.phase-2' })` 404'd and the
 * player parked forever in a content-free overlay. Being loaded is not being
 * runnable; only `registerChainBackedWorkflow` closes that gap.
 *
 * Derived from the LOADED chains by prefix rather than a hand-listed array, so
 * shipping a new tutorial chain pack cannot silently miss registration — the
 * failure mode this correction exists to remove.
 */
export function registerTutorialChainWorkflows(): void {
  for (const { chain } of listChains()) {
    if (!chain.chainId.startsWith(TUTORIAL_CHAIN_PREFIX)) continue;
    const name = chain.label || chain.chainId;
    registerChainBackedWorkflow(chain.chainId, {
      // Mark it like the system walkthroughs so the player + walkthroughs
      // surface treat it as one (workflow-level metadata can't ride the fragment).
      postProcess: (def) => { def.metadata = { ...(def.metadata ?? {}), name, walkthrough: true }; },
    });
  }
}

export const tutorialsFeature: BackendFeature = {
  id: 'tutorials',
  registerRoutes: ({ app }) => {
    registerTutorialsRoutes(app);
    registerTutorialChainWorkflows();
    // ADR 0488 P6 — the chat-drivability seam (ADR 0308). READ-only tools,
    // allowlisted to the Tutor pack rather than added to the ADR 0315
    // default-on baseline (that is its own ADR-level decision).
    registerTutorialsAgentTools();
  },
  // ADR 0014 — the honest `ctx.features.tutorials` READ surface. No launch op:
  // a backend run has no live walkthrough player (the walkthroughs-surface
  // precedent), so advertising one would be a capability the host cannot honour.
  surface: { id: 'tutorials', build: buildTutorialsSurface },
};
