/**
 * ADR 0950 P2 — start a governed promotion: the `experiments.promote` chain,
 * one live run per experiment.
 *
 * Order matters (architect review #1/#2):
 *   1. every gate passes NOW (else 409 `gate_failed`, naming them);
 *   2. the experiment is CLAIMED for a fresh run id (CAS on `promotionRunId`;
 *      409 `promotion_in_progress` while a previous promotion run is still live,
 *      so a crashed run never wedges it);
 *   3. the run starts through the ONE starter; a definitive null refusal releases
 *      the claim, while an uncertain insert keeps it through reconciliation.
 * Every promotion node refuses any run but the claimed one, so the chain cannot
 * be driven by a hand-launched copy.
 */
import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import type { Storage } from '../../storage/storage.js';
import type { HostAdapterSuite } from '../../host/index.js';
import { startWorkflowRun } from '../../host/runStarter.js';
import { getChainBackedWorkflow } from '../../host/chainBackedWorkflows.js';
import { definitionHashOf } from '../../host/definitionHash.js';
import { hostExtStorage } from '../../host/hostExtPersistence.js';
import { checkPromotionAdmission } from '../../host/experiments/promotion.js';
import { claimPromotionRun, MAX_HOLDOUT_PCT, MIN_HOLDOUT_PCT, releasePromotionRun, type PromotionRunState } from '../../host/experiments/promote.js';
import { getExperimentRow } from '../../host/experiments/store.js';

export const PROMOTE_CHAIN_ID = 'experiments.promote';
export const AUTO_PROMOTE_TOGGLE = 'experiments.auto-promote';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

async function promotionRunState(runId: string): Promise<PromotionRunState> {
  const run = await hostExtStorage().getRun(runId);
  return run ? (TERMINAL.has(run.status) ? 'terminal' : 'live') : 'missing';
}

export interface StartPromotionInput {
  holdoutPct?: unknown;
}

export async function startPromotion(
  deps: { storage: Storage; hostSuite: HostAdapterSuite },
  tenantId: string, orgId: string, experimentId: string, actor: string, input: StartPromotionInput = {},
): Promise<{ runId: string; experimentId: string; winner: string }> {
  const exp = await getExperimentRow(tenantId, orgId, experimentId);
  if (!exp) throw new OpenwopError('not_found', 'Experiment not found.', 404, {});
  const holdoutPct = input.holdoutPct === undefined ? exp.promotion?.holdoutPct ?? 2 : input.holdoutPct;
  if (typeof holdoutPct !== 'number' || !Number.isInteger(holdoutPct) || holdoutPct < MIN_HOLDOUT_PCT || holdoutPct > MAX_HOLDOUT_PCT) {
    throw new OpenwopError('validation_error', `holdoutPct is a whole number from ${MIN_HOLDOUT_PCT} to ${MAX_HOLDOUT_PCT}.`, 400, { field: 'holdoutPct' });
  }
  if (exp.promotion && holdoutPct !== exp.promotion.holdoutPct) throw new OpenwopError('conflict', 'A resumed promotion keeps its original holdout.', 409, { reason: 'holdout_changed' });
  const now = new Date().toISOString();
  const admission = await checkPromotionAdmission(exp, now);
  const trustedDefinition = getChainBackedWorkflow(PROMOTE_CHAIN_ID);
  if (!trustedDefinition) throw new OpenwopError('workflow_not_found', `Promotion workflow not found: ${PROMOTE_CHAIN_ID}`, 422, { workflowId: PROMOTE_CHAIN_ID });
  const runId = randomUUID();
  await claimPromotionRun(tenantId, orgId, experimentId, runId, promotionRunState, now, admission);
  let started: string | null = null;
  let returned = false;
  try {
    started = await startWorkflowRun(deps, {
      tenantId,
      workflowId: PROMOTE_CHAIN_ID,
      expectedDefinitionHash: definitionHashOf(trustedDefinition),
      runId,
      inputs: {
        orgId, experimentId, holdoutPct,
      },
      metadata: { experimentPromotion: { experimentId, orgId, ...admission } },
      orgScopeSubject: actor,
    });
    returned = true;
  } finally {
    // A throw may follow a committed insert/outbox write. Retain authority until
    // the run can be reconciled (or the existing missing-run grace expires).
    // A normal null return proves that no workflow was started.
    if (returned && !started) await releasePromotionRun(tenantId, orgId, experimentId, runId);
  }
  if (!started) throw new OpenwopError('workflow_not_found', `Promotion workflow not found: ${PROMOTE_CHAIN_ID}`, 422, { workflowId: PROMOTE_CHAIN_ID });
  return { runId, experimentId, winner: admission.winner };
}
