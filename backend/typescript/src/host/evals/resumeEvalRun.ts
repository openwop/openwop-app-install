/**
 * ADR 0889 A1 — resume an orphaned eval run (called by the dispatch sweeper).
 *
 * The suite is re-resolved by the run's recorded `suiteRef`. A tenant suite is
 * immutable once referenced (`lockedAt`), so the resumed run grades against the
 * exact suite it started with. A suite that has since vanished (deleted) cannot
 * be resumed honestly: the run fails typed, never guesses.
 */
import { emitTerminalFailure } from '../../executor/executor.js';
import { notifyRunTerminal } from '../../executor/runLifecycle.js';
import type { Storage } from '../../storage/storage.js';
import type { RunRecord } from '../../types.js';
import { tenantEvalJudge } from '../workflowEvalJudge.js';
import { resolveEvalSuite } from './createEvalRun.js';
import { suiteDigest } from './packSuites.js';
import { runAgentEval, type AgentEvalMeta } from './agentEvalRun.js';
import { agentEvalsRefusal } from './access.js';

export async function resumeAgentEvalRun(
  storage: Storage,
  run: RunRecord,
  policyResolver?: Parameters<typeof runAgentEval>[0]['policyResolver'],
): Promise<void> {
  const meta = (run.metadata ?? {}).eval as AgentEvalMeta;
  // Review H1 — a run whose workspace lost `evals` (toggle off / plan narrowed)
  // must not keep spending on resume. A resolver FAULT is not a refusal: leave the
  // run for the next sweep rather than failing it on an outage.
  const refusal = await agentEvalsRefusal({ tenantId: run.tenantId });
  if (refusal === 'feature_unavailable') return;
  if (refusal) {
    await emitTerminalFailure({ storage, runId: run.runId, error: { code: 'eval_feature_disabled', message: `Agent evals are no longer available for this workspace (${refusal}); the interrupted eval run was not resumed.` } }).catch(() => undefined);
    notifyRunTerminal(run.runId, 'failed');
    return;
  }
  const resolved = await resolveEvalSuite(run.tenantId, meta.suiteRef, meta.agentId);
  // A pack upgrade, a corpus pin bump (fixture suites) or an erasure redaction can
  // change a suite under the same ref; never finish a run on other content. Every
  // source is compared once the run carries a digest (WF-EV-8).
  const swapped = resolved && meta.suiteDigest !== undefined && suiteDigest(resolved.suite) !== meta.suiteDigest;
  if (!resolved || swapped) {
    await emitTerminalFailure({ storage, runId: run.runId, error: { code: 'eval_suite_unavailable', message: swapped ? `Suite ${meta.suiteRef} changed since the run started; the interrupted eval run cannot resume.` : `Suite ${meta.suiteRef} is no longer available; the interrupted eval run cannot resume.` } }).catch(() => undefined);
    notifyRunTerminal(run.runId, 'failed');
    return;
  }
  // The runner decides which preamble/terminal events are missing from the LOG,
  // not from `run.status` (WF-EV-4): the row and the log disagree in exactly the
  // crash windows a resume exists for. `claimOrphanedRuns` stamped this instance
  // as the owner, so `resume` only skips re-stamping the lease.
  await runAgentEval(
    { storage, run, suite: resolved.suite, judge: tenantEvalJudge(run.tenantId), ...(policyResolver ? { policyResolver } : {}) },
    { resume: true },
  );
}
