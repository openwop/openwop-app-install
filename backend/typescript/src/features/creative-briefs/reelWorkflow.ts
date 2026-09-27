/**
 * ADR 0411 P3b / ADR 0472 Phase 4 — the "generate reel" workflow, MIGRATED off the
 * deprecated `builtinWorkflows` seam to an RFC 0013 chain pack
 * (`examples/workflow-chain-packs/creative-briefs-reel/`, chainId
 * `openwop-app.creative-briefs-reel`). It registers CHAIN-BACKED at feature boot
 * (`feature.ts` → `registerCreativeBriefsReelWorkflow`) under the SAME id, so the
 * route ignition + `getWorkflow(...)` resolution + replay are unchanged — and it is
 * now a gallery-editable + `/`-runnable chain (which a code-pinned builtin never was).
 *
 * The single node is `feature.creative-briefs.nodes.generate-reel` (P3a), which uses
 * `ctx.callVideoGenerator` + `ctx.features.media`/`creative-briefs` surfaces — so
 * running it through a run keeps the reel path boundary-clean. Per-node `outputRole`
 * (a WorkflowNode field the portable fragment can't carry) is re-applied at
 * registration via the ADR 0472 Phase 1 `postProcess` hook.
 */
import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import type { WorkflowDefinition } from '../../executor/types.js';

export const CREATIVE_BRIEFS_REEL_ID = 'openwop-app.creative-briefs-reel';

/** Boot registration — chainId-only, resolve-by-id under the stable original id,
 *  with the `reel` node re-marked `outputRole:'primary'`. Chain packs boot-load
 *  before features register (the app-builder precedent). */
export function registerCreativeBriefsReelWorkflow(): void {
  registerChainBackedWorkflow(CREATIVE_BRIEFS_REEL_ID, {
    postProcess: (def: WorkflowDefinition) => {
      for (const node of def.nodes) {
        if (node.nodeId === 'reel' || node.nodeId.endsWith('_reel')) node.outputRole = 'primary';
        else if (node.outputRole !== undefined) delete node.outputRole;
      }
    },
  });
}
