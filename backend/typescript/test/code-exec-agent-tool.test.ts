/**
 * ADR 0114/0146 — the code-exec node is now projected as a BUILTIN AGENT TOOL so the Code
 * Interpreter persona can actually invoke it through chat. Before this, `feature.code-exec.nodes.run`
 * resolved to nothing in the conversation tool loop → the loop fell back to a streaming completion
 * and the model faked the tool call as leaked `<invoke>` text. These tests lock in that it resolves
 * + executes via the WASI sandbox + is honest-off when no runtime.
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { builtinAgentToolIds, createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { wasmPath } from '../src/host/wasiSandbox.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

const TOOL_ID = 'openwop:feature.code-exec.nodes.run';

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); }); // budget store

beforeEach(() => {
  delete process.env.OPENWOP_CODE_EXEC_ENDPOINT;
  delete process.env.OPENWOP_CODE_EXEC_RUNTIME;
});

describe('code-exec as a builtin agent tool', () => {
  it('is now a resolvable builtin (the fix — it was absent before)', () => {
    expect(builtinAgentToolIds()).toContain(TOOL_ID);
  });

  it('the agent tool provider resolves + describes it', () => {
    const provider = createAgentToolProvider({ tenantId: 't1' });
    const def = provider.resolveTool(TOOL_ID);
    expect(def).toBeTruthy();
    expect(def?.name).toBe(TOOL_ID);
  });

  it('honest-off: returns capability_not_provided when no runtime is enabled', async () => {
    process.env.OPENWOP_CODE_EXEC_RUNTIME = 'off';
    const provider = createAgentToolProvider({ tenantId: 't1' });
    const res = await provider.executeTool({ name: TOOL_ID, input: { code: 'print(1)' } });
    expect(res.isError).toBe(true);
    expect(res.content).toContain('capability_not_provided');
  });

  describe('with the WASI runtime', () => {
    beforeAll(() => {
      if (!existsSync(wasmPath())) throw new Error(`WASI asset missing at ${wasmPath()} — run scripts/sync-pythonwasm.sh`);
    });
    it('EXECUTES the code via the sandbox and returns real stdout', async () => {
      process.env.OPENWOP_CODE_EXEC_RUNTIME = 'wasi';
      const provider = createAgentToolProvider({ tenantId: 't1' });
      const res = await provider.executeTool({ name: TOOL_ID, input: { code: 'import sys; print(sys.platform); print(6*7)' } });
      expect(res.isError).toBeFalsy();
      const out = JSON.parse(res.content) as { exitCode: number; stdout: string };
      expect(out.exitCode).toBe(0);
      expect(out.stdout).toContain('wasi'); // the unforgeable proof the WASI runtime ran the code
      expect(out.stdout).toContain('42');
    }, 30_000);
  });
});
