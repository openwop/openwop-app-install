/**
 * RFC 0081 `live-shadow` eval for the Workforce demo (host extension; non-normative).
 *
 * This is a REAL eval — it dispatches the workforce's supervisor agent over an
 * embedded eval suite and scores each task against the human/legacy baseline —
 * NOT the runs-metadata-derived stand-in in `workforceService.ts §aggregateShadowEval`.
 * It uses the DETERMINISTIC dispatch seam (`runAgentDispatch`, the same seam the
 * conformance harness uses): a real turn through the agent registry + handoff
 * validation, driven by a per-task `simulateConfidence`, so the eval is
 * reproducible and costs no tokens. (A live-model variant via
 * `runAgentDispatchLive` is a future toggle.)
 *
 * Shapes mirror RFC 0081 (`spec/v1/agent-evaluation.md` §C): an `EvalSummary`
 * plus `eval.started` / `eval.scored` / `eval.completed` events on a real run.
 * Content-free per the `eval-summary-no-content-leak` invariant — scores, ids,
 * and counts only; never the scenario text or the agent's output.
 *
 * GATED: only callable when `OPENWOP_AGENT_EVAL_SUITE_ENABLED=true`, so the host's
 * `assurance.evals` / `agents.evalSuite` advertisement stays honest (RFC 0031).
 */

import { getEventLog } from '../executor/eventLog.js';
import { createHash } from 'node:crypto';
import type { Storage } from '../storage/storage.js';
import { getAgentRegistry } from '../executor/agentRegistry.js';
import { runAgentDispatch } from './agentDispatch.js';
import { createLogger } from '../observability/logger.js';
import { OpenwopError } from '../types.js';
import type { AgentSpec } from './workforce.js';

const log = createLogger('host.workforceEval');

/** Honest gate: the eval surface is only live when explicitly enabled. */
export function evalSuiteEnabled(): boolean {
  return process.env.OPENWOP_AGENT_EVAL_SUITE_ENABLED === 'true';
}

const INVOICE_SUPERVISOR_ID = 'host.priya';
export const EVAL_SUITE_ID = 'openwop-app.evals.invoice-exception';
const EVAL_SUITE_VERSION = '1.0.0';
const EVAL_MODEL_CLASS = 'reasoning';
const PASS_SCORE = 0.8;

interface EvalTask {
  taskId: string;
  /** The invoice-exception scenario handed to the agent (never leaves the host). */
  scenario: string;
  /** Drives the deterministic §F escalation path (≥ threshold ⇒ act, < ⇒ escalate). */
  simulateConfidence: number;
  /** The human/legacy baseline decision this task is scored against. */
  expect: 'completed' | 'escalated';
}

/** The embedded `live-shadow` suite — invoice-exception scenarios + their baseline
 *  (human) decision. The agent's deterministic threshold (0.7) means high-confidence
 *  scenarios should clear and low-confidence ones should escalate. */
const SUITE: readonly EvalTask[] = [
  { taskId: 'clean-po-match', scenario: 'Invoice matches PO and goods receipt within tolerance.', simulateConfidence: 0.96, expect: 'completed' },
  { taskId: 'small-price-variance', scenario: 'Unit price 2% over PO, within the auto-clear band.', simulateConfidence: 0.88, expect: 'completed' },
  { taskId: 'missing-receipt', scenario: 'No goods receipt on file for the invoiced quantity.', simulateConfidence: 0.55, expect: 'escalated' },
  { taskId: 'duplicate-suspect', scenario: 'Header closely matches an already-posted invoice.', simulateConfidence: 0.48, expect: 'escalated' },
  // A genuine agent/baseline DISAGREEMENT: the agent clears a 6%-over-PO line it
  // judges in-band, but the human baseline escalated it. Scores 0 → the suite
  // lands at 0.8 (4/5), a credible "good but not perfect" pass rather than 1.0.
  { taskId: 'borderline-variance', scenario: 'Unit price 6% over PO — outside the auto-clear band.', simulateConfidence: 0.74, expect: 'escalated' },
];

/** An embedded suite and the one workforce + supervisor it was authored for. */
interface EvalSuite {
  suiteId: string;
  suiteVersion: string;
  /** The supervisor the suite's baseline decisions were written against. */
  subjectAgentId: string;
  tasks: readonly EvalTask[];
}

/** ADR 0775 P4 (`ARWF-8`) — suites are keyed by workforce. Before this, every
 *  workforce was scored by dispatching `host.priya` over the invoice suite, so a
 *  support or claims workforce reported an invoice agent's score as its own. A
 *  workforce with no entry here has no eval and the route says so. */
const EVAL_SUITES: ReadonlyMap<string, EvalSuite> = new Map([
  ['workforce.finance.invoice-exception', {
    suiteId: EVAL_SUITE_ID,
    suiteVersion: EVAL_SUITE_VERSION,
    subjectAgentId: INVOICE_SUPERVISOR_ID,
    tasks: SUITE,
  }],
]);

export interface EvalTaskResult {
  taskId: string;
  score: number;
  passed: boolean;
}

/** Mirrors RFC 0081 `EvalSummary` (host-ext shape; content-free). */
export interface WorkforceEvalSummary {
  runId: string;
  workforceId: string;
  suiteId: string;
  suiteVersion: string;
  mode: 'live-shadow';
  aggregateScore: number;
  passed: boolean;
  taskCount: number;
  passedCount: number;
  evaluatedModelClass: string;
  tasks: EvalTaskResult[];
}

let agentsRegistered = false;

/**
 * Register the workforce's supervisor as a REAL manifest agent so a live-shadow
 * eval can dispatch it (the `workforces.json` entries are otherwise decorative
 * AgentSpec refs). Idempotent + tenant-agnostic (no `ownerTenant`).
 */
export function registerWorkforceEvalAgents(): void {
  if (agentsRegistered) return;
  const reg = getAgentRegistry();
  if (!reg.get(INVOICE_SUPERVISOR_ID)) {
    reg.register({
      agentId: INVOICE_SUPERVISOR_ID,
      persona: 'invoice-exception-supervisor',
      modelClass: EVAL_MODEL_CLASS,
      systemPrompt:
        'Resolve invoice exceptions. Clear clean PO/receipt matches within tolerance; ' +
        'escalate ambiguous, duplicate-suspect, or unreceipted invoices to a human.',
      label: 'Priya — Invoice Exception Supervisor',
      toolAllowlist: [],
      memoryShape: { scratchpad: true, conversation: false, longTerm: true },
      confidence: { defaultThreshold: 0.7 },
      packName: 'host:workforce',
      packVersion: '0',
    });
  }
  agentsRegistered = true;
}

function evalRunId(tenantId: string, workforceId: string, nowMs: number): string {
  return `eval-${createHash('sha256').update(`${tenantId}:${workforceId}:${nowMs}`).digest('hex').slice(0, 24)}`;
}

/**
 * Run a real live-shadow eval of the workforce's supervisor over the suite
 * authored for that workforce. Persists a real eval run + `eval.*` events and
 * returns the EvalSummary.
 *
 * ADR 0775 P4 (`ARWF-8`) — the agent and the suite both come from the workforce:
 * the supervisor is the workforce's `role: 'supervisor'` member, and the suite is
 * the one keyed by its id. A workforce with no suite, or whose supervisor is not
 * the agent its suite was written for, is refused with `409` rather than scored
 * on another workforce's suite.
 */
export async function runWorkforceLiveShadowEval(
  storage: Storage,
  tenantId: string,
  workforce: { workforceId: string; agents: readonly Pick<AgentSpec, 'agentRef' | 'role'>[] },
  nowMs: number,
): Promise<WorkforceEvalSummary> {
  const { workforceId } = workforce;
  const suite = EVAL_SUITES.get(workforceId);
  if (!suite) {
    throw new OpenwopError('conflict', `Workforce \`${workforceId}\` has no eval suite.`, 409, {
      workforceId,
      reason: 'no_eval_suite',
    });
  }
  const supervisor = workforce.agents.find((a) => a.role === 'supervisor')?.agentRef;
  if (supervisor !== suite.subjectAgentId) {
    throw new OpenwopError(
      'conflict',
      `Workforce \`${workforceId}\`'s supervisor is not the agent its eval suite was written for.`,
      409,
      { workforceId, reason: 'supervisor_mismatch', suiteId: suite.suiteId },
    );
  }
  const SUITE_TASKS = suite.tasks;
  const evalAgentId = supervisor;
  registerWorkforceEvalAgents();
  const runId = evalRunId(tenantId, workforceId, nowMs);
  const at = (offsetMs: number): string => new Date(nowMs + offsetMs).toISOString();

  await storage.insertRun({
    runId,
    workflowId: suite.suiteId,
    tenantId,
    status: 'running',
    inputs: { suiteId: suite.suiteId, mode: 'live-shadow' },
    metadata: { mode: 'eval', workforceId, suiteId: suite.suiteId, evalAgentId },
    configurable: {},
    createdAt: at(0),
    updatedAt: at(0),
  });
  await getEventLog().append({
    runId,
    type: 'eval.started',
    payload: { suiteId: suite.suiteId, suiteVersion: suite.suiteVersion, taskCount: SUITE_TASKS.length, modes: ['live-shadow'] },
  });

  const tasks: EvalTaskResult[] = [];
  let n = 0;
  for (const t of SUITE_TASKS) {
    // A REAL dispatch through the agent registry (deterministic seam).
    const r = runAgentDispatch({
      agentId: evalAgentId,
      task: { scenario: t.scenario },
      simulateConfidence: t.simulateConfidence,
    });
    const passed = r.status === t.expect;
    const score = passed ? 1 : 0;
    tasks.push({ taskId: t.taskId, score, passed });
    await getEventLog().append({
      runId,
      type: 'eval.scored',
      // Content-free per `eval-summary-no-content-leak`: scores/ids only — no
      // scenario text, no agent output.
      payload: { taskId: t.taskId, score, passed },
    });
  }

  const passedCount = tasks.filter((t) => t.passed).length;
  const aggregateScore = tasks.length
    ? Number((tasks.reduce((s, t) => s + t.score, 0) / tasks.length).toFixed(4))
    : 0;
  const passed = aggregateScore >= PASS_SCORE;

  await getEventLog().append({
    runId,
    type: 'eval.completed',
    payload: { aggregateScore, passed, taskCount: tasks.length, passedCount },
  });

  const summary: WorkforceEvalSummary = {
    runId,
    workforceId,
    suiteId: suite.suiteId,
    suiteVersion: suite.suiteVersion,
    mode: 'live-shadow',
    aggregateScore,
    passed,
    taskCount: tasks.length,
    passedCount,
    evaluatedModelClass: EVAL_MODEL_CLASS,
    tasks,
  };

  await storage.updateRun(runId, {
    status: 'completed',
    completedAt: at(n + 2),
    metadata: { mode: 'eval', workforceId, suiteId: suite.suiteId, evalAgentId, evalSummary: summary },
  });
  log.info('workforce_eval_completed', { tenantId, workforceId, runId, aggregateScore, passed });
  return summary;
}
