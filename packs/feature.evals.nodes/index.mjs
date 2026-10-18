/**
 * feature.evals.nodes — agent eval nodes over the `ctx.features.evals` surface
 * (ADR 0889 WF-EV-11). Pure-JS, Node-20 stdlib only.
 *
 * `run-suite` is role:"side-effect". Starting an eval run spends model calls on
 * every task and trial, so the derived side-effect floor must serve a replay fork
 * the recorded outcome instead of executing the node again (a role:"action" node
 * is re-executed on a fork and would start a second eval run).
 *
 * The node never reports a pass it did not read: a refused start, an eval run that
 * ends `failed` or `cancelled`, and a wait that runs out are typed failures. When
 * the workflow run is cancelled, or the wait times out, it cancels its eval run so
 * the spend stops with it.
 *
 * 1.1.0: it passes its own `nodeId`, and the surface starts the eval run once per
 * (workflow run, node). A node re-dispatched after a crash between the start and
 * its recorded outcome gets the same eval run back, not a second one.
 */

const DEFAULT_TIMEOUT_MS = 540_000; // inside the executor's 600 000 ms run-duration ceiling
const DEFAULT_POLL_MS = 2_000;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v, min, max, dflt) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, min), max) : dflt);

function ensureEvals(ctx) {
  const ev = ctx.features && ctx.features.evals;
  if (!ev || typeof ev.startSuiteRun !== 'function' || typeof ev.getRun !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.features.evals — the evals feature must be composed and enabled (ADR 0889)'),
      { code: 'host_capability_missing', capability: 'host.sample.evals' },
    );
  }
  return ev;
}

/** A surface refusal as a typed node failure: the refusal reason when there is one. */
function failed(code, err) {
  const reason = err && err.details && typeof err.details.reason === 'string' ? err.details.reason : null;
  return {
    status: 'failed',
    error: { code: reason || (err && typeof err.code === 'string' ? err.code : code), message: err instanceof Error ? err.message : String(err) },
  };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function cancelQuietly(ev, runId) {
  if (typeof ev.cancelRun !== 'function') return;
  try { await ev.cancelRun({ runId }); } catch { /* best effort: the run may already be terminal */ }
}

/** run-suite — start an eval run, wait for it, output the scorecard and the gate. */
export async function runSuite(ctx) {
  const ev = ensureEvals(ctx);
  const i = { ...(ctx.config ?? {}), ...(ctx.inputs ?? {}) };
  const timeoutMs = num(i.timeoutMs, 1_000, DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const pollMs = num(i.pollIntervalMs, 20, 10_000, DEFAULT_POLL_MS);

  let started;
  try {
    started = await ev.startSuiteRun({
      suiteRef: str(i.suiteRef),
      agentId: str(i.agentId),
      baselineRunId: str(i.baselineRunId) || undefined,
      nodeId: str(ctx.nodeId) || undefined,
    });
  } catch (err) {
    return failed('eval_start_failed', err);
  }
  const evalRunId = started.runId;

  const deadline = Date.now() + timeoutMs;
  let run;
  try {
    for (;;) {
      run = await ev.getRun({ runId: evalRunId });
      if (TERMINAL.has(run.status)) break;
      if (Date.now() >= deadline) {
        await cancelQuietly(ev, evalRunId);
        return { status: 'failed', error: { code: 'eval_wait_timeout', message: `Eval run ${evalRunId} did not finish within ${timeoutMs} ms; it was cancelled.` } };
      }
      await sleep(pollMs, ctx.signal);
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      await cancelQuietly(ev, evalRunId);
      throw err;
    }
    return failed('eval_read_failed', err);
  }

  if (run.status !== 'completed' || !run.summary) {
    const code = run.error && typeof run.error.code === 'string' ? run.error.code : 'eval_run_' + run.status;
    return { status: 'failed', error: { code, message: `Eval run ${evalRunId} ended ${run.status}${run.error && run.error.message ? `: ${run.error.message}` : ''}.` } };
  }
  const s = run.summary;
  const verdict = s.regression && typeof s.regression.verdict === 'string' ? s.regression.verdict : null;
  const passed = s.passed === true;
  const regressed = verdict === 'regressed';
  return {
    status: 'success',
    outputs: {
      evalRunId,
      status: 'completed',
      passed,
      regressed,
      ok: passed && !regressed,
      aggregateScore: s.aggregateScore,
      passedCount: s.passedCount,
      taskCount: s.taskCount,
      verdict,
    },
  };
}

export const nodes = {
  'feature.evals.nodes.run-suite': runSuite,
};

export default nodes;
