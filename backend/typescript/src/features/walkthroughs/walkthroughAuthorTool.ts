/**
 * `openwop:walkthroughs.register-draft` (ADR 0368 Phase 6c) — the Tour Author's
 * deterministic register. The AGENT (LLM, in its chat turn) does the
 * enrichment reasoning — narration wording, HITL classification, where a
 * checkpoint belongs — from a recording; THIS tool is the deterministic tail:
 * validate the enriched steps, synthesize the `ui.tour.step`/`ui.tour.checkpoint`
 * DAG, and register it as a TRANSIENT draft (the ADR 0369 lifecycle, the same
 * path record-mode's deterministic save uses). No LLM lives here — the tool is
 * the reproducible register, so a re-run with the same input is idempotent in
 * shape (only the id differs).
 *
 * Riding the ONE chat (ADR 0058): this is a registered agent tool, not a new
 * panel. The FE record-mode's "Enrich with AI" stages a composer draft (the
 * recording + guidance) into the shared chat; the agent reasons, then calls
 * this tool. Promotion to a saved walkthrough stays a USER act (ADR 0369 OQ5 — run
 * it once).
 */
import { registerFeatureAgentTool } from '../../host/agentToolProvider.js';
import { registerWorkflow, getRegisteredWorkflowAsync } from '../../host/workflowsRegistry.js';
import { recordRevision } from '../../host/workflowRevisions.js';
import { recordOwnership } from '../../host/workflowOwnership.js';
import { WALKTHROUGH_STEP_TYPE_ID, WALKTHROUGH_CHECKPOINT_TYPE_ID } from './walkthroughNodes.js';
import { withLifecycle } from '../../host/workflowLifecycle.js';
import { validateWorkflowDefinition } from '../../host/workflowDefinitionValidation.js';
import type { WorkflowDefinition } from '../../executor/types.js';
import { OpenwopError } from '../../types.js';
import { randomUUID } from 'node:crypto';

export const WALKTHROUGH_REGISTER_DRAFT_TOOL_ID = 'openwop:walkthroughs.register-draft';

const err = (message: string): { content: string; isError: true } =>
  ({ content: JSON.stringify({ error: 'validation_error', message }), isError: true });

export function registerWalkthroughAuthorTool(): void {
  registerFeatureAgentTool({
    // TRUSTED: echoes back the caller's own draft; no stored read.
    contentTrust: 'trusted',
    def: {
      name: WALKTHROUGH_REGISTER_DRAFT_TOOL_ID,
      description:
        'Register an enriched walkthrough as a transient draft. Give it a name and an ordered list of steps; '
        + 'each step is either an ACTION step {actionId, narration, hitl?} — actionId is a semantic walkthrough-action '
        + 'id the app registered (e.g. "campaign-studio.new-brief.click"); write a short, friendly narration; set '
        + 'hitl:true when the real user must act (typing, choosing a file) — or a CHECKPOINT step {checkpoint, '
        + 'narration?} that verifies app state after a mutating step. Use the actionIds from the recording '
        + 'VERBATIM (do not invent them — an unknown actionId makes the walkthrough non-runnable; '
        // XCH-WALK-2 ruling: the action registry is FE-only (semantic DOM
        // resolvers), so the host cannot validate actionIds here — the OQ5
        // run-once promote gate is the designed safety net (an unknown id
        // needs-updates at play time, the run cannot complete, promotion is
        // blocked). Accepted + documented, not silent.
        + 'the run-once review before promotion will catch any that do not resolve). The draft is '
        + 'catalog-hidden; the user reviews it in the builder and runs it once to publish it.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-readable walkthrough name.' },
          steps: {
            type: 'array',
            description: 'Ordered steps: action {actionId, narration, hitl?} or checkpoint {checkpoint, narration?}.',
            items: { type: 'object' },
          },
        },
        required: ['name', 'steps'],
        additionalProperties: false,
      },
    },
    async run(input, scope) {
      const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : '';
      const steps = Array.isArray(input.steps) ? input.steps : null;
      if (!name) return err('name is required.');
      if (!steps || steps.length === 0) return err('steps must be a non-empty array.');

      const nodes: Array<{ nodeId: string; typeId: string; config: Record<string, unknown> }> = [];
      const edges: Array<{ edgeId: string; sourceNodeId: string; targetNodeId: string }> = [];
      for (let i = 0; i < steps.length; i++) {
        const raw = (steps[i] ?? {}) as Record<string, unknown>;
        const nodeId = `s${i + 1}`;
        const narration = typeof raw.narration === 'string' ? raw.narration : undefined;
        // Held value: 'ui.tour.checkpoint' / 'ui.tour.step' are the persisted node
        // type ids (renamed to walkthrough* in ADR 0376 Phase 2, with an alias).
        if (typeof raw.checkpoint === 'string' && raw.checkpoint) {
          nodes.push({ nodeId, typeId: WALKTHROUGH_CHECKPOINT_TYPE_ID, config: { expect: raw.checkpoint, ...(narration ? { narration } : {}) } });
        } else if (typeof raw.actionId === 'string' && raw.actionId) {
          nodes.push({ nodeId, typeId: WALKTHROUGH_STEP_TYPE_ID, config: { actionId: raw.actionId, narration: narration ?? raw.actionId, ...(raw.hitl === true ? { hitl: true } : {}) } });
        } else {
          return err(`step ${i + 1} needs an actionId or a checkpoint.`);
        }
        if (i > 0) edges.push({ edgeId: `e${i}`, sourceNodeId: `s${i}`, targetNodeId: nodeId });
      }

      const workflowId = `walkthrough.authored.${randomUUID()}`;
      let def: WorkflowDefinition;
      try {
        def = validateWorkflowDefinition({ workflowId, metadata: { name, walkthrough: true }, nodes, edges });
      } catch (e) {
        return err(`the walkthrough did not validate: ${e instanceof OpenwopError ? e.message : String(e)}`);
      }
      if (await getRegisteredWorkflowAsync(workflowId)) return err('id collision — retry.');

      const stamped = withLifecycle(def, { transient: true, generatedBy: `agent:${scope.agentProfileId ?? 'tour-author'}` });
      registerWorkflow(stamped);
      // ADR 0474 — the authored draft is the first revision.
      await recordRevision(scope.tenantId, stamped, { createdBy: `agent:${scope.agentProfileId ?? 'tour-author'}` });
      await recordOwnership(scope.tenantId, workflowId, { name, nodeCount: nodes.length, transient: true });
      return { content: JSON.stringify({ workflowId, stepCount: nodes.length, note: 'Draft registered (catalog-hidden). Open it in the builder and run it once to publish.' }) };
    },
  });
}
