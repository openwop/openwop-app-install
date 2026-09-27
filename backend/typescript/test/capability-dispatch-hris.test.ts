/**
 * ADR 0186 slice 3 — provider-agnostic HRIS action node (recommendation).
 *
 * core.openwop.connectors.hris-action reports the connected `hr` provider (Workday
 * today) and RECOMMENDS a worker action — it applies NOTHING (HRIS writes are
 * high-stakes; real execution is a future gated slice). Fails on an unknown action.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { createApp } from '../src/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { NodeContext } from '../src/executor/types.js';

function makeCtx(over: Partial<NodeContext>): NodeContext {
  const base: NodeContext = {
    runId: 'run_1', nodeId: 'n1', tenantId: 'demo', inputs: {}, configurable: {},
    attempt: 1, secrets: {}, emit: async () => ({ eventId: 'e1', sequence: 1 }),
  };
  return { ...base, ...over };
}
const outputsOf = (res: { status: string; outputs?: unknown }): Record<string, unknown> => {
  if (res.status !== 'success') throw new Error(`expected success, got ${res.status}`);
  return (res.outputs ?? {}) as Record<string, unknown>;
};
/** ctx.connectors double that resolves `provider` for the 'hr' capability. */
const conns = (provider: string | null) => ({
  resolveForCapability: async () => provider,
  resolveAllForCapability: async () => (provider ? [provider] : []),
  invoke: async () => ({ ok: false, status: 0, error: 'should_not_call' }),
});

describe('ADR 0186 slice 3 — hris-action node', () => {
  beforeAll(() => ensureNodesRegistered());
  const node = () => getNodeRegistry().get('core.openwop.connectors.hris-action')!;

  it('recommends a create-worker action against the connected HRIS (applied:false)', async () => {
    const res = await node().execute(makeCtx({ config: { action: 'create-worker', workerName: 'Ada', role: 'Engineer' }, connectors: conns('workday') }));
    expect(outputsOf(res)).toMatchObject({ connected: true, applied: false, provider: 'workday', planned: { action: 'create-worker', fields: { workerName: 'Ada', role: 'Engineer' } } });
  });

  it('reports connected:false when no HR provider is connected — still recommends', async () => {
    const res = await node().execute(makeCtx({ config: { action: 'terminate-worker', workerName: 'Bob' }, connectors: conns(null) }));
    expect(outputsOf(res)).toMatchObject({ connected: false, applied: false, provider: null, planned: { action: 'terminate-worker' } });
  });

  it('applies nothing — never calls the connector', async () => {
    let called = false;
    const c = { ...conns('workday'), invoke: async () => { called = true; return { ok: true }; } };
    await node().execute(makeCtx({ config: { action: 'submit-time-off', dates: 'Jul 4-8' }, connectors: c }));
    expect(called).toBe(false);
  });

  it('fails on an unknown action', async () => {
    const res = await node().execute(makeCtx({ config: { action: 'delete-everything' }, connectors: conns('workday') }));
    expect(res.status).toBe('failure');
    if (res.status === 'failure') expect(res.error?.code).toBe('invalid_config');
  });

  it('tolerates a host without the capability-resolution surface', async () => {
    expect(outputsOf(await node().execute(makeCtx({ config: { action: 'create-worker' } })))).toMatchObject({ connected: false, applied: false });
  });
});

/** ctx.connectors double whose invoke succeeds + records the call (slice-3b real path). */
function execConns(provider: string | null, ok = true) {
  const calls: Array<{ id: string; url: string; method?: string; body?: string }> = [];
  return {
    calls,
    surface: {
      resolveForCapability: async () => provider,
      resolveAllForCapability: async () => (provider ? [provider] : []),
      invoke: async (id: string, req: { url: string; method?: string; body?: string }) => {
        calls.push({ id, url: req.url, ...(req.method ? { method: req.method } : {}), ...(req.body ? { body: req.body } : {}) });
        return ok ? { ok: true, status: 200, data: {} } : { ok: false, status: 400, error: 'bad_request' };
      },
    },
  };
}
const timeOffCfg = { action: 'submit-time-off', dryRun: false, baseUrl: 'https://acme.workday.com/ccx/api/absenceManagement/v1/acme', workerId: 'W-1', date: '2026-07-04', timeOffType: 'PTO' };

describe('ADR 0186 slice 3b — submit-time-off real execution (Workday, dry-run default)', () => {
  beforeAll(async () => { await createApp({ port: 18995, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false }); ensureNodesRegistered(); });
  const node = () => getNodeRegistry().get('core.openwop.connectors.hris-action')!;

  it('DEFAULT (no dryRun) recommends — never submits', async () => {
    const c = execConns('workday');
    const res = await node().execute(makeCtx({ tenantId: 'to1', config: { ...timeOffCfg, dryRun: undefined }, connectors: c.surface }));
    expect(outputsOf(res)).toMatchObject({ applied: false });
    expect(c.calls.length).toBe(0);
  });

  it('dryRun:false submits to Workday /requestTimeOff with a days[] body', async () => {
    const c = execConns('workday');
    const res = await node().execute(makeCtx({ tenantId: 'to2', config: timeOffCfg, connectors: c.surface }));
    expect(outputsOf(res)).toMatchObject({ applied: true, reused: false, provider: 'workday' });
    expect(c.calls[0]).toMatchObject({ id: 'workday', method: 'POST', url: 'https://acme.workday.com/ccx/api/absenceManagement/v1/acme/workers/W-1/requestTimeOff' });
    expect(JSON.parse(c.calls[0].body!).days[0]).toMatchObject({ date: '2026-07-04', timeOffType: { id: 'PTO' } });
  });

  it('idempotent: a repeat submit for the same key is REUSED, never double-submitted', async () => {
    const c = execConns('workday');
    await node().execute(makeCtx({ tenantId: 'to3', config: timeOffCfg, connectors: c.surface }));
    const c2 = execConns('workday');
    expect(outputsOf(await node().execute(makeCtx({ tenantId: 'to3', config: timeOffCfg, connectors: c2.surface })))).toMatchObject({ applied: true, reused: true });
    expect(c2.calls.length).toBe(0);
  });

  it('create/terminate stay recommend-only even with dryRun:false (staffing SOAP)', async () => {
    const c = execConns('workday');
    const res = await node().execute(makeCtx({ tenantId: 'to4', config: { action: 'terminate-worker', dryRun: false, baseUrl: timeOffCfg.baseUrl, workerId: 'W-9' }, connectors: c.surface }));
    expect(outputsOf(res)).toMatchObject({ applied: false, reason: 'staffing_soap_only' });
    expect(c.calls.length).toBe(0);
  });

  it('dryRun:false but missing workerId/baseUrl ⇒ recommend, no submit', async () => {
    const c = execConns('workday');
    expect(outputsOf(await node().execute(makeCtx({ tenantId: 'to5', config: { action: 'submit-time-off', dryRun: false, date: '2026-07-04' }, connectors: c.surface })))).toMatchObject({ applied: false });
    expect(c.calls.length).toBe(0);
  });

  it('a real submit that the platform rejects → failure', async () => {
    const c = execConns('workday', false);
    expect((await node().execute(makeCtx({ tenantId: 'to6', config: timeOffCfg, connectors: c.surface }))).status).toBe('failure');
  });
});
