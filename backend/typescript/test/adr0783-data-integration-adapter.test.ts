/**
 * ADR 0783 phase 1 — `ctx.dataIntegration`: `fetchMCP`, `fetchVariable`,
 * `transform`, `computeVariable`, and deliberately NOT `fetchRest`.
 *
 * Three legs, because a mechanism and its wiring fail independently:
 *   1. the adapter, against the shapes the pack's own schemas declare;
 *   2. the pack (`vendor.myndhyve.data-integration`) driven through the adapter —
 *      and, the honesty leg, its `ensureDI` STILL refusing every node, because
 *      phase 1 serves no `fetchRest` and so claims nothing;
 *   3. the executor wiring: a real run's node sees the adapter on its ctx.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DATA_INTEGRATION_BUDGET,
  evaluateJsonata,
  makeDataIntegrationAdapter,
  type DataIntegrationMcp,
} from '../src/host/dataIntegrationAdapter.js';
import { __resetAllRunVariablesForTests, setRunVariable, snapshotRunVariables } from '../src/host/variablesRuntime.js';
import { EXT_FAMILY_CLAIMS } from '../src/host/extFamilyRecords.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Run `p` and return the thrown `code` (the pack's error convention). */
async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try { await p; return undefined; } catch (e) { return (e as { code?: string }).code; }
}

afterEach(() => __resetAllRunVariablesForTests());

describe('ADR 0783 P1 — transform (JSONata under a budget)', () => {
  const di = makeDataIntegrationAdapter({ runId: 'run-di-transform' });

  it('evaluates JSONata against the data', async () => {
    const r = await di.transform({ expression: '$sum(items.price)', language: 'jsonata', data: { items: [{ price: 2 }, { price: 3 }] } });
    expect(r.result).toBe(5);
  });

  it('defaults to JSONata when no language is given', async () => {
    expect((await di.transform({ expression: 'a & "-" & b', data: { a: 'x', b: 'y' } })).result).toBe('x-y');
  });

  it('refuses jq and host-extension as unsupported, never as a silent null', async () => {
    expect(await codeOf(di.transform({ expression: '.a', language: 'jq', data: {} }))).toBe('unsupported_language');
    expect(await codeOf(di.transform({ expression: 'a', language: 'host-extension', data: {} }))).toBe('unsupported_language');
  });

  it('a parse error is expression_invalid; a runtime error is expression_failed', async () => {
    expect(await codeOf(di.transform({ expression: '$sum(', data: {} }))).toBe('expression_invalid');
    expect(await codeOf(di.transform({ expression: '$number("x")', data: {} }))).toBe('expression_failed');
  });

  it('non-terminating recursion is stopped by the budget, not by the process', async () => {
    const t0 = Date.now();
    expect(await codeOf(di.transform({ expression: '($f := function($x){ $f($x) }; $f(1))', data: {} }))).toBe('expression_budget_exceeded');
    expect(Date.now() - t0).toBeLessThan(DATA_INTEGRATION_BUDGET.timeoutMs * 5);
  });

  it('an oversized expression or input is refused before evaluation', async () => {
    expect(await codeOf(di.transform({ expression: 'a'.repeat(DATA_INTEGRATION_BUDGET.maxExpressionChars + 1), data: {} }))).toBe('validation_error');
    const big = { s: 'x'.repeat(DATA_INTEGRATION_BUDGET.maxInputBytes) };
    expect(await codeOf(di.transform({ expression: 's', data: big }))).toBe('payload_too_large');
  });

  it('an oversized result is refused', async () => {
    expect(await codeOf(evaluateJsonata('$pad("", 1100000, "x")', 'jsonata', {}))).toBe('payload_too_large');
  });
});

describe('ADR 0783 P1 — variables', () => {
  const runId = 'run-di-vars';
  const di = makeDataIntegrationAdapter({ runId });

  it('fetchVariable reports presence, so a variable set to null is FOUND', async () => {
    setRunVariable(runId, 'n', null);
    expect(await di.fetchVariable({ variableName: 'n' })).toEqual({ found: true, value: null });
    expect(await di.fetchVariable({ variableName: 'absent' })).toEqual({ found: false, value: undefined });
  });

  it('computeVariable WRITES the variable (the pack does not), over the run bag merged with the context', async () => {
    setRunVariable(runId, 'base', 10);
    setRunVariable(runId, 'k', 1);
    const r = await di.computeVariable({ variableName: 'total', expression: 'base + k', context: { k: 5 } });
    expect(r.value).toBe(15); // context wins on a shared name
    expect(snapshotRunVariables(runId)?.total).toBe(15);
  });

  it('a non-object context is refused', async () => {
    expect(await codeOf(di.computeVariable({ variableName: 'x', expression: '1', context: [1] }))).toBe('validation_error');
  });
});

describe('ADR 0783 P1 — fetchMCP delegates to the run\'s MCP client', () => {
  const calls: unknown[][] = [];
  const mcp: DataIntegrationMcp = {
    async invokeTool(...a) { calls.push(['tool', ...a]); return { result: 'text', structuredContent: { rows: 2 }, isError: false }; },
    async readResource(...a) { calls.push(['resource', ...a]); return { content: 'body', mimeType: 'text/plain' }; },
  };
  const di = makeDataIntegrationAdapter({ runId: 'run-di-mcp', mcp });

  it('a tool call prefers structured content and keeps the untrusted mark', async () => {
    const r = await di.fetchMCP({ serverId: 'srv', operation: { kind: 'tool', toolName: 'q' }, args: { a: 1 } });
    expect(r).toEqual({ data: { rows: 2 }, isError: false, untrustedContent: true });
    expect(calls.at(-1)).toEqual(['tool', 'srv', 'q', { a: 1 }]);
  });

  it('a resource read carries its mimeType', async () => {
    const r = await di.fetchMCP({ serverId: 'srv', operation: { kind: 'resource', uri: 'file:///x' } });
    expect(r).toEqual({ data: 'body', mimeType: 'text/plain', untrustedContent: true });
  });

  it('an unknown operation kind is refused; no MCP client is host_capability_missing', async () => {
    expect(await codeOf(di.fetchMCP({ serverId: 'srv', operation: { kind: 'prompt' } }))).toBe('validation_error');
    const bare = makeDataIntegrationAdapter({ runId: 'run-di-nomcp' });
    expect(await codeOf(bare.fetchMCP({ serverId: 'srv', operation: { kind: 'tool', toolName: 'q' } }))).toBe('host_capability_missing');
  });
});

describe('ADR 0783 P1 — the pack, driven through the adapter', () => {
  type Ctx = Record<string, unknown>;
  type NodeFn = (ctx: Ctx) => Promise<{ status: string; outputs: Record<string, unknown> }>;
  let pack: { dataTransform: NodeFn; variableCompute: NodeFn; variableFetch: NodeFn; sourceMCP: NodeFn };
  beforeAll(async () => {
    pack = (await import(pathToFileURL(join(HERE, '..', '..', '..', 'packs', 'vendor.myndhyve.data-integration', 'index.mjs')).href)) as typeof pack;
  });

  it('EXECUTES, and is CLAIMED with no node left unserved (ADR 0783 D9, ADR 0865)', async () => {
    const ctx = { runId: 'run-di-pack', nodeId: 'n', config: { expression: '1 + 1', language: 'jsonata' }, inputs: {}, dataIntegration: makeDataIntegrationAdapter({ runId: 'run-di-pack' }) };
    expect((await pack.dataTransform(ctx)).outputs).toEqual({ result: 2 });
    const claim = EXT_FAMILY_CLAIMS.find((c) => c.extensionName === 'data-integration');
    expect(claim?.unavailable).toBeUndefined(); // ADR 0865 served data.binding.apply (P1) and data.source.a2a (P2)
  });

  it('once fetchRest exists (phase 2), the phase-1 nodes run on this adapter end to end', async () => {
    const runId = 'run-di-pack2';
    // A STUB fetchRest stands in for phase 2 so ensureDI passes; it is never called.
    const dataIntegration = { ...makeDataIntegrationAdapter({ runId }), fetchRest: async () => { throw new Error('not in phase 1'); } };
    const base = { runId, nodeId: 'n', dataIntegration };
    const computed = await pack.variableCompute({ ...base, config: { variableName: 'v', expression: 'a * 2' }, inputs: { context: { a: 21 } } });
    expect(computed.outputs).toEqual({ variableName: 'v', value: 42 });
    const fetched = await pack.variableFetch({ ...base, config: { variableName: 'v' }, inputs: {} });
    expect(fetched.outputs).toEqual({ variableName: 'v', value: 42, found: true });
    const transformed = await pack.dataTransform({ ...base, config: { expression: '$uppercase(s)', language: 'jsonata' }, inputs: { data: { s: 'ok' } } });
    expect(transformed.outputs).toEqual({ result: 'OK' });
    expect(await codeOf(pack.variableFetch({ ...base, config: { variableName: 'nope' }, inputs: {} }))).toBe('variable_not_found');
  });
});

describe('ADR 0783 P1 — the executor wires ctx.dataIntegration onto a real run', () => {
  beforeAll(async () => {
    // The executor needs the host's seams (suspend manager, storage) installed.
    const { createApp } = await import('../src/index.js');
    await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  });
  it('a node in a real run computes and reads back a variable through its ctx', async () => {
    const { openStorage } = await import('../src/storage/index.js');
    const { executeRun } = await import('../src/executor/executor.js');
    const { getNodeRegistry } = await import('../src/executor/nodeRegistry.js');
    const typeId = 'test.adr0783.di-probe';
    getNodeRegistry().register({
      typeId,
      version: '1.0.0',
      async execute(ctx: { dataIntegration?: ReturnType<typeof makeDataIntegrationAdapter> }) {
        const di = ctx.dataIntegration;
        if (!di) return { status: 'failure', error: { code: 'no_surface', message: 'ctx.dataIntegration absent' } };
        await di.computeVariable({ variableName: 'probe', expression: '6 * 7' });
        const back = await di.fetchVariable({ variableName: 'probe' });
        return back.found && back.value === 42
          ? { status: 'success', outputs: { value: back.value } }
          : { status: 'failure', error: { code: 'roundtrip', message: JSON.stringify(back) } };
      },
    } as never);
    const storage = await openStorage('memory://');
    const now = new Date().toISOString();
    const run = {
      runId: `run-0783-${Math.random().toString(36).slice(2, 10)}`,
      workflowId: 'wf.test.adr0783.probe', tenantId: 'default', status: 'pending',
      inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run as never);
    const result = await executeRun(storage, run as never, { workflowId: 'wf.test.adr0783.probe', nodes: [{ nodeId: 'p', typeId }] } as never,
      { policyResolver: { async resolveForRun() { return []; } } } as never);
    expect(result.status).toBe('completed');
    expect(snapshotRunVariables(run.runId)?.probe).toBe(42);
  });
});
