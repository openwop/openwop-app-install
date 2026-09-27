/**
 * KickTodo built-in workflows (ADR 0414 P4; PRD §8.2) — the SMALL, stable,
 * versioned set the host executes, parameterized by immutable challenge/plan
 * revisions. The app does NOT generate one workflow per challenge (PRD §6.1);
 * these compose the `feature.kicktodo.nodes` pack, whose thin adapters call
 * `ctx.features.kicktodo-core`.
 *
 * - `openwop-app.kicktodo.enrollment` — the enrollment saga as a run:
 *   enroll (idempotent) → materialize today. Run inputs: ownerSubject,
 *   challengeId, challengeVersion, timezone?.
 * - `openwop-app.kicktodo.daily-loop` — the scheduled checkpoint the ADR 0412
 *   `armContinuation` job fires: materialize today → freeze evidence →
 *   evaluate through the goals owner. Run inputs: enrollmentId, ownerSubject.
 */

import { registerChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import type { WorkflowDefinition } from '../../executor/types.js';

const input = (variableName: string) => ({ type: 'variable' as const, variableName });

/** ADR 0459 P1 — the participant-replan builtin id. */
export const KICKTODO_REPLAN_WORKFLOW_ID = 'openwop-app.kicktodo.replan';

const AGENT_RUNNER_TYPE_ID = 'local.openwop-app.agent-runner';
/** The MANAGED free credential the replan composer dispatches under (no BYOK). */
const REPLAN_CREDENTIAL_REF = 'managed:openwop-free';
/** The approval-card artifact type for the proposed plan revision (registered in
 *  `artifactSchemas.ts`, schema-pinned to the agents-pack plan-revision schema). */
const PLAN_REVISION_ARTIFACT_TYPE = 'kicktodo.plan-revision';

export const kicktodoBuiltinWorkflows: readonly WorkflowDefinition[] = [
  // NOTE (ADR 0472 P4): enrollment + daily-loop + reminder-loop MIGRATED to chain
  // packs (examples/workflow-chain-packs/kicktodo-loops/), registered chain-backed via
  // registerKicktodoLoopWorkflows(). Only the participant-replan builtin remains (its
  // reject-safe barrier + agent-runner conversion is a dedicated follow-up).
  {
    /**
     * ADR 0459 §3.1 / P1 — the participant-loop chat-ignition workflow, the
     * participant-side mirror of the Challenge Factory (ADR 0458). KickBot ignites
     * it from the ONE chat via `openwop:kicktodo.replan`:
     *
     *   compose (replan-composer, reads REAL state) → clarify (replan-clarify, the
     *     ADR 0463 one-round A2UI ask, or passthrough) → approve (core.chat.approvalGate
     *     in the participant's OWN conversation)
     *       ├─ approved → apply (feature.kicktodo.nodes.apply-revision-commands)
     *       └─ rejected → reject (core.fail) ⇒ the run FAILS TYPED, nothing mutates
     *
     * The composer returns a CLOSED-WORLD `plan-revision` ({ commands, rationale };
     * `schemas/plan-revision.schema.json`) built ONLY from the three ADR 0429 lanes,
     * grounded in the enrollment's real state (its two READ tools + the state summary
     * the tool seeds into `participantIntent`). NO conversationId on the runner — the
     * gate, not the runner, owns the participant interaction (a runner-posted reply
     * would pre-empt the approval card).
     *
     * REJECT-SAFE BARRIER (the ADR 0458 factory pattern, one size smaller): the gate
     * always returns `status:'success'` (even on reject), so `approved` drives the
     * branch. On reject, `reject` (core.fail) RUNS and, as an upstream of `apply` via
     * `none_failed`, forces `apply` to SKIP — so a rejected revision mutates NOTHING
     * and the run fails typed. On approve, `reject` is SKIPPED (its `approved:falsy`
     * edge condition is false), so `apply` (both incoming edges `none_failed`, no
     * failure) runs. The CLARIFY node's structured `result` (the filled-or-passthrough
     * revision, ADR 0463) reaches `apply` on its default `input` port (the executor
     * unwraps the single-`input` edge map back to the value), so `apply` reads
     * `commands` off the revision while `enrollmentId` + `subject` come from the run
     * variables.
     */
    workflowId: KICKTODO_REPLAN_WORKFLOW_ID,
    variables: [
      { name: 'enrollmentId' },
      { name: 'ownerSubject' },
      { name: 'participantIntent' },
      { name: 'conversationId' },
    ],
    nodes: [
      {
        // The replan composer reads the participant's REAL state (its offered
        // today/progress read tools authorize under the run's acting user) and
        // returns a closed-world plan revision. Managed free tier; NO conversationId
        // (the gate owns the interaction). `offerTools` REPLACES the catalog so the
        // composer is confined to exactly the two reads — no ADR 0315 write baseline.
        nodeId: 'compose',
        typeId: AGENT_RUNNER_TYPE_ID,
        config: { offerTools: ['openwop:kicktodo.today', 'openwop:kicktodo.progress'] as string[] },
        inputs: {
          agentId: 'feature.kicktodo.agents.replan-composer',
          task: input('participantIntent'),
          credentialRef: REPLAN_CREDENTIAL_REF,
        },
      },
      {
        // ADR 0463 — the ONE-ROUND A2UI clarification leg, inserted BETWEEN compose
        // and enrich. When the composer's raw revision carries a `clarification`
        // (ASK XOR ACT — an under-specified intent within the ADR 0429 lanes, e.g.
        // "move my rest day" with no day), this node raises a day-1-catalog
        // clarification form in the participant's OWN conversation (the same
        // interrupt→`a2uiInterruptCard` bridge the chat renders, RFC 0102 / ADR 0051)
        // and folds the collected answer into the pending command's single unfilled
        // slot — emitting the COMPLETED revision. With no clarification it passes the
        // revision through UNCHANGED (bounded to one round; never re-clarifies). Its
        // output (filled-or-passthrough) is the revision that now reaches BOTH enrich
        // (humanized for the card) and apply. `revision` arrives via `e_compose_clarify`.
        nodeId: 'clarify',
        typeId: 'feature.kicktodo.nodes.replan-clarify',
      },
      {
        // ADR 0459 grade-fix — HUMANIZE the (now clarified) revision for the card:
        // wrap it as a TYPED `kicktodo.plan-revision` artifact envelope carrying a
        // server-resolved `display` (activity/alternative titles, never opaque ids), so
        // the approval card renders humanized text instead of raw JSON. The apply path
        // still reads the RAW revision off `e_clarify_apply` — `commands` is untouched.
        // Best-effort in the node: enrichment failure degrades to the un-humanized typed
        // payload, so this never blocks the gate. Sits ONLY on the clarify→approve path.
        nodeId: 'enrich',
        typeId: 'feature.kicktodo.nodes.enrich-plan-revision',
        inputs: { enrollmentId: input('enrollmentId') },
      },
      {
        // The participant approves the proposed changes IN THEIR OWN conversation
        // (inline interrupt card; durable decision record). `artifact` is the
        // enriched, TYPED revision envelope, delivered via the edge below.
        nodeId: 'approve',
        typeId: 'core.chat.approvalGate',
        config: {
          title: 'Apply these changes to your plan?',
          artifactType: PLAN_REVISION_ARTIFACT_TYPE,
          maxRequestChangesIterations: 0,
        },
      },
      {
        // Runs ONLY when the gate is rejected — fails the run typed AND (as an
        // upstream of apply) forces the barrier to skip so nothing mutates.
        nodeId: 'reject',
        typeId: 'core.fail',
        config: { code: 'replan_rejected', message: 'The plan changes were declined — nothing was changed.' },
      },
      {
        // Applies the approved closed-world revision through the governed surface
        // (owner-checked; per-lane). `commands` arrives on the default `input` port
        // (the composer's revision, unwrapped); enrollmentId + subject from variables.
        nodeId: 'apply',
        typeId: 'feature.kicktodo.nodes.apply-revision-commands',
        inputs: { enrollmentId: input('enrollmentId'), subject: input('ownerSubject') },
      },
    ],
    edges: [
      // compose → clarify → enrich → approve (ADR 0463): the raw revision flows into
      // the clarify leg (which asks the one-round A2UI question or passes through),
      // then the clarified revision is humanized into a TYPED artifact envelope that
      // becomes the gate's `artifact`. (The apply path reads the RAW clarified revision
      // straight off `e_clarify_apply` — so enrich never touches it.)
      { edgeId: 'e_compose_clarify', sourceNodeId: 'compose', targetNodeId: 'clarify', triggerRule: 'all_success', sourceOutput: 'result', targetInput: 'revision' },
      { edgeId: 'e_clarify_enrich', sourceNodeId: 'clarify', targetNodeId: 'enrich', triggerRule: 'all_success', sourceOutput: 'result', targetInput: 'revision' },
      { edgeId: 'e_enrich_approve', sourceNodeId: 'enrich', targetNodeId: 'approve', triggerRule: 'all_success', sourceOutput: 'result', targetInput: 'artifact' },
      // rejected ⇒ core.fail (fails the run typed AND skips the barrier below).
      { edgeId: 'e_approve_reject', sourceNodeId: 'approve', targetNodeId: 'reject', condition: { path: 'approved', op: 'falsy' } },
      // The reject-safe barrier: apply depends on `reject` via none_failed (skipped
      // on approve ⇒ ready; failed on reject ⇒ apply skipped). The clarify→apply
      // edge carries the clarified revision on the default `input` port (unwrapped to
      // the value) — so apply reads the FILLED-or-passthrough `commands`.
      { edgeId: 'e_clarify_apply', sourceNodeId: 'clarify', targetNodeId: 'apply', triggerRule: 'none_failed', sourceOutput: 'result' },
      { edgeId: 'e_reject_apply', sourceNodeId: 'reject', targetNodeId: 'apply', triggerRule: 'none_failed' },
    ],
    metadata: { kind: 'kicktodo-replan', feature: 'kicktodo-core' },
  },
];


import { buildChainBackedDefinition } from '../../host/chainBackedWorkflows.js';

/** Per-chain variable defaults (deferred expansion drops JSON-Schema `default` without a
 *  passed value — restore the builder-visible default; the enroll node also defaults it). */
const KICKTODO_LOOP_DEFAULTS: Record<string, Record<string, unknown>> = {
  'openwop-app.kicktodo.enrollment': { challengeVersion: 1 },
};

function kicktodoLoopPostProcess(id: string) {
  const defaults = KICKTODO_LOOP_DEFAULTS[id] ?? {};
  return (def: WorkflowDefinition): void => {
    for (const v of def.variables ?? []) if (v.name in defaults && v.defaultValue === undefined) v.defaultValue = defaults[v.name];
  };
}

/** Build a migrated loop workflow's expanded def (requires the pack loaded). Exposed for
 *  the dataflow tests. */
export function buildKicktodoLoopWorkflow(id: string): WorkflowDefinition {
  return buildChainBackedDefinition(id, { postProcess: kicktodoLoopPostProcess(id) });
}

/** ADR 0472 P4 — register the 3 migrated kicktodo loop workflows CHAIN-BACKED under
 *  their stable ids (scheduler-continuation ignition + replay unchanged). */
export function registerKicktodoLoopWorkflows(): void {
  for (const id of ['openwop-app.kicktodo.enrollment', 'openwop-app.kicktodo.daily-loop', 'openwop-app.kicktodo.reminder-loop']) {
    registerChainBackedWorkflow(id, { postProcess: kicktodoLoopPostProcess(id) });
  }
}
