/**
 * ADR 0114/0146 — the code-exec node is now projected as a BUILTIN AGENT TOOL so the Code
 * Interpreter persona can actually invoke it through chat. Before this, `feature.code-exec.nodes.run`
 * resolved to nothing in the conversation tool loop → the loop fell back to a streaming completion
 * and the model faked the tool call as leaked `<invoke>` text. These tests lock in that it resolves
 * + executes via the WASI sandbox + is honest-off when no runtime.
 *
 * `builtinAgentToolIds()` membership is covered by `agent-allowlist-resolution.test.ts`
 * ("every allowlisted id is offerable…" — the Code Interpreter allowlists this id; probe
 * w24g2-at-builtin-covering). CEILING: the WASI arm is asset-gated — it runs only where
 * `vendor/python-3.12.0.wasm` is synced (`npm run ci`, the Tracegate daemon and Docker, WASI-GATE-1); on a plain checkout the asset's absence
 * ALSO makes honest-off hold, so `RUNTIME=off` is a second guard there, not the only one.
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { wasmPath } from '../src/host/wasiSandbox.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { codeExecFeature } from '../src/features/code-exec/feature.js';

const TOOL_ID = 'openwop:feature.code-exec.nodes.run';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://')); // budget store
  // ADR 0820 §8.2 — the runner's `code-exec` access gate reads this toggle. Without
  // it every execution is `feature_disabled`. That went unseen because the WASI arm
  // below SKIPS when the wasm asset is absent (every plain local checkout), and the
  // first run to sync the asset was the ADR 0863 Linux pilot.
  registerToggleDefault(codeExecFeature.toggleDefault!);
});

beforeEach(() => {
  delete process.env.OPENWOP_CODE_EXEC_ENDPOINT;
  delete process.env.OPENWOP_CODE_EXEC_RUNTIME;
});

describe('code-exec as a builtin agent tool', () => {
  it('the agent tool provider resolves + describes it', () => {
    const provider = createAgentToolProvider({ tenantId: 't1' });
    const def = provider.resolveTool(TOOL_ID);
    expect(def?.name).toBe(TOOL_ID);
    // the schema the MODEL sees: `code` is required (a missing one is refused before execution)
    expect(def?.inputSchema).toMatchObject({ required: ['code'] });
  });

  it('honest-off: returns capability_not_provided when no runtime is enabled', async () => {
    process.env.OPENWOP_CODE_EXEC_RUNTIME = 'off';
    const provider = createAgentToolProvider({ tenantId: 't1' });
    const res = await provider.executeTool({ name: TOOL_ID, input: { code: 'print(1)' } });
    expect(res.isError).toBe(true);
    expect((JSON.parse(res.content) as { error?: string }).error).toBe('capability_not_provided');
  });

  // Asset-gated: skip loudly on plain local checkouts (CI/Docker sync the wasm;
  // the hard throw was a permanent local-baseline red — see wasi-sandbox.test.ts).
  // Under the gate (OPENWOP_REQUIRE_WASI=1, WASI-GATE-1) a missing asset fails instead of skipping.
  if (!existsSync(wasmPath()) && process.env.OPENWOP_REQUIRE_WASI === '1') {
    throw new Error(`OPENWOP_REQUIRE_WASI=1 but the CPython-WASI asset is missing at ${wasmPath()}`);
  }
  (existsSync(wasmPath()) ? describe : describe.skip)('with the WASI runtime', () => {
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
