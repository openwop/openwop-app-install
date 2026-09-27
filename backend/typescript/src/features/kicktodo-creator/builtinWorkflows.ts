/**
 * Factory built-in workflows (ADR 0415 P1) — the research spine:
 * frame (deterministic questions) → search (`core.web.search` — honestly demo
 * or live per the host adapter) → normalize (canonical source records) →
 * evidence-graph (structure-checked claims) → record (fail-closed on stub
 * sources inside the creator service).
 */

import type { WorkflowDefinition } from '../../executor/types.js';

const input = (variableName: string) => ({ type: 'variable' as const, variableName });

export const CHALLENGE_FACTORY_WORKFLOW_ID = 'openwop-app.kicktodo.challenge-factory';

/** ADR 0458 §2.2 / P2 — the child builtin that BUILDS one checkpoint batch of
 *  lessons (invoked per slot by the factory via `core.subWorkflow`). A batch is a
 *  small bounded array of plan days; the executor is acyclic with no node
 *  re-entry, so per-DAY nodes are not expressible for a variable-length batch —
 *  the single `lesson-batch-build` pack node iterates the batch INTERNALLY,
 *  each day riding `ctx.callAI` with validation + one bounded repair (the
 *  plan-generate pattern) and, when `generateMedia`, `ctx.callImageGenerator`
 *  (the reach `core.openwop.ai.image-generate` delegates to) → persisted through
 *  `ctx.features.media.createAssetFromServeUrl` → the app-owned
 *  `kicktodo-creator.setLessonMedia` pointer. NO gates in this child (a child
 *  run's interrupts are opaque in the parent's chat — ALL human checkpoints are
 *  parent-run gates). */
export const LESSON_BATCH_WORKFLOW_ID = 'openwop-app.kicktodo.lesson-batch';

const AGENT_RUNNER_TYPE_ID = 'local.openwop-app.agent-runner';

/** The MANAGED free credential the sim personas dispatch under (no BYOK, no
 *  conversation). */
const SIM_CREDENTIAL_REF = 'managed:openwop-free';

/** The three sim personas the factory convenes against the validated plan
 *  (ADR 0458 §2.2 / ADR 0442 convene precedent). `port` names the input the
 *  `sim-collect` node reads each verdict from. */
const SIM_STAGES = [
  { nodeId: 'sim-newcomer', agentId: 'feature.kicktodo.agents.sim-newcomer', port: 'newcomer' },
  { nodeId: 'sim-time-poor', agentId: 'feature.kicktodo.agents.sim-time-poor', port: 'timePoor' },
  { nodeId: 'sim-skeptic', agentId: 'feature.kicktodo.agents.sim-skeptic', port: 'skeptic' },
] as const;

const SLOTS = [0, 1, 2, 3] as const;

/**
 * ADR 0458 §2.2 / P2 — the ONE packaged, versioned Challenge Factory workflow the
 * Challenge Author ignites from the chat (never generated per challenge, PRD
 * §6.1). Composes the EXISTING node catalog end-to-end:
 *
 *   research-frame → core.web.search → source-normalize → evidence-graph
 *     → plan-generate → outline-approve (core.chat.approvalGate)
 *       ├─ approved  → plan-validate → checkpoint-plan → [≤4 checkpoint slots]
 *       │                → decompose → [3 sims ∥] → sim-collect → submit-publication
 *       └─ rejected  → gate-reject (core.fail)  ⇒ the run FAILS TYPED
 *
 * OUTLINE reject (Phase 1, unchanged): `core.chat.approvalGate` always returns
 * `status:'success'` (even on reject), so the gate's `approved` output drives TWO
 * conditioned edges — a false-conditioned edge's source reads as `skipped`, so the
 * build branch is skipped while `gate-reject` (core.fail) fails the run typed.
 *
 * PER-LESSON CHECKPOINTS (P2): `checkpoint-plan` (a thin pack node over the
 * `kicktodo-creator.checkpointPlan` surface op) partitions the VALIDATED plan into
 * ≤4 contiguous batches from the `checkpointEvery` run input ('outline-only' |
 * 'batched') — it writes `batch0..batch3` (day payloads) + `planBrief` to the bag
 * and OUTPUTS `slot0Live..slot3Live` + `noLiveSlots` for the edge conditions.
 * Each slot is `build-N` (core.subWorkflow → lesson-batch, conditioned on
 * `slotNLive` so an absent slot is skipped, never a gate over an empty batch) →
 * `gate-N` (parent-run core.chat.approvalGate, the batch's built lessons as its
 * artifact). Per-day cadence is APPROXIMATED by these ≤4 batch checkpoints (the
 * acyclic-no-re-entry executor constraint; recorded in the ADR).
 *
 * THE REJECT-SAFE BARRIER (the load-bearing wiring): `decompose ← fail-0..3` with
 * triggerRule `none_failed` — it fires when every fail node is terminal and none
 * FAILED. Each `fail-N` is SKIPPED when its slot is dead OR its checkpoint was
 * approved, and FAILED only when the checkpoint was REJECTED. So every-approved
 * and outline-only (K=0, all fails skipped) both fire the barrier, while ANY
 * reject fails its `fail-N` ⇒ `none_failed` skips `decompose` (and thus every sim
 * + `submit`) while the run fails typed. `decompose` depends ONLY on the fail
 * nodes — the deepest, same-depth layer — so a fully-synchronous K=0 skip cascade
 * evaluates it after they all settle (a convergence reached prematurely would be
 * stranded, since `releaseDownstream` visits a node once). Checkpoint gates fire
 * in parallel; after a reject the sibling gates still resolve before the run
 * finalizes as failed — an accepted UX wart; the submit invariant holds
 * unconditionally.
 *
 * SIMULATION (P2): after decompose, the three sim personas dispatch in parallel
 * as `agent-runner` nodes — each with `offerTools:[]` (ZERO tool surface,
 * confining the read-only sim away from the ADR 0315 write/egress baseline
 * without a racy stored override) and the managed free credential — returning
 * structured verdicts that `sim-collect` records via
 * `kicktodo-creator.recordSimulationVerdicts`. The publication `simulation` gate
 * then refuses to pass unless all three personas returned and none is `block`.
 *
 * `submit-publication` still only RAISES the separation-of-duties
 * `challenge-publish` approval — no in-run step completes publication.
 */
const challengeFactoryWorkflow: WorkflowDefinition = {
  workflowId: CHALLENGE_FACTORY_WORKFLOW_ID,
  variables: [
    { name: 'candidateId' },
    { name: 'topic' },
    { name: 'audience' },
    { name: 'authorSubject' },
    // Produced at runtime (evidence-graph → bag, plan-generate → bag), declared
    // with no default so `seedRunVariables` leaves them writable (KTFULL-B4).
    { name: 'evidenceSummary' },
    { name: 'plan' },
    // Optional model targeting for the plan-generate provider call — unset in
    // production (the node defaults to the managed provider); the mock-AI test
    // seam sets `provider:'mock'`.
    { name: 'provider' },
    { name: 'model' },
    // P2 checkpoint cadence — 'batched' (default) | 'outline-only'. Declared with
    // no default so the run input flows; the checkpoint-plan node treats anything
    // other than 'outline-only' as 'batched'.
    { name: 'checkpointEvery' },
    // P2 media toggle — whether each lesson gets a generated visual asset.
    { name: 'generateMedia' },
    // Produced by checkpoint-plan (bag writes): the ≤4 batch day-payload arrays
    // (subWorkflow inputMapping sources) + the sims' plan brief.
    { name: 'batch0' },
    { name: 'batch1' },
    { name: 'batch2' },
    { name: 'batch3' },
    { name: 'planBrief' },
  ],
  nodes: [
    {
      nodeId: 'research-frame',
      typeId: 'feature.kicktodo.nodes.research-frame',
      inputs: { topic: input('topic'), audience: input('audience') },
    },
    {
      nodeId: 'search',
      typeId: 'core.web.search',
      inputs: { query: input('topic'), maxResults: 8 },
    },
    {
      // Receives the search node's `{ results, engine }` output via the edge
      // (source-normalize reads `i.results` + `i.engine`).
      nodeId: 'normalize',
      typeId: 'feature.kicktodo.nodes.source-normalize',
      inputs: {},
    },
    {
      // `sources` arrive from `normalize` via the edge; `candidateId` from the bag.
      nodeId: 'evidence-graph',
      typeId: 'feature.kicktodo.nodes.evidence-graph',
      inputs: { candidateId: input('candidateId') },
    },
    {
      nodeId: 'generate',
      typeId: 'feature.kicktodo.nodes.plan-generate',
      inputs: {
        candidateId: input('candidateId'),
        topic: input('topic'),
        audience: input('audience'),
        evidenceSummary: input('evidenceSummary'),
        provider: input('provider'),
        model: input('model'),
      },
    },
    {
      // The creator approves the outline IN THE CONVERSATION (inline interrupt
      // card; durable decision record). `artifact` is the validated plan the
      // generate step wrote to the bag.
      nodeId: 'outline-approve',
      typeId: 'core.chat.approvalGate',
      inputs: { artifact: input('plan') },
      config: {
        title: 'Approve the challenge outline?',
        artifactType: 'challenge-outline',
        maxRequestChangesIterations: 0,
      },
    },
    {
      nodeId: 'plan-validate',
      typeId: 'feature.kicktodo.nodes.plan-validate',
      inputs: { plan: input('plan') },
    },
    {
      // P2 — partitions the validated plan into ≤4 checkpoint batches; writes
      // batch0..batch3 + planBrief to the bag and OUTPUTS slot0Live..slot3Live +
      // noLiveSlots for the edge conditions below (pack node over the
      // `kicktodo-creator.checkpointPlan` surface op).
      nodeId: 'checkpoint-plan',
      typeId: 'feature.kicktodo.nodes.checkpoint-plan',
      inputs: { plan: input('plan'), checkpointEvery: input('checkpointEvery') },
    },
    // ── ≤4 checkpoint slots: build-N (subWorkflow) → gate-N; reject → fail-N ──
    ...SLOTS.flatMap((n) => [
      {
        nodeId: `build-${n}`,
        typeId: 'core.subWorkflow',
        config: {
          workflowId: LESSON_BATCH_WORKFLOW_ID,
          waitForCompletion: true,
          // A per-day enrichment/media hiccup surfaces to the checkpoint reviewer
          // rather than killing the whole authoring run.
          onChildFailure: 'absorb',
          inputMapping: {
            candidateId: 'candidateId',
            authorSubject: 'authorSubject',
            days: `batch${n}`,
            generateMedia: 'generateMedia',
          },
        },
      },
      {
        nodeId: `gate-${n}`,
        typeId: 'core.chat.approvalGate',
        config: {
          title: `Approve the lessons for checkpoint ${n + 1}?`,
          artifactType: 'challenge-lesson-batch',
          maxRequestChangesIterations: 0,
        },
      },
      {
        // Runs ONLY when gate-N is rejected — fails the run typed AND (as an
        // upstream of decompose) forces the barrier to skip so nothing publishes.
        nodeId: `fail-${n}`,
        typeId: 'core.fail',
        config: { code: 'checkpoint_rejected', message: `Checkpoint ${n + 1} was rejected — the factory run stops here.` },
      },
    ]),
    {
      nodeId: 'decompose',
      typeId: 'feature.kicktodo.nodes.decompose',
      inputs: { plan: input('plan'), authorSubject: input('authorSubject'), candidateId: input('candidateId') },
    },
    // ── simulation stage: 3 read-only sims in parallel → collect verdicts ──
    ...SIM_STAGES.map((s) => ({
      nodeId: s.nodeId,
      typeId: AGENT_RUNNER_TYPE_ID,
      // `offerTools:[]` REPLACES the offered catalog ⇒ a ZERO-tool surface (no
      // ADR 0315 baseline union), confining the sim without a racy stored override.
      config: { offerTools: [] as string[] },
      inputs: { agentId: s.agentId, task: input('planBrief'), credentialRef: SIM_CREDENTIAL_REF },
    })),
    {
      // Reads the three sims' structured `result` outputs (via the edges below)
      // and records them through `kicktodo-creator.recordSimulationVerdicts`
      // (closed-world normalized). Pack node.
      nodeId: 'sim-collect',
      typeId: 'feature.kicktodo.nodes.sim-collect',
      inputs: { candidateId: input('candidateId') },
    },
    {
      // TERMINAL — raises the separation-of-duties `challenge-publish` approval;
      // it NEVER completes publication (ADR 0458 §2.2 step 7). The publication
      // `simulation` gate reads the verdicts sim-collect recorded.
      nodeId: 'submit',
      typeId: 'feature.kicktodo.nodes.submit-publication',
      inputs: { candidateId: input('candidateId') },
    },
    {
      // Runs ONLY on the rejected OUTLINE branch — terminates the run with a
      // typed error so a rejected outline never proceeds to build/decompose/publish.
      nodeId: 'gate-reject',
      typeId: 'core.fail',
      config: { code: 'outline_rejected', message: 'The challenge outline was rejected — the factory run stops here.' },
    },
  ],
  edges: [
    { edgeId: 'e_frame_search', sourceNodeId: 'research-frame', targetNodeId: 'search' },
    { edgeId: 'e_search_normalize', sourceNodeId: 'search', targetNodeId: 'normalize' },
    { edgeId: 'e_normalize_graph', sourceNodeId: 'normalize', targetNodeId: 'evidence-graph' },
    { edgeId: 'e_graph_generate', sourceNodeId: 'evidence-graph', targetNodeId: 'generate' },
    { edgeId: 'e_generate_approve', sourceNodeId: 'generate', targetNodeId: 'outline-approve' },
    // APPROVED branch — the conditioned edge fires plan-validate only when the
    // gate output `approved` is truthy.
    { edgeId: 'e_approve_validate', sourceNodeId: 'outline-approve', targetNodeId: 'plan-validate', triggerRule: 'all_success', condition: { path: 'approved', op: 'truthy' } },
    { edgeId: 'e_validate_checkpoints', sourceNodeId: 'plan-validate', targetNodeId: 'checkpoint-plan', triggerRule: 'all_success' },
    // REJECTED OUTLINE branch — fires core.fail only when `approved` is falsy.
    { edgeId: 'e_approve_reject', sourceNodeId: 'outline-approve', targetNodeId: 'gate-reject', condition: { path: 'approved', op: 'falsy' } },
    // ── per-slot build/gate/fail wiring + the reject-safe barrier into decompose ──
    //
    // The barrier is `decompose ← fail-0..3` with triggerRule `none_failed`. Each
    // `fail-N` is the load-bearing convergence: it is SKIPPED when its slot is dead
    // (gate-N skipped) OR when the checkpoint was approved (the `approved:falsy`
    // condition is false), and FAILED only when the checkpoint was REJECTED. So:
    //   - all live checkpoints approved / dead slots → every fail-N skipped ⇒
    //     none_failed fires (all upstreams terminal, none failed) ⇒ decompose runs;
    //   - K=0 outline-only → every fail-N skipped (via dead gates) ⇒ decompose runs
    //     with NO gate (the fails encode the bypass — no separate cp→decompose edge,
    //     which would strand decompose in the fully-synchronous skip cascade because
    //     `releaseDownstream` visits a node once);
    //   - ANY reject → that fail-N FAILS ⇒ none_failed returns skip ⇒ decompose (and
    //     thus every sim + submit downstream) is skipped while the run fails typed.
    // decompose depends ONLY on the fail nodes (the deepest, same-depth layer) so it
    // is evaluated after they all settle — never prematurely visited.
    ...SLOTS.flatMap((n) => [
      { edgeId: `e_cp_build${n}`, sourceNodeId: 'checkpoint-plan', targetNodeId: `build-${n}`, triggerRule: 'all_success' as const, condition: { path: `slot${n}Live`, op: 'truthy' as const } },
      { edgeId: `e_build${n}_gate${n}`, sourceNodeId: `build-${n}`, targetNodeId: `gate-${n}`, triggerRule: 'all_success' as const },
      // rejected ⇒ core.fail (fails the run typed AND, as a decompose upstream, skips the barrier).
      { edgeId: `e_gate${n}_fail${n}`, sourceNodeId: `gate-${n}`, targetNodeId: `fail-${n}`, condition: { path: 'approved', op: 'falsy' as const } },
      { edgeId: `e_fail${n}_decompose`, sourceNodeId: `fail-${n}`, targetNodeId: 'decompose', triggerRule: 'none_failed' as const },
    ]),
    // ── decompose → sims (parallel) → collect → submit ──
    ...SIM_STAGES.map((s) => ({ edgeId: `e_decompose_${s.nodeId}`, sourceNodeId: 'decompose', targetNodeId: s.nodeId, triggerRule: 'all_success' as const })),
    // Each sim's STRUCTURED `result` output lands on its own `sim-collect` input
    // port (newcomer / timePoor / skeptic) — sourceOutput picks the agent-runner's
    // typed verdict, targetInput separates the three (else they'd collide on one port).
    ...SIM_STAGES.map((s) => ({ edgeId: `e_${s.nodeId}_collect`, sourceNodeId: s.nodeId, targetNodeId: 'sim-collect', triggerRule: 'all_success' as const, sourceOutput: 'result', targetInput: s.port })),
    { edgeId: 'e_collect_submit', sourceNodeId: 'sim-collect', targetNodeId: 'submit', triggerRule: 'all_success' },
  ],
  metadata: { kind: 'challenge-factory', feature: 'kicktodo-creator' },
};

/** ADR 0458 §2.2 / P2 — the per-batch lesson-build child (see
 *  `LESSON_BATCH_WORKFLOW_ID`). ONE iterating pack node; NO gates. */
const lessonBatchWorkflow: WorkflowDefinition = {
  workflowId: LESSON_BATCH_WORKFLOW_ID,
  variables: [
    { name: 'candidateId' },
    { name: 'authorSubject' },
    // The batch's day payloads (from the parent's `batchN` via subWorkflow
    // inputMapping) — a small bounded array the build node iterates internally.
    { name: 'days' },
    { name: 'generateMedia' },
  ],
  nodes: [
    {
      nodeId: 'lesson-batch-build',
      typeId: 'feature.kicktodo.nodes.lesson-batch-build',
      inputs: {
        candidateId: input('candidateId'),
        authorSubject: input('authorSubject'),
        days: input('days'),
        generateMedia: input('generateMedia'),
      },
    },
  ],
};

export const kicktodoCreatorBuiltinWorkflows: readonly WorkflowDefinition[] = [
  challengeFactoryWorkflow,
  lessonBatchWorkflow,
  // NOTE (chains-or-stacks doctrine / RFC 0133 migration, 2026-07-23): the
  // `openwop-app.kicktodo.plan-generation` builtin MIGRATED OUT of this deprecated
  // ADR 0072 array to an RFC 0013/0133 chain pack —
  // `examples/workflow-chain-packs/kicktodo-plan-generation/` (chainId
  // `kicktodo.plan-generation`). It was the cleanest of the 5 format-ext-blocked
  // builtins: a pure RFC 0133 §2 produced-variable case (`generate` writes `plan`
  // to the run bag, `decompose` reads it by name) with no sub-chain and no
  // conditional edges, and it had zero code consumers — so it now shows in
  // `/builder` + the `/` picker and is builder-editable, which a code-pinned
  // builtin never is. The Factory + lesson-batch stay here pending TWO more format
  // gaps this migration surfaced (see docs/builtin-workflow-migration-audit.md):
  // fragment edge-conditions can't express `truthy`/`falsy` (the reject-safe
  // barrier), and a sub-chain child's dispatch-seeded run-inputs don't yet reach
  // its expanded `variables[]`.
  // NOTE (ADR 0472 Phase 2, 2026-07-23): `openwop-app.kicktodo.research` MIGRATED OUT
  // of this deprecated array → `examples/workflow-chain-packs/kicktodo-research/`
  // (chainId `kicktodo.research`). A clean 4-node convert (frame→search→normalize→graph)
  // with zero code consumers; conversion tightened the builtin's implicit ordering into
  // explicit edge dataflow (the audit's honesty note). Now builder-visible + `/`-runnable.
];
