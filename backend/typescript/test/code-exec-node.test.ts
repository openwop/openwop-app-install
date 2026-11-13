/**
 * ADR 0114 Phase 1 — code-exec node capability-honesty.
 * The `run` node throws `capability_not_provided` when no sandbox adapter is wired
 * (the default), and delegates to `ctx.runSandboxedCode` when one is present.
 * Phase 3: on a host with an interrupt primitive it SUSPENDS for a human approval
 * (kind `code-exec`) before executing; a decline never executes.
 * Breaks if the node fakes execution with no adapter, forwards the wrong request,
 * marks sandbox output trusted, or runs code the approver declined.
 *
 * ADR 0995 D1/D2 — the approval used to be faked here as `{decision:'approved'}`, a shape no
 * resolver produces, so this file was green while every real approval read as a decline. The
 * cases now use the interrupt.md canonical `{action}` the cards send, and a host with no
 * `ctx.suspend` refuses instead of running unapproved.
 *
 * Two refusals share `capability_not_provided`: no sandbox adapter (`host.sample.code-exec`) and
 * no interrupt primitive (`interrupt`). Each case asserts its own `capability`, because the
 * honest-off case also has no `suspend`, so dropping the adapter check alone still throws the
 * interrupt refusal (wave 106 found this case vacuous on `code` alone).
 *
 * Sabotages each red their case (wave 106 probes w106g2-ce-*): the adapter check, the empty-code
 * check, the suspend check, asking after executing, the approval kind, the forwarded request,
 * the untrusted stamp, the decline branch, the `accept` spelling, accepting a legacy shape, the
 * stdin preview slice, and a resume key that ignores the code.
 */
const ok = async () => ({ exitCode: 0, stdout: 'ok', stderr: '', files: [] });
import { describe, it, expect } from 'vitest';
import { run } from '../../../packs/feature.code-exec.nodes/index.mjs';
import { makeSuspendFn } from '../src/executor/suspendSignal.js';

interface AskedApproval { reason?: string; kind?: string; resumeKey?: string; prompt?: unknown; actions?: string[]; codeExec?: { language?: string; code?: string; stdinPreview?: string; stdinLength?: number } }

describe('feature.code-exec.nodes.run', () => {
  it('throws capability_not_provided when no sandbox adapter is wired (honest-off)', async () => {
    const ctx = { inputs: { language: 'python', code: 'print(1)' } };
    await expect(run(ctx)).rejects.toMatchObject({ code: 'capability_not_provided', capability: 'host.sample.code-exec' });
  });

  it('rejects an empty code body', async () => {
    const ctx = { inputs: { language: 'python', code: '' }, runSandboxedCode: async () => ({ exitCode: 0, stdout: '', stderr: '' }) };
    await expect(run(ctx)).rejects.toMatchObject({ code: 'validation_error', message: '`code` is required' });
  });

  it('ADR 0995 D1 — a host with no ctx.suspend refuses rather than running unapproved', async () => {
    const calls: unknown[] = [];
    const ctx = {
      inputs: { language: 'python', code: 'print(2+2)' },
      runSandboxedCode: async (req: unknown) => { calls.push(req); return ok(); },
    };
    await expect(run(ctx)).rejects.toMatchObject({ code: 'capability_not_provided', capability: 'interrupt' });
    expect(calls).toHaveLength(0);
  });

  it('delegates to ctx.runSandboxedCode after approval and projects the result', async () => {
    const calls: unknown[] = [];
    const ctx = {
      // stdin and timeoutMs are REAL values: `toEqual` treats an undefined property as absent,
      // so undefined fixtures could not show a request that drops them.
      inputs: { language: 'python', code: 'print(input())', stdin: 'four', timeoutMs: 1_500 },
      suspend: async () => ({ action: 'approve' }),
      runSandboxedCode: async (req: unknown) => { calls.push(req); return { exitCode: 0, stdout: '4\n', stderr: '', files: [] }; },
    };
    const out = await run(ctx);
    expect(calls).toEqual([{ language: 'python', code: 'print(input())', stdin: 'four', timeoutMs: 1_500 }]);
    const result = { exitCode: 0, stdout: '4\n', stderr: '', timedOut: false, language: 'python', files: [] };
    // ADR 0114 Phase 4b — output carries the typed artifact (untrusted).
    expect(out).toEqual({
      status: 'success',
      outputs: { ...result, artifact: { artifactTypeId: 'code.execution-result', payload: result, contentTrust: 'untrusted' } },
    });
  });

  it('ADR 0114 Phase 3 — HITL approval gates execution: approved → runs', async () => {
    const order: string[] = [];
    const asked: AskedApproval[] = [];
    const ctx = {
      inputs: { language: 'python', code: 'print(1)' },
      suspend: async (req: AskedApproval) => { order.push('ask'); asked.push(req); return { action: 'approve' }; },
      runSandboxedCode: async () => { order.push('run'); return { exitCode: 0, stdout: 'ok', stderr: '', files: [] }; },
    };
    const out = await run(ctx);
    // asked FIRST, with a STRING prompt (both cards render it as a text child), a closed action
    // set, and the exact code as evidence (ADR 0995 D2).
    expect(order).toEqual(['ask', 'run']);
    expect(asked).toEqual([expect.objectContaining({
      reason: 'approval', kind: 'code-exec', prompt: 'Run this python code in the sandbox?', actions: ['approve', 'reject'],
      codeExec: { language: 'python', code: 'print(1)' },
    })]);
    expect(out.outputs.stdout).toBe('ok');
  });

  it('HITL declined → does NOT execute (refused outcome, no silent run)', async () => {
    const calls: unknown[] = [];
    const ctx = {
      inputs: { language: 'python', code: 'rm -rf /' },
      suspend: async () => ({ action: 'reject' }),
      runSandboxedCode: async (req: unknown) => { calls.push(req); return { exitCode: 0, stdout: 'ran', stderr: '', files: [] }; },
    };
    const out = await run(ctx);
    expect(calls).toHaveLength(0); // NEVER executed
    // a refused-but-successful outcome, not a node failure
    expect(out).toEqual({ status: 'success', outputs: { exitCode: -1, stdout: '', stderr: 'execution declined by approver', timedOut: false, files: [], declined: true } });
  });

  it('the wire spelling `accept` approves; legacy and unknown shapes do not (ADR 0995 D1)', async () => {
    for (const [decision, runs] of [
      [{ action: 'accept' }, 1],
      [{ decision: 'approved' }, 0],
      [{ approved: true }, 0],
      [true, 0],
      [{ action: 'request-changes' }, 0],
    ] as const) {
      const calls: unknown[] = [];
      const ctx = { inputs: { language: 'python', code: 'print(1)' }, suspend: async () => decision, runSandboxedCode: async (r: unknown) => { calls.push(r); return ok(); } };
      const out = await run(ctx);
      expect(calls, JSON.stringify(decision)).toHaveLength(runs);
      expect(out.outputs.declined ?? false, JSON.stringify(decision)).toBe(runs === 0);
    }
  });

  it('a long stdin is previewed, truncated, with its full length (ADR 0995 D2)', async () => {
    const asked: AskedApproval[] = [];
    // Asymmetric: the head differs from the tail, so a tail slice shows.
    const stdin = 'h'.repeat(2_000) + 't'.repeat(3_000);
    const ctx = { inputs: { language: 'python', code: 'print(input())', stdin }, suspend: async (r: AskedApproval) => { asked.push(r); return { action: 'reject' }; }, runSandboxedCode: ok };
    await run(ctx);
    expect(asked[0]?.codeExec).toEqual({ language: 'python', code: 'print(input())', stdinPreview: 'h'.repeat(2_000), stdinLength: 5_000 });
  });

  it('an approval is bound to the code it approved: a changed program asks again (ADR 0995 D1)', async () => {
    // Raise the gate for program A and capture its resume key, as the executor would.
    let keyA = '';
    await expect(run({ inputs: { language: 'python', code: 'print("A")' }, suspend: makeSuspendFn('run', undefined), runSandboxedCode: ok }))
      .rejects.toSatisfy((e: { resumeKey?: string }) => { keyA = e.resumeKey ?? ''; return keyA.startsWith('code-exec:'); });
    // Resume with that approval: the SAME program runs ...
    const calls: unknown[] = [];
    const exec = async (r: unknown) => { calls.push(r); return ok(); };
    await run({ inputs: { language: 'python', code: 'print("A")' }, suspend: makeSuspendFn('run', { resumeKey: keyA, value: { action: 'approve' } }), runSandboxedCode: exec });
    expect(calls).toHaveLength(1);
    // ... a DIFFERENT program (an edited definition re-read on resume) suspends again instead,
    // under a key of its own.
    let keyB = '';
    await expect(run({ inputs: { language: 'python', code: 'print("B")' }, suspend: makeSuspendFn('run', { resumeKey: keyA, value: { action: 'approve' } }), runSandboxedCode: exec }))
      .rejects.toSatisfy((e: { resumeKey?: string }) => { keyB = e.resumeKey ?? ''; return keyB.startsWith('code-exec:'); });
    expect(keyB).not.toBe(keyA);
    expect(calls).toHaveLength(1);
  });
});
