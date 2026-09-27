/**
 * ADR 0186 slice 5 — provider-agnostic ERP action node (recommendation).
 *
 * core.openwop.connectors.erp-action reports the connected `finance` provider and
 * RECOMMENDS a finance action — it applies NOTHING (ERP postings move money; real
 * execution is a future gated slice). Fails on an unknown action.
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
const conns = (provider: string | null) => ({
  resolveForCapability: async () => provider,
  resolveAllForCapability: async () => (provider ? [provider] : []),
  invoke: async () => ({ ok: false, status: 0, error: 'should_not_call' }),
});

describe('ADR 0186 slice 5 — erp-action node', () => {
  beforeAll(() => ensureNodesRegistered());
  const node = () => getNodeRegistry().get('core.openwop.connectors.erp-action')!;

  it('recommends a post-bill action against the connected ERP (applied:false)', async () => {
    const res = await node().execute(makeCtx({ config: { action: 'post-bill', vendor: 'Acme', amount: '4200' }, connectors: conns('netsuite') }));
    expect(outputsOf(res)).toMatchObject({ connected: true, applied: false, provider: 'netsuite', planned: { action: 'post-bill', fields: { vendor: 'Acme', amount: '4200' } } });
  });

  it('recommends a read action (get-financial-summary) but applies nothing', async () => {
    let called = false;
    const c = { ...conns('netsuite'), invoke: async () => { called = true; return { ok: true }; } };
    expect(outputsOf(await node().execute(makeCtx({ config: { action: 'get-financial-summary', period: '2026-05' }, connectors: c })))).toMatchObject({ applied: false, planned: { action: 'get-financial-summary' } });
    expect(called).toBe(false);
  });

  it('reports connected:false when no ERP is connected — still recommends', async () => {
    expect(outputsOf(await node().execute(makeCtx({ config: { action: 'match-po' }, connectors: conns(null) })))).toMatchObject({ connected: false, applied: false, provider: null, planned: { action: 'match-po' } });
  });

  it('fails on an unknown action', async () => {
    const res = await node().execute(makeCtx({ config: { action: 'wire-transfer' }, connectors: conns('netsuite') }));
    expect(res.status).toBe('failure');
    if (res.status === 'failure') expect(res.error?.code).toBe('invalid_config');
  });

  it('tolerates a host without the capability-resolution surface', async () => {
    expect(outputsOf(await node().execute(makeCtx({ config: { action: 'create-expense-report' } })))).toMatchObject({ connected: false, applied: false });
  });
});

/** ctx.connectors double whose invoke succeeds + records the call (slice-5b writes +
 *  slice-B SuiteQL reads). A suiteql URL returns a NetSuite-shaped `{ items: [...] }`. */
function execConns(provider: string | null, ok = true) {
  const calls: Array<{ id: string; url: string; method?: string; body?: string; extraHeaders?: Record<string, string> }> = [];
  return {
    calls,
    surface: {
      resolveForCapability: async () => provider,
      resolveAllForCapability: async () => (provider ? [provider] : []),
      invoke: async (id: string, req: { url: string; method?: string; body?: string; extraHeaders?: Record<string, string> }) => {
        calls.push({ id, url: req.url, ...(req.method ? { method: req.method } : {}), ...(req.body ? { body: req.body } : {}), ...(req.extraHeaders ? { extraHeaders: req.extraHeaders } : {}) });
        if (!ok) return { ok: false, status: 400, error: 'bad_request' };
        return req.url.endsWith('/suiteql')
          ? { ok: true, status: 200, data: { items: [{ type: 'VendBill', txns: 3, total: 12600 }] } }
          : { ok: true, status: 200, data: { id: 'REC-9' } };
      },
    },
  };
}
const billCfg = { action: 'post-bill', dryRun: false, baseUrl: 'https://acct.suitetalk.api.netsuite.com', vendorId: 'V-1', amount: '4200' };

describe('ADR 0186 slice 5b — post-bill / expense-report real execution (dry-run default)', () => {
  beforeAll(async () => { await createApp({ port: 18996, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false }); ensureNodesRegistered(); });
  const node = () => getNodeRegistry().get('core.openwop.connectors.erp-action')!;

  it('DEFAULT (no dryRun) recommends — never posts', async () => {
    const c = execConns('netsuite');
    expect(outputsOf(await node().execute(makeCtx({ tenantId: 'e1', config: { ...billCfg, dryRun: undefined }, connectors: c.surface })))).toMatchObject({ applied: false });
    expect(c.calls.length).toBe(0);
  });

  it('dryRun:false posts a vendorBill to SuiteTalk with entity + item', async () => {
    const c = execConns('netsuite');
    const res = await node().execute(makeCtx({ tenantId: 'e2', config: billCfg, connectors: c.surface }));
    expect(outputsOf(res)).toMatchObject({ applied: true, reused: false, provider: 'netsuite', recordId: 'REC-9' });
    expect(c.calls[0]).toMatchObject({ id: 'netsuite', method: 'POST', url: 'https://acct.suitetalk.api.netsuite.com/services/rest/record/v1/vendorBill' });
    expect(JSON.parse(c.calls[0].body!)).toMatchObject({ entity: { id: 'V-1' }, item: { items: [{ rate: 4200 }] } });
  });

  it('posts an expensereport for create-expense-report', async () => {
    const c = execConns('netsuite');
    await node().execute(makeCtx({ tenantId: 'e3', config: { action: 'create-expense-report', dryRun: false, baseUrl: billCfg.baseUrl, employeeId: 'E-7', amount: '90' }, connectors: c.surface }));
    expect(c.calls[0].url).toBe('https://acct.suitetalk.api.netsuite.com/services/rest/record/v1/expensereport');
    expect(JSON.parse(c.calls[0].body!)).toMatchObject({ entity: { id: 'E-7' }, expense: { items: [{ amount: 90 }] } });
  });

  it('idempotent: a repeat post for the same key is REUSED, never double-posted', async () => {
    const c = execConns('netsuite');
    await node().execute(makeCtx({ tenantId: 'e4', config: billCfg, connectors: c.surface }));
    const c2 = execConns('netsuite');
    expect(outputsOf(await node().execute(makeCtx({ tenantId: 'e4', config: billCfg, connectors: c2.surface })))).toMatchObject({ applied: true, reused: true, recordId: 'REC-9' });
    expect(c2.calls.length).toBe(0);
  });

  it('ADR 0186 slice-B: get-financial-summary dispatches a SuiteQL query with Prefer:transient (read, applies nothing)', async () => {
    const c = execConns('netsuite');
    const res = await node().execute(makeCtx({ tenantId: 'e5', config: { action: 'get-financial-summary', dryRun: false, baseUrl: billCfg.baseUrl, postingPeriod: '42' }, connectors: c.surface }));
    expect(outputsOf(res)).toMatchObject({ applied: false, dispatched: true, provider: 'netsuite', result: [{ type: 'VendBill', txns: 3, total: 12600 }] });
    expect(c.calls[0]).toMatchObject({ id: 'netsuite', method: 'POST', url: `${billCfg.baseUrl}/services/rest/query/v1/suiteql`, extraHeaders: { Prefer: 'transient' } });
    // the validated numeric filter is interpolated; the query is well-formed SuiteQL
    const q = JSON.parse(c.calls[0].body!).q as string;
    expect(q).toContain('t.postingperiod = 42');
    expect(q.startsWith('SELECT')).toBe(true);
  });

  it('slice-B injection safety: a non-numeric postingPeriod is DROPPED (never interpolated)', async () => {
    const c = execConns('netsuite');
    await node().execute(makeCtx({ tenantId: 'e5b', config: { action: 'get-financial-summary', dryRun: false, baseUrl: billCfg.baseUrl, postingPeriod: "1 OR 1=1; DROP" }, connectors: c.surface }));
    const q = JSON.parse(c.calls[0].body!).q as string;
    expect(q).not.toContain('OR 1=1');
    expect(q).not.toContain('DROP');
    expect(q).not.toContain('WHERE'); // the only filter was rejected ⇒ no WHERE clause
  });

  it('slice-B: match-po escapes the PO number literal (no injection) and matches PurchOrd', async () => {
    const c = execConns('netsuite');
    await node().execute(makeCtx({ tenantId: 'e5c', config: { action: 'match-po', dryRun: false, baseUrl: billCfg.baseUrl, poNumber: "PO-1' OR '1'='1" }, connectors: c.surface }));
    const q = JSON.parse(c.calls[0].body!).q as string;
    expect(q).toContain("type = 'PurchOrd'");
    expect(q).toContain("tranid = 'PO-1'' OR ''1''=''1'"); // single quotes doubled — escaped, not injectable
  });

  it('slice-B: match-po with NO identifier ⇒ recommend (read_missing_filter), no call', async () => {
    const c = execConns('netsuite');
    expect(outputsOf(await node().execute(makeCtx({ tenantId: 'e5d', config: { action: 'match-po', dryRun: false, baseUrl: billCfg.baseUrl }, connectors: c.surface })))).toMatchObject({ applied: false, reason: 'read_missing_filter' });
    expect(c.calls.length).toBe(0);
  });

  it('dryRun:false but missing baseUrl ⇒ recommend, no post', async () => {
    const c = execConns('netsuite');
    expect(outputsOf(await node().execute(makeCtx({ tenantId: 'e6', config: { action: 'post-bill', dryRun: false, vendorId: 'V-1', amount: '10' }, connectors: c.surface })))).toMatchObject({ applied: false });
    expect(c.calls.length).toBe(0);
  });

  it('a real post the platform rejects → failure', async () => {
    const c = execConns('netsuite', false);
    expect((await node().execute(makeCtx({ tenantId: 'e7', config: billCfg, connectors: c.surface }))).status).toBe('failure');
  });
});
