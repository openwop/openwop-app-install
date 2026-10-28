/**
 * Demo-node availability for a set of workflow ids (ADR 0870 §Stopgap).
 *
 * The ten Work-Twin agents' portfolios bind pinned `tmpl.*` / `openwop-app.agents.*`
 * definitions (ADR 0775) whose AI steps are `local.sample.demo.mock-ai` — a node
 * that returns canned "Mock response to: …" text. LEAK-3
 * (`bootstrap/nodes.ts`, the `enterprisePosture()` guard around
 * `registry.register(mockAiNode)`) deliberately leaves that node UNREGISTERED in
 * the `auth` deploy posture, so on a sign-in deployment such a workflow fails at
 * dispatch with `node module not registered`.
 *
 * The agent portfolio UI used to decide "runnable" from a frontend-hard-coded id
 * list (`roleTemplates.ts isKnownWorkflow`), which is true for every pinned id in
 * every posture. This module is the backend answer the UI reads instead:
 *
 *   - `known`    — the id resolves through the SAME workflow catalog `POST /runs`
 *                  uses, and the caller may read it (the `GET /workflows/{id}`
 *                  tenant predicate). Unknown and foreign are indistinguishable
 *                  on purpose (no cross-tenant existence oracle).
 *   - `demo`     — the definition, or any `core.subWorkflow` child it binds by
 *                  `config.workflowId`, contains a mock-AI node.
 *   - `runnable` — false ONLY when it is a demo AND the mock node is not
 *                  resolvable here (`registry.isResolvable`, the same two lanes
 *                  `registry.resolve()` walks). It deliberately does not claim
 *                  to predict every other dispatch failure: it answers the one
 *                  question it can answer exactly.
 *
 * Host-extension, non-normative: served under `/host/openwop-app/*`; the
 * OpenWOP wire is untouched.
 */

import type { WorkflowDefinition } from '../executor/types.js';

/** The fabricated-output demo node (registered in `bootstrap/nodes.ts`). */
export const MOCK_AI_TYPE_ID = 'local.sample.demo.mock-ai';
const SUBWORKFLOW_TYPE_ID = 'core.subWorkflow';
/** Bounds the sub-workflow walk (the pinned twins nest one level). */
const MAX_DEPTH = 4;
/** Bounds one request (a portfolio plus the ~32 built-in picker templates). */
export const MAX_AVAILABILITY_IDS = 100;

export type WorkflowAvailabilityReason = 'demo-node-unavailable';

export interface WorkflowAvailability {
  workflowId: string;
  known: boolean;
  demo: boolean;
  runnable: boolean;
  /** Present iff `runnable === false`. */
  reason?: WorkflowAvailabilityReason;
}

export interface AvailabilityDeps {
  /** Catalog read (catalog source A + registry + fixtures), already
   *  tenant-filtered: returns null for an id the caller may not read. */
  readDefinition: (workflowId: string) => Promise<WorkflowDefinition | null>;
  /** `getNodeRegistry().isResolvable`. */
  isResolvable: (typeId: string) => boolean;
}

/** Does `def` (or a sub-workflow child it binds) use the mock-AI node? */
async function usesMockAi(
  def: WorkflowDefinition,
  read: AvailabilityDeps['readDefinition'],
  depth: number,
  seen: Set<string>,
): Promise<boolean> {
  for (const node of def.nodes ?? []) {
    if (node.typeId === MOCK_AI_TYPE_ID) return true;
  }
  if (depth >= MAX_DEPTH) return false;
  for (const node of def.nodes ?? []) {
    if (node.typeId !== SUBWORKFLOW_TYPE_ID) continue;
    const childId = (node.config as { workflowId?: unknown } | undefined)?.workflowId;
    if (typeof childId !== 'string' || seen.has(childId)) continue;
    seen.add(childId);
    const child = await read(childId).catch(() => null);
    if (child && (await usesMockAi(child, read, depth + 1, seen))) return true;
  }
  return false;
}

export async function assessWorkflowAvailability(
  workflowIds: readonly string[],
  deps: AvailabilityDeps,
): Promise<WorkflowAvailability[]> {
  const mockResolvable = deps.isResolvable(MOCK_AI_TYPE_ID);
  const ids = [...new Set(workflowIds)].slice(0, MAX_AVAILABILITY_IDS);
  return Promise.all(ids.map(async (workflowId): Promise<WorkflowAvailability> => {
    const def = await deps.readDefinition(workflowId).catch(() => null);
    if (!def) return { workflowId, known: false, demo: false, runnable: false };
    const demo = await usesMockAi(def, deps.readDefinition, 0, new Set([workflowId]));
    if (demo && !mockResolvable) {
      return { workflowId, known: true, demo, runnable: false, reason: 'demo-node-unavailable' };
    }
    return { workflowId, known: true, demo, runnable: true };
  }));
}

/**
 * ADR 0979 D2 — did this run's output come from a node that MAKES UP output?
 * True when a COMPLETED node is the mock-AI node (version suffix stripped, as a
 * chain-pack typeId carries `@0.1.0`) or recorded a placeholder marker: `stub:
 * true`, or `engine: 'stub' | 'demo'` (the two shapes `core.web.search` returns
 * with no live search provider, and the ones KickTodo already refuses as
 * evidence, `kicktodo-creator/creatorService.ts`). The executor writes no
 * run summary for such a run: a memory entry is a durable record, and under the
 * scope cap each fabricated row evicts a real one.
 *
 * NOT detected, stated: a fabricating step inside a `core.subWorkflow` child (the
 * child's own summary is skipped) or a dynamically spawned node.
 */
export function runOutputWasFabricated(
  nodes: ReadonlyArray<{ nodeId: string; typeId: string }>,
  nodeState: ReadonlyMap<string, string>,
  nodeOutputs: ReadonlyMap<string, Record<string, unknown> | undefined>,
): boolean {
  for (const n of nodes) {
    if (nodeState.get(n.nodeId) !== 'completed') continue;
    if (n.typeId.replace(/@.*$/, '') === MOCK_AI_TYPE_ID) return true;
    const out = nodeOutputs.get(n.nodeId);
    if (out?.stub === true || out?.engine === 'stub' || out?.engine === 'demo') return true;
  }
  return false;
}
