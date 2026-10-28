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
 */
const ok = async () => ({ exitCode: 0, stdout: 'ok', stderr: '', files: [] });
import { describe, it, expect } from 'vitest';
import { run } from '../../../packs/feature.code-exec.nodes/index.mjs';
import { makeSuspendFn } from '../src/executor/suspendSignal.js';

describe('feature.code-exec.nodes.run', () => {
  it('throws capability_not_provided when no sandbox adapter is wired (honest-off)', async () => {
    const ctx = { inputs: { language: 'python', code: 'print(1)' } };
    await expect(run(ctx)).rejects.toMatchObject({ code: 'capability_not_provided' });
  });

  it('rejects an empty code body', async () => {
    const ctx = { inputs: { language: 'python', code: '' }, runSandboxedCode: async () => ({ exitCode: 0, stdout: '', stderr: '' }) };
    await expect(run(ctx)).rejects.toMatchObject({ code: 'validation_error' });
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
      inputs: { language: 'python', code: 'print(2+2)' },
      suspend: async () => ({ action: 'approve' }),
      runSandboxedCode: async (req: unknown) => { calls.push(req); return { exitCode: 0, stdout: '4\n', stderr: '', files: [] }; },
    };
    const out = await run(ctx);
    expect(out.status).toBe('success');
    expect(out.outputs.stdout).toBe('4\n');
    expect(calls).toEqual([{ language: 'python', code: 'print(2+2)', stdin: undefined, timeoutMs: undefined }]);
    // ADR 0114 Phase 4b — output carries the typed artifact (untrusted).
    expect(out.outputs.artifact.artifactTypeId).toBe('code.execution-result');
    expect(out.outputs.artifact.contentTrust).toBe('untrusted');
    expect(out.outputs.artifact.payload.stdout).toBe('4\n');
  });

  it('ADR 0114 Phase 3 — HITL approval gates execution: approved → runs', async () => {
    const calls: unknown[] = [];
    const asked: unknown[] = [];
    const ctx = {
      inputs: { language: 'python', code: 'print(1)' },
      suspend: async (req: unknown) => { asked.push(req); return { action: 'approve' }; },
      runSandboxedCode: async (req: unknown) => { calls.push(req); return { exitCode: 0, stdout: 'ok', stderr: '', files: [] }; },
    };
    const out = await run(ctx);
    // asked FIRST, with a STRING prompt (both cards render it as a text child), a closed action
    // set, and the exact code as evidence (ADR 0995 D2).
    expect(asked).toEqual([expect.objectContaining({
      reason: 'approval', kind: 'code-exec', prompt: expect.any(String), actions: ['approve', 'reject'],
      codeExec: { language: 'python', code: 'print(1)' },
    })]);
    expect(calls).toHaveLength(1); // executed after approval
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
    expect(out.status).toBe('success'); // a refused-but-successful outcome, not a node failure
    expect(out.outputs.declined).toBe(true);
    expect(out.outputs.exitCode).toBe(-1);
    expect(out.outputs.stderr).toBe('execution declined by approver');
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
      await run(ctx);
      expect(calls, JSON.stringify(decision)).toHaveLength(runs);
    }
  });

  it('a long stdin is previewed, truncated, with its full length (ADR 0995 D2)', async () => {
    const asked: Array<{ codeExec?: { stdinPreview?: string; stdinLength?: number } }> = [];
    const stdin = 'x'.repeat(5_000);
    const ctx = { inputs: { language: 'python', code: 'print(input())', stdin }, suspend: async (r: never) => { asked.push(r); return { action: 'reject' }; }, runSandboxedCode: ok };
    await run(ctx);
    expect(asked[0]?.codeExec?.stdinPreview).toHaveLength(2_000);
    expect(asked[0]?.codeExec?.stdinLength).toBe(5_000);
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
    // ... a DIFFERENT program (an edited definition re-read on resume) suspends again instead.
    await expect(run({ inputs: { language: 'python', code: 'print("B")' }, suspend: makeSuspendFn('run', { resumeKey: keyA, value: { action: 'approve' } }), runSandboxedCode: exec }))
      .rejects.toMatchObject({ resumeKey: expect.stringMatching(/^code-exec:/) });
    expect(calls).toHaveLength(1);
  });
});
