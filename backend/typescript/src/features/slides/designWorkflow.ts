/**
 * The slides design chain (ADR 0328 Phase 6) — outline-first deck generation
 * as ONE restart-safe built-in workflow on the ADR 0325 shapes:
 *
 *   brief → outline → OUTLINE GATE (HITL) → draft → deepen → notes → audit → review
 *
 * The outline gate is the product decision (the Gamma lesson): the user
 * approves the NARRATIVE as a skeleton-deck preview before the deck is paid
 * for. outline/draft are the paid core (hard-fail); deepen/notes are
 * soft-fail-loud enhancers whose warnings become audit findings; audit is
 * deterministic (zero AI) and passes the artifact through so the review
 * gate's upstream binding still receives the deck. Every AI node stamps
 * provider/model (no host default for callAI — the ADR 0325 blocker lesson),
 * and neither gate receives top-level string outputs (the junk-picker rule).
 * Chat-drivable (the chat runs workflows natively — ADR 0058).
 */
import { registerChainBackedWorkflow, buildChainBackedDefinition } from '../../host/chainBackedWorkflows.js';
import type { WorkflowDefinition } from '../../executor/types.js';



export const SLIDES_DESIGN_WORKFLOW_ID = 'slides.design';

/** Per-node outputRole map (a WorkflowNode field the portable fragment can't carry). */
function slidesPostProcess(def: WorkflowDefinition): void {
  for (const n of def.nodes) {
    if (n.nodeId.endsWith('_outline') || n.nodeId === 'outline' || n.nodeId.endsWith('_draft') || n.nodeId === 'draft') n.outputRole = 'secondary';
    else if (n.nodeId.endsWith('_audit') || n.nodeId === 'audit') n.outputRole = 'primary';
    else if (n.outputRole !== undefined) delete n.outputRole;
  }
}

/** Build the slides-design expanded definition from its chain (requires the pack
 *  loaded). Exposed so the structure test validates the MIGRATED form. */
export function buildSlidesDesignDefinition(): WorkflowDefinition {
  return buildChainBackedDefinition(SLIDES_DESIGN_WORKFLOW_ID, { postProcess: slidesPostProcess });
}

/** Boot registration — chain-backed under the stable id, chain packs boot-load first. */
export function registerSlidesDesignWorkflow(): void {
  registerChainBackedWorkflow(SLIDES_DESIGN_WORKFLOW_ID, { postProcess: slidesPostProcess });
}
