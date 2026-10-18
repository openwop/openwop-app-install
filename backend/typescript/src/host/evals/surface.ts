/**
 * ADR 0889 WF-EV-11 — the `ctx.features.evals` workflow surface: a chain node can
 * start an agent eval run, read its scorecard, and cancel it.
 *
 * The node is `feature.evals.nodes.run-suite` (`packs/feature.evals.nodes`), and
 * the reference chain is `examples/workflow-chain-packs/agent-eval-regression-gate`.
 * This is the in-app half of D10's regression gate: the CLI exit code was the only
 * gate, and nothing inside the app could act on a `regressed` verdict.
 *
 * Nothing here is a second path. Each method calls the code its chat tool and
 * route call — `createAgentEvalRun` (through its once-only wrapper), the stored `metadata.evalSummary`, and the
 * ONE cancel recipe `cancelRunAndCascade` — behind the SAME predicate the tools
 * use (`agentEvalsToolGate`: the `evals` toggle + plan, then the route's tenant
 * scope). The seam additionally gates the `evals` toggle, because the surface id
 * IS that toggle id. Without an acting user every method fails typed: a run with
 * no person behind it cannot spend model calls.
 *
 * Exactly once per node execution (ADR 0889 §Grade remediation): `startSuiteRun`
 * creates through `createAgentEvalRunOnce` keyed `<the workflow run>:<nodeId>`, so
 * a node re-dispatched after a crash (between the start and its recorded outcome)
 * gets the SAME eval run back instead of starting and paying for a second one.
 * The run id comes from the surface's own scope, never from the node. The node
 * also cancels its child on abort and on timeout. The child eval run still carries
 * no `parentRunId`, so a cancel does not cascade by itself (`EVR-*`, TODO.md).
 */
import { OpenwopError } from '../../types.js';
import type { BundleScope } from '../inMemorySurfaces.js';
import type { FeatureSurface } from '../featureSurfaces.js';
import { hostExtStorage } from '../hostExtPersistence.js';
import { cancelRunAndCascade } from '../runCancel.js';
import { agentEvalsToolGate } from './access.js';
import { createAgentEvalRunOnce } from './createEvalRun.js';
import { isAgentEvalRun } from './agentEvalRun.js';
import { storedRunId } from './runIds.js';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

async function gate(scope: BundleScope, needed: 'workspace:read' | 'workspace:write'): Promise<string> {
  if (!scope.actingUserId) throw new OpenwopError('forbidden', 'An eval run needs a signed-in person behind the workflow run.', 403, { reason: 'acting_user_required' });
  const refused = await agentEvalsToolGate(scope, needed);
  if (refused) throw new OpenwopError('forbidden', refused.message, 403, { reason: refused.error });
  return scope.actingUserId;
}

/** The tenant's own eval run, or a uniform 404 (another tenant's is indistinguishable). */
async function loadEvalRun(scope: BundleScope, runId: string) {
  const id = storedRunId(runId, scope.tenantId);
  const run = id ? await hostExtStorage().getRun(id) : null;
  if (!run || run.tenantId !== scope.tenantId || !isAgentEvalRun(run)) throw new OpenwopError('not_found', 'Eval run not found.', 404);
  return run;
}

export function buildAgentEvalsSurface(scope: BundleScope): FeatureSurface {
  return {
    /** Start an eval run of `suiteRef` against `agentId` (optionally vs `baselineRunId`).
     *  `nodeId` (the calling node) scopes the once-only key to one node of this run. */
    startSuiteRun: async (raw) => {
      const actingUserId = await gate(scope, 'workspace:write');
      const { suiteRef, agentId, baselineRunId, nodeId } = (raw ?? {}) as Record<string, unknown>;
      const dedupeKey = scope.runId && str(nodeId) ? `${scope.runId}:${str(nodeId)}` : undefined;
      const created = await createAgentEvalRunOnce({
        ...(dedupeKey ? { dedupeKey } : {}),
        caller: { actingUserId, ...(scope.personalTenant ? { personalTenant: scope.personalTenant } : {}) },
        storage: hostExtStorage(),
        tenantId: scope.tenantId,
        body: {
          mode: 'eval', evalSuiteRef: str(suiteRef), agentId: str(agentId),
          ...(str(baselineRunId) ? { configurable: { baselineRunId: str(baselineRunId) } } : {}),
        },
      });
      return { runId: created.runId, status: created.status };
    },

    /** The run's status and, once terminal, its content-free scorecard. */
    getRun: async (raw) => {
      await gate(scope, 'workspace:read');
      const { runId } = (raw ?? {}) as Record<string, unknown>;
      const run = await loadEvalRun(scope, str(runId));
      return { runId: run.runId, status: run.status, summary: run.metadata?.evalSummary ?? null, error: run.error ?? null };
    },

    /** Cancel the run (the ONE cancel recipe). A terminal run is left as it is. */
    cancelRun: async (raw) => {
      await gate(scope, 'workspace:write');
      const { runId } = (raw ?? {}) as Record<string, unknown>;
      const run = await loadEvalRun(scope, str(runId));
      const outcome = await cancelRunAndCascade(hostExtStorage(), run, 'cancelled by the workflow that started it');
      return { runId: run.runId, outcome };
    },
  };
}
