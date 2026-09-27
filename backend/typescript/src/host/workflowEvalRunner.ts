/**
 * ADR 0477 §2 — the eval runner + assertion engine. Each case is an ORDINARY
 * draft run of the FULL head (the debug-run dispatch template): quota-charged,
 * audit-rowed, revision-pinned, with the case's pins applied as a
 * self-describing synthetic prefix + fork-checkpoint `resumeSnapshot` (pins
 * MOCK nodes; everything else executes). Verdicts land at run-terminal via
 * `onRunTerminal`; a case whose run never settles (an interrupt gate) is
 * timed out with an honest verdict — an eval suite always FINISHES.
 */

import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from './index.js';
import type { WorkflowDefinition } from '../executor/types.js';
import type { RunRecord } from '../types.js';
import { buildRunRecord, failRunClosedOnDispatchError } from './runDispatch.js';
import { insertRunWithStartContext } from './runInsert.js';
import { seedRunVariables, deferredConfigurableInputs } from './variablesRuntime.js';
import { executeRun, type SerializedSnapshot } from '../executor/executor.js';
import { getEventLog } from '../executor/eventLog.js';
import { onRunTerminal } from '../executor/runLifecycle.js';
import { createLogger } from '../observability/logger.js';
import {
  type EvalAssertion,
  type EvalCase,
  type EvalCaseResult,
  type WorkflowEvalSet,
  newEvalResultRow,
  putEvalResult,
  settleEvalCase,
  getEvalResult,
  isEvalCaseSettled,
  pruneEvalResults,
} from './workflowEvalSets.js';
import { revisionHashOf } from './definitionHash.js';

const log = createLogger('workflowEvalRunner');

export const EVAL_CASE_TIMEOUT_MS_DEFAULT = 120_000;
function caseTimeoutMs(): number {
  const v = Number(process.env.OPENWOP_EVAL_CASE_TIMEOUT_MS);
  return Number.isFinite(v) && v > 0 ? v : EVAL_CASE_TIMEOUT_MS_DEFAULT;
}

/** OQ1 — serial-ish: at most 2 case runs in flight per invocation. */
const CASE_STRIDE = 2;

/* ── the assertion engine ───────────────────────────────────────────────── */

/** P4b seam: evaluates an `llm-judge` assertion. Absent (P4a) or unavailable
 *  ⇒ the assertion FAILS with a named reason — an assertion that cannot be
 *  evaluated is never passing (ADR 0477 §3). */
export type EvalJudge = (input: { criteria: string; output: unknown; threshold?: number }) =>
  Promise<{ pass: boolean; detail: string }>;

function dotPath(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

interface RunEvidence {
  status: string;
  /** `run.completed.payload.outputs` (`output` on era-2 logs; undefined for failed runs). */
  output: unknown;
  /** nodeIds with a LIVE `node.completed` (synthetic pinned prefixes excluded). */
  completedNodes: Set<string>;
  /** nodeIds with any live start/completion. */
  touchedNodes: Set<string>;
}

/**
 * `pinnedNodeIds` — which nodes the case MOCKED. This used to be read off each
 * event as `payload.pinned`; the corpus ruled (replay.md §Determinism 5,
 * webhooks.md §Replay) that pinned-ness is a property of the RUN, not the event,
 * and the flag was dropped. The case's pin set IS `pinnedNodeIds[]` -- the same
 * seat rc.36 gives `eval-summary` -- so the evidence collector takes it from the
 * run's side rather than reading a fixed-history event for run-level state.
 */
export function collectRunEvidence(run: RunRecord, events: ReadonlyArray<{ type: string; nodeId?: string; payload?: unknown }>, pinnedNodeIds: ReadonlySet<string> = new Set()): RunEvidence {
  let output: unknown;
  const completedNodes = new Set<string>();
  const touchedNodes = new Set<string>();
  for (const e of events) {
    if (e.type === 'run.completed') {
      // `outputs` is the contract key (f4ecd05b8); era-2 logs on this host carry
      // `output`. Read both, never rewrite. This line was the reader f4ecd05b8
      // missed -- the doc comment moved and the code did not, and every eval
      // verdict went `failed` on `undefined`.
      const p = e.payload as { outputs?: unknown; output?: unknown } | undefined;
      output = p?.outputs ?? p?.output;
    }
    if (!e.nodeId) continue;
    // A mocked node's node.completed is NOT evidence that the node executed.
    if (e.type === 'node.completed' && !pinnedNodeIds.has(e.nodeId)) {
      completedNodes.add(e.nodeId);
      touchedNodes.add(e.nodeId);
    } else if (e.type === 'node.started' || e.type === 'node.failed') {
      touchedNodes.add(e.nodeId);
    }
  }
  return { status: run.status, output, completedNodes, touchedNodes };
}

export async function evaluateAssertions(
  assertions: readonly EvalAssertion[],
  evidence: RunEvidence,
  judge?: EvalJudge,
): Promise<Array<{ kind: string; pass: boolean; detail?: string }>> {
  const out: Array<{ kind: string; pass: boolean; detail?: string }> = [];
  for (const a of assertions) {
    switch (a.kind) {
      case 'status': {
        const pass = evidence.status === a.value;
        out.push({ kind: a.kind, pass, ...(pass ? {} : { detail: `expected status '${a.value}', got '${evidence.status}'` }) });
        break;
      }
      case 'output-contains': {
        const json = JSON.stringify(evidence.output ?? null);
        const pass = json.includes(a.value);
        out.push({ kind: a.kind, pass, ...(pass ? {} : { detail: `output does not contain '${a.value.slice(0, 120)}'` }) });
        break;
      }
      case 'output-path-equals': {
        const actual = dotPath(evidence.output, a.path);
        const pass = JSON.stringify(actual) === JSON.stringify(a.value);
        out.push({ kind: a.kind, pass, ...(pass ? {} : { detail: `output.${a.path} = ${JSON.stringify(actual)?.slice(0, 200) ?? 'undefined'}` }) });
        break;
      }
      case 'node-completed': {
        const pass = evidence.completedNodes.has(a.nodeId);
        out.push({ kind: a.kind, pass, ...(pass ? {} : { detail: `node '${a.nodeId}' did not complete (live)` }) });
        break;
      }
      case 'node-not-run': {
        const pass = !evidence.touchedNodes.has(a.nodeId);
        out.push({ kind: a.kind, pass, ...(pass ? {} : { detail: `node '${a.nodeId}' ran` }) });
        break;
      }
      case 'llm-judge': {
        if (!judge) {
          out.push({ kind: a.kind, pass: false, detail: 'judge_unavailable: no judge is configured on this host' });
          break;
        }
        try {
          const v = await judge({ criteria: a.criteria, output: evidence.output, ...(a.threshold !== undefined ? { threshold: a.threshold } : {}) });
          out.push({ kind: a.kind, pass: v.pass, detail: v.detail });
        } catch (err) {
          out.push({ kind: a.kind, pass: false, detail: `judge_error: ${err instanceof Error ? err.message : String(err)}` });
        }
        break;
      }
      default: {
        // Grade-data M5 — a persisted row can carry an assertion kind this
        // code doesn't know (rollback after a newer kind shipped; hand-edited
        // row). Silently omitting it would green a case on an assertion that
        // was NEVER evaluated — fail closed instead (the module contract:
        // never 'skipped' at evaluation time).
        const kind = (a as { kind?: unknown }).kind;
        out.push({ kind: typeof kind === 'string' ? kind : 'unknown', pass: false, detail: 'unknown_assertion_kind: this host version cannot evaluate it' });
        break;
      }
    }
  }
  return out;
}

/* ── the invocation ─────────────────────────────────────────────────────── */

export interface EvalRunDeps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
  judge?: EvalJudge;
}

export interface StartEvalRunInput {
  set: WorkflowEvalSet;
  definition: WorkflowDefinition;
  resultId: string;
  actingUserId?: string;
  /** Called per minted run so the HTTP layer can reserve concurrency slots. */
  onRunMinted?: (runId: string) => void;
}

/** Dispatch every case (stride-bounded), settle verdicts at terminal, and
 *  return immediately after the LAST case is dispatched. The result row is
 *  the observable state. */
export async function startEvalRun(deps: EvalRunDeps, input: StartEvalRunInput): Promise<void> {
  const { set, definition, resultId } = input;
  const row = newEvalResultRow({
    tenantId: set.tenantId,
    workflowId: set.workflowId,
    evalSetId: set.evalSetId,
    resultId,
    revisionHash: revisionHashOf(definition),
    caseIds: set.cases.map((c) => c.caseId),
    ...(input.actingUserId ? { startedBy: input.actingUserId } : {}),
  });
  await putEvalResult(row);

  let inFlight = 0;
  const queue = [...set.cases];
  const keyParts = { tenantId: set.tenantId, workflowId: set.workflowId, evalSetId: set.evalSetId, resultId };

  const settle = async (caseResult: EvalCaseResult): Promise<void> => {
    await settleEvalCase(keyParts, caseResult);
    const after = await getEvalResult(set.tenantId, set.workflowId, set.evalSetId, resultId);
    if (after?.status === 'complete') await pruneEvalResults(set.tenantId, set.workflowId, set.evalSetId);
  };

  const launchNext = (): void => {
    while (inFlight < CASE_STRIDE) {
      const c = queue.shift();
      if (!c) return;
      inFlight += 1;
      void dispatchCase(deps, input, c, keyParts, settle)
        .catch(async (err) => {
          log.error('eval_case_dispatch_failed', { evalSetId: set.evalSetId, caseId: c.caseId, error: err instanceof Error ? err.message : String(err) });
          await settle({ caseId: c.caseId, runId: '', status: 'failed', assertions: [{ kind: 'dispatch', pass: false, detail: 'dispatch_failed' }] });
        })
        .finally(() => {
          inFlight -= 1;
          launchNext();
        });
    }
  };
  launchNext();
}

async function dispatchCase(
  deps: EvalRunDeps,
  input: StartEvalRunInput,
  c: EvalCase,
  keyParts: { tenantId: string; workflowId: string; evalSetId: string; resultId: string },
  settle: (r: EvalCaseResult) => Promise<void>,
): Promise<void> {
  const { set, definition } = input;
  const nodeIds = new Set(definition.nodes.map((n) => n.nodeId));
  const badPins = (c.pins ?? []).filter((p) => !nodeIds.has(p.nodeId)).map((p) => p.nodeId);
  if (badPins.length > 0) {
    // A fixture referencing nodes the head no longer has cannot honestly run.
    await settle({
      caseId: c.caseId, runId: '', status: 'failed',
      assertions: [{ kind: 'fixture', pass: false, detail: `pinned node(s) not on the head: ${badPins.join(', ')}` }],
    });
    return;
  }

  const run = buildRunRecord({
    workflowId: set.workflowId,
    tenantId: set.tenantId,
    inputs: c.inputs ?? {},
    metadata: { launch: 'draft' },
    ...(input.actingUserId !== undefined ? { actingUserId: input.actingUserId } : {}),
  });
  run.metadata.launchResolved = 'head';
  // RESERVED post-strip stamp (grade-code M5) — only the runner marks eval runs.
  run.metadata.eval = { evalSetId: set.evalSetId, caseId: c.caseId, resultId: keyParts.resultId };
  await insertRunWithStartContext(deps.storage, run, { definition });
  seedRunVariables(run.runId, definition.variables, deferredConfigurableInputs(definition, run.configurable, c.inputs ?? {}));
  input.onRunMinted?.(run.runId);

  // The honest verdict path: settle exactly once per case (settleEvalCase
  // only replaces a case still 'running', so terminal-vs-timeout races are
  // first-writer-wins by construction).
  const timer = setTimeout(() => {
    void settle({
      caseId: c.caseId, runId: run.runId, status: 'timed_out',
      assertions: [{ kind: 'timeout', pass: false, detail: `no terminal state within ${caseTimeoutMs()}ms (an interrupt gate suspends eval runs — evals need gate-free paths or pinned gates)` }],
    });
  }, caseTimeoutMs());
  onRunTerminal(run.runId, () => {
    clearTimeout(timer);
    void (async () => {
      try {
        // Review LOW — a case the timeout already settled must not pay for a
        // live evaluation (an llm-judge assertion dispatches a model call).
        if (await isEvalCaseSettled(keyParts, c.caseId)) return;
        const settled = await deps.storage.getRun(run.runId);
        if (!settled) return;
        const events = await deps.storage.listEvents(run.runId, { fromSeq: -1, limit: 100_000 });
        const evidence = collectRunEvidence(settled, events, new Set((c.pins ?? []).map((p) => p.nodeId)));
        const verdicts = await evaluateAssertions(c.assertions, evidence, deps.judge);
        await settle({
          caseId: c.caseId,
          runId: run.runId,
          status: verdicts.every((v) => v.pass) ? 'passed' : 'failed',
          assertions: verdicts,
        });
      } catch (err) {
        log.error('eval_case_evaluation_failed', { caseId: c.caseId, runId: run.runId, error: err instanceof Error ? err.message : String(err) });
        await settle({ caseId: c.caseId, runId: run.runId, status: 'failed', assertions: [{ kind: 'evaluation', pass: false, detail: 'evaluation_error' }] });
      }
    })();
  });

  // Synthetic pinned prefix (the ADR 0475 self-describing checkpoint) when
  // the case mocks nodes; otherwise a plain fresh run.
  const pins = c.pins ?? [];
  try {
    if (pins.length > 0) {
      await getEventLog().append({ runId: run.runId, type: 'run.started', payload: { workflowId: set.workflowId } });
      for (const p of pins) {
        await getEventLog().append({
          runId: run.runId, type: 'node.completed', nodeId: p.nodeId,
          // `nodeId` inside the payload per $defs/nodeCompleted (required).
          // No `pinned` flag: pinned-ness is a property of the RUN, not the event
          // (replay.md §Determinism 5 -- recorded-fact events are re-emitted
          // verbatim; webhooks.md §Replay -- replay-ness is read from the run).
          // This runner is an eval FIXTURE (ADR 0477 §2: pins MOCK nodes on a
          // fresh draft run), and the pin set already lives on the run's resume
          // snapshot (`nodeState` / `nodeOutputs` below) -- the flag duplicated
          // run-level state onto a fixed-history event. Ruled and dropped.
          payload: { nodeId: p.nodeId, outputs: p.output },
        });
      }
      const snapshot: SerializedSnapshot = {
        schemaVersion: 1,
        nodeState: pins.map((p) => [p.nodeId, 'completed'] as [string, string]),
        nodeOutputs: pins.map((p) => [p.nodeId, p.output] as [string, Record<string, unknown>]),
        nodeErrors: [],
      };
      await executeRun(deps.storage, run, definition, {
        policyResolver: deps.hostSuite.providerPolicyResolver,
        resumeSnapshot: snapshot,
      });
    } else {
      await executeRun(deps.storage, run, definition, {
        policyResolver: deps.hostSuite.providerPolicyResolver,
      });
    }
  } catch (err) {
    // Review M2 — the debug-run template's discipline: a dispatch throw must
    // fail the RUN closed (terminal event + row), never leave a zombie
    // `running` run. The terminal listener above then settles the case.
    await failRunClosedOnDispatchError(deps.storage, run.runId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
