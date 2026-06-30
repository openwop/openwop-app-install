/**
 * NodeModule registration. One-shot at boot.
 *
 * Registers the minimal set of `core.*` node types the sample executor
 * dispatches inline + the demo pack's `local.openwop-app.uppercase`.
 *
 * Sample-grade — no MCP, no AI providers (those would require external
 * accounts). Real deployers wire `core.openwop.ai`, `core.openwop.mcp`,
 * `core.openwop.http` from the published packs.
 */

import { createHash } from 'node:crypto';
import { getNodeRegistry } from '../executor/nodeRegistry.js';
import { getAgentRegistry } from '../executor/agentRegistry.js';
import type { NodeContext, NodeModule } from '../executor/types.js';
import { emitCost } from '../observability/costEmitter.js';
import { composeAgentSystemPrompt } from '../host/agentPromptScaffold.js';
import { applyToolResultTransform } from '../host/toolResultTransform.js';
import { resolveAgentKnowledgeRetrieve, composeAgentKnowledgeContext } from '../host/agentKnowledgeComposition.js';
import { createAgentMemoryPort, agentMemoryScope } from '../host/agentMemoryAdapter.js';
import { conversationIdFor, makeTurn } from '../host/conversation.js';
import { appendChannelMessage } from '../host/channelsRuntime.js';
import { getUser } from '../features/users/usersService.js';
import { composePromptTemplate } from '../host/promptCompose.js';
import { resolvePromptRef, type PromptKind } from '../host/promptResolve.js';
import { getTemplate } from '../host/promptStore.js';
import { getPromptsHostConfig } from '../host/promptHostConfig.js';
import { dispatchChat, type ChatMessage, type ContentPart, type DispatchResult, type ProviderId } from '../providers/dispatch.js';
import { dispatchAnthropicWithTools, type ToolDef } from '../providers/dispatchAnthropicTools.js';
import { dispatchMiniMaxWithTools } from '../providers/dispatchMiniMaxTools.js';
import { getDefaultModel } from '../providers/catalog.js';
import {
  CHAT_RESPONDER_TYPE_ID,
  dispatchManagedChat,
  isManagedCredentialRef,
  managedProviderIdFromRef,
  ManagedProviderError,
  type ManagedDispatchResult,
} from '../providers/managedProvider.js';
import {
  buildRefusalPayload,
  buildTruncatedPayload,
} from '../host/envelopeReliabilityEmit.js';
import { dispatchSubRun, type SubRunResult } from '../subruns/subRunDispatcher.js';
import { registerMockAgentNode, conformanceNodesEnabled } from './conformanceMockAgent.js';
import { diagnoseEmptyCompletion } from './emptyCompletionDiagnostic.js';
import { storeMediaAsset, resolveMediaAsset, writeMemoryEntry, MEMORY_DEMO_REF } from '../host/inMemorySurfaces.js';
import agentRunnerNode from '../host/agentRunnerNode.js';

const noopNode: NodeModule = {
  typeId: 'core.noop',
  version: '1.0.0',
  async execute(ctx) {
    const inputs = (ctx.inputs && typeof ctx.inputs === 'object') ? (ctx.inputs as Record<string, unknown>) : {};
    return { status: 'success', outputs: { ...inputs } };
  },
};

/** Identity passthrough — copies every input port to a same-named
 *  output port. Used by `conformance-identity` to assert that
 *  `inputs.{var}` from POST /v1/runs round-trips to
 *  `RunSnapshot.variables.{var}`. The output→variable plumbing
 *  happens in the executor; this node's only job is to be present so
 *  the run reaches terminal `completed`. Behaviorally indistinguishable
 *  from `core.noop` today; preserved as a distinct typeId because the
 *  fixture catalog (and conformance/fixtures.md) names it explicitly. */
const identityNode: NodeModule = {
  typeId: 'core.identity',
  version: '1.0.0',
  async execute(ctx) {
    const inputs = (ctx.inputs && typeof ctx.inputs === 'object') ? (ctx.inputs as Record<string, unknown>) : {};
    // `channels-and-reducers.md §message` idempotency probe (the
    // `conformance-message-reducer` fixture): emit a small conversation
    // into the workflow-declared `messages` channel, intentionally
    // re-emitting one `messageId`. The `message` reducer
    // (`host/channelsRuntime.ts`) folds the duplicate to a single
    // entry — `RunSnapshot.channels.messages` MUST contain each
    // messageId exactly once.
    if ((ctx.config ?? {})['emitDuplicateMessageId'] === true) {
      const { appendChannelMessage } = await import('../host/channelsRuntime.js');
      const agentId = ctx.nodeAgent?.agentId;
      const ts = new Date().toISOString();
      const emit = (messageId: string, content: string): void => {
        appendChannelMessage(ctx.runId, 'messages', {
          messageId,
          role: 'assistant',
          content,
          timestamp: ts,
          ...(agentId !== undefined ? { agentId } : {}),
        });
      };
      emit(`${ctx.runId}-msg-1`, 'first message');
      emit(`${ctx.runId}-msg-2`, 'second message');
      // Intentional duplicate emission of msg-2 — MUST fold to one entry.
      emit(`${ctx.runId}-msg-2`, 'second message (duplicate emission)');
    }
    return { status: 'success', outputs: { ...inputs } };
  },
};

/** RFC 0022 §A — `core.orchestrator.supervisor` (conformance-mock form).
 *  Reads `mockDispatchPlan` from config (an ordered list of
 *  OrchestratorDecision records) and emits the entire plan as
 *  `outputs.decisions[]`. The downstream `core.dispatch` node consumes
 *  the plan and drives the per-decision dispatch loop internally.
 *
 *  The fixture-catalog hosts this supervisor at the head of a 2-node
 *  supervisor → dispatch → supervisor cycle. The back-edge from
 *  dispatch back to supervisor is detected + dropped by
 *  scheduler.ts findBackEdges() — the cycle is documentation-only;
 *  dispatch loops over the decisions internally without re-firing
 *  the supervisor in the DAG. Real (non-mock) supervisors would emit
 *  one decision per invocation; future spec work (RFC 0022 §"Unresolved
 *  questions" #6) will normate that contract. */
const orchestratorSupervisorNode: NodeModule = {
  typeId: 'core.orchestrator.supervisor',
  version: '1.0.0',
  async execute(ctx) {
    const cfg = (ctx.config ?? {}) as { mockDispatchPlan?: unknown; agentId?: unknown };
    // Default plan when no mockDispatchPlan is configured: a single
    // pass through the dispatch loop (one no-op next-worker decision +
    // terminate). Lets the `conformance-dispatch-loop` fixture
    // exercise the supervisor→dispatch round-trip without a fixture-
    // declared plan. Fixtures that want richer behavior (specific
    // child workflow ids, multi-pass dispatching) carry the plan
    // explicitly in their config.
    const plan = Array.isArray(cfg.mockDispatchPlan) && cfg.mockDispatchPlan.length > 0
      ? cfg.mockDispatchPlan
      : [
          { kind: 'next-worker', nextWorkerIds: [] },
          { kind: 'terminate', reason: 'goal-reached' },
        ];
    // RFC 0006 §B + `runOrchestratorDecided` schema requires `agentId` on
    // every emission. The supervisor's agent identity is either declared
    // explicitly via `config.agentId` (fixtures may pin a specific identity
    // for cross-host parity tests) or synthesized deterministically from
    // the supervisor's nodeId so a single run's supervisor identity stays
    // stable across all decisions. Falls back to `'supervisor-<nodeId>'`
    // when no explicit identity is given.
    const agentIdRaw = typeof cfg.agentId === 'string' && cfg.agentId.length >= 3 ? cfg.agentId : undefined;
    const agentId = agentIdRaw ?? `supervisor-${ctx.nodeId}`;
    return { status: 'success', outputs: { decisions: plan, agentId } };
  },
};

/** RFC 0022 §A + RFC 0007 §D — `core.dispatch`.
 *  Consumes an OrchestratorDecision sequence (from the upstream
 *  supervisor's `decisions` output) and drives the dispatch loop
 *  internally: for each `next-worker` decision spawn the named
 *  child workflow via the subWorkflow dispatcher with inputMapping/
 *  outputMapping applied; for `terminate` break the loop. Each spawn
 *  emits a `node.dispatched` event carrying `childRunId` +
 *  `childWorkflowId` so the conformance suite can locate spawned
 *  children via the parent's event log.
 *
 *  Capability gating: `inputMapping` / `outputMapping` keys are only
 *  honored when `capabilities.agents.dispatchMapping` is advertised
 *  (validated at workflow registration via routes/workflows.ts
 *  §checkMappingCapability); the runtime side here trusts that the
 *  registration check already refused non-conformant workflows. */
const dispatchNode: NodeModule = {
  typeId: 'core.dispatch',
  version: '1.0.0',
  async execute(ctx) {
    const cfg = (ctx.config ?? {}) as {
      inputMapping?: unknown;
      outputMapping?: unknown;
      perWorkerInputMappings?: unknown;
      perWorkerOutputMappings?: unknown;
      fanOutPolicy?: unknown;
      joinPolicy?: unknown;
      maxConcurrency?: unknown;
    };
    const defaultInputMapping = (cfg.inputMapping && typeof cfg.inputMapping === 'object' && !Array.isArray(cfg.inputMapping))
      ? (cfg.inputMapping as Record<string, string>)
      : undefined;
    const defaultOutputMapping = (cfg.outputMapping && typeof cfg.outputMapping === 'object' && !Array.isArray(cfg.outputMapping))
      ? (cfg.outputMapping as Record<string, string>)
      : undefined;
    // RFC 0022 §D — per-worker overrides (keyed by child workflowId).
    // Used by `dispatch-cross-worker-handoff` to direct different
    // mappings at child-a vs child-b in the same parent run.
    const perWorkerInputMappings = (cfg.perWorkerInputMappings && typeof cfg.perWorkerInputMappings === 'object' && !Array.isArray(cfg.perWorkerInputMappings))
      ? (cfg.perWorkerInputMappings as Record<string, Record<string, string>>)
      : undefined;
    const perWorkerOutputMappings = (cfg.perWorkerOutputMappings && typeof cfg.perWorkerOutputMappings === 'object' && !Array.isArray(cfg.perWorkerOutputMappings))
      ? (cfg.perWorkerOutputMappings as Record<string, Record<string, string>>)
      : undefined;

    // Pull the supervisor's decisions list off ctx.inputs. The executor
    // unwraps a single-port `{input: X}` to X for back-compat with the
    // legacy linear executor (executor.ts:271). Accept both shapes.
    const rawInputs = (ctx.inputs && typeof ctx.inputs === 'object' && !Array.isArray(ctx.inputs))
      ? (ctx.inputs as Record<string, unknown>)
      : {};
    const supervisorPayload = (rawInputs.input && typeof rawInputs.input === 'object')
      ? (rawInputs.input as Record<string, unknown>)
      : rawInputs;
    const decisions = Array.isArray(supervisorPayload.decisions) ? (supervisorPayload.decisions as Array<Record<string, unknown>>) : [];
    // RFC 0006 §B + `runOrchestratorDecided` schema — the supervisor's
    // agent identity threads into every emitted `runOrchestrator.decided`
    // event. Read from the supervisor's output (preferred); fall back to a
    // run-scoped synthetic id when the supervisor didn't emit one (back-
    // compat with pre-RFC-0006 supervisor fixtures).
    const supervisorAgentId = typeof supervisorPayload.agentId === 'string' && supervisorPayload.agentId.length >= 3
      ? supervisorPayload.agentId
      : `orchestrator-${ctx.runId}`;

    if (decisions.length === 0) {
      return { status: 'failure', error: { code: 'invalid_request', message: 'core.dispatch requires supervisor `decisions` input' } };
    }

    const { dispatchSubWorkflow, DispatchCreationError } = await import('../executor/subWorkflowDispatcher.js');
    const { getEventLog } = await import('../executor/eventLog.js');
    const eventLog = getEventLog();

    // RFC 0037 Phase 1 — emit `core.workflowChain.event` transition records
    // alongside the existing `node.dispatched` event when the host opts in
    // via `OPENWOP_MULTI_AGENT_EXECUTION_MODEL=true`. The flag must agree
    // with the discovery doc's advertisement (`routes/discovery.ts`); the
    // RFC's normative wire contract is "do not emit unless advertised."
    const multiAgentEnabled = process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL === 'true';
    // RFC 0039 §A — Phase 2 confidence-floor escalation. When the host
    // advertises capabilities.multiAgent.executionModel.version >= 2 (signaled
    // here by the OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2=true env-flag
    // alongside the version: 2 advertisement in routes/discovery.ts), every
    // decision with a stated `confidence` below the floor MUST escalate via
    // clarify-or-escalate interrupt before any dispatch.began event fires
    // for the named worker. The spec floor is 0.5 (max-entropy threshold);
    // operator-stricter policy comes from `confidenceEscalationFloor`.
    const multiAgentPhase2Enabled = process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_2 === 'true';
    const confidenceFloor = (() => {
      const raw = process.env.OPENWOP_MULTI_AGENT_CONFIDENCE_FLOOR;
      const parsed = raw === undefined ? 0.5 : Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0.5 || parsed > 1.0) return 0.5;
      return parsed;
    })();
    const hasOutputMapping = (childWorkflowId: string): boolean => {
      const m = perWorkerOutputMappings?.[childWorkflowId] ?? defaultOutputMapping;
      return !!m && Object.keys(m).length > 0;
    };

    const dispatchedChildren: Array<{ childRunId: string; childWorkflowId: string; childStatus: string }> = [];
    let terminateReason: string | null = null;
    // RFC 0118 — set by a parallel fan-out wave; surfaces the normative {joinOutcome, children[]}
    // node output (children: {workflowId, childRunId, childStatus, error?}). Last wave wins.
    let parallelResult: { joinOutcome: string; children: Array<{ workflowId: string; childRunId: string; childStatus: string; error?: { code: string; message: string } }> } | null = null;

    // RFC 0061 §B — the observable `iteration` counter on runOrchestrator.decided
    // (additive optional field, `run-event-payloads.schema.json#runOrchestratorDecided`).
    // Set ONLY when the host advertises executionModel.version >= 5 (signaled by the
    // PHASE_5 env-flag alongside the version: 5 advertisement in routes/discovery.ts).
    // 1-based, monotonic, +1 per orchestrator turn. Sourced from a PERSISTED run
    // variable so it stays monotonic across re-entrant supervisor→dispatch passes AND
    // continues — never restarts — across a stateful HITL resume / `:fork`. The value
    // is recorded in the event and re-emitted verbatim on replay, never recomputed
    // (replay.md). Hosts on version < 5 omit the field; consumers ignore it per the
    // forward-compatibility contract.
    const emitIteration = process.env.OPENWOP_MULTI_AGENT_EXECUTION_MODEL_PHASE_5 === 'true';
    const ITERATION_VAR = '__runOrchestratorIteration';
    let iterationCounter = emitIteration ? Number(ctx.variables?.get(ITERATION_VAR) ?? 0) : 0;

    for (const decision of decisions) {
      const kind = decision.kind;
      const iteration = emitIteration ? (iterationCounter += 1) : undefined;
      // RFC 0007 §D / `run-orchestrator-decided-event.schema.json` —
      // surface each consumed decision on the event log so observers
      // (and the conformance dispatch-loop test) can see the loop's
      // decision sequence. RFC 0061 §B adds the `iteration` counter (v>=5).
      const decidedRec = await eventLog.append({
        runId: ctx.runId,
        nodeId: ctx.nodeId,
        type: 'runOrchestrator.decided',
        payload: {
          agentId: supervisorAgentId,
          decision,
          ...(iteration !== undefined ? { iteration } : {}),
        },
      });
      // RFC 0039 §A — confidence-floor escalation. Apply ONLY when Phase 2 is
      // advertised AND the decision carries an explicit confidence value. A
      // missing confidence means "no opinion stated" — NOT low confidence —
      // and MUST NOT trigger escalation. Decision kinds `next-worker` and
      // `terminate` are both eligible; `clarify` / `escalate` already are the
      // escalation themselves and don't double-escalate.
      const confidenceRaw = (decision as { confidence?: unknown }).confidence;
      const confidenceNumber = typeof confidenceRaw === 'number' ? confidenceRaw : undefined;
      const isEligibleKind = kind === 'next-worker' || kind === 'terminate';
      if (multiAgentPhase2Enabled && multiAgentEnabled && isEligibleKind &&
          confidenceNumber !== undefined && confidenceNumber < confidenceFloor) {
        // Per coreWorkflowChainConfidenceEscalated schema: workerId is OPTIONAL
        // and OMITTED for terminate-kind escalations (no worker to name).
        // Present + non-empty for next-worker-kind.
        const workerIdHint = kind === 'next-worker' && Array.isArray(decision.nextWorkerIds)
          ? String(decision.nextWorkerIds[0] ?? '')
          : '';
        await eventLog.append({
          runId: ctx.runId,
          nodeId: ctx.nodeId,
          type: 'core.workflowChain.confidence-escalated',
          causationId: decidedRec.eventId,
          payload: {
            confidence: confidenceNumber,
            floor: confidenceFloor,
            escalationKind: 'clarify',
            parentRunId: ctx.runId,
            ...(workerIdHint.length > 0 ? { workerId: workerIdHint } : {}),
            originalDecision: decision,
          },
        });
        // Suspend the parent with a clarification interrupt. The interrupt
        // surface carries the decision + floor so the operator can confirm,
        // adjust, or cancel.
        return {
          status: 'suspended',
          interrupt: {
            kind: 'clarification',
            data: {
              reason: 'confidence-floor-breached',
              confidence: confidenceNumber,
              floor: confidenceFloor,
              originalDecision: decision,
            },
          },
        };
      }
      if (kind === 'terminate') {
        terminateReason = typeof decision.reason === 'string' ? decision.reason : 'terminate';
        break;
      }
      if (kind !== 'next-worker') continue; // ignore unknown kinds for forward-compat
      const nextWorkerIds = Array.isArray(decision.nextWorkerIds) ? (decision.nextWorkerIds as string[]) : [];

      // RFC 0118 — parallel fan-out wave. When fanOutPolicy:'parallel' and >1 worker, dispatch
      // all children concurrently (bounded by maxConcurrency) and join per joinPolicy, instead of
      // the serial loop below. The host advertises only joinMode 'wait-all' (dispatchCapability),
      // so registration already rejected anything else. CRITICAL replay invariant (R1): children
      // are dispatched WITHOUT outputMapping; we record `mergeOrder` (observed terminal order) on
      // the core.dispatch.join event and apply outputMapping ONCE in that order — so a colliding
      // parent var resolves to the same (last-in-mergeOrder) winner reproducibly on :fork, never
      // recomputed from child wall-clock. (ADR 0165 executor arm.)
      if (cfg.fanOutPolicy === 'parallel' && nextWorkerIds.filter((w) => typeof w === 'string' && w).length > 1) {
        const { runParallelFanOut, HOST_MAX_FAN_OUT } = await import('../host/dispatchFanOut.js');
        const workers = nextWorkerIds.filter((w): w is string => typeof w === 'string' && w.length > 0);
        const jpCfg = (cfg.joinPolicy && typeof cfg.joinPolicy === 'object' && !Array.isArray(cfg.joinPolicy)) ? (cfg.joinPolicy as Record<string, unknown>) : {};
        const joinMode = typeof jpCfg.mode === 'string' ? jpCfg.mode : 'wait-all';
        const maxConcurrency = typeof cfg.maxConcurrency === 'number' ? cfg.maxConcurrency : undefined;
        const effConc = Math.min(maxConcurrency ?? Number.POSITIVE_INFINITY, HOST_MAX_FAN_OUT);

        const fanOutRec = await eventLog.append({
          runId: ctx.runId,
          nodeId: ctx.nodeId,
          type: 'core.dispatch.fanOut',
          causationId: decidedRec.eventId,
          payload: { fanOutPolicy: 'parallel', childCount: workers.length, maxConcurrency: effConc, joinMode },
        });

        const out = await runParallelFanOut({
          nextWorkerIds: workers,
          config: { fanOutPolicy: 'parallel', ...(maxConcurrency !== undefined ? { maxConcurrency } : {}), joinPolicy: { mode: 'wait-all' } },
          maxFanOut: HOST_MAX_FAN_OUT,
          // Dispatch each child WITHOUT outputMapping (R1) — collect its terminal + childVariables;
          // outputMapping is applied post-join in mergeOrder below.
          dispatchChild: async (childWorkflowId, idx) => {
            const inputMapping = perWorkerInputMappings?.[childWorkflowId] ?? defaultInputMapping;
            try {
              const result = await dispatchSubWorkflow({
                parentRunId: ctx.runId,
                parentTenantId: ctx.tenantId,
                ...(ctx.scopeId ? { parentScopeId: ctx.scopeId } : {}),
                parentNodeId: ctx.nodeId,
                childWorkflowId,
                ...(inputMapping ? { inputMapping } : {}),
                onChildFailure: 'continue',
              });
              await eventLog.append({
                runId: ctx.runId,
                nodeId: ctx.nodeId,
                type: 'node.dispatched',
                payload: { childRunId: result.childRunId, childWorkflowId, childStatus: result.childStatus },
              });
              const status = result.childStatus === 'completed' ? 'completed' : result.childStatus === 'cancelled' ? 'cancelled' : 'failed';
              return {
                childRunId: result.childRunId,
                status,
                workflowId: childWorkflowId,
                childVariables: result.childVariables,
                ...(result.childRuntimeError ? { error: result.childRuntimeError } : {}),
              };
            } catch (err) {
              // Pre-creation failure (DispatchCreationError) — synthesize a `failed` terminal so the
              // wave continues under collect (no parent throw). childRunId is deterministic.
              const code = err instanceof DispatchCreationError ? (err as InstanceType<typeof DispatchCreationError>).code : 'dispatch_unexpected_error';
              return {
                childRunId: `dispatch-creation-failed:${childWorkflowId}:${idx}`,
                status: 'failed' as const,
                workflowId: childWorkflowId,
                error: { code, message: err instanceof Error ? err.message : String(err) },
              };
            }
          },
        });

        // R1 — apply outputMapping ONCE in the recorded mergeOrder (last-in-mergeOrder wins on a
        // colliding parent var). outputMapping is `{parentVar: childVarName}` (RFC 0022 §A).
        for (const childRunId of out.mergeOrder) {
          const term = out.children.find((c) => c.childRunId === childRunId);
          if (!term || term.status !== 'completed' || !term.workflowId || !term.childVariables) continue;
          const om = perWorkerOutputMappings?.[term.workflowId] ?? defaultOutputMapping;
          if (om) {
            for (const [parentVar, childVar] of Object.entries(om)) {
              if (Object.prototype.hasOwnProperty.call(term.childVariables, childVar)) {
                ctx.variables?.set(parentVar, term.childVariables[childVar]);
              }
            }
          }
        }

        await eventLog.append({
          runId: ctx.runId,
          nodeId: ctx.nodeId,
          type: 'core.dispatch.join',
          causationId: fanOutRec.eventId,
          payload: {
            joinOutcome: out.joinOutcome,
            completedCount: out.completedCount,
            failedCount: out.failedCount,
            cancelledCount: out.cancelledCount,
            mergeOrder: out.mergeOrder,
          },
        });

        for (const term of out.children) {
          dispatchedChildren.push({ childRunId: term.childRunId, childWorkflowId: term.workflowId ?? '', childStatus: String(term.status) });
        }
        parallelResult = {
          joinOutcome: out.joinOutcome,
          children: out.children.map((t) => ({ workflowId: t.workflowId ?? '', childRunId: t.childRunId, childStatus: String(t.status), ...(t.error ? { error: t.error } : {}) })),
        };
        continue; // wave handled; proceed to the next decision
      }

      for (const childWorkflowId of nextWorkerIds) {
        if (typeof childWorkflowId !== 'string' || childWorkflowId.length === 0) continue;
        const inputMapping = perWorkerInputMappings?.[childWorkflowId] ?? defaultInputMapping;
        const outputMapping = perWorkerOutputMappings?.[childWorkflowId] ?? defaultOutputMapping;

        // RFC 0037 §"Handoff state machine" — transition 1/7: pending → dispatching.
        // Chains causationId back to the runOrchestrator.decided that named this worker.
        let dispatchBeganId: string | undefined;
        if (multiAgentEnabled) {
          const beganRec = await eventLog.append({
            runId: ctx.runId,
            nodeId: ctx.nodeId,
            type: 'core.workflowChain.event',
            causationId: decidedRec.eventId,
            payload: { phase: 'dispatch.began', workerId: childWorkflowId, parentRunId: ctx.runId },
          });
          dispatchBeganId = beganRec.eventId;
        }

        try {
          const result = await dispatchSubWorkflow({
            parentRunId: ctx.runId,
            parentTenantId: ctx.tenantId,
            ...(ctx.scopeId ? { parentScopeId: ctx.scopeId } : {}),
            parentNodeId: ctx.nodeId,
            childWorkflowId,
            ...(inputMapping ? { inputMapping } : {}),
            ...(outputMapping ? { outputMapping } : {}),
            onChildFailure: 'continue', // dispatch loop doesn't fail-parent on a single worker miss
          });
          // RFC 0007 §D — emit `node.dispatched` for each spawned child
          // so the parent event log carries the linkage. The conformance
          // suite reads this event to locate the child run id.
          await eventLog.append({
            runId: ctx.runId,
            nodeId: ctx.nodeId,
            type: 'node.dispatched',
            payload: { childRunId: result.childRunId, childWorkflowId, childStatus: result.childStatus },
          });
          dispatchedChildren.push({ childRunId: result.childRunId, childWorkflowId, childStatus: result.childStatus });

          // RFC 0037 — transitions 2..N: dispatching → running → terminal → (harvested?).
          if (multiAgentEnabled) {
            // Transition 2/7: dispatching → running. (Phase 1 collapses
            // "dispatching" and "running" — dispatchSubWorkflow blocks until
            // terminal — so dispatch.succeeded fires after the child has
            // already terminated. The state-machine semantics still hold:
            // a `dispatch.succeeded` event always precedes the child.*
            // event in the log.)
            const succeededRec = await eventLog.append({
              runId: ctx.runId,
              nodeId: ctx.nodeId,
              type: 'core.workflowChain.event',
              ...(dispatchBeganId ? { causationId: dispatchBeganId } : {}),
              payload: {
                phase: 'dispatch.succeeded',
                workerId: childWorkflowId,
                parentRunId: ctx.runId,
                childRunId: result.childRunId,
              },
            });

            // Transitions 3-5 (one fires): child.completed / child.failed / child.cancelled.
            // Per RFC 0037 §"Handoff state machine" the `running → failed` row covers
            // both terminal-failed and exception-during-run. dispatchSubWorkflow surfaces
            // the exception case via `result.childRuntimeError` (status: failed + error
            // envelope captured); we attach it to the child.failed event's payload.error.
            const terminalPhase =
              result.childStatus === 'completed' ? 'child.completed' :
              result.childStatus === 'failed'    ? 'child.failed'    :
              result.childStatus === 'cancelled' ? 'child.cancelled' :
              null;
            let terminalEventId: string | undefined;
            if (terminalPhase) {
              const termRec = await eventLog.append({
                runId: ctx.runId,
                nodeId: ctx.nodeId,
                type: 'core.workflowChain.event',
                causationId: succeededRec.eventId,
                payload: {
                  phase: terminalPhase,
                  workerId: childWorkflowId,
                  parentRunId: ctx.runId,
                  childRunId: result.childRunId,
                  ...(terminalPhase === 'child.failed' && result.childRuntimeError
                    ? { error: result.childRuntimeError }
                    : {}),
                },
              });
              terminalEventId = termRec.eventId;
            }

            // Transition 6/7 — output.harvested fires ONLY when child terminated
            // `completed` AND outputMapping is non-empty (per RFC 0022 §B + RFC 0037
            // §"Handoff state machine" terminal-row constraint).
            if (terminalPhase === 'child.completed' && hasOutputMapping(childWorkflowId) && terminalEventId) {
              const harvestedKeys = Object.keys(perWorkerOutputMappings?.[childWorkflowId] ?? defaultOutputMapping ?? {});
              await eventLog.append({
                runId: ctx.runId,
                nodeId: ctx.nodeId,
                type: 'core.workflowChain.event',
                causationId: terminalEventId,
                payload: {
                  phase: 'output.harvested',
                  workerId: childWorkflowId,
                  parentRunId: ctx.runId,
                  childRunId: result.childRunId,
                  harvestedKeys,
                },
              });
            }
          }
        } catch (err) {
          // Transition 7/7: dispatching → failed (creation failed BEFORE the
          // child ran any node) — per RFC 0037 §"Handoff state machine" this
          // path is reserved for pre-creation failures. dispatchSubWorkflow
          // surfaces those as DispatchCreationError; any OTHER exception class
          // here would be a bug (the dispatcher catches runtime errors
          // internally and converts them to childStatus: 'failed' + result.
          // childRuntimeError). Defensive: if a non-DispatchCreationError
          // reaches us we still emit dispatch.failed but flag the code as
          // unexpected so the failure surfaces in logs.
          if (multiAgentEnabled) {
            const isCreationFailure = err instanceof DispatchCreationError;
            const errorCode = isCreationFailure
              ? (err as InstanceType<typeof DispatchCreationError>).code
              : 'dispatch_unexpected_error';
            await eventLog.append({
              runId: ctx.runId,
              nodeId: ctx.nodeId,
              type: 'core.workflowChain.event',
              ...(dispatchBeganId ? { causationId: dispatchBeganId } : {}),
              payload: {
                phase: 'dispatch.failed',
                workerId: childWorkflowId,
                parentRunId: ctx.runId,
                error: { code: errorCode, message: err instanceof Error ? err.message : String(err) },
              },
            });
          }
          return {
            status: 'failure',
            error: { code: 'internal_error', message: err instanceof Error ? err.message : String(err) },
          };
        }
      }
    }

    // RFC 0061 §B — persist the monotonic counter so the next re-entrant
    // supervisor→dispatch pass (and any `:fork` of this run) continues from here
    // rather than restarting at 1. No-op when version < 5.
    if (emitIteration) ctx.variables?.set(ITERATION_VAR, iterationCounter);

    return {
      status: 'success',
      outputs: {
        dispatched: dispatchedChildren,
        terminated: terminateReason !== null,
        ...(terminateReason !== null ? { reason: terminateReason } : {}),
        // RFC 0118 §D — normative parallel-fan-out output (additive; absent on the serial path).
        ...(parallelResult ? { joinOutcome: parallelResult.joinOutcome, children: parallelResult.children } : {}),
      },
    };
  },
};

/** RFC 0022 §A+§B — sub-workflow dispatch primitive. Spawns a child
 *  run, applies inputMapping at dispatch + outputMapping on terminal,
 *  returns childRunId + childStatus. The actual spawn-and-wait logic
 *  lives in `executor/subWorkflowDispatcher.ts` so the node module
 *  doesn't need direct access to RunRecord storage. */
const subWorkflowNode: NodeModule = {
  typeId: 'core.subWorkflow',
  version: '1.0.0',
  async execute(ctx) {
    const cfg = (ctx.config ?? {}) as {
      workflowId?: unknown;
      inputMapping?: unknown;
      outputMapping?: unknown;
      waitForCompletion?: unknown;
      onChildFailure?: unknown;
    };
    const childWorkflowId = typeof cfg.workflowId === 'string' ? cfg.workflowId : '';
    if (!childWorkflowId) {
      return { status: 'failure', error: { code: 'invalid_request', message: 'core.subWorkflow requires config.workflowId' } };
    }
    const inputMapping = (cfg.inputMapping && typeof cfg.inputMapping === 'object' && !Array.isArray(cfg.inputMapping))
      ? (cfg.inputMapping as Record<string, string>)
      : undefined;
    const outputMapping = (cfg.outputMapping && typeof cfg.outputMapping === 'object' && !Array.isArray(cfg.outputMapping))
      ? (cfg.outputMapping as Record<string, string>)
      : undefined;
    const onChildFailure = cfg.onChildFailure === 'continue' ? 'continue' : 'fail-parent';

    const { dispatchSubWorkflow } = await import('../executor/subWorkflowDispatcher.js');
    try {
      const result = await dispatchSubWorkflow({
        parentRunId: ctx.runId,
        parentTenantId: ctx.tenantId,
        ...(ctx.scopeId ? { parentScopeId: ctx.scopeId } : {}),
        parentNodeId: ctx.nodeId,
        childWorkflowId,
        ...(inputMapping ? { inputMapping } : {}),
        ...(outputMapping ? { outputMapping } : {}),
        onChildFailure,
      });
      // Non-terminal child status → parent suspends with the matching
      // kind. The cancel cascade (routes/runs.ts) walks parentRunId
      // links to invalidate the child interrupt when the parent is
      // cancelled, satisfying the `openwop-interrupt-parent-child`
      // profile in interrupt-profiles.md.
      const TERMINAL: readonly string[] = ['completed', 'failed', 'cancelled'];
      if (!TERMINAL.includes(result.childStatus)) {
        return {
          status: 'suspended',
          interrupt: {
            kind: result.childInterruptKind ?? 'approval',
            data: {
              childRunId: result.childRunId,
              childInterruptNodeId: result.childInterruptNodeId,
              childStatus: result.childStatus,
            },
          },
        };
      }
      if (result.childStatus !== 'completed' && onChildFailure === 'fail-parent') {
        return {
          status: 'failure',
          error: {
            code: 'subworkflow_child_failed',
            message: `child run ${result.childRunId} terminated ${result.childStatus}`,
          },
        };
      }
      return {
        status: 'success',
        outputs: {
          childRunId: result.childRunId,
          childStatus: result.childStatus,
          outputMappingSkipped: result.outputMappingSkipped,
        },
      };
    } catch (err) {
      return {
        status: 'failure',
        error: {
          code: 'internal_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  },
};

/** Per `channels-and-reducers.md §append + §TTL`: append a
 *  `{value, _ts}` entry to the named channel (modeled as a workflow
 *  variable storing an array). When `ttlMs > 0`, drop existing
 *  entries whose `_ts < now - ttlMs` BEFORE appending — the TTL is
 *  a write-time filter, not a read-time one. */
const channelWriteNode: NodeModule = {
  typeId: 'core.channelWrite',
  version: '1.0.0',
  async execute(ctx) {
    const cfg = (ctx.config ?? {}) as { channelName?: unknown; reducer?: unknown; ttlMs?: unknown; value?: unknown };
    const channelName = typeof cfg.channelName === 'string' ? cfg.channelName : '';
    if (!channelName) {
      return { status: 'failure', error: { code: 'invalid_request', message: 'core.channelWrite requires config.channelName' } };
    }
    const reducer = typeof cfg.reducer === 'string' ? cfg.reducer : 'append';
    const ttlMs = typeof cfg.ttlMs === 'number' && cfg.ttlMs > 0 ? cfg.ttlMs : 0;
    const now = Date.now();
    // Dynamic import to avoid bootstrap import cycle.
    const { snapshotRunVariables, setRunVariable } = await import('../host/variablesRuntime.js');
    const bag = snapshotRunVariables(ctx.runId) ?? {};
    const existing = Array.isArray(bag[channelName]) ? (bag[channelName] as Array<{ value: unknown; _ts: number }>) : [];
    let kept = existing;
    if (ttlMs > 0) {
      const cutoff = now - ttlMs;
      kept = existing.filter((e) => typeof e?._ts === 'number' && e._ts >= cutoff);
    }
    if (reducer === 'append') {
      kept = [...kept, { value: cfg.value, _ts: now }];
    } else if (reducer === 'replace') {
      kept = [{ value: cfg.value, _ts: now }];
    }
    setRunVariable(ctx.runId, channelName, kept);
    return { status: 'success', outputs: { channelName, size: kept.length } };
  },
};

const delayNode: NodeModule = {
  typeId: 'core.delay',
  version: '1.0.0',
  async execute(ctx) {
    // Support three input sources, in precedence order:
    //   1. ctx.inputs.delayMs — fixture-shape input port resolved by
    //      the executor from a variable reference (e.g.,
    //      conformance-cancellable seeds delayMs=30000 via its
    //      variable bag, which the executor resolves into the input
    //      port).
    //   2. ctx.config.durationMs — legacy direct config (sample
    //      workflows that hard-code the delay).
    //   3. 0 — safe default.
    // The 60s cap stays — the sample isn't a long-running daemon.
    const inputs = (ctx.inputs ?? {}) as Record<string, unknown>;
    const fromInput = typeof inputs.delayMs === 'number' ? inputs.delayMs : Number(inputs.delayMs);
    const fromConfig = Number(ctx.config?.durationMs);
    const fromConfigShort = Number((ctx.config as { ms?: unknown } | undefined)?.ms);
    const raw = Number.isFinite(fromInput) ? fromInput
      : (Number.isFinite(fromConfig) ? fromConfig
      : (Number.isFinite(fromConfigShort) ? fromConfigShort : 0));
    const ms = Math.max(0, Math.min(60_000, raw));
    await new Promise((r) => setTimeout(r, ms));
    return { status: 'success', outputs: { waitedMs: ms } };
  },
};

/** Deterministic-failure node — terminates with `status: 'failed'`
 *  every time. Inverse of `core.noop`. Conformance fixtures use this
 *  to exercise downstream paths (e.g., RFC 0022 §B "outputMapping is
 *  SKIPPED when child terminates failed/cancelled" — HVMAP-1b-failed). */
const failNode: NodeModule = {
  typeId: 'core.fail',
  version: '1.0.0',
  async execute(ctx) {
    const code = String(ctx.config?.code ?? 'deterministic_fail');
    const message = String(ctx.config?.message ?? 'core.fail node terminated deterministically');
    return { status: 'failure', error: { code, message } };
  },
};

const approvalGateNode: NodeModule = {
  typeId: 'core.approvalGate',
  version: '1.0.0',
  async execute(ctx) {
    const cfg = (ctx.config ?? {}) as {
      prompt?: unknown;
      title?: unknown;
      description?: unknown;
      actions?: unknown;
      requiredApprovals?: unknown;
      rejectionPolicy?: unknown;
      approversList?: unknown;
      approverRefs?: unknown;
      approverGroupRefs?: unknown;
      approverRoleRefs?: unknown;
      overrideScopes?: unknown;
      optionLabels?: unknown;
    };
    // Surface upstream node outputs to the approver. When two or more
    // input ports carry string content (the Triple-AI fan-in shape:
    // three critic summaries reaching the arbiter on distinct ports),
    // bundle them as `options` so the FE card can render a per-option
    // expand + pick button.
    //
    // **Producer↔consumer coupling.** This is the PRODUCER side. The
    // consumer is `ApprovalCard` in
    // `frontend/react/src/chat/registry/defaultCards.tsx`,
    // which renders `data.options` as a picker and sends back
    // `{action: 'approve', content: <picked>, selectedKey, comment?}`
    // as the resume value. `content` is the key the executor's
    // `findFirstStringValue()` walks last (`['prompt', 'text',
    // 'message', 'content', 'completion']`), so downstream nodes pull
    // the picked text out via the standard input-fallback path with
    // no further plumbing. Both sides MUST move together when the
    // shape changes — there's no spec/v1 schema for `data.options`
    // yet (sample-app contract; spec promotion is a follow-up).
    const inputs = (ctx.inputs && typeof ctx.inputs === 'object' && !Array.isArray(ctx.inputs))
      ? (ctx.inputs as Record<string, unknown>)
      : {};
    const optionLabels = (cfg.optionLabels && typeof cfg.optionLabels === 'object')
      ? (cfg.optionLabels as Record<string, string>)
      : {};
    const options: Array<{ key: string; label: string; content: string }> = [];
    for (const [key, value] of Object.entries(inputs)) {
      if (typeof value !== 'string' || value.length === 0) continue;
      const label = optionLabels[key] ?? humanizePortName(key);
      options.push({ key, label, content: value });
    }
    return {
      status: 'suspended',
      interrupt: {
        kind: 'approval',
        // Forward quorum config into interrupt.data so the resolve
        // handler can read requiredApprovals + rejectionPolicy per
        // `interrupt-profiles.md §openwop-interrupt-quorum`. The
        // resolver's `recordQuorumVote` only activates when
        // requiredApprovals > 1; single-approver gates stay on the
        // immediate-resume path.
        data: {
          prompt: typeof cfg.prompt === 'string' ? cfg.prompt : (typeof cfg.title === 'string' ? cfg.title : 'Please approve to continue.'),
          actions: Array.isArray(cfg.actions) ? cfg.actions : ['approve', 'reject'],
          ...(options.length >= 1 ? { options } : {}),
          ...(typeof cfg.requiredApprovals === 'number' ? { requiredApprovals: cfg.requiredApprovals } : {}),
          ...(typeof cfg.rejectionPolicy === 'string' ? { rejectionPolicy: cfg.rejectionPolicy } : {}),
          ...(Array.isArray(cfg.approversList) ? { approversList: cfg.approversList } : {}),
          // ADR 0070 — eligible approver subjects + override scopes for the quorum gate.
          ...(Array.isArray(cfg.approverRefs) ? { approverRefs: cfg.approverRefs } : {}),
          // ADR 0075 / RFC 0104 (Active) — group/role approver refs, host-resolved
          // against the run's org to the eligible subject set at resolve time.
          ...(Array.isArray(cfg.approverGroupRefs) ? { approverGroupRefs: cfg.approverGroupRefs } : {}),
          ...(Array.isArray(cfg.approverRoleRefs) ? { approverRoleRefs: cfg.approverRoleRefs } : {}),
          ...(Array.isArray(cfg.overrideScopes) ? { overrideScopes: cfg.overrideScopes } : {}),
        },
      },
    };
  },
};

/** Port names like `_gate_2` / `option_clarity` get turned into human-
 *  readable labels for the approval card. Strips leading underscores,
 *  splits on `_`/`-`, and Title Cases each segment. */
function humanizePortName(key: string): string {
  const stripped = key.replace(/^_+/, '');
  const parts = stripped.split(/[-_]+/).filter(Boolean);
  if (parts.length === 0) return key;
  return parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

const clarificationGateNode: NodeModule = {
  typeId: 'core.clarificationGate',
  version: '1.0.0',
  async execute(ctx) {
    return {
      status: 'suspended',
      interrupt: {
        kind: 'clarification',
        data: {
          question: ctx.config?.question ?? 'Please clarify.',
          schema: ctx.config?.schema ?? { type: 'string' },
        },
      },
    };
  },
};

const VALID_KINDS = ['approval', 'clarification', 'refinement', 'cancellation', 'external-event'] as const;
type InterruptKind = (typeof VALID_KINDS)[number];
function coerceKind(raw: unknown): InterruptKind {
  return VALID_KINDS.includes(raw as InterruptKind) ? (raw as InterruptKind) : 'approval';
}

const interruptNode: NodeModule = {
  typeId: 'core.interrupt',
  version: '1.0.0',
  async execute(ctx) {
    return {
      status: 'suspended',
      interrupt: { kind: coerceKind(ctx.config?.kind), data: ctx.config?.data ?? {} },
    };
  },
};

// Multi-turn conversation primitive (RFC 0005, MAS Phase 4). Gated on
// `capabilities.conversationPrimitive: true` (see routes/discovery.ts +
// routes/runs.ts refusal). The node only OPENS the conversation: it mints a
// deterministic `conversationId`, emits `conversation.opened` (turnIndex 0), and
// SUSPENDS. Per RFC 0005 §D, each `exchange` round-trips through the resolve
// endpoint WITHOUT resuming the node (it appends the user turn, dispatches the
// addressed agent, emits `conversation.exchanged`, and leaves the node
// suspended); only `operation: 'close'` resumes the node. Exchange handling
// lives in routes/interrupts.ts so it has the storage + dispatch surface.
export const conversationGateNode: NodeModule = {
  typeId: 'core.conversationGate',
  version: '1.0.0',
  async execute(ctx) {
    const cfg = (ctx.config ?? {}) as { prompt?: unknown; schema?: unknown; mockAutoResume?: unknown; turnCount?: unknown; participants?: unknown };
    const conversationId = conversationIdFor(ctx.runId, ctx.nodeId);
    // RFC 0101 (ADR 0040 Phase 6) — when a multi-party conversation declares its
    // agent cohort at OPEN time, carry the participant roster onto
    // `conversation.opened` so a cross-host peer/auditor/replayer can discover
    // "this conversation has advisors A,B,C". Additive: absent ⇒ omitted (a 1:1 /
    // ungrouped chat opens with no roster, exactly as before). A board summoned
    // INTO an existing chat (the common path) is still observable via the
    // per-turn `speakerId` + the roster on the chat's `ConversationMeta`.
    const participants = Array.isArray(cfg.participants)
      ? cfg.participants
          .map((p) => (p && typeof p === 'object' && typeof (p as { agentId?: unknown }).agentId === 'string'
            ? { agentId: (p as { agentId: string }).agentId }
            : null))
          .filter((p): p is { agentId: string } => p !== null)
      : undefined;

    // Conformance / replay-determinism mode (RFC 0005 §G). When
    // `mockAutoResume: true`, self-drive the whole conversation to COMPLETION in
    // one execution — open → N exchanges → close — with NO human resume and NO
    // LLM. Every channel id + timestamp is runId-INDEPENDENT (keyed on nodeId +
    // turnIndex), so a `:fork` (mode: replay, different runId) re-executes to a
    // BYTE-EQUAL `conversation` channel projection — the conversationReplayDeterminism
    // contract. The `conversation.*` event payloads carry the per-run
    // conversationId (events aren't byte-compared; only the channel is).
    if (cfg.mockAutoResume === true) {
      const turnCount = typeof cfg.turnCount === 'number' && cfg.turnCount > 0 ? Math.floor(cfg.turnCount) : 1;
      const CH = 'conversation';
      const detTs = (i: number): string => new Date(i * 1000).toISOString(); // fork-stable
      const detId = (i: number, role: string): string => `${ctx.nodeId}:${i}:${role}`;
      const writeTurn = async (idx: number, role: 'system' | 'user' | 'agent', from: string, content: string): Promise<void> => {
        const turn = makeTurn({ conversationId, turnIndex: idx, role, from, content, ts: idx, groupId: conversationId });
        const evt = idx === 0 ? 'conversation.opened' : 'conversation.exchanged';
        await ctx.emit(evt, idx === 0 ? { conversationId, initialTurn: turn, capabilities: ['multi-turn'] } : { conversationId, turnIndex: idx, turn });
        appendChannelMessage(ctx.runId, CH, { messageId: detId(idx, role), role: role === 'agent' ? 'assistant' : role, content, timestamp: detTs(idx) });
      };
      await writeTurn(0, 'system', 'system', 'Conversation started.');
      let idx = 1;
      for (let t = 0; t < turnCount; t++) {
        await writeTurn(idx++, 'user', 'user', `Turn ${t + 1} from the user.`);
        await writeTurn(idx++, 'agent', 'assistant', `Acknowledged turn ${t + 1}.`);
      }
      const finalTurn = makeTurn({ conversationId, turnIndex: idx, role: 'system', from: 'system', content: 'Conversation closed.', ts: idx, groupId: conversationId });
      await ctx.emit('conversation.closed', { conversationId, turnIndex: idx, finalTurn });
      appendChannelMessage(ctx.runId, CH, { messageId: detId(idx, 'system'), role: 'system', content: 'Conversation closed.', timestamp: detTs(idx) });
      return { status: 'success', outputs: { conversationId, turns: idx + 1 } };
    }

    // Sample-grade: ts is the host wall clock (the existing chat path does the
    // same). Replay re-folds `conversation.*` from the log (RFC 0005 §G), so the
    // exchange turns are never re-dispatched; the open turn's ts is advisory.
    const initialTurn = makeTurn({
      conversationId,
      turnIndex: 0,
      role: 'system',
      from: 'system',
      content: typeof cfg.prompt === 'string' ? cfg.prompt : 'Conversation opened.',
      ts: Date.now(),
    });
    const schema = cfg.schema && typeof cfg.schema === 'object' ? (cfg.schema as Record<string, unknown>) : undefined;
    await ctx.emit('conversation.opened', {
      conversationId,
      initialTurn,
      ...(schema ? { schema } : {}),
      ...(participants && participants.length > 0 ? { participants } : {}),
      capabilities: ['multi-turn'],
    });
    return {
      status: 'suspended',
      interrupt: {
        kind: 'conversation',
        data: { conversationId, turnIndex: 0 },
        ...(schema ? { resumeSchema: schema } : {}),
      },
    };
  },
};

// Mock AI node — demonstrates the cost-attribution pattern. Real
// deployers wire core.openwop.ai (published pack) which calls actual
// providers and records real token counts + USD via emitCost().
//
// RFC 0027 + RFC 0029 integration: when any of the four PromptRef
// kinds is set on `config` (`systemPromptRef`, `userPromptRef`,
// `schemaHintPromptRef`, `fewShotPromptRefs[]`), the node walks the
// four-layer resolution chain (per `spec/v1/prompts.md` §"Resolution
// chain (normative)"), emits one `agent.promptResolved` event per
// kind+slot resolved, then composes the body via the host's
// composition pipeline and emits one `prompt.composed` event per
// composition. The composed bodies are concatenated into the prompt
// the mock LLM responds to.
const mockAiNode: NodeModule = {
  typeId: 'local.sample.demo.mock-ai',
  version: '0.1.0',
  async execute(ctx) {
    const inputs = (ctx.inputs && typeof ctx.inputs === 'object') ? (ctx.inputs as Record<string, unknown>) : {};
    const cfg = (ctx.config ?? {}) as {
      systemPromptRef?: unknown;
      userPromptRef?: unknown;
      schemaHintPromptRef?: unknown;
      fewShotPromptRefs?: unknown[];
      agentId?: string;
    };

    // ── Prompt-library integration ────────────────────────────────
    // For each kind whose ref(s) is/are set, walk the resolution
    // chain, emit `agent.promptResolved`, then (if resolved) compose
    // + emit `prompt.composed`. The discovery-advertised capability
    // values (observability + agentBindings) are read from the
    // shared `getPromptsHostConfig()` so a deployer who tightens the
    // advertisement can't end up with a dispatch path that emits
    // looser data than the host claims to expose.
    //
    // All four kinds defined in `schemas/prompt-kind.schema.json` are
    // wired (RFC 0027 §A):
    //   - `system` / `user` / `schema-hint` — singular ref fields.
    //   - `few-shot` — plural `fewShotPromptRefs[]` (each entry
    //     resolves + composes independently; one event pair per
    //     entry).
    //
    // The mock LLM "prompt" is the concatenation of composed bodies
    // in the conventional dispatch order (per myndhyve precedent +
    // RFC 0027 prose): system → schema-hint → few-shot exemplars →
    // user. Real provider dispatchers (e.g., `core.openwop.ai`)
    // route each kind to its provider-specific slot (system message,
    // response_format hint, assistant/user exemplar pairs, user
    // message) rather than concatenating; the mock LLM here only
    // needs to verify the dispatch reaches each composed body.
    const promptsConfig = getPromptsHostConfig();

    /** Compose one template by ref, emit the chain + composed events,
     *  and return the composed body (or null on miss). The kind is
     *  passed through to the resolver + composer so observability
     *  events carry accurate per-kind attribution. The slotIndex
     *  argument disambiguates few-shot entries when multiple refs
     *  share the same kind — for kind: "few-shot", the resolver
     *  reads `fewShotPromptRefs[slotIndex]`; ignored for the
     *  singular-ref kinds. */
    const composeRef = async (
      kind: PromptKind,
      refValue: unknown,
      slotIndex: number = 0,
    ): Promise<string | null> => {
      if (refValue === undefined || refValue === null || refValue === '') return null;

      const resolution = resolvePromptRef({
        kind,
        node: { nodeId: ctx.nodeId, config: cfg },
        agentBindingsSupported: promptsConfig.agentBindings,
        fewShotIndex: slotIndex,
      });
      // agent.promptResolved emits before any composition so cross-
      // host debuggers see the chain trace whether or not composition
      // succeeds. The event carries refs (not bodies), so emission
      // is safe regardless of observability mode.
      await ctx.emit('agent.promptResolved', resolution);

      if (resolution.resolved === null) return null;

      // Parse the winning ref to look up the template. Stringy form
      // `prompt:templateId[@version]` is canonical for the resolver's
      // output.
      const refMatch = /^prompt:([a-z0-9][a-z0-9._-]{0,127})(?:@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?))?$/.exec(resolution.resolved);
      if (!refMatch) return null;
      const templateId = refMatch[1]!;
      const version = refMatch[2];
      const found = getTemplate(templateId, version !== undefined ? { version } : {});
      if (!found || found === 'ambiguous') return null;

      // Compose with ctx.inputs as the variable-binding source. The
      // composer respects PromptVariable.source declarations on the
      // template (secret-source → BYOK lookup, etc.) and emits the
      // composed body with redaction + trust-marker preservation.
      // observability is read from the shared host config so the
      // emitted payload matches what the host advertised — a
      // deployer who tightens to "hashed" or "off" gets the strict
      // emission without further dispatch-path changes.
      const composed = await composePromptTemplate({
        templateId,
        bindings: inputs,
        observability: promptsConfig.observability,
        nodeId: ctx.nodeId,
      });
      await ctx.emit('prompt.composed', composed);
      return composed.composed ?? null;
    };

    const systemBody = await composeRef('system', cfg.systemPromptRef);
    const schemaHintBody = await composeRef('schema-hint', cfg.schemaHintPromptRef);
    const fewShotBodies: string[] = [];
    if (Array.isArray(cfg.fewShotPromptRefs)) {
      for (let i = 0; i < cfg.fewShotPromptRefs.length; i++) {
        const body = await composeRef('few-shot', cfg.fewShotPromptRefs[i], i);
        if (body !== null) fewShotBodies.push(body);
      }
    }
    const userBody = await composeRef('user', cfg.userPromptRef);

    // Concatenate composed bodies in the conventional dispatch order.
    // Fallback chain expanded so multi-step workflows always produce
    // a non-empty mock output even when (a) prompt composition returns
    // null bodies despite the ref resolving, or (b) an upstream edge
    // delivered the text under a different input field (`inputs.text`
    // from an `uppercase` node, `inputs.message`, etc.) than the
    // canonical `inputs.prompt`. Previously these cases produced the
    // literal stub "Mock response to:" with nothing after, which read
    // as broken to demo users.
    const parts: string[] = [];
    if (systemBody !== null) parts.push(systemBody);
    if (schemaHintBody !== null) parts.push(schemaHintBody);
    for (const f of fewShotBodies) parts.push(f);
    if (userBody !== null) parts.push(userBody);
    function firstStringInput(): string {
      // Walk the most-common upstream port names in order of likelihood,
      // then fall back to any string-valued input field. Keeps the demo
      // from rendering empty cards when an edge maps to a non-canonical
      // input port. `text` is what `uppercase` emits; `prompt` is the
      // canonical mock-ai input; `message` covers chat-style upstreams.
      for (const k of ['prompt', 'text', 'message', 'content', 'input']) {
        const v = inputs[k];
        if (typeof v === 'string' && v.length > 0) return v;
      }
      for (const v of Object.values(inputs)) {
        if (typeof v === 'string' && v.length > 0) return v;
      }
      return '';
    }
    const prompt = parts.length > 0
      ? parts.join('\n\n')
      : firstStringInput();

    // Simulated token accounting — real impls read from the provider response.
    const promptTokens = Math.ceil(prompt.length / 4);
    const completionTokens = Math.max(8, Math.floor(promptTokens / 2));
    emitCost({
      provider: 'mock',
      model: 'mock-mini',
      promptTokens,
      completionTokens,
      // Mock pricing: $0.001/1k prompt, $0.002/1k completion.
      usdCost: (promptTokens * 0.001 + completionTokens * 0.002) / 1000,
    });
    return {
      status: 'success',
      outputs: { completion: `Mock response to: ${prompt.slice(0, 80)}` },
    };
  },
};

// Chat responder — dispatches to a real AI provider via raw fetch.
// Reads BYOK credentialRef from ctx.secrets, model/provider from inputs,
// and streams tokens via ai.message.chunk events (ADR 0079).
//
// Tool calling: when inputs.tools is a non-empty array of
// {workflowId, name, description}, the node routes anthropic dispatch
// through `dispatchAnthropicWithTools` and lets the model invoke saved
// workflows as tools. Each tool_use dispatches a sub-run via
// `dispatchSubRun` with a 30s budget; the result (or a "pending" stub
// if it hits an interrupt) feeds back as tool_result.
/**
 * Resolve `agent.reasoned` verbosity per `capabilities.md` precedence:
 *   per-run `RunOptions.configurable.reasoningVerbosity`
 *   > host capability default (advertised in /.well-known/openwop)
 *   > suite default (default arg)
 * Returns the resolved verbosity along with `agent.reasoning.delta` +
 * `agent.reasoned` emission callbacks bound to `ctx` and `agentId`.
 *
 * The callbacks are `undefined` when resolved verbosity is `'off'` —
 * the dispatcher's optional spread (`...(cb ? { cb } : {})`) skips
 * registration entirely in that case, so the provider's server-side
 * thinking surface stays disabled too.
 *
 * SR-1 redaction: `ctx.emit` routes every payload through
 * `stripSecretsFromPersisted` (executor.ts:emit). Any host-resolved
 * credential the model echoes into reasoning is redacted before the
 * event lands in the log. See `SECURITY/threat-model-secret-leakage.md`.
 */
function buildReasoningCallbacks(
  ctx: NodeContext,
  agentId: string,
  defaultVerbosity: 'summary' | 'full' | 'off',
): {
  verbosity: 'summary' | 'full' | 'off';
  onReasoningDelta?: (delta: string) => Promise<void>;
  onReasoningBlock?: (block: string) => Promise<void>;
} {
  const reqVerbosity = ctx.configurable?.reasoningVerbosity;
  const verbosity: 'summary' | 'full' | 'off' =
    reqVerbosity === 'off' || reqVerbosity === 'full' || reqVerbosity === 'summary'
      ? reqVerbosity
      : defaultVerbosity;
  if (verbosity === 'off') return { verbosity };
  // RFC 0024: per-block sequence counter. Resets to 0 on each closed
  // block so consumers can detect dropped deltas within a block without
  // global cross-block bookkeeping.
  let seq = 0;
  return {
    verbosity,
    onReasoningDelta: async (delta: string): Promise<void> => {
      await ctx.emit('agent.reasoning.delta', { agentId, delta, sequence: seq, verbosity });
      seq++;
    },
    onReasoningBlock: async (block: string): Promise<void> => {
      // Closing event carries the full content (truncated under
      // 'summary'). Per RFC 0024, this event is authoritative even
      // if it disagrees with the delta concatenation.
      const reasoning = verbosity === 'summary' ? block.slice(0, 2048) : block;
      await ctx.emit('agent.reasoned', { agentId, reasoning, verbosity });
      seq = 0;
    },
  };
}

/**
 * RFC 0032 §B.3 + §B.4 — emit `envelope.refusal` / `envelope.truncated` from
 * the chat-responder dispatch path so the live AI chat surfaces these signals
 * the same way `aiProvidersHost.dispatchStructured()` does for structured-
 * output paths. The chat-responder doesn't have retry, NL→format coercion,
 * or recovery loops (those are structured-output features), so only refusal
 * and truncation apply here.
 *
 * Refusal detection: each provider returns a vendor-native finishReason on
 * safety stop:
 *   - Anthropic: 'refusal' (2025 stop_reason) | 'end_turn' with empty body
 *   - OpenAI:    'content_filter'
 *   - Gemini:    'SAFETY' | 'RECITATION' OR a non-empty `blockReason`
 * Truncation detection: vendor-native `length` / `max_tokens` / `MAX_TOKENS`.
 *
 * Refusal text is intentionally NOT included on the wire to honor the
 * SECURITY invariant `envelope-refusal-no-prompt-leak` — the partial
 * completion would echo prompt content.
 */
async function emitChatEnvelopeSignals(
  ctx: NodeContext,
  result: DispatchResult | ManagedDispatchResult,
): Promise<void> {
  const fr = (result.finishReason ?? '').toLowerCase();
  // RFC 0032 §B.3 — refusal detection lifted to @openwop/openwop's parseRefusal()
  // helper, called by each dispatcher in providers/dispatch.ts and surfaced
  // here as a typed RefusalSignal. ManagedDispatchResult doesn't carry the
  // signal (managed-provider path goes through a different pipeline), so the
  // narrowing `'refusal' in result` keeps the union safe under
  // exactOptionalPropertyTypes.
  const refusal = 'refusal' in result ? result.refusal : undefined;
  if (refusal) {
    try {
      await ctx.emit(
        'envelope.refusal',
        buildRefusalPayload(
          ctx.nodeId,
          result.provider,
          result.model,
          // refusalText omitted from the wire per SECURITY/invariants.yaml
          // §envelope-refusal-no-prompt-leak — provider refusal messages CAN
          // echo prompt content, and the chat-responder has no redaction
          // harness wired yet. The signal's presence is enough to fire the chip;
          // the FE doesn't need the text.
          undefined,
          refusal.safetyCategory,
        ),
      );
    } catch { /* best-effort emission — never block the response */ }
  }

  const isTruncated = fr === 'max_tokens' || fr === 'length';
  if (isTruncated) {
    try {
      // Preserve OpenAI's `length` distinction per RFC 0032 §B.4 schema description
      // (`length preserved as a separate value for hosts that distinguish provider-
      // side length cap from host-side budget cap`). The chat-responder sees the
      // raw provider string, so we can keep the fidelity the reference
      // classifyTruncationStopReason() helper has to collapse upstream.
      const stopReason = fr === 'length' ? 'length' : 'max_tokens';
      await ctx.emit(
        'envelope.truncated',
        buildTruncatedPayload(
          ctx.nodeId,
          result.provider,
          result.model,
          stopReason,
          result.completion.length > 0,
          // outputTokens: pass `undefined` on absence so the helper omits the field
          // (`!== undefined` guard). The wire shape accepts both null and absent,
          // but absent matches the structured-output emission convention.
          result.usage?.outputTokens,
        ),
      );
    } catch { /* best-effort */ }
  }
}

/**
 * Sample chat-responder. Sits in the `vendor.openwop-app.*` namespace
 * per `spec/v1/node-packs.md` §"Reserved-typeIds" (the unrestricted
 * carve-out), which puts it inside RFC 0023 §A's authorized-emitter
 * scope for `agent.reasoned` events.
 */
/** Resolve a PromptRef declared in node config (per RFC 0027), compose
 *  the template body against the run inputs, and return the composed
 *  string. Returns null when the ref is unset, unresolvable, points at
 *  an ambiguous/missing template, or the composer emits an empty body.
 *  Emits `agent.promptResolved` + `prompt.composed` events identically
 *  to the mock-ai path so observability is uniform across executors. */
async function resolveAndComposePromptRef(
  ctx: NodeContext,
  kind: PromptKind,
  refValue: unknown,
  inputs: Record<string, unknown>,
): Promise<string | null> {
  if (refValue === undefined || refValue === null || refValue === '') return null;
  const cfg = (ctx.config ?? {}) as Record<string, unknown>;
  const promptsConfig = getPromptsHostConfig();
  const resolution = resolvePromptRef({
    kind,
    node: { nodeId: ctx.nodeId, config: cfg },
    agentBindingsSupported: promptsConfig.agentBindings,
  });
  await ctx.emit('agent.promptResolved', resolution);
  if (resolution.resolved === null) return null;
  const refMatch = /^prompt:([a-z0-9][a-z0-9._-]{0,127})(?:@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?))?$/.exec(resolution.resolved);
  if (!refMatch) return null;
  const templateId = refMatch[1]!;
  const version = refMatch[2];
  const found = getTemplate(templateId, version !== undefined ? { version } : {});
  if (!found || found === 'ambiguous') return null;
  const composed = await composePromptTemplate({
    templateId,
    bindings: inputs,
    observability: promptsConfig.observability,
    nodeId: ctx.nodeId,
  });
  await ctx.emit('prompt.composed', composed);
  return composed.composed ?? null;
}

/** Walk the inputs map looking for a usable string. Tries the canonical
 *  port names first, then any string-valued field, then one level into
 *  nested objects (covers cases where an upstream node delivered a
 *  whole outputs map under a single port — e.g., `{ in: { text: '...' }}`
 *  from a noop fan-in). Returns the first non-empty string found. */
function findFirstStringValue(inputs: Record<string, unknown>): string | undefined {
  for (const k of ['prompt', 'text', 'message', 'content', 'input', 'in']) {
    const v = inputs[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const v of Object.values(inputs)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  for (const v of Object.values(inputs)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const nested = v as Record<string, unknown>;
      for (const k of ['prompt', 'text', 'message', 'content', 'completion']) {
        const inner = nested[k];
        if (typeof inner === 'string' && inner.length > 0) return inner;
      }
    }
  }
  return undefined;
}

function lastIndexOfRole(messages: readonly ChatMessage[], role: ChatMessage['role']): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === role) return i;
  }
  return -1;
}

/** The acting human's display name for the persona scaffold — tenant-scoped
 *  (CTI-1) and fail-soft: any miss/error ⇒ null, so the scaffold addresses the
 *  user neutrally rather than risk a wrong name. Anonymous callers carry no
 *  `actingUserId` and so take the neutral path by construction. */
async function resolveActingUserName(ctx: { actingUserId?: string; tenantId: string }): Promise<string | null> {
  if (!ctx.actingUserId) return null;
  try {
    const user = await getUser(ctx.actingUserId);
    if (!user) return null;
    if (user.tenantId && user.tenantId !== ctx.tenantId) return null; // never borrow a name across tenants
    const name = user.displayName?.trim();
    return name && name.length > 0 ? name : null;
  } catch {
    return null;
  }
}

/** Replace the TEXT of a (possibly multi-modal) user turn with `text` while
 *  PRESERVING any non-text attachment parts. A `userPromptRef` that resolves
 *  to a string must not silently drop the image/file the user attached. */
function withUserText(original: ChatMessage['content'], text: string): ChatMessage['content'] {
  if (typeof original === 'string') return text;
  const nonText = original.filter((p) => p.type !== 'text');
  if (nonText.length === 0) return text;
  return [{ type: 'text', text }, ...nonText];
}

/** Extract the capability token from a host media-asset serve URL, or null. */
function tokenFromAssetUrl(url: string): string | null {
  const m = /\/v1\/host\/openwop-app\/assets\/([^/?#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Resolve any URL-referenced image/file attachment to inline `dataBase64`
 *  BEFORE dispatch. Providers can't fetch a relative host URL, and inlining
 *  here keeps a forked/replayed run self-contained. Tenant-checked (CTI-1):
 *  a token minted for another tenant — or an expired one — fails closed. */
async function resolveAttachmentBytes(messages: readonly ChatMessage[], tenantId: string): Promise<ChatMessage[]> {
  let touched = false;
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') { out.push(m); continue; }
    const parts: ContentPart[] = [];
    for (const part of m.content) {
      if ((part.type === 'image' || part.type === 'file') && !part.dataBase64 && part.url) {
        const token = tokenFromAssetUrl(part.url);
        const entry = token ? await resolveMediaAsset(token) : null;
        if (!entry || entry.tenantId !== tenantId) {
          throw new Error('a referenced attachment is unavailable or has expired — re-attach the file and retry');
        }
        parts.push({ ...part, dataBase64: entry.contentBase64, mimeType: part.mimeType || entry.contentType });
        touched = true;
      } else {
        parts.push(part);
      }
    }
    out.push({ ...m, content: parts });
  }
  return touched ? out : [...messages];
}

/** Upper bound on managed-chat (openwop-free / MiniMax) dispatch wall
 *  time. Without a timeout, an unresponsive upstream parks the worker
 *  forever and the run goes `running` with no further events.
 *  Override per-deploy via `OPENWOP_MANAGED_CHAT_TIMEOUT_MS`. Read
 *  once at module load — restart Cloud Run revision to pick up a
 *  changed value (matches the convention for `maxConcurrentNodes`).
 *  Use `let` (not `const`) so the `_setManagedChatTimeoutMs` test
 *  affordance below can swing the value at runtime without dynamic
 *  re-import gymnastics. */
let MANAGED_CHAT_TIMEOUT_MS =
  Number(process.env.OPENWOP_MANAGED_CHAT_TIMEOUT_MS) || 60_000;

/** Test affordance — override the managed-chat timeout for a single
 *  test run. Mirrors the `_resetOidcVerifier` convention used by the
 *  auth middleware tests. NOT for production callers; the env var is
 *  the supported configuration surface. */
export function _setManagedChatTimeoutMs(ms: number): void {
  MANAGED_CHAT_TIMEOUT_MS = ms;
}

// Exported for test access; production callers wire via the registry
// in `registerExampleNodes` below.
export const chatResponderNode: NodeModule = {
  typeId: CHAT_RESPONDER_TYPE_ID,
  version: '0.2.0',
  async execute(ctx) {
    const inputs = (ctx.inputs && typeof ctx.inputs === 'object') ? (ctx.inputs as Record<string, unknown>) : {};
    const config = (ctx.config && typeof ctx.config === 'object') ? (ctx.config as Record<string, unknown>) : {};
    // Per-node provider/model/credentialRef precedence: workflow node
    // config FIRST (set via the builder Inspector), inputs SECOND (the
    // chat-tab path supplies these through the run's inputs). Keeps
    // chat-tab semantics unchanged while letting builder-authored
    // workflows pin each chat node to a specific provider+model+key.
    const provider =
      (config.provider as ProviderId | undefined) ??
      (inputs.provider as ProviderId | undefined) ??
      'anthropic';
    const model =
      (config.model as string | undefined) ??
      (inputs.model as string | undefined) ??
      getDefaultModel(provider);
    // Default to the managed `openwop-free` tile when no credential is
    // pinned at the workflow-graph or run-input layer. Lets builder
    // templates (and freshly-dragged chat nodes) call a real LLM out of
    // the box — the user only has to swap the credential when they want
    // a different model or their own key.
    const credentialRef =
      (config.credentialRef as string | undefined) ??
      (inputs.credentialRef as string | undefined) ??
      'managed:openwop-free';
    // Accept either a multi-turn `messages` array (chat-tab shape) OR a
    // single `prompt` string (workflow-graph shape, what `uppercase` /
    // `etl-extractor` / other text-emitting upstream nodes deliver under
    // the `prompt` port). When only `prompt` is present, wrap it into a
    // one-shot user turn. Common upstream port names are walked in the
    // same order as the mock-ai fallback so the swap from `mock-ai` →
    // `chat` is wire-shape-compatible.
    let messages = inputs.messages as ChatMessage[] | undefined;
    if (!Array.isArray(messages) || messages.length === 0) {
      const promptText = findFirstStringValue(inputs);
      if (promptText !== undefined) {
        messages = [{ role: 'user', content: promptText }];
      }
    }
    const maxTokens = typeof inputs.maxTokens === 'number' ? inputs.maxTokens : 1024;
    const webSearch = inputs.webSearch === true;
    const rawTools = Array.isArray(inputs.tools) ? (inputs.tools as ToolBinding[]) : [];

    if (!Array.isArray(messages) || messages.length === 0) {
      // Diagnostic — surfaces which input ports actually arrived so a
      // misconfigured fan-out / port-name mismatch can be traced from
      // the run event log without a separate logging round-trip.
      const inputKeys = Object.keys(inputs);
      return {
        status: 'failure',
        error: {
          code: 'invalid_request',
          message:
            inputKeys.length === 0
              ? 'No upstream inputs reached this chat node. Check the workflow edges.'
              : `Chat node received inputs on ports [${inputKeys.join(', ')}] but none carried a string. Edges should map to a port named one of: prompt, text, message, content, input.`,
        },
      };
    }

    // Resolve a system message from one of four sources, in precedence
    // order:
    //   (1) `inputs.agentId` — an active agent from the chat-tab's
    //       active-agents lineup (phase D2). When set, the chat is
    //       routing through that agent's persona, so its
    //       resolvedSystemPrompt overrides the node-level config. The
    //       agent is read from the in-process AgentRegistry (RFC 0070);
    //       missing-agent gracefully falls through to (2) so an
    //       uninstalled agent doesn't break the turn.
    //   (2) `config.systemPrompt` — a literal string the template
    //       or Inspector wires directly (no host-side template registry
    //       needed).
    //   (3) `config.systemPromptRef` — an RFC 0027 PromptRef pointing
    //       at a template in the host prompt store.
    //   (4) nothing — the LLM sees only the user turn.
    // The composed body is prepended as a `role: 'system'` message so
    // the LLM has its role before reading the user's content.
    let systemBody: string | null = null;
    const agentIdInput = inputs['agentId'];
    if (typeof agentIdInput === 'string' && agentIdInput.length > 0) {
      // `resolve()` (not `get()`) so a seeded/user agent absent from THIS
      // instance's boot-hydrated registry is read through from durable storage
      // (agentPackResolver miss-path) rather than silently falling through to
      // the default prompt — the chat turn routes correctly on any instance.
      const agent = await getAgentRegistry().resolve(agentIdInput);
      // Cross-tenant isolation (CTI-1, agent-memory.md). User-authored
      // agents carry `ownerTenant`; pack-installed agents don't. The
      // request that triggered this node carries `ctx.tenantId` (the
      // executor sets it from the run record). Reject mismatches by
      // silently falling through to the default system-prompt path —
      // surfacing a 403 here would leak which agent ids exist in
      // another tenant.
      const tenantOk = !agent || !agent.ownerTenant || agent.ownerTenant === ctx.tenantId;
      if (agent && agent.systemPrompt && tenantOk) {
        // Wrap the persona prompt with the multi-agent persona-preservation
        // scaffold (user identity + narrative-casting framing + recency
        // re-anchor) so the agent doesn't (a) treat a prior agent's name as the
        // user's, or (b) impersonate another agent whose turns are in the shared
        // history. The user's display name is resolved from the durable acting
        // user, tenant-scoped (CTI-1); absent (anonymous) ⇒ neutral fallback.
        const userName = await resolveActingUserName(ctx);
        systemBody = composeAgentSystemPrompt({
          persona: agent.persona,
          role: agent.label,
          systemPrompt: agent.systemPrompt,
          userName,
        });
        // `vendor.openwop-app.agent.routed` — vendor-namespaced
        // per host-extensions.md §"Canonical prefixes" so a future
        // RFC 0024 `agent.*` event can't collide.
        //
        // `systemPromptHash` is a replay-determinism anchor (sha256
        // truncated to 16 hex chars — enough collision resistance for
        // drift detection without bloating the event log). User-
        // authored agent systemPrompts are mutable storage: editing
        // the agent between an original run and a replay produces
        // different LLM output. A replay can compare the recorded
        // hash to the registry's current resolution and emit a
        // divergence signal when they differ. Pack-installed agents
        // are immutable post-install so the hash is stable across
        // replays for them too.
        const systemPromptHash = createHash('sha256')
          .update(agent.systemPrompt)
          .digest('hex')
          .slice(0, 16);
        await ctx.emit('vendor.openwop-app.agent.routed', {
          agentId: agent.agentId,
          persona: agent.persona,
          modelClass: agent.modelClass,
          source: agent.ownerTenant ? 'user' : 'pack',
          systemPromptHash,
          systemPromptLength: agent.systemPrompt.length,
        });

        // ADR 0043 Phase 5B: compose this agent's bound knowledge (ADR 0038) into
        // the turn so advisors recall their preseeded memory + bound KB. Appended
        // to the system prompt (keeps a single system message — see the de-dup
        // note below). Gated on the agent's `knowledge` capability
        // (`resolveAgentKnowledgeRetrieve` returns undefined otherwise) and
        // entirely best-effort, so an agent without a binding — or a KB/memory
        // backend hiccup — leaves the turn byte-identical to before.
        //
        // Retrieval query: an explicit `inputs.knowledgeQuery` wins, else the
        // latest user text. The boardroom cadence (ADR 0043 Phase 5A) sets the
        // explicit query to the user's ORIGINAL question, so each advisor
        // retrieves against the real topic — not the bland "<persona>, your
        // perspective?" hand-off that is the latest user turn on a cadence step.
        // Knowledge is a TEXT query: a multimodal-only turn (no string user
        // content and no explicit query) simply skips retrieval.
        const knowledgeQuery = ((): string => {
          const explicit = inputs['knowledgeQuery'];
          if (typeof explicit === 'string' && explicit.trim().length > 0) return explicit;
          const li = lastIndexOfRole(messages, 'user');
          const last = li >= 0 ? messages[li] : undefined;
          return typeof last?.content === 'string' ? last.content : '';
        })();
        if (knowledgeQuery) {
          try {
            // A per-agent profile read on the hot path — a cheap point lookup
            // that returns undefined fast for agents with no `knowledge` binding.
            const memory = createAgentMemoryPort(ctx.tenantId);
            const retrieve = await resolveAgentKnowledgeRetrieve(ctx.tenantId, agent.agentId, memory, agentMemoryScope(agent.agentId));
            if (retrieve) {
              const knowledgeBlock = await composeAgentKnowledgeContext(retrieve, knowledgeQuery);
              if (knowledgeBlock) systemBody = `${systemBody}\n\n${knowledgeBlock}`;
            }
          } catch {
            /* best-effort — knowledge never fails the turn */
          }
        }
      }
    }
    if (systemBody === null) {
      const literalSystem = config['systemPrompt'];
      if (typeof literalSystem === 'string' && literalSystem.length > 0) {
        systemBody = literalSystem;
      } else {
        systemBody = await resolveAndComposePromptRef(ctx, 'system', config['systemPromptRef'], inputs);
      }
    }
    if (systemBody !== null) {
      // The resolved systemBody (from agent / config.systemPrompt /
      // config.systemPromptRef, in that precedence) is authoritative —
      // strip any system messages already present in `messages` before
      // prepending so the dispatch carries exactly ONE system message.
      // The chat-tab path bundles its own default system prompt into
      // `inputs.messages`; when an agent is active OR the workflow
      // pins its own system, we'd otherwise emit two system messages
      // back-to-back. MiniMax (the managed default, now MiniMax-M3;
      // first hit on M2.7) rejects that with HTTP 400
      // `invalid params, invalid chat setting (2013)` (confirmed by
      // direct curl bisect — single system passes, two systems fail).
      // Anthropic accepts multi-system but collapses them; OpenAI
      // accepts but the API contract increasingly recommends one.
      // De-duplicating here is the correct shape for every provider.
      messages = [
        { role: 'system', content: systemBody },
        ...messages.filter((m) => m.role !== 'system'),
      ];
    }
    const userBody = await resolveAndComposePromptRef(ctx, 'user', config['userPromptRef'], inputs);
    if (userBody !== null) {
      // Replace only the trailing user turn so multi-turn chat histories
      // (chat-tab path) keep their earlier turns intact.
      const lastUserIdx = lastIndexOfRole(messages, 'user');
      if (lastUserIdx >= 0) {
        messages = messages.map((m, i) =>
          i === lastUserIdx ? { ...m, content: withUserText(m.content, userBody) } : m,
        );
      } else {
        messages = [...messages, { role: 'user', content: userBody }];
      }
    }

    // Resolve URL-referenced attachments to inline bytes before dispatch
    // (tenant-checked; replay-safe). No-op when every part is already inline
    // or text-only, so the common chat path pays nothing.
    messages = await resolveAttachmentBytes(messages, ctx.tenantId);

    // Managed-provider path: server-held key, per-tenant daily cap,
    // underlying provider hidden. The chat-responder short-circuits
    // BEFORE the standard ctx.secrets lookup so users never need a
    // BYOK row for managed providers.
    if (isManagedCredentialRef(credentialRef)) {
      const userFacingProvider = managedProviderIdFromRef(credentialRef);
      // Managed-tile agentId hides the underlying model (e.g.
      // 'openwop-free-assistant', NOT 'minimax-assistant'). Matches the
      // dispatchManagedChat result-rewriting boundary.
      const agentId = `${userFacingProvider}-assistant`;
      const { onReasoningDelta, onReasoningBlock } = buildReasoningCallbacks(ctx, agentId, 'full');

      try {
        const onDelta = async (delta: string) => {
          // ADR 0079 — the spec-canonical streaming delta the FE consumes. The
          // transitional `node.message` dual-emit was retired in Phase 5.
          await ctx.emit('ai.message.chunk', { chunk: delta, isLast: false });
        };
        // Bound the upstream LLM call. Without this, an unresponsive
        // managed-provider request (slow network, stuck connection,
        // upstream rate-limit hold) parks the worker forever — the
        // executor sets `currentNodeId` but `node.started` never fires
        // because the dispatch is still awaiting a response, and the
        // run stalls indefinitely with no observable failure. 60s is
        // generous for chat completions; surface as `timeout` so a
        // future retry/route-error policy can act on it.
        const abort = new AbortController();
        const timer = setTimeout(() => abort.abort(), MANAGED_CHAT_TIMEOUT_MS);
        let managed: ManagedDispatchResult;
        try {
          managed = await dispatchManagedChat({
            userFacingProvider,
            tenantId: ctx.tenantId,
            messages: messages as ChatMessage[],
            maxTokens,
            onDelta,
            signal: abort.signal,
            ...(onReasoningDelta ? { onReasoningDelta } : {}),
            ...(onReasoningBlock ? { onReasoningBlock } : {}),
          });
        } finally {
          clearTimeout(timer);
        }
        await emitChatEnvelopeSignals(ctx, managed);
        emitCost({
          provider: managed.provider,
          model: managed.model,
          promptTokens: managed.usage?.inputTokens,
          completionTokens: managed.usage?.outputTokens,
        });
        if (managed.completion.length === 0) {
          return {
            status: 'failure',
            error: {
              code: 'empty_completion',
              message: 'Free tier returned no content. Try again or pick a different provider.',
            },
          };
        }
        return {
          status: 'success',
          outputs: {
            completion: managed.completion,
            provider: managed.provider,
            model: managed.model,
            usage: managed.usage,
          },
        };
      } catch (err) {
        if (err instanceof ManagedProviderError) {
          return { status: 'failure', error: { code: err.code, message: err.message } };
        }
        // AbortError from the timeout above. Surfaces as a clean
        // `timeout` so a future retry/route-error policy can act on
        // it; the run won't park indefinitely waiting on a stuck
        // upstream.
        if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
          return {
            status: 'failure',
            error: {
              code: 'timeout',
              message: `Managed chat dispatch exceeded ${MANAGED_CHAT_TIMEOUT_MS}ms — upstream provider unresponsive.`,
            },
          };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { status: 'failure', error: { code: 'internal_error', message } };
      }
    }

    const apiKey = ctx.secrets[credentialRef];
    if (!apiKey) {
      return { status: 'failure', error: { code: 'credential_unavailable', message: `Secret ${credentialRef} not resolved by host.` } };
    }

    // Tool mode is wired for Anthropic + MiniMax. Each has its own
    // dispatcher (Anthropic's native tools API vs OpenAI-compatible
    // tool_calls for MiniMax); OpenAI + Google are deferred since
    // their tool-call wire shapes diverge further. The provider gate
    // here short-circuits before we resolve tool bindings.
    const toolsCapableProvider = provider === 'anthropic' || provider === 'minimax';
    const useTools = rawTools.length > 0 && toolsCapableProvider;
    const toolBindings = useTools ? validateToolBindings(rawTools) : [];
    // Tools requested but the resolved provider has no dispatcher for
    // them — emit a structured warning so the FE can show it inline
    // ("tools were silently dropped"). The dispatch still runs without
    // tools rather than failing the run; the warning gives the user
    // visibility into why their tool-bound chat node didn't tool-call.
    if (rawTools.length > 0 && !toolsCapableProvider) {
      await ctx.emit('node.warning', {
        code: 'tools_unsupported_provider',
        message: `Tools were requested but provider '${provider}' has no tools dispatcher wired. Tools dropped; chat will dispatch text-only.`,
        provider,
        requestedToolCount: rawTools.length,
      });
    }

    // BYOK agentId reveals the actual provider+model — by design.
    // Managed-tile hides the underlying model (`openwop-free-assistant`);
    // BYOK users picked their own model so honesty wins over uniformity.
    const byokAgentId = `${provider}-${model}-assistant`.slice(0, 256);
    const { verbosity: byokVerbosity, onReasoningDelta: byokOnReasoningDelta, onReasoningBlock: byokOnReasoningBlock } =
      buildReasoningCallbacks(ctx, byokAgentId, 'full');

    try {
      const onDelta = async (delta: string) => {
        // ADR 0079 — canonical `ai.message.chunk` (see above); `node.message`
        // retired in Phase 5.
        await ctx.emit('ai.message.chunk', { chunk: delta, isLast: false });
      };
      let result: DispatchResult;
      if (useTools) {
        const toolDefs: ToolDef[] = toolBindings.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: { type: 'object', additionalProperties: true },
        }));
        const bindingByName = new Map(toolBindings.map((t) => [t.name, t]));
        // Shared tool-execution callback — same surface for both
        // dispatchers. Each round, the model requests a tool, this
        // looks up the bound workflow, executes it via dispatchSubRun,
        // and emits structured node.tool_use / node.tool_result events
        // so the UI can render its own breadcrumb cards instead of the
        // dispatcher's inline Markdown.
        const onToolUse = async (use: { id: string; name: string; input: Record<string, unknown> }) => {
          const binding = bindingByName.get(use.name);
          if (!binding) {
            return {
              toolUseId: use.id,
              content: `tool_not_found: ${use.name}`,
              isError: true,
            };
          }
          await ctx.emit('node.tool_use', {
            toolUseId: use.id,
            name: use.name,
            workflowId: binding.workflowId,
            input: use.input,
          });
          const subResult = await dispatchSubRun({
            workflowId: binding.workflowId,
            inputs: use.input,
            budgetMs: 30_000,
            tenantId: ctx.tenantId,
            ...(ctx.scopeId ? { scopeId: ctx.scopeId } : {}),
            // ADR 0133 — link the delegated sub-run to the run + agent that spawned it.
            parentRunId: ctx.runId,
            ...(ctx.nodeAgent ? { delegatedBy: `agent:${ctx.nodeAgent.agentId}` } : {}),
          });
          await ctx.emit('node.tool_result', {
            toolUseId: use.id,
            name: use.name,
            status: subResult.status,
            ...(subResult.status === 'completed' ? { output: subResult.output } : {}),
            ...(subResult.status === 'failed' ? { error: subResult.error } : {}),
            ...(subResult.status !== 'completed' && 'runId' in subResult ? { runId: subResult.runId } : {}),
          });
          return {
            toolUseId: use.id,
            // ADR 0099 — compact the tool result at this typed boundary (the
            // string is known to be tool output) before it re-enters the model
            // context. Fail-open identity when no compaction decision is frozen.
            content: applyToolResultTransform(formatSubRunResult(subResult), {
              decision: ctx.compaction,
              toolName: use.name,
              tenantId: ctx.tenantId,
            }),
            isError: subResult.status === 'failed',
          };
        };
        const toolsReq = {
          provider,
          model,
          apiKey,
          messages,
          maxTokens,
          onDelta,
          tools: toolDefs,
          onToolUse,
        };
        result = provider === 'minimax'
          ? await dispatchMiniMaxWithTools(toolsReq)
          : await dispatchAnthropicWithTools(toolsReq);
      } else {
        result = await dispatchChat({
          provider,
          model,
          apiKey,
          messages,
          maxTokens,
          webSearch,
          onDelta,
          reasoningVerbosity: byokVerbosity,
          ...(byokOnReasoningDelta ? { onReasoningDelta: byokOnReasoningDelta } : {}),
          ...(byokOnReasoningBlock ? { onReasoningBlock: byokOnReasoningBlock } : {}),
        });
      }
      await emitChatEnvelopeSignals(ctx, result);
      emitCost({
        provider: result.provider,
        model: result.model,
        promptTokens: result.usage?.inputTokens,
        completionTokens: result.usage?.outputTokens,
      });
      if (result.completion.length === 0) {
        // Provider returned 200 but no text. Use the real provider-
        // reported diagnostic (finishReason, blockReason, safetyCategory)
        // when present; fall back to provider-specific heuristics.
        return {
          status: 'failure',
          error: {
            code: 'empty_completion',
            message: diagnoseEmptyCompletion(result),
          },
        };
      }
      return {
        status: 'success',
        outputs: {
          completion: result.completion,
          provider: result.provider,
          model: result.model,
          usage: result.usage,
          ...(result.citations && result.citations.length > 0 ? { citations: result.citations } : {}),
        },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'failure', error: { code: 'internal_error', message } };
    }
  },
};

export interface ToolBinding {
  workflowId: string;
  name: string;
  description: string;
}

/**
 * Validate the untrusted `inputs.tools` array of a chat-responder/heartbeat node
 * into executable tool bindings.
 *
 * SECURITY INVARIANT (ADR 0105): a heartbeat/scheduled chat node's "tools" are
 * **workflow sub-runs ONLY** — each binding MUST carry a string `workflowId`
 * (dispatched via `dispatchSubRun`, governed by the agent's workflow portfolio +
 * autonomy + sub-run authz). A native/builtin tool id (the surface the ADR 0102
 * per-tool `permissions.read/write` gate governs) MUST NOT enter here: a binding
 * without a `workflowId` is DROPPED. This is the structural guarantee that makes
 * the "ungated heartbeat path" a non-gap. If a future feature deliberately binds
 * native tools to a chat node, it MUST extend this type with a native-tool kind AND
 * gate exactly those bindings with `evaluateToolPermission` — do NOT relax the
 * `workflowId` requirement. `validate-tool-bindings.test.ts` is the alarm that
 * fires if this is loosened. Exported for that test.
 */
export function validateToolBindings(raw: unknown[]): ToolBinding[] {
  const out: ToolBinding[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const rec = r as Record<string, unknown>;
    if (typeof rec.workflowId !== 'string') continue;
    if (typeof rec.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(rec.name)) continue;
    if (typeof rec.description !== 'string') continue;
    out.push({ workflowId: rec.workflowId, name: rec.name, description: rec.description });
  }
  return out;
}

function formatSubRunResult(r: SubRunResult): string {
  if (r.status === 'completed') {
    try {
      return typeof r.output === 'string' ? r.output : JSON.stringify(r.output);
    } catch {
      return String(r.output);
    }
  }
  if (r.status === 'pending') {
    return JSON.stringify({
      status: 'pending',
      runId: r.runId,
      message: `Workflow is still running or waiting on an interrupt after the ${r.budgetMs}ms tool budget. Tell the user they can resume it at /runs/${r.runId}.`,
    });
  }
  return JSON.stringify({
    status: 'failed',
    runId: r.runId,
    error: r.error,
  });
}

// A 1×1 transparent PNG — the default asset the media-emit demo node serves
// when the caller supplies no image of its own.
const DEMO_PNG_1x1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * RFC 0055 §C demo producer. Stores an image asset in the host's media
 * store (tenant-scoped capability-token URL) and emits a `media.image`
 * event referencing it BY URL — never inlining the binary. This is the
 * "producer" the §C serving + §B rendering rails were built to carry: a
 * run now has a `media.image` in its event log + debug bundle, served
 * from `GET /v1/host/openwop-app/assets/{token}`.
 *
 * Inputs (all optional): `contentBase64` + `mimeType` to emit a
 * caller-supplied image; otherwise a 1×1 PNG. The emitted payload conforms
 * to `schemas/envelopes/media.image.schema.json` (`{ url, bytes, mimeType,
 * alt }`) — `alt` carries the accessibility text a consumer renders.
 */
const imageEmitNode: NodeModule = {
  typeId: 'local.openwop-app.image-emit',
  version: '0.1.0',
  async execute(ctx) {
    const inputs = (ctx.inputs && typeof ctx.inputs === 'object') ? (ctx.inputs as Record<string, unknown>) : {};
    const contentBase64 = typeof inputs.contentBase64 === 'string' && inputs.contentBase64.length > 0
      ? inputs.contentBase64
      : DEMO_PNG_1x1_BASE64;
    const mimeType = typeof inputs.mimeType === 'string' && inputs.mimeType.length > 0
      ? inputs.mimeType
      : 'image/png';
    const alt = typeof inputs.alt === 'string' ? inputs.alt : 'Demo image (RFC 0055 media.image)';

    const stored = await storeMediaAsset(ctx.tenantId, { contentBase64, contentType: mimeType });

    // RFC 0055 §C rule 1 + 3: reference the asset by its tenant-scoped URL,
    // never inline the binary. Payload conforms to the media.image schema
    // (url/bytes/mimeType/alt). The event lands in the run event log + debug
    // bundle (flipping the §C debug-bundle conformance assertion live).
    const payload = { url: stored.url, bytes: stored.bytes, mimeType, alt };
    await ctx.emit('media.image', payload);

    return { status: 'success', outputs: { image: payload } };
  },
};

/**
 * Demo node: write a memory entry mid-run and attribute it (RFC 0057).
 *
 * The host's only other memory write is the session-end run-summary
 * (executor.ts), which is a host write and carries no `nodeId`. This node
 * is the *node-attributed* counterpart: executing it writes a tenant memory
 * entry and emits a `memory.written` RunEvent carrying the node that caused
 * the write — turning the flat memory ledger (app-ux §A3) into a per-node
 * memory trail. It gives the RunTimeline memory-write markers (#192, which
 * read `memory.written`) a node-attributed event to render, and mirrors
 * `local.openwop-app.image-emit` (the RFC 0055 §C "close the loop" node).
 *
 * `ctx.emit` stamps the envelope `nodeId`; we ALSO put `nodeId` in the
 * payload per RFC 0057 §B (SHOULD) so a consumer reading the canonical
 * payload shape (`run-event-payloads.schema.json#/$defs/memoryWritten`)
 * gets the attribution without inspecting the envelope. The event is
 * content-free (identifiers + non-secret tags only — never the entry
 * content; the read-side serves that, SR-1-redacted). The host advertises
 * `capabilities.memory.attribution.emitsWriteEvents` (discovery.ts).
 *
 * Input (optional): `note` — the text to store. Defaults to a demo string.
 */
const memoryWriteNode: NodeModule = {
  typeId: 'local.openwop-app.memory-write',
  version: '0.1.0',
  async execute(ctx) {
    const inputs = (ctx.inputs && typeof ctx.inputs === 'object') ? (ctx.inputs as Record<string, unknown>) : {};
    const note = typeof inputs.note === 'string' && inputs.note.length > 0
      ? inputs.note
      : `Demo memory entry written by node ${ctx.nodeId}`;
    const tags = ['demo-write', `node:${ctx.nodeId}`, `run-id:${ctx.runId}`];
    const row = writeMemoryEntry(ctx.tenantId, MEMORY_DEMO_REF, { content: note, tags });
    // RFC 0057 §B — attribute the write on the event log, content-free
    // (identifiers + non-secret tags; never the entry content). `nodeId` is
    // included in the payload per the SHOULD; `ctx.emit` also stamps it on
    // the event envelope.
    await ctx.emit('memory.written', {
      memoryRef: MEMORY_DEMO_REF,
      memoryId: row.id,
      nodeId: ctx.nodeId,
      tags,
    });
    return { status: 'success', outputs: { memoryId: row.id, memoryRef: MEMORY_DEMO_REF } };
  },
};

/**
 * Gap D-4 — `core.web.search` (core.openwop.web-search pack).
 *
 * Protocol-layer, capability-advertised search node — NOT a host-side
 * `exec` tool. The canonical pack implementation
 * (`packs/core.openwop.web-search/index.mjs`) delegates to the host's
 * `ctx.webSearch(...)` surface. This reference host does NOT advertise
 * `host.webSearch` (see routes/discovery.ts), so this in-process
 * registration mirrors the pack's stub branch: it returns a DETERMINISTIC
 * fixture result derived purely from the query, tagged `stub: true`, so
 * `openwop-app.web.research` runs end-to-end and replays deterministically
 * without provisioning a real search provider. A production deployer wires
 * a real `host.webSearch` and ships the published pack instead.
 */
const webSearchNode: NodeModule = {
  typeId: 'core.web.search',
  version: '1.0.0',
  async execute(ctx) {
    const inputs = (ctx.inputs && typeof ctx.inputs === 'object') ? (ctx.inputs as Record<string, unknown>) : {};
    const config = (ctx.config ?? {}) as { maxResults?: unknown };
    const query = typeof inputs.query === 'string' && inputs.query.length > 0
      ? inputs.query
      : findFirstStringValue(inputs);
    if (!query) {
      return { status: 'failure', error: { code: 'invalid_request', message: 'core.web.search requires a non-empty `query` input' } };
    }
    const n = typeof config.maxResults === 'number' && config.maxResults > 0
      ? Math.min(50, Math.floor(config.maxResults))
      : 5;
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'query';
    const results = Array.from({ length: n }, (_unused, i) => ({
      url: `https://example.com/${slug}/result-${i + 1}`,
      title: `${query} — reference result ${i + 1}`,
      snippet: `Deterministic example snippet ${i + 1} for "${query}". The demo backend stubs live web search so replays stay deterministic.`,
      rank: i + 1,
    }));
    return {
      status: 'success',
      outputs: { results, engine: 'stub', query, totalResults: results.length, stub: true },
    };
  },
};

const uppercaseNode: NodeModule = {
  typeId: 'local.openwop-app.uppercase',
  version: '0.1.0',
  async execute(ctx) {
    const inputs = (ctx.inputs && typeof ctx.inputs === 'object') ? (ctx.inputs as Record<string, unknown>) : {};
    // Prefer the canonical `text` port, but fall back to any string-
    // valued input (and one level into nested objects). Templates that
    // wire `uppercase` downstream of a `chat` node with a sourcePort
    // mismatch — or that pass a whole outputs map under a single port
    // — would otherwise see undefined and produce an empty string.
    let text: string | undefined;
    if (typeof inputs.text === 'string') text = inputs.text;
    else text = findFirstStringValue(inputs);
    return { status: 'success', outputs: { text: (text ?? '').toUpperCase() } };
  },
};

/**
 * `local.openwop-app.a2ui-clarify` — ADR 0051 Phase 3 producer.
 *
 * Raises a `clarification` interrupt that carries an A2UI surface in its
 * `data` (RFC 0102 `ui.a2ui-surface` shape). The chat renders it as a real
 * form (via the `a2uiInterruptCard` bridge in `MessageFeed` → the
 * `ui.a2ui-surface` card) instead of a free-text textarea, and the collected
 * field values come back as the interrupt resume value — the "structured
 * clarification" use case from ADR 0051. The default surface is a
 * meeting-scheduling form; a workflow MAY override `config.surface` /
 * `config.question` / `config.catalogVersion`. The surface uses only the
 * host-pinned day-1 catalog components (catalog 0.9.1) so the renderer's
 * closed-catalog validation accepts it; `action.button.action.target:
 * "resume"` confines the action to the interrupt-resume path.
 */
const A2UI_CLARIFY_DEFAULT_SURFACE = {
  title: 'Schedule the kickoff',
  components: [
    { component: 'text', text: "A couple of details and I'll set it up." },
    { component: 'field.date', id: 'date', label: 'Date', required: true },
    {
      component: 'field.select', id: 'duration', label: 'Duration', required: true,
      options: [
        { value: '30', label: '30 minutes' },
        { value: '60', label: '60 minutes' },
        { value: '90', label: '90 minutes' },
      ],
    },
    { component: 'field.checkbox', id: 'reminder', label: 'Send a reminder the day before' },
    { component: 'action.button', id: 'confirm', label: 'Confirm', action: { target: 'resume' } },
  ],
} as const;

const a2uiClarifyNode: NodeModule = {
  typeId: 'local.openwop-app.a2ui-clarify',
  version: '0.1.0',
  async execute(ctx) {
    const cfg = (ctx.config && typeof ctx.config === 'object' && !Array.isArray(ctx.config))
      ? (ctx.config as Record<string, unknown>)
      : {};
    const surface = (cfg.surface && typeof cfg.surface === 'object' && !Array.isArray(cfg.surface))
      ? (cfg.surface as Record<string, unknown>)
      : A2UI_CLARIFY_DEFAULT_SURFACE;
    return {
      status: 'suspended',
      interrupt: {
        kind: 'clarification',
        data: {
          // Free-text fallback for any consumer that doesn't render A2UI
          // surfaces (the renderer bridge prefers `surface` when present).
          question: typeof cfg.question === 'string' ? cfg.question : 'A few details, please.',
          // RFC 0102: the surface + its pinned catalog version. The chat's
          // `a2uiInterruptCard` bridge keys on these two fields.
          catalogVersion: typeof cfg.catalogVersion === 'string' ? cfg.catalogVersion : '0.9.1',
          surface,
        },
      },
    };
  },
};

// diagnoseEmptyCompletion moved to ./emptyCompletionDiagnostic.ts (ENG-10).

/**
 * core.bigquery.query (ADR 0076) — a READ-ONLY BigQuery query node. Calls the
 * BigQuery `jobs.query` REST API through `ctx.connectors` (the ADR 0037 broker:
 * eTLD+1-pinned to `bigquery.googleapis.com` via the `google` provider, credential
 * resolved as the run's acting human, RFC 0079 provenance stamped). It NEVER writes
 * — there is no BigQuery write scope; a DML/DDL statement simply fails at Google's
 * scope check.
 *
 * Output carries the exact `sql` + `projectId` + `jobId` as deterministic fields —
 * the "Verify Source" provenance the variance workflow (ADR 0078) surfaces. The
 * data-freshness `asOf` is stamped by that workflow from run-start (replay-safe),
 * NOT fabricated here with a wall clock.
 */
function mapBigQueryRows(data: unknown): Array<Record<string, unknown>> {
  const d = (data ?? {}) as { schema?: { fields?: Array<{ name?: unknown }> }; rows?: Array<{ f?: Array<{ v?: unknown }> }> };
  const fields = Array.isArray(d.schema?.fields) ? d.schema!.fields! : [];
  const rows = Array.isArray(d.rows) ? d.rows : [];
  return rows.map((row) => {
    const cells = Array.isArray(row.f) ? row.f : [];
    const obj: Record<string, unknown> = {};
    fields.forEach((field, i) => {
      const name = typeof field?.name === 'string' ? field.name : `f${i}`;
      obj[name] = cells[i]?.v;
    });
    return obj;
  });
}

const bigqueryQueryNode: NodeModule = {
  typeId: 'core.bigquery.query',
  version: '1.0.0',
  async execute(ctx) {
    const cfg = (ctx.config ?? {}) as { projectId?: unknown; sql?: unknown; connectorId?: unknown; maxRows?: unknown };
    const inputs = (ctx.inputs ?? {}) as Record<string, unknown>;
    const projectId = String(cfg.projectId ?? inputs.projectId ?? '').trim();
    const sql = String(cfg.sql ?? inputs.sql ?? '').trim();
    const connectorId = String(cfg.connectorId ?? 'bigquery');
    const maxRows = Number.isFinite(Number(cfg.maxRows)) ? Math.max(1, Math.min(10_000, Number(cfg.maxRows))) : 1000;

    if (!projectId) return { status: 'failure', error: { code: 'invalid_config', message: 'core.bigquery.query requires config.projectId.' } };
    if (!sql) return { status: 'failure', error: { code: 'invalid_config', message: 'core.bigquery.query requires config.sql (or inputs.sql).' } };
    if (!ctx.connectors) return { status: 'failure', error: { code: 'host_capability_missing', message: 'host.connectors surface is not available.' } };

    const r = await ctx.connectors.invoke(connectorId, {
      url: `https://bigquery.googleapis.com/bigquery/v2/projects/${encodeURIComponent(projectId)}/queries`,
      method: 'POST',
      body: JSON.stringify({ query: sql, useLegacySql: false, maxResults: maxRows }),
      contentType: 'application/json',
      authScheme: 'bearer',
    });

    if (!r.ok) {
      return { status: 'failure', error: { code: r.error ?? 'connector_request_failed', message: `BigQuery query failed (${r.error ?? `HTTP ${r.status ?? '?'}`}).` } };
    }

    const data = r.data as { jobReference?: { jobId?: unknown }; totalRows?: unknown } | undefined;
    const rows = mapBigQueryRows(r.data);
    const jobId = typeof data?.jobReference?.jobId === 'string' ? data.jobReference.jobId : undefined;

    return {
      status: 'success',
      outputs: {
        rows,
        rowCount: rows.length,
        // Provenance (deterministic — feeds "Verify Source", ADR 0078):
        sql,
        projectId,
        ...(jobId ? { jobId } : {}),
      },
    };
  },
};

/**
 * core.workday.query (ADR 0082) — read HCM / People data from Workday via `ctx.connectors`
 * (the ADR 0037 broker: apiHosts-pinned to *.workday.com, credential resolved as the acting
 * human, RFC 0079 provenance stamped, `connections:use` enforced, READ-ONLY provider). The
 * real source node for the talent + recognition-drafting workflows (replaces the prior
 * mock-ai placeholders). The tenant-specific REST base
 * (`https://{instance}.workday.com/ccx/api/v1/{tenant}`) is supplied via `config.baseUrl`
 * (resolved from the connection's `instanceUrlTemplate`); the apiHosts pin guarantees egress
 * can only reach *.workday.com regardless of the configured base.
 *
 * Output carries `{ rows, rowCount, resource, baseUrl }` — deterministic "Verify Source"
 * provenance, mirroring core.bigquery.query.
 */
const WORKDAY_RESOURCES = ['workers', 'performanceReviews', 'serviceDates'] as const;

const workdayQueryNode: NodeModule = {
  typeId: 'core.workday.query',
  version: '1.0.0',
  async execute(ctx) {
    const cfg = (ctx.config ?? {}) as { baseUrl?: unknown; resource?: unknown; connectorId?: unknown; params?: unknown; maxRows?: unknown };
    const inputs = (ctx.inputs ?? {}) as Record<string, unknown>;
    const baseUrl = String(cfg.baseUrl ?? inputs.baseUrl ?? '').trim().replace(/\/+$/, '');
    // INS-4 — a run INPUT overrides the authored `config.resource` default (so a workflow can
    // parameterize the resource via a variable, e.g. `promotionDates` instead of the baked-in
    // `serviceDates`), falling back to config when no input is supplied. (Input-wins precedence;
    // every existing caller passes the resource via config with no `inputs.resource`, so the
    // default behaviour is unchanged.)
    const resource = String(inputs.resource ?? cfg.resource ?? '').trim();
    const connectorId = String(cfg.connectorId ?? 'workday');
    const maxRows = Number.isFinite(Number(cfg.maxRows)) ? Math.max(1, Math.min(10_000, Number(cfg.maxRows))) : 1000;

    if (!baseUrl) return { status: 'failure', error: { code: 'invalid_config', message: 'core.workday.query requires config.baseUrl (the tenant REST base, from the connection instanceUrlTemplate).' } };
    if (!(WORKDAY_RESOURCES as readonly string[]).includes(resource)) {
      return { status: 'failure', error: { code: 'invalid_config', message: `core.workday.query requires config.resource ∈ {${WORKDAY_RESOURCES.join(', ')}}.` } };
    }
    if (!ctx.connectors) return { status: 'failure', error: { code: 'host_capability_missing', message: 'host.connectors surface is not available.' } };

    // Build the query string from a flat params bag (scalars only — no injection surface).
    const params = (cfg.params && typeof cfg.params === 'object') ? cfg.params as Record<string, unknown> : {};
    const qs = new URLSearchParams();
    qs.set('limit', String(maxRows));
    for (const [k, v] of Object.entries(params)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') qs.set(k, String(v));
    }
    // Read-only GET to the tenant REST base; the broker pins the host to *.workday.com.
    const url = `${baseUrl}/${encodeURIComponent(resource)}?${qs.toString()}`;
    const r = await ctx.connectors.invoke(connectorId, { url, method: 'GET', authScheme: 'bearer' });

    if (!r.ok) {
      return { status: 'failure', error: { code: r.error ?? 'connector_request_failed', message: `Workday query failed (${r.error ?? `HTTP ${r.status ?? '?'}`}).` } };
    }

    // Workday REST collections return `{ data: [...], total }`; tolerate a bare array too.
    const data = (r.data ?? {}) as { data?: unknown };
    const rows = Array.isArray(data.data) ? data.data as Array<Record<string, unknown>>
      : Array.isArray(r.data) ? r.data as Array<Record<string, unknown>>
      : [];
    return {
      status: 'success',
      outputs: {
        rows,
        rowCount: rows.length,
        resource, // Provenance (deterministic — "Verify Source"):
        baseUrl,
      },
    };
  },
};

/**
 * core.email.draft (ADR 0076 P2, +Gmail parity ADR 0081 P6) — creates a DRAFT
 * message in the acting human's mailbox via `ctx.connectors` (the ADR 0037 broker:
 * eTLD+1-pinned per provider, credential resolved as the acting human, RFC 0079
 * provenance stamped). Provider is chosen by `config.connectorId`:
 *   - `microsoft-graph` (default) → Outlook draft via `POST /v1.0/me/messages`.
 *   - `gmail` → Gmail draft via `POST gmail/v1/users/me/drafts` ({message:{raw}}).
 *
 * NEVER SENDS — the only URLs it ever constructs are the fixed create-draft literals;
 * there is no code path to a send endpoint (`/sendMail`, `…/send`, drafts.send,
 * messages.send). For Graph this is belt-and-suspenders (the `Mail.ReadWrite` scope
 * also excludes `Mail.Send`); for Gmail the never-send guarantee is BY CONSTRUCTION
 * ONLY — Gmail has no draft-create scope that forbids send (`gmail.compose` is the
 * narrowest), so the fixed-drafts-URL construction is the sole guard. "Always draft
 * for approval" (the PRD invariant) is enforced by construction either way.
 */
const GRAPH_CREATE_DRAFT_URL = 'https://graph.microsoft.com/v1.0/me/messages';
// ADR 0081 P6 — Gmail draft endpoint (sibling to Graph). NEVER a send endpoint
// (.../drafts/send or messages.send) — the never-send invariant is by construction.
const GMAIL_CREATE_DRAFT_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';

/** base64url (no padding) of a UTF-8 string — the Gmail `message.raw` encoding. */
function gmailB64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Collapse CR/LF in a header value to a space — defense-in-depth against MIME
 *  header injection (the node guard already rejects line-break values; this keeps the
 *  pure builder safe even if reused). Body content is unaffected (only headers). */
function headerSafe(v: string): string {
  return v.replace(/[\r\n]+/g, ' ');
}

/** Pure: build the RFC822 MIME message Gmail's drafts.create expects in `raw`.
 *  Headers + a single text/plain|text/html part. Exported-shape kept minimal —
 *  no attachments, no non-ASCII header encoding (sufficient for the draft body).
 *  Header values are CR/LF-stripped so a recipient/subject can never inject a
 *  header (e.g. a hidden `Bcc:`) or terminate the header block early. */
function buildRfc822(recipients: string[], subject: string, body: string, html: boolean): string {
  const contentType = html ? 'text/html; charset="UTF-8"' : 'text/plain; charset="UTF-8"';
  return [
    `To: ${recipients.map(headerSafe).join(', ')}`,
    `Subject: ${headerSafe(subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: ${contentType}`,
    '',
    body,
  ].join('\r\n');
}

const emailDraftNode: NodeModule = {
  typeId: 'core.email.draft',
  version: '1.0.0',
  async execute(ctx) {
    const cfg = (ctx.config ?? {}) as { to?: unknown; subject?: unknown; body?: unknown; bodyFormat?: unknown; connectorId?: unknown };
    const inputs = (ctx.inputs ?? {}) as Record<string, unknown>;
    const toRaw = cfg.to ?? inputs.to;
    const subject = String(cfg.subject ?? inputs.subject ?? '').trim();
    const body = String(cfg.body ?? inputs.body ?? '');
    const bodyFormat = String(cfg.bodyFormat ?? 'Text') === 'HTML' ? 'HTML' : 'Text';
    const connectorId = String(cfg.connectorId ?? 'microsoft-graph');
    const recipients = (Array.isArray(toRaw) ? toRaw : toRaw ? [toRaw] : [])
      .map((a) => String(a).trim())
      .filter(Boolean);

    if (recipients.length === 0) return { status: 'failure', error: { code: 'invalid_config', message: 'core.email.draft requires config.to (one or more recipients).' } };
    if (!subject) return { status: 'failure', error: { code: 'invalid_config', message: 'core.email.draft requires config.subject.' } };
    // Email headers are single-line — a CR/LF in a recipient/subject is a MIME
    // header-injection vector on the Gmail raw-RFC822 path (Graph's structured JSON is
    // safe, but reject for both: a line break in a header value is never legitimate and
    // could smuggle a hidden Bcc/Cc onto the draft). Fail closed (ADR 0081 P6).
    if (/[\r\n]/.test(subject) || recipients.some((a) => /[\r\n]/.test(a))) {
      return { status: 'failure', error: { code: 'invalid_config', message: 'core.email.draft recipients/subject must not contain line breaks.' } };
    }
    if (!ctx.connectors) return { status: 'failure', error: { code: 'host_capability_missing', message: 'host.connectors surface is not available.' } };

    // Provider strategy by connectorId (ADR 0081 P6): `gmail` → Gmail drafts.create
    // (base64url RFC822); anything else → the Graph create-message shape. Both URLs are
    // fixed literals — never caller-supplied, never a send endpoint.
    const isGmail = connectorId === 'gmail';
    const url = isGmail ? GMAIL_CREATE_DRAFT_URL : GRAPH_CREATE_DRAFT_URL;
    const requestBody = isGmail
      ? JSON.stringify({ message: { raw: gmailB64Url(buildRfc822(recipients, subject, body, bodyFormat === 'HTML')) } })
      : JSON.stringify({
          subject,
          body: { contentType: bodyFormat, content: body },
          toRecipients: recipients.map((address) => ({ emailAddress: { address } })),
        });

    const r = await ctx.connectors.invoke(connectorId, {
      url,
      method: 'POST',
      body: requestBody,
      contentType: 'application/json',
      authScheme: 'bearer',
    });

    if (!r.ok) {
      const which = isGmail ? 'Gmail' : 'Outlook';
      return { status: 'failure', error: { code: r.error ?? 'connector_request_failed', message: `${which} draft creation failed (${r.error ?? `HTTP ${r.status ?? '?'}`}).` } };
    }

    const data = r.data as { id?: unknown; webLink?: unknown } | undefined;
    const draftId = typeof data?.id === 'string' ? data.id : undefined;
    const webLink = typeof data?.webLink === 'string' ? data.webLink : undefined;

    return {
      status: 'success',
      outputs: {
        drafted: true,
        ...(draftId ? { draftId } : {}),
        ...(webLink ? { webLink } : {}),
        // ADR 0083 — emit the recipients + body so the draft is previewable at the
        // approval gate (the run-artifact the gate persists derives its preview from this
        // output). Without the body the approver had nothing to see — the dead-end card.
        to: recipients,
        subject,
        body,
        recipientCount: recipients.length,
      },
    };
  },
};

let registered = false;

export function ensureNodesRegistered(): void {
  if (registered) return;
  const registry = getNodeRegistry();
  registry.register(noopNode);
  registry.register(identityNode);
  registry.register(subWorkflowNode);
  registry.register(orchestratorSupervisorNode);
  registry.register(dispatchNode);
  registry.register(channelWriteNode);
  // ── Conformance-only nodes ──────────────────────────────────────────
  // These typeIds exist solely to drive the OpenWOP conformance suite
  // (capability-refusal, BYOK echo, cost-attr allowlist, model-capability
  // refusal, agent-event hooks). They are gated behind
  // conformanceNodesEnabled() so a production deploy of this codebase does
  // NOT expose executable typeIds like `conformance.secret.echo` by default
  // (it returns hashes of host-provisioned canary secrets) — only the
  // reference conformance host opts in. The advertisement in
  // routes/discovery.ts reads the SAME switch so the two cannot drift.
  if (conformanceNodesEnabled()) {
    registerConformanceNodes(registry);
  }
  registry.register(delayNode);
  registry.register(failNode);
  registry.register(approvalGateNode);
  registry.register(clarificationGateNode);
  registry.register(interruptNode);
  registry.register(conversationGateNode);
  registry.register(webSearchNode);
  registry.register(uppercaseNode);
  registry.register(a2uiClarifyNode);
  registry.register(imageEmitNode);
  registry.register(memoryWriteNode);
  registry.register(mockAiNode);
  registry.register(chatResponderNode);
  registry.register(bigqueryQueryNode);
  registry.register(workdayQueryNode);
  registry.register(emailDraftNode);
  // ADR 0089 Phase 4 (Option B) — the agent-runner node behind the synthetic
  // `openwop-app.agent-mention` workflow (runs a tool-bearing @mentioned agent's
  // gated tool loop as a persisted run / chat `workflow_run` bubble).
  registry.register(agentRunnerNode);
  registered = true;
}

/**
 * The conformance-only node registrations, extracted so the production
 * default (NODE_ENV=production without OPENWOP_ENABLE_CONFORMANCE_NODES=true)
 * simply never calls them. See conformanceNodesEnabled().
 */
function registerConformanceNodes(registry: ReturnType<typeof getNodeRegistry>): void {
  // RFC: conformance-only typeId for runtime-capability refusal test.
  // Declares `requires` pointing at a capability the host never
  // provides. The executor's pre-execute capability check refuses
  // with `capability_not_provided`.
  registry.register({
    typeId: 'conformance.requiresMissing',
    version: '1.0.0',
    requires: ['conformance.never-provided'],
    async execute() {
      // Unreachable: the host's capability check fails before this runs.
      return { status: 'success', outputs: {} };
    },
  });
  // Conformance-only typeId for BYOK end-to-end. Resolves the
  // host-provisioned canary secret via the SecretResolver, emits
  // SHA-256 hex + byte length to variables. NEVER emits the raw
  // value.
  registry.register({
    typeId: 'conformance.secret.echo',
    version: '1.0.0',
    async execute(ctx) {
      const cfg = (ctx.config ?? {}) as { secretId?: unknown };
      const secretId = typeof cfg.secretId === 'string' ? cfg.secretId : '';
      if (!secretId) {
        return { status: 'failure', error: { code: 'invalid_request', message: 'conformance.secret.echo requires config.secretId' } };
      }
      const { resolveSecret } = await import('../byok/secretResolver.js');
      const value = await resolveSecret(secretId, { tenantId: ctx.tenantId });
      if (!value) {
        return {
          status: 'failure',
          error: { code: 'credential_unavailable', message: `Canary secret '${secretId}' not provisioned by host` },
        };
      }
      const { createHash } = await import('node:crypto');
      const sha256 = createHash('sha256').update(value).digest('hex');
      const { setRunVariable } = await import('../host/variablesRuntime.js');
      setRunVariable(ctx.runId, 'sha256', sha256);
      setRunVariable(ctx.runId, 'byteLength', value.length);
      return {
        status: 'success',
        outputs: { sha256, byteLength: value.length },
      };
    },
  });
  // Conformance-only typeId for cost-attribution allowlist enforcement
  // (`spec/v1/observability.md §"Cost attribution attributes"`). Fixture
  // configs ship arbitrary `attrs` (including non-allowlisted keys + a
  // credential-shaped canary). The node hands the raw map to
  // `emitRawCostAttrs`, which routes through `sanitizeCostForOtel` to
  // drop everything outside `OPENWOP_COST_ATTRIBUTE_NAMES`. The
  // conformance suite then reads the live OTel span and asserts the
  // span attrs ⊆ the allowlist (and that no credential canary leaked).
  // Production deployments SHOULD skip this registration.
  registry.register({
    typeId: 'conformance.cost.emit',
    version: '1.0.0',
    async execute(ctx) {
      const cfg = (ctx.config ?? {}) as { attrs?: unknown };
      const attrs = (cfg.attrs && typeof cfg.attrs === 'object' && !Array.isArray(cfg.attrs))
        ? (cfg.attrs as Record<string, unknown>)
        : {};
      const { emitRawCostAttrs, sanitizeCostForOtel, applyCostRollup } = await import('../observability/costEmitter.js');
      // Write sanitized attrs to the active OTel span AND fold the
      // numeric pieces into the per-run rollup so the snapshot's
      // metrics.openwopCost reflects them per
      // `run-snapshot.schema.json §metrics.openwopCost`.
      emitRawCostAttrs(attrs);
      applyCostRollup(ctx.runId, sanitizeCostForOtel(attrs));
      return { status: 'success', outputs: { emittedKeyCount: Object.keys(attrs).length } };
    },
  });
  // Conformance-only typeId for the RFC 0031 §B step 4 refusal path
  // (`model-capability-insufficient.test.ts` end-to-end branch). Declares a
  // capability no model advertises so the executor's gate check at
  // executor.ts:230-289 ALWAYS refuses, emitting `model.capability.insufficient`
  // before `node.failed` per §D. Per RFC 0031 §C "Reservation policy" the id
  // MUST be spec-reserved OR match the `x-host-<host>-<key>` extension pattern;
  // we use the host-extension form — still outside the reserved set (so it
  // always refuses) AND conformant per `node-module-required-capabilities-shape`.
  registry.register({
    typeId: 'conformance.modelCapability.insufficient',
    version: '1.0.0',
    requiredModelCapabilities: ['x-host-openwop-app-nonexistent-capability-9b3f'],
    async execute() {
      // Unreachable — gate refuses before this runs.
      return { status: 'success', outputs: {} };
    },
  });
  // RFC 0023 — conformance-only typeId for agent-event emission hooks.
  registerMockAgentNode();
}
