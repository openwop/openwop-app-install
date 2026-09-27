/**
 * feature.code-exec.nodes — sandboxed code execution (ADR 0114 Phase 1).
 *
 * The `run` node delegates to the host `ctx.runSandboxedCode` adapter. CAPABILITY-HONEST: when
 * no sandbox executor resolves, it throws `capability_not_provided` rather than pretending to
 * execute.
 *
 * CORRECTED (ADR 0686 D2) — this used to say "the DEFAULT — there is no in-process runtime by
 * design". Phase 8 added a THIRD rung: `host/sandboxAdapter.ts` resolves first-party E2B, then
 * the external Code-API endpoint, then an OPT-IN **in-process** CPython-WASI runtime (`:222`,
 * no host FFI). Honest-off is intact — the resolver still returns `undefined` when none is
 * configured — but "there is no in-process runtime" is false as written.
 *
 * REPLAY CLASSIFICATION (ADR 0686 D1) — this header used to claim: "Action node — its output is
 * recorded in the event log, so replay/fork read the recorded result and NEVER re-execute."
 * **That was FALSE, and on the one node where it matters most.** `role:"action"` confers
 * nothing: `gen-side-effect-floor.mjs:139` binds `role === 'side-effect'` OR the
 * `side-effectful` capability, and nothing under `src/executor/` compares `role` to "action".
 * This node carried NEITHER, so it sat in `MANIFEST_DECLARED_TYPE_IDS` alone and
 * `isSideEffectingNode` returned false — meaning a `mode:'replay'` fork **re-ran arbitrary user
 * code in a paid sandbox**. Nor is that masked by a backstop: `sandboxAdapter.ts` makes no
 * `assertEffectAllowed` call, so the replay did not throw, it executed. The node now declares
 * `capabilities: ["side-effectful"]`, which the guarantee above actually depends on.
 *
 * Pure-JS, Node-20 stdlib only. The sandbox endpoint + credential are brokered
 * host-side (ADR 0024 / RFC 0076); they never reach this node.
 */

function inputs(ctx) {
  const i = ctx.inputs ?? {};
  return {
    language: typeof i.language === 'string' ? i.language : 'python',
    code: typeof i.code === 'string' ? i.code : '',
    stdin: typeof i.stdin === 'string' ? i.stdin : undefined,
    timeoutMs: typeof i.timeoutMs === 'number' ? i.timeoutMs : undefined,
  };
}

export async function run(ctx) {
  if (typeof ctx.runSandboxedCode !== 'function') {
    throw Object.assign(
      new Error('host does not expose ctx.runSandboxedCode — no sandbox adapter is wired (ADR 0114). Code execution is unavailable on this host.'),
      { code: 'capability_not_provided', capability: 'host.sample.code-exec' },
    );
  }
  const { language, code, stdin, timeoutMs } = inputs(ctx);
  if (!code) {
    throw Object.assign(new Error('`code` is required'), { code: 'validation_error' });
  }
  // ADR 0114 Phase 3 — HITL approval BEFORE execution. Code execution is
  // high-blast-radius, so it suspends for a human decision (interrupt.md). On a
  // host with no interrupt primitive the gate is skipped. A declined approval
  // returns a refused-but-successful node outcome (no execution), never silently
  // runs. This per-exec approval is the load-bearing safety control now that the
  // in-process WASI runtime is on by default (ADR 0146).
  if (typeof ctx.suspend === 'function') {
    const decision = await ctx.suspend({
      reason: 'approval',
      kind: 'code-exec',
      prompt: { title: 'Run code?', body: `Approve running this ${language} snippet (${code.length} chars) in the sandbox.` },
    });
    const approved = decision?.decision === 'approved' || decision?.approved === true;
    if (!approved) {
      return { status: 'success', outputs: { exitCode: -1, stdout: '', stderr: 'execution declined by approver', timedOut: false, files: [], declined: true } };
    }
  }
  const r = await ctx.runSandboxedCode({ language, code, stdin, timeoutMs });
  const result = {
    exitCode: typeof r.exitCode === 'number' ? r.exitCode : 0,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    timedOut: r.timedOut ?? false,
    language,
    files: r.files ?? [],
  };
  // ADR 0114 Phase 4b — project the result as a typed `code.execution-result`
  // artifact (ADR 0055/0083), so it flows through the run-artifact producer + the
  // workbench. The output is model/code-derived → UNTRUSTED downstream.
  return {
    status: 'success',
    outputs: {
      ...result,
      artifact: { artifactTypeId: 'code.execution-result', payload: result, contentTrust: 'untrusted' },
    },
  };
}

// Parity tripwire fix (NODE-PACK-AUDIT 2026-07-17): the loader reads the
// NAMED `nodes` export (tarballLoader.ts) — without this map every declared
// node was invisible at load time (the skills-bridge bug class).
export const nodes = {
  'feature.code-exec.nodes.run': run,
};

export default nodes;
