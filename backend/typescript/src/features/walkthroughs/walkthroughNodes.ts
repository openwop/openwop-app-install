/**
 * ADR 0368 Phase 1 — the guided-walkthrough step nodes.
 *
 * A tour is an ORDINARY workflow whose steps are `ui.tour.step` nodes. Each
 * step suspends the run with a `tour-step` interrupt carrying the semantic
 * payload the FE player consumes: which registry ACTION to perform, the
 * narration caption, and whether the step is HITL (only the real user's
 * action resolves it). The engine never watches the UI — the player performs
 * and RESOLVES; resolve marks the node completed with the resume value as its
 * outputs, so pause/resume/reload are just the durable run's normal states.
 *
 * `ui.tour.checkpoint` is the honesty valve: a step that asserts expected
 * app state so a diverged walkthrough stops visibly instead of clicking into the
 * wrong screen. Resolve COMPLETES a suspended node with the resume value as
 * outputs (the node never re-executes), so a checkpoint cannot fail itself —
 * on a FAILED evaluation the PLAYER does not resolve: it CANCELS the run
 * (walkthrough aborted, honest in run history) and shows the "walkthrough needs an
 * update" state.
 *
 * ADR 0489 D1 added a THIRD outcome, ALREADY-SATISFIED: the checkpoint finds the
 * state this step would produce ALREADY held (the learner had done it before).
 * The player resolves with `{passed:true, skipped:true, because}` — done, not
 * failed — and narrates `because`. Because the node completes with the resume
 * value as outputs and never re-executes, the skip decision is FROZEN into the
 * run at resolve time and is read verbatim on replay/`:fork` — the player never
 * re-evaluates a historical checkpoint. Cancellation stays reserved for genuine
 * divergence.
 */

import { getNodeRegistry } from '../../executor/nodeRegistry.js';
import type { NodeContext, NodeOutcome } from '../../executor/types.js';

export const WALKTHROUGH_STEP_TYPE_ID = 'ui.walkthrough.step';
export const WALKTHROUGH_CHECKPOINT_TYPE_ID = 'ui.walkthrough.checkpoint';
/** ADR 0376 Phase 2 — the pre-rename node type ids, still REGISTERED as aliases
 *  (same impl) so tour defs/runs created before the rename replay + `:fork`
 *  unchanged. New defs emit the `ui.walkthrough.*` ids. */
export const LEGACY_STEP_TYPE_ID = 'ui.tour.step';
export const LEGACY_CHECKPOINT_TYPE_ID = 'ui.tour.checkpoint';
/** ADR 0376 Phase 2 — the interrupt kind (persisted on suspended runs). New
 *  suspensions raise `walkthrough-step`; consumers ALSO accept the legacy
 *  `tour-step` so in-flight pre-rename runs still resolve. */
export const WALKTHROUGH_INTERRUPT_KIND = 'walkthrough-step';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function stepPayload(ctx: NodeContext): Record<string, unknown> {
  const cfg = (ctx.config ?? {}) as Record<string, unknown>;
  const actionId = str(cfg.actionId);
  const narration = str(cfg.narration);
  return {
    ...(actionId ? { actionId } : {}),
    ...(narration ? { narration } : {}),
    hitl: cfg.hitl === true || (typeof cfg.hitl === 'object' && cfg.hitl !== null)
      ? (typeof cfg.hitl === 'object' ? cfg.hitl : true)
      : false,
    ...(cfg.prefill && typeof cfg.prefill === 'object' ? { prefill: cfg.prefill } : {}),
  };
}

const stepExecute = async (ctx: NodeContext): Promise<NodeOutcome> => {
  const payload = stepPayload(ctx);
  if (!payload.actionId) {
    return { status: 'failure', error: { code: 'validation_error', message: `${WALKTHROUGH_STEP_TYPE_ID} requires config.actionId (a walkthrough action registry id).` } };
  }
  // Suspend with the step payload; the PLAYER (or, for hitl steps, the real
  // user's action) resolves the interrupt — resolve completes the node with the
  // resume value as outputs (executor resume semantics).
  return {
    status: 'suspended',
    interrupt: {
      kind: WALKTHROUGH_INTERRUPT_KIND,
      data: payload,
      resumeSchema: {
        type: 'object',
        properties: {
          acked: { type: 'boolean' },
          actionId: { type: 'string' },
          hitlValue: { description: 'What the user did on a hitl step (never raw file contents — a reference).' },
        },
      },
    },
  };
};

const checkpointExecute = async (ctx: NodeContext): Promise<NodeOutcome> => {
  const cfg = (ctx.config ?? {}) as Record<string, unknown>;
  const expect = str(cfg.expect);
  if (!expect) {
    return { status: 'failure', error: { code: 'validation_error', message: `${WALKTHROUGH_CHECKPOINT_TYPE_ID} requires config.expect (a walkthrough checkpoint id in the action registry).` } };
  }
  return {
    status: 'suspended',
    interrupt: {
      kind: WALKTHROUGH_INTERRUPT_KIND,
      data: { checkpoint: expect, ...(str(cfg.narration) ? { narration: cfg.narration } : {}), hitl: false },
      // ADR 0489 D1 — the resume value gained an ALREADY-SATISFIED arm, so the
      // schema advertises it. `skipped:true` means the checkpoint found the
      // state already held before the walkthrough produced it; `because` is the
      // learner-facing reason the player narrated. Advertising only honored
      // behaviour is the house rule — an unlisted key is an undeclared contract.
      resumeSchema: {
        type: 'object',
        properties: {
          passed: { type: 'boolean' },
          detail: { type: 'string' },
          skipped: { type: 'boolean', description: 'The step was resolved because its expected state ALREADY held (ADR 0489).' },
          because: { type: 'string', description: 'Learner-facing reason the step was skipped; present iff `skipped`.' },
        },
        required: ['passed'],
      },
    },
  };
};

export function registerWalkthroughNodes(): void {
  const registry = getNodeRegistry();
  // Register each impl under the NEW id and its LEGACY alias so pre-rename
  // defs/runs (whose node records carry `ui.tour.*`) still resolve on replay.
  for (const typeId of [WALKTHROUGH_STEP_TYPE_ID, LEGACY_STEP_TYPE_ID]) {
    registry.register({ typeId, version: '1.0.0', execute: stepExecute });
  }
  for (const typeId of [WALKTHROUGH_CHECKPOINT_TYPE_ID, LEGACY_CHECKPOINT_TYPE_ID]) {
    registry.register({ typeId, version: '1.0.0', execute: checkpointExecute });
  }
}
