/**
 * ADR 0114 Phase 1 — code-exec node capability-honesty.
 * The `run` node throws `capability_not_provided` when no sandbox adapter is wired
 * (the default), and delegates to `ctx.runSandboxedCode` when one is present.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs pack module has no type declarations (pure-JS node pack).
import { run } from '../../packs/feature.code-exec.nodes/index.mjs';

describe('feature.code-exec.nodes.run', () => {
  it('throws capability_not_provided when no sandbox adapter is wired (honest-off)', async () => {
    const ctx = { inputs: { language: 'python', code: 'print(1)' } };
    await expect(run(ctx)).rejects.toMatchObject({ code: 'capability_not_provided' });
  });

  it('rejects an empty code body', async () => {
    const ctx = { inputs: { language: 'python', code: '' }, runSandboxedCode: async () => ({ exitCode: 0, stdout: '', stderr: '' }) };
    await expect(run(ctx)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('delegates to ctx.runSandboxedCode and projects the result when wired (no HITL host)', async () => {
    const calls: unknown[] = [];
    const ctx = {
      inputs: { language: 'python', code: 'print(2+2)' },
      runSandboxedCode: async (req: unknown) => { calls.push(req); return { exitCode: 0, stdout: '4\n', stderr: '', files: [] }; },
    };
    const out = await run(ctx);
    expect(out.status).toBe('success');
    expect(out.outputs.stdout).toBe('4\n');
    expect(calls).toHaveLength(1);
    // ADR 0114 Phase 4b — output carries the typed artifact (untrusted).
    expect(out.outputs.artifact.artifactTypeId).toBe('code.execution-result');
    expect(out.outputs.artifact.contentTrust).toBe('untrusted');
    expect(out.outputs.artifact.payload.stdout).toBe('4\n');
  });

  it('ADR 0114 Phase 3 — HITL approval gates execution: approved → runs', async () => {
    const calls: unknown[] = [];
    const ctx = {
      inputs: { language: 'python', code: 'print(1)' },
      suspend: async () => ({ decision: 'approved' }),
      runSandboxedCode: async (req: unknown) => { calls.push(req); return { exitCode: 0, stdout: 'ok', stderr: '', files: [] }; },
    };
    const out = await run(ctx);
    expect(calls).toHaveLength(1); // executed after approval
    expect(out.outputs.stdout).toBe('ok');
  });

  it('HITL declined → does NOT execute (refused outcome, no silent run)', async () => {
    const calls: unknown[] = [];
    const ctx = {
      inputs: { language: 'python', code: 'rm -rf /' },
      suspend: async () => ({ decision: 'declined' }),
      runSandboxedCode: async (req: unknown) => { calls.push(req); return { exitCode: 0, stdout: 'ran', stderr: '', files: [] }; },
    };
    const out = await run(ctx);
    expect(calls).toHaveLength(0); // NEVER executed
    expect(out.outputs.declined).toBe(true);
    expect(out.outputs.exitCode).toBe(-1);
  });
});
