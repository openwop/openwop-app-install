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

export const WORKFLOW_ID_PATTERN = /^[a-zA-Z0-9_.\-:]{1,128}$/;
export const NODE_ID_PATTERN = /^[a-zA-Z0-9_\-]{1,64}$/;
export const TYPE_ID_PATTERN = /^[a-zA-Z0-9_.\-]{1,128}$/;
export const EDGE_ID_PATTERN = /^[a-zA-Z0-9_\-]{1,64}$/;
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
      throw new OpenwopError('validation_error', `nodes[${i}].nodeId MUST match [a-zA-Z0-9_-]{1,64}.`, 400);
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
    return {
      nodeId: node.nodeId,
      typeId: node.typeId,
      ...(node.config ? { config: node.config as Record<string, unknown> } : {}),
      ...(node.outputRole !== undefined ? { outputRole: node.outputRole as 'primary' | 'secondary' } : {}),
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
      if (typeof e.edgeId !== 'string' || !EDGE_ID_PATTERN.test(e.edgeId)) {
        throw new OpenwopError('validation_error', `edges[${i}].edgeId MUST match [a-zA-Z0-9_-]{1,64}.`, 400);
      }
      if (seenEdgeIds.has(e.edgeId)) {
        throw new OpenwopError('validation_error', `Duplicate edgeId: ${e.edgeId}`, 400);
      }
      seenEdgeIds.add(e.edgeId);
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
        edgeId: e.edgeId,
        sourceNodeId: e.sourceNodeId,
        targetNodeId: e.targetNodeId,
      };
      if (typeof e.sourceOutput === 'string') out.sourceOutput = e.sourceOutput;
      if (typeof e.targetInput === 'string') out.targetInput = e.targetInput;
      if (typeof e.triggerRule === 'string') out.triggerRule = e.triggerRule as EdgeDef['triggerRule'];
      if (e.condition && typeof e.condition === 'object') out.condition = e.condition as EdgeDef['condition'];
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
  return def;
}
