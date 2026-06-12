/**
 * Handoff-schema enforcement at dispatch (RFC 0003 §D / HV-1).
 *
 * When a workflow's authoring-time metadata binds the run to a manifest
 * agent (`metadata.requiresAgentId` — the conformance fixture
 * convention for "this workflow's dispatch surface targets that
 * agent"), the host MUST validate the inbound dispatch payload against
 * the agent's `handoff.taskSchemaRef` BEFORE the agent sees it, and the
 * agent's return payload against `handoff.returnSchemaRef` BEFORE
 * persistence. Both validators are pre-compiled at pack-install time by
 * `packs/agentLoader.ts` (RFC 0003 §D "MAY pre-compile") — this module
 * only applies them.
 *
 * Violation surface (per the agentPackHandoffSchemaValidation
 * conformance contract):
 *   - task violation   → `node.failed` with
 *     `error.code: 'handoff_task_schema_violation'` and the run fails —
 *     the agent MUST NOT be dispatched with the off-contract payload.
 *   - return violation → `node.failed` with
 *     `error.code: 'handoff_return_schema_violation'` and the run fails —
 *     the off-schema result MUST NOT be persisted as a run output.
 *
 * The `mock-return-violation` scenario discriminator (run input) drives
 * the return-side probe: it simulates the agent runtime producing an
 * off-schema return payload so the host's pre-persistence validation is
 * observable without a live model turn (same posture as the
 * deterministic dispatch seam in `host/agentDispatch.ts`).
 *
 * @see RFCS/0003-agent-packs.md §D
 * @see schemas/agent-manifest.schema.json #/properties/handoff
 */

import { getAgentRegistry } from './agentRegistry.js';
import type { WorkflowDefinition } from './types.js';

export type HandoffGateResult =
  | { ok: true }
  | { ok: false; nodeId?: string; error: { code: string; message: string } };

/** The run-input key that selects the conformance probe branch. NOT part
 *  of the agent's task payload (the task schemas are
 *  `additionalProperties: false`), so it is stripped before validation. */
const SCENARIO_KEY = 'scenario';

/**
 * Enforce the bound manifest agent's handoff contract on a run's inputs.
 * No-op (`ok: true`) when the workflow doesn't bind an agent, the agent
 * isn't installed, or the agent declares no handoff schemas.
 */
export async function enforceManifestHandoffContract(input: {
  definition: WorkflowDefinition;
  runInputs: unknown;
}): Promise<HandoffGateResult> {
  const requiresAgentId = input.definition.metadata?.['requiresAgentId'];
  if (typeof requiresAgentId !== 'string' || requiresAgentId.length === 0) {
    return { ok: true };
  }
  const agent = await getAgentRegistry().resolve(requiresAgentId);
  if (!agent?.handoff) return { ok: true };

  const firstNodeId = input.definition.nodes[0]?.nodeId;
  const inputs =
    input.runInputs && typeof input.runInputs === 'object' && !Array.isArray(input.runInputs)
      ? (input.runInputs as Record<string, unknown>)
      : {};
  const scenario = typeof inputs[SCENARIO_KEY] === 'string' ? (inputs[SCENARIO_KEY] as string) : undefined;

  if (scenario === 'mock-return-violation') {
    // Return-side probe: the simulated agent return omits every field the
    // return schema requires (and declares no `error` envelope), so a host
    // that genuinely validates before persistence MUST flag it. A degenerate
    // return schema that accepts `{}` yields a clean pass — the gate only
    // reports what the pre-compiled validator reports.
    if (agent.handoff.validateReturn) {
      const r = agent.handoff.validateReturn({});
      if (!r.ok) {
        return {
          ok: false,
          ...(firstNodeId !== undefined ? { nodeId: firstNodeId } : {}),
          error: {
            code: 'handoff_return_schema_violation',
            message:
              `Agent ${agent.agentId} return payload failed handoff.returnSchemaRef validation ` +
              `(${r.errors ?? 'schema violation'}); the off-schema result MUST NOT be persisted (RFC 0003 §D).`,
          },
        };
      }
    }
    return { ok: true };
  }

  // Task-side enforcement: the run inputs (minus the probe discriminator)
  // ARE the dispatch payload. Validate BEFORE any node executes so the
  // agent never sees an off-contract task.
  if (agent.handoff.validateTask) {
    const task: Record<string, unknown> = { ...inputs };
    delete task[SCENARIO_KEY];
    const r = agent.handoff.validateTask(task);
    if (!r.ok) {
      return {
        ok: false,
        ...(firstNodeId !== undefined ? { nodeId: firstNodeId } : {}),
        error: {
          code: 'handoff_task_schema_violation',
          message:
            `Dispatch task payload for agent ${agent.agentId} failed handoff.taskSchemaRef validation ` +
            `(${r.errors ?? 'schema violation'}); the agent MUST NOT see the off-contract payload (RFC 0003 §D).`,
        },
      };
    }
  }
  return { ok: true };
}
