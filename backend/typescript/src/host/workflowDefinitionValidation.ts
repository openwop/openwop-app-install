/**
 * Canonical `WorkflowDefinition` validation — the SINGLE validation path
 * shared by the host-extension registration route (`routes/workflows.ts`) and
 * the AI workflow-author feature (ADR 0072). Extracted so an authored workflow
 * passes the EXACT validator a hand-built one does — no second validation path
 * that could drift (the explicit ADR 0072 invariant "one validation path").
 *
 * The wire-shape mirrors `spec/v1/workflow-definition.schema.json`; without the
 * `edges` validation the executor falls back to an implicit linear chain over
 * `nodes`, silently mis-wiring every fan-out graph (see the 2026-05-23 bug).
 *
 * RFC 0022 §C capability gate lives here too (`checkMappingCapability`): a node
 * whose mapping fields are non-empty but whose capability the host does not
 * advertise is refused at validation time, so an authored graph that would 400
 * on registration is rejected BEFORE persist (ADR 0072 "capability-gate honesty").
 */

import { OpenwopError } from '../types.js';
import type { EdgeDef, WorkflowDefinition } from '../executor/types.js';
import { resolveCapabilityFlag } from './capabilityOverlay.js';
import { dispatchCapability, validateDispatchFanOutConfig } from './dispatchFanOut.js';
import { normalizeEdgeCondition } from './edgeConditionMapping.js';
import {
  COMPENSATION_ORDERING_MODEL,
  COMPENSATION_TRIGGERS,
  FIRED_COMPENSATION_TRIGGERS,
} from './compensationUnwind.js';
import { COMPENSATION_PROFILE_VERSION } from './compensationLedger.js';
import { buildGraph, topologicalOrder } from '../executor/scheduler.js';

export const WORKFLOW_ID_PATTERN = /^[a-zA-Z0-9_.\-:]{1,128}$/;

/**
 * `WFAWF-9` (ADR 0596) — does this definition contain a cycle the EXECUTOR would
 * refuse to schedule? Returns the executor's own message, or `null` when the
 * graph is schedulable.
 *
 * It delegates to `buildGraph` + `topologicalOrder` rather than hand-rolling a
 * DFS, and that is the whole point: the executor does NOT reject every cycle.
 * A back-edge whose endpoints include `core.dispatch` /
 * `core.orchestrator.supervisor` is a legitimate RFC 0022 dispatch-supervisor
 * loop and is stripped as inert. A hand-written "no cycles" check would have
 * been a NEW rule that rejects graphs the runtime happily runs — a gate that
 * disagrees with the thing it is gating. Reusing the scheduler's own pair makes
 * "would this run?" and "may this be authored?" the same question by
 * construction, and keeps them the same question when the executor's rule moves.
 *
 * NOT called from `validateWorkflowDefinition` itself — see ADR 0596 §3 for the
 * blast-radius reasoning (existing stored definitions, revision restore).
 */
export function findWorkflowCycleError(def: WorkflowDefinition): string | null {
  if (!def.edges || def.edges.length === 0) return null;
  try {
    topologicalOrder(def, buildGraph(def));
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if ((err as { code?: string } | null)?.code === 'cycle_detected') return message;
    // Fail CLOSED: a graph the scheduler cannot even analyse is not a graph we
    // should be certifying as valid.
    return `Workflow graph could not be scheduled: ${message}`;
  }
}
// ADR 0673 D4 (`WFAWF-16`) — the node/edge id bound is ENFORCED, not just promised. Both error
// messages below have always said `[a-zA-Z0-9_-]{1,64}`, and the repair loop feeds that text
// back to the model — so an unbounded pattern told the model a constraint the code did not
// keep, and a 200-character node id (a storage key) passed. `WORKFLOW_ID_PATTERN` above
// already carries its own bound; these two were the outliers against their own sibling, which
// is why adding it brings them in line rather than inventing a new constraint.
//
// CORRECTED before merge — the bound is `{1,128}`, NOT the `{1,64}` the messages advertised.
// Enforcing the advertised 64 turned 14 test files red: chain expansion mints node ids as
// `<chainId dots->underscores>_<12-hex instance>_<nodeId>`, and a SUB-CHAIN prefixes an
// already-prefixed id a second time. MEASURED over all 181 shipped chains (570 nodes): the
// un-prefixed population maxes at exactly 64, real single-prefixed ids run 65-66
// (`campaign-studio_campaign-orchestration_a001317ad3f5_kernel-approve`), and double-prefixed
// ids reach 87. So `{1,64}` was never a description of this host's own minting - the ADVERTISED
// text was the thing that was wrong, and enforcing it verbatim would have rejected legitimate
// chains at `from-chain` and at the `workflow-chain:expand` seam. 128 matches
// WORKFLOW_ID_PATTERN, clears the measured 87 with headroom, and still bounds the storage key.
export const NODE_ID_PATTERN = /^[a-zA-Z0-9_\-]{1,128}$/;
export const TYPE_ID_PATTERN = /^[a-zA-Z0-9_.\-]{1,128}$/;
export const EDGE_ID_PATTERN = /^[a-zA-Z0-9_\-]{1,128}$/; // ADR 0673 D4 — see NODE_ID_PATTERN
export const TRIGGER_RULES = new Set([
  'all_success',
  'any_success',
  'all_complete',
  'none_failed',
  'any_failed',
]);

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** RFC 0022 §C — refuse with `validation_error` + `details.requiredCapability`
 *  when a node's mapping field is non-empty AND the matching capability flag is
 *  not advertised (or has been toggled off via the test-seam overlay). */
export function checkMappingCapability(
  nodes: ReadonlyArray<{ nodeId: string; typeId: string; config?: Record<string, unknown> }>,
): void {
  for (const node of nodes) {
    const cfg = node.config ?? {};
    if (node.typeId === 'core.dispatch') {
      const hasMapping = hasNonEmptyMapping(cfg, ['inputMapping', 'outputMapping', 'perWorkerInputMappings', 'perWorkerOutputMappings']);
      if (hasMapping && resolveCapabilityFlag('agents.dispatchMapping') !== true) {
        throw new OpenwopError(
          'validation_error',
          `Node '${node.nodeId}' (core.dispatch) declares non-empty mapping fields but the host does not advertise capabilities.agents.dispatchMapping: true.`,
          400,
          { nodeId: node.nodeId, requiredCapability: 'agents.dispatchMapping' },
        );
      }
      // RFC 0118 — fan-out policy. The host honors only the policies it ADVERTISES
      // (capabilities.dispatch.fanOutPolicies); `parallel` is accepted because the host
      // advertises fanOutSupported (single-sourced off host/dispatchFanOut.ts so
      // accept/advertise can't drift — ADR 0165 executor arm). The cross-field MUSTs
      // (joinPolicy-without-parallel, quorum-without-quorum, unknown joinPolicy.mode) are
      // enforced here at POST /v1/workflows — the RFC 0118 negative conformance cases.
      const cap = dispatchCapability();
      const fanOutPolicy = (cfg.fanOutPolicy ?? 'sequential') as unknown;
      if (typeof fanOutPolicy === 'string' && !(cap.fanOutPolicies as readonly string[]).includes(fanOutPolicy)) {
        throw new OpenwopError(
          'capability_not_provided',
          `Node '${node.nodeId}' (core.dispatch) requests fanOutPolicy='${fanOutPolicy}' but this host advertises ${JSON.stringify(cap.fanOutPolicies)}.`,
          400,
          { nodeId: node.nodeId, requiredCapability: 'dispatch.fanOut' },
        );
      }
      const jp = (cfg.joinPolicy ?? undefined) as Record<string, unknown> | undefined;
      if (jp && typeof jp.mode === 'string' && !(cap.joinModes as readonly string[]).includes(jp.mode)) {
        throw new OpenwopError(
          'validation_error',
          `Node '${node.nodeId}' (core.dispatch) joinPolicy.mode='${jp.mode}' is not one of ${JSON.stringify(cap.joinModes)}.`,
          400,
          { nodeId: node.nodeId },
        );
      }
      // RFC 0118 §seam amendment (openwop#789): the SECOND join axis (`onChildFailure`) is
      // capability-gated by `dispatch.onChildFailureModes`, mirroring `joinModes`. A node pinning
      // an `onChildFailure` ∉ the advertised set → registration `validation_error`. This host
      // advertises `['collect','absorb']` (both honored; neither needs child cancellation) and so
      // rejects `fail-fast` — but now DISCOVERABLY (an author sees the set at /.well-known/openwop)
      // rather than as an undiscoverable footgun. Single-sourced off dispatchCapability().
      if (jp && typeof jp.onChildFailure === 'string' && !(cap.onChildFailureModes as readonly string[]).includes(jp.onChildFailure)) {
        throw new OpenwopError(
          'validation_error',
          `Node '${node.nodeId}' (core.dispatch) joinPolicy.onChildFailure='${jp.onChildFailure}' is not one of ${JSON.stringify(cap.onChildFailureModes)} (this host does not implement in-flight child cancellation).`,
          400,
          { nodeId: node.nodeId },
        );
      }
      const fanOutErr = validateDispatchFanOutConfig(
        {
          ...(typeof fanOutPolicy === 'string' ? { fanOutPolicy: fanOutPolicy as 'sequential' | 'reject' | 'parallel' } : {}),
          ...(jp
            ? {
                joinPolicy: {
                  ...(typeof jp.mode === 'string' ? { mode: jp.mode as 'wait-all' | 'quorum' | 'first' | 'race' } : {}),
                  ...(typeof jp.quorum === 'number' ? { quorum: jp.quorum } : {}),
                },
              }
            : {}),
        },
        (cap.fanOutPolicies as readonly string[]).includes('parallel'),
      );
      if (fanOutErr) {
        throw new OpenwopError('validation_error', `Node '${node.nodeId}' (core.dispatch) ${fanOutErr.message}.`, 400, { nodeId: node.nodeId });
      }
      const workerDispatchModel = (cfg.workerDispatchModel ?? 'child-run') as unknown;
      if (typeof workerDispatchModel === 'string' && workerDispatchModel !== 'child-run') {
        throw new OpenwopError(
          'capability_not_provided',
          `Node '${node.nodeId}' (core.dispatch) requests workerDispatchModel='${workerDispatchModel}' but this host only implements 'child-run'.`,
          400,
          { nodeId: node.nodeId, requiredCapability: 'dispatch.workerDispatchModel' },
        );
      }
      const askUserRouting = (cfg.askUserRouting ?? 'auto') as unknown;
      if (typeof askUserRouting === 'string' && askUserRouting !== 'auto') {
        throw new OpenwopError(
          'capability_not_provided',
          `Node '${node.nodeId}' (core.dispatch) requests askUserRouting='${askUserRouting}' but this host only implements 'auto'.`,
          400,
          { nodeId: node.nodeId, requiredCapability: 'dispatch.askUserRouting' },
        );
      }
    }
    if (node.typeId === 'core.subWorkflow') {
      const hasMapping = hasNonEmptyMapping(cfg, ['inputMapping']);
      if (hasMapping && resolveCapabilityFlag('subWorkflow.inputMapping') !== true) {
        throw new OpenwopError(
          'validation_error',
          `Node '${node.nodeId}' (core.subWorkflow) declares non-empty inputMapping but the host does not advertise capabilities.subWorkflow.inputMapping: true.`,
          400,
          { nodeId: node.nodeId, requiredCapability: 'subWorkflow.inputMapping' },
        );
      }
    }
  }
}

function hasNonEmptyMapping(cfg: Record<string, unknown>, fields: readonly string[]): boolean {
  for (const f of fields) {
    const v = cfg[f];
    if (!v) continue;
    if (typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      if (v.length > 0) return true;
      continue;
    }
    if (Object.keys(v as Record<string, unknown>).length > 0) return true;
  }
  return false;
}

/** Validate a raw value into a `WorkflowDefinition`, throwing `OpenwopError`
 *  (400) on any structural or capability-gate violation. */
type NodeCompensation = NonNullable<WorkflowDefinition['nodes'][number]['compensation']>;

/**
 * RFC 0151 §B — the node's `compensation` block, CLOSED and optional.
 *
 * Validated at REGISTRATION on purpose. §B: `nodeTypeId` "MUST resolve at
 * registration time, so an unwind cannot fail on a typo discovered only during
 * a failure — the worst possible moment to learn of one." This checks the shape
 * that far; resolving the type against the registry is the unwind's job today
 * (a pack may register after the workflow does), and an unresolvable one is
 * recorded as `manual_intervention_required` rather than silently skipped.
 *
 * Note this needs NO capability advert. A node-level declaration is a statement
 * about the workflow, not a claim about the host: a host that never unwinds
 * simply never acts on it. The workflow-LEVEL policy is the opposite case — it
 * asserts the host will run an unwind — which is why only that one is refused
 * below.
 */
function validateNodeCompensation(raw: unknown, i: number): NodeCompensation | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new OpenwopError('validation_error', `nodes[${i}].compensation MUST be an object when present.`, 400);
  }
  const c = raw as Record<string, unknown>;
  const allowed = new Set(['nodeTypeId', 'inputMapping', 'retry', 'requiresApproval', 'waiveRequiresApproval']);
  for (const key of Object.keys(c)) {
    if (!allowed.has(key)) {
      throw new OpenwopError(
        'validation_error',
        `nodes[${i}].compensation.${key} is not permitted — the RFC 0151 §B block is closed.`,
        400,
        { field: `nodes[${i}].compensation.${key}` },
      );
    }
  }
  if (typeof c.nodeTypeId !== 'string' || !TYPE_ID_PATTERN.test(c.nodeTypeId)) {
    throw new OpenwopError(
      'validation_error',
      `nodes[${i}].compensation.nodeTypeId is REQUIRED and MUST match [a-zA-Z0-9_.-]{1,128}.`,
      400,
      { field: `nodes[${i}].compensation.nodeTypeId` },
    );
  }
  if (c.inputMapping !== undefined && (typeof c.inputMapping !== 'object' || c.inputMapping === null || Array.isArray(c.inputMapping))) {
    throw new OpenwopError('validation_error', `nodes[${i}].compensation.inputMapping MUST be an object when present.`, 400);
  }
  if (c.requiresApproval !== undefined && typeof c.requiresApproval !== 'boolean') {
    throw new OpenwopError('validation_error', `nodes[${i}].compensation.requiresApproval MUST be a boolean when present.`, 400);
  }
  // RFC 0151 §B (S36). ABSENT IS NOT `false` — it means "inherit the effective
  // `requiresApproval`" — so this validates the shape only; the defaulting lives
  // in `compensationUnwind.effectiveWaiveRequiresApproval`, which is the one
  // place that comparison is made.
  if (c.waiveRequiresApproval !== undefined && typeof c.waiveRequiresApproval !== 'boolean') {
    throw new OpenwopError('validation_error', `nodes[${i}].compensation.waiveRequiresApproval MUST be a boolean when present.`, 400);
  }
  let retry: NodeCompensation['retry'];
  if (c.retry !== undefined) {
    if (typeof c.retry !== 'object' || c.retry === null || Array.isArray(c.retry)) {
      throw new OpenwopError('validation_error', `nodes[${i}].compensation.retry MUST be an object when present.`, 400);
    }
    const r = c.retry as Record<string, unknown>;
    if (r.maxAttempts !== undefined && (!Number.isInteger(r.maxAttempts) || (r.maxAttempts as number) < 1)) {
      throw new OpenwopError('validation_error', `nodes[${i}].compensation.retry.maxAttempts MUST be an integer >= 1.`, 400);
    }
    if (r.backoffMs !== undefined && (!Number.isInteger(r.backoffMs) || (r.backoffMs as number) < 0)) {
      throw new OpenwopError('validation_error', `nodes[${i}].compensation.retry.backoffMs MUST be an integer >= 0.`, 400);
    }
    retry = {
      ...(r.maxAttempts !== undefined ? { maxAttempts: r.maxAttempts as number } : {}),
      ...(r.backoffMs !== undefined ? { backoffMs: r.backoffMs as number } : {}),
    };
  }
  return {
    nodeTypeId: c.nodeTypeId,
    ...(c.inputMapping !== undefined ? { inputMapping: c.inputMapping as Record<string, unknown> } : {}),
    ...(retry ? { retry } : {}),
    ...(c.requiresApproval !== undefined ? { requiresApproval: c.requiresApproval } : {}),
    ...(c.waiveRequiresApproval !== undefined ? { waiveRequiresApproval: c.waiveRequiresApproval } : {}),
  };
}

/**
 * RFC 0151 §B — the workflow-level `settings.compensation` policy.
 *
 * THE RULE THIS ENFORCES, verbatim from `compensation-policy.schema.json`: a
 * host that does NOT advertise `capabilities.compensation` "MUST refuse a
 * workflow that carries this key with `capability_required` … rather than
 * accept it silently: accepting a policy the host will never honour tells the
 * author an unwind will happen when it will not, which is RFC 0148 §B's
 * advertise-and-opt-out failure with the sign flipped."
 *
 * This host implements the unwind (ADR 0554 P2) but does NOT yet advertise the
 * family — the advert and `compensationStatus` on `RunSnapshot` are a pair that
 * lands together — so today this ALWAYS refuses. That is the honest posture and
 * not a placeholder: an author whose policy is accepted here would be told the
 * host runs their triggers, and the snapshot would never report on it.
 *
 * WHEN THE ADVERT FLIPS, the branch below switches from "refuse" to "validate
 * against the advertised set", which is why the accept path is written out
 * rather than left as a TODO: `orderingModel` and `profileVersion` MUST be
 * values the host advertises, refused at REGISTRATION "so an unwind never
 * discovers at failure time that its ordering rule is unimplemented", and
 * `manual-intervention` / `pause` / `manual` additionally require
 * `manualIntervention: true`.
 */
export function checkCompensationPolicy(settings: unknown): void {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return;
  const policy = (settings as Record<string, unknown>).compensation;
  if (policy === undefined) return;

  if (resolveCapabilityFlag('compensation.supported') !== true) {
    throw new OpenwopError(
      'capability_required',
      'Workflow carries `settings.compensation`, but this host does not advertise capabilities.compensation. '
        + 'Node-level `compensation` declarations are accepted; the workflow-level POLICY asserts the host will '
        + 'run an unwind on the triggers it names, and this host makes no such claim yet.',
      400,
      { requiredCapability: 'compensation', field: 'settings.compensation' },
    );
  }

  // ── The accept path, live only once the advert flips ───────────────────────
  if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
    throw new OpenwopError('validation_error', '`settings.compensation` MUST be an object.', 400, { field: 'settings.compensation' });
  }
  const p = policy as Record<string, unknown>;
  if (!Array.isArray(p.triggers) || p.triggers.length === 0) {
    throw new OpenwopError(
      'validation_error',
      '`settings.compensation.triggers` is REQUIRED and MUST be a non-empty array — a policy that names no trigger is not a policy.',
      400,
      { field: 'settings.compensation.triggers' },
    );
  }
  for (const t of p.triggers) {
    if (typeof t !== 'string' || !COMPENSATION_TRIGGERS.includes(t as never)) {
      throw new OpenwopError(
        'validation_error',
        `\`settings.compensation.triggers\` MUST be one of ${COMPENSATION_TRIGGERS.join(', ')}.`,
        400,
        { field: 'settings.compensation.triggers' },
      );
    }
    // RFC 0151 erratum — refuse a trigger this host does not FIRE, not merely
    // one outside the vocabulary. Accepting it is a silent false promise: the
    // author believes those effects unwind and they never do. Same disposition
    // as the `orderingModel` check below.
    if (!FIRED_COMPENSATION_TRIGGERS.includes(t as never)) {
      throw new OpenwopError(
        'validation_error',
        `\`settings.compensation.triggers\` names \`${t}\`, which this host accepts but never fires. `
          + `It initiates: ${FIRED_COMPENSATION_TRIGGERS.join(', ')}. Refused at registration rather than `
          + 'accepted and silently ignored — a policy naming a trigger the host will not act on is a promise '
          + 'about committed effects that nothing keeps.',
        400,
        { field: 'settings.compensation.triggers' },
      );
    }
  }
  if (p.orderingModel !== undefined && p.orderingModel !== COMPENSATION_ORDERING_MODEL) {
    // The advertised set is exactly `['reverse-completion']` — this host does
    // not implement `dependency-graph`, so accepting a workflow that names it
    // would defer the failure to the worst possible moment.
    throw new OpenwopError(
      'validation_error',
      `\`settings.compensation.orderingModel\` MUST be one of the host's advertised capabilities.compensation.orderingModels — got '${String(p.orderingModel)}'.`,
      400,
      { field: 'settings.compensation.orderingModel', requiredCapability: 'compensation' },
    );
  }
  if (p.profileVersion !== undefined && p.profileVersion !== COMPENSATION_PROFILE_VERSION) {
    // §C: `profileVersion` participates in the inverse-action identity, so a
    // workflow authored under one ordering rule MUST NOT mint identities under
    // another.
    throw new OpenwopError(
      'validation_error',
      `\`settings.compensation.profileVersion\` MUST equal the host's advertised capabilities.compensation.profileVersion ('${COMPENSATION_PROFILE_VERSION}').`,
      400,
      { field: 'settings.compensation.profileVersion', requiredCapability: 'compensation' },
    );
  }
  const needsManual =
    p.exhaustedDisposition === 'manual-intervention'
    || p.onParentCancel === 'pause'
    || p.onParentCancel === 'manual';
  if (needsManual && resolveCapabilityFlag('compensation.manualIntervention') !== true) {
    throw new OpenwopError(
      'validation_error',
      '`settings.compensation` selects a manual-intervention disposition, which requires capabilities.compensation.manualIntervention: true.',
      400,
      { field: 'settings.compensation', requiredCapability: 'compensation.manualIntervention' },
    );
  }
}

export function validateWorkflowDefinition(raw: unknown): WorkflowDefinition {
  if (!raw || typeof raw !== 'object') {
    throw new OpenwopError('validation_error', 'Request body MUST be a JSON object.', 400);
  }
  const obj = raw as Record<string, unknown>;
  const workflowId = obj.workflowId;
  if (typeof workflowId !== 'string' || !WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw new OpenwopError(
      'validation_error',
      'Field `workflowId` MUST match [a-zA-Z0-9_.-:]{1,128}.',
      400,
      { field: 'workflowId' },
    );
  }
  if (!Array.isArray(obj.nodes) || obj.nodes.length === 0) {
    throw new OpenwopError('validation_error', 'Field `nodes` MUST be a non-empty array.', 400, { field: 'nodes' });
  }
  const seen = new Set<string>();
  const nodes = obj.nodes.map((n, i) => {
    if (!n || typeof n !== 'object') {
      throw new OpenwopError('validation_error', `nodes[${i}] MUST be an object.`, 400);
    }
    const node = n as Record<string, unknown>;
    if (typeof node.nodeId !== 'string' || !NODE_ID_PATTERN.test(node.nodeId)) {
      throw new OpenwopError('validation_error', `nodes[${i}].nodeId MUST match [a-zA-Z0-9_-]{1,128}.`, 400);
    }
    if (seen.has(node.nodeId)) {
      throw new OpenwopError('validation_error', `Duplicate nodeId: ${node.nodeId}`, 400);
    }
    seen.add(node.nodeId);
    if (typeof node.typeId !== 'string' || !TYPE_ID_PATTERN.test(node.typeId)) {
      throw new OpenwopError('validation_error', `nodes[${i}].typeId MUST match [a-zA-Z0-9_.-]{1,128}.`, 400);
    }
    if (node.config != null && (typeof node.config !== 'object' || Array.isArray(node.config))) {
      throw new OpenwopError('validation_error', `nodes[${i}].config MUST be an object when present.`, 400);
    }
    // RFC 0065 — optional advisory `outputRole` annotation; enum validation
    // matches the wire-level schema so the registered definition round-trips
    // through `workflow-definition.schema.json`.
    if (node.outputRole !== undefined && node.outputRole !== 'primary' && node.outputRole !== 'secondary') {
      throw new OpenwopError('validation_error', `nodes[${i}].outputRole MUST be 'primary' or 'secondary' when present.`, 400);
    }
    // CHAINX-5 safety-fix: `inputs` is a schema-`required` node field
    // (workflow-definition.schema.json §WorkflowNode — a map of PortValue
    // port declarations) that the executor DOES honor (executor.ts resolves
    // static/variable/connection PortValues + `{{inputs.*}}` tokens). Dropping
    // it here silently discarded the spec-mandated `{{params.*}}`-in-`inputs`
    // expansion substitution (RFC 0013 §"Substitution MUST recurse into …
    // `inputs`") and re-emitted defs missing a required field. Preserve it.
    if (node.inputs != null && (typeof node.inputs !== 'object' || Array.isArray(node.inputs))) {
      throw new OpenwopError('validation_error', `nodes[${i}].inputs MUST be an object when present.`, 400);
    }
    // RFC 0151 §B (ADR 0554 P2) — the node's inverse action. PRESERVED, not
    // dropped: this validator rebuilds the node from an allowlist of fields, so
    // an unlisted one is silently discarded. `compensation` being unlisted meant
    // a registered workflow lost its declarations entirely — the executor would
    // then mint no obligations and an unwind would report a clean `none` for a
    // run that committed real effects. The unwind is only reachable through this
    // path, so the whole phase was inert for registered workflows.
    const compensation = validateNodeCompensation(node.compensation, i);
    // RFC 0151 §B UQ4 (reachable from a chain via RFC 0157) — the author's
    // statement that this node's effect has NO inverse. Same allowlist hazard as
    // `compensation` above: unlisted ⇒ silently discarded, and a discarded
    // `irreversibleEffect` is worse than a discarded `compensation` because the
    // §D rollup would then report a clean `completed` for a run that committed an
    // effect nobody can undo.
    if (node.irreversibleEffect !== undefined && typeof node.irreversibleEffect !== 'boolean') {
      throw new OpenwopError(
        'validation_error',
        `nodes[${i}].irreversibleEffect MUST be a boolean when present.`,
        400,
        { field: `nodes[${i}].irreversibleEffect` },
      );
    }
    // `workflow-definition.schema.json` §WorkflowNode encodes this as
    // `if irreversibleEffect === true then not required compensation`, and its
    // description says a host "MUST reject it at registration
    // (`validation_error`)". An effect cannot both have and lack an inverse, and
    // picking a side for the author is the guess-at-a-contract failure.
    if (node.irreversibleEffect === true && compensation !== undefined) {
      throw new OpenwopError(
        'validation_error',
        `nodes[${i}] declares both \`irreversibleEffect: true\` and a \`compensation\` — an effect cannot both have and lack an inverse.`,
        400,
        { field: `nodes[${i}].irreversibleEffect` },
      );
    }
    return {
      nodeId: node.nodeId,
      typeId: node.typeId,
      ...(node.config ? { config: node.config as Record<string, unknown> } : {}),
      ...(node.inputs ? { inputs: node.inputs as Record<string, unknown> } : {}),
      ...(node.outputRole !== undefined ? { outputRole: node.outputRole as 'primary' | 'secondary' } : {}),
      ...(compensation ? { compensation } : {}),
      ...(node.irreversibleEffect !== undefined ? { irreversibleEffect: node.irreversibleEffect as boolean } : {}),
    };
  });
  // RFC 0022 §C capability-gate refusal check.
  checkMappingCapability(nodes);

  // Optional `edges` array — wire-shape matches `WorkflowEdge`.
  let edges: WorkflowDefinition['edges'];
  if (obj.edges !== undefined) {
    if (!Array.isArray(obj.edges)) {
      throw new OpenwopError('validation_error', 'Field `edges` MUST be an array when present.', 400, { field: 'edges' });
    }
    const nodeIds = new Set(nodes.map((n) => n.nodeId));
    const seenEdgeIds = new Set<string>();
    edges = obj.edges.map((rawEdge, i) => {
      if (!rawEdge || typeof rawEdge !== 'object') {
        throw new OpenwopError('validation_error', `edges[${i}] MUST be an object.`, 400);
      }
      const e = rawEdge as Record<string, unknown>;
      // ── Wire spelling vs internal spelling (H26, spec/v1/host-sample-test-seams.md §24) ──
      //
      // `workflow-definition.schema.json` §WorkflowEdge names this field `id`
      // (required, `additionalProperties: false`). The host's internal `EdgeDef`
      // (`executor/types.ts`) has always called it `edgeId`, and this ingest
      // boundary accepted only that — so a client that posts the CANONICAL
      // document it validated against was answered `400 validation_error`. The
      // 2026-08-16 conformance catalogue of this seam recorded the divergence
      // rather than the host's ability to read the wire shape.
      //
      // Translate here rather than renaming `EdgeDef`: `edgeId` is load-bearing
      // across the executor, the chain expander, the builder and the stored
      // definitions, and renaming it would be a data migration in service of a
      // spelling. `id` WINS when both are present — the canonical field is the
      // one the schema declares; `edgeId` remains accepted so every existing
      // caller (the builder's autosave, the chain expander, the sample seam's
      // own historic callers) keeps working unchanged.
      const edgeId = typeof e.id === 'string' ? e.id : e.edgeId;
      if (typeof edgeId !== 'string' || !EDGE_ID_PATTERN.test(edgeId)) {
        throw new OpenwopError('validation_error', `edges[${i}].id (or its host alias \`edgeId\`) MUST match [a-zA-Z0-9_-]{1,128}.`, 400);
      }
      if (seenEdgeIds.has(edgeId)) {
        throw new OpenwopError('validation_error', `Duplicate edgeId: ${edgeId}`, 400);
      }
      seenEdgeIds.add(edgeId);
      if (typeof e.sourceNodeId !== 'string' || !nodeIds.has(e.sourceNodeId)) {
        throw new OpenwopError('validation_error', `edges[${i}].sourceNodeId MUST reference a declared node.`, 400);
      }
      if (typeof e.targetNodeId !== 'string' || !nodeIds.has(e.targetNodeId)) {
        throw new OpenwopError('validation_error', `edges[${i}].targetNodeId MUST reference a declared node.`, 400);
      }
      if (e.triggerRule !== undefined && (typeof e.triggerRule !== 'string' || !TRIGGER_RULES.has(e.triggerRule))) {
        throw new OpenwopError('validation_error', `edges[${i}].triggerRule MUST be one of ${[...TRIGGER_RULES].join(', ')}.`, 400);
      }
      const out: Mutable<EdgeDef> = {
        edgeId,
        sourceNodeId: e.sourceNodeId,
        targetNodeId: e.targetNodeId,
      };
      if (typeof e.sourceOutput === 'string') out.sourceOutput = e.sourceOutput;
      if (typeof e.targetInput === 'string') out.targetInput = e.targetInput;
      if (typeof e.triggerRule === 'string') out.triggerRule = e.triggerRule as EdgeDef['triggerRule'];
      // Normalize the edge condition to the host executor's {path,op,value}
      // shape. A conformant client emits the WIRE shape {type,left,right}
      // (workflow-definition.schema.json §EdgeCondition); casting it straight
      // through left the executor with path/op undefined → the edge was
      // silently dropped. Route BOTH ingest seams through the one mapper so the
      // register route honestly honors the shape it advertises. ADR 0207 §Phase 2.
      if (e.condition !== undefined) out.condition = normalizeEdgeCondition(e.condition, edgeId);
      if (typeof e.label === 'string') out.label = e.label;
      return out;
    });
  }

  // Preserve the optional authoring/metadata surface when present so a
  // registered definition round-trips through `workflow-definition.schema.json`
  // (previously dropped — losing `metadata.authoring` provenance, ADR 0072, and
  // any `variables`/`inputSchema` an API caller sent). Conservative shape checks
  // only; the engine validates deeper at run time.
  const def: Mutable<WorkflowDefinition> = { workflowId, nodes };
  if (edges) def.edges = edges;
  if (obj.metadata !== undefined) {
    if (typeof obj.metadata !== 'object' || obj.metadata === null || Array.isArray(obj.metadata)) {
      throw new OpenwopError('validation_error', 'Field `metadata` MUST be an object when present.', 400, { field: 'metadata' });
    }
    def.metadata = obj.metadata as Record<string, unknown>;
  }
  if (obj.variables !== undefined) {
    if (!Array.isArray(obj.variables)) {
      throw new OpenwopError('validation_error', 'Field `variables` MUST be an array when present.', 400, { field: 'variables' });
    }
    def.variables = obj.variables as WorkflowDefinition['variables'];
  }
  if (obj.inputSchema !== undefined) {
    if (typeof obj.inputSchema !== 'object' || obj.inputSchema === null || Array.isArray(obj.inputSchema)) {
      throw new OpenwopError('validation_error', 'Field `inputSchema` MUST be an object when present.', 400, { field: 'inputSchema' });
    }
    def.inputSchema = obj.inputSchema as Record<string, unknown>;
  }
  if (obj.configurableSchema !== undefined) {
    if (typeof obj.configurableSchema !== 'object' || obj.configurableSchema === null || Array.isArray(obj.configurableSchema)) {
      throw new OpenwopError('validation_error', 'Field `configurableSchema` MUST be an object when present.', 400, { field: 'configurableSchema' });
    }
    def.configurableSchema = obj.configurableSchema as Record<string, unknown>;
  }
  // RFC 0151 §B (ADR 0554 P2) — refuse `settings.compensation` when the host
  // does not advertise the family. Checked BEFORE `settings` is preserved, so a
  // refused policy can never reach the stored definition on any path.
  if (obj.settings !== undefined) {
    if (typeof obj.settings !== 'object' || obj.settings === null || Array.isArray(obj.settings)) {
      throw new OpenwopError('validation_error', 'Field `settings` MUST be an object when present.', 400, { field: 'settings' });
    }
    checkCompensationPolicy(obj.settings);
    def.settings = obj.settings as WorkflowDefinition['settings'];
  }
  return def;
}
