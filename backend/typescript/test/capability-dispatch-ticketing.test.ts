/**
 * ADR 0186 slice 2 — provider-agnostic ticketing nodes.
 *
 * core.openwop.connectors.ticket-create / ticket-transition resolve the tenant's
 * connected `ticketing` provider (Jira / ServiceNow) via ctx.connectors, build the
 * per-provider REST request against the tenant `baseUrl`, and fail SAFE (no provider /
 * baseUrl / required field ⇒ connected:false, no side effect).
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

function connectors(providers: string[] | string | null, data: unknown, ok = true) {
  const list = providers == null ? [] : Array.isArray(providers) ? providers : [providers];
  const calls: Array<{ id: string; url: string; method?: string; body?: string }> = [];
  return {
    calls,
    surface: {
      resolveForCapability: async () => list[0] ?? null,
      resolveAllForCapability: async () => list,
      invoke: async (id: string, req: { url: string; method?: string; body?: string }) => {
        calls.push({ id, url: req.url, ...(req.method ? { method: req.method } : {}), ...(req.body ? { body: req.body } : {}) });
        return ok ? { ok: true, status: 200, data } : { ok: false, status: 400, error: 'bad_request' };
      },
    },
  };
}

describe('ADR 0186 slice 2 — ticket-create', () => {
  beforeAll(() => ensureNodesRegistered());
  const node = () => getNodeRegistry().get('core.openwop.connectors.ticket-create')!;

  it('creates a Jira issue and returns id + key', async () => {
    const c = connectors('jira', { id: '10001', key: 'OPS-42' });
    const res = await node().execute(makeCtx({ config: { baseUrl: 'https://acme.atlassian.net', project: 'OPS', summary: 'Boom' }, connectors: c.surface }));
    expect(c.calls[0]).toMatchObject({ id: 'jira', method: 'POST', url: 'https://acme.atlassian.net/rest/api/3/issue' });
    expect(JSON.parse(c.calls[0].body!).fields).toMatchObject({ project: { key: 'OPS' }, summary: 'Boom', issuetype: { name: 'Task' } });
    expect(outputsOf(res)).toMatchObject({ connected: true, created: true, provider: 'jira', id: '10001', key: 'OPS-42' });
  });

  it('creates a ServiceNow record and maps sys_id/number → id/key', async () => {
    const c = connectors('servicenow', { result: { sys_id: 'abc', number: 'INC0001' } });
    const res = await node().execute(makeCtx({ config: { baseUrl: 'https://acme.service-now.com', summary: 'Down' }, connectors: c.surface }));
    expect(c.calls[0].url).toBe('https://acme.service-now.com/api/now/table/incident');
    expect(outputsOf(res)).toMatchObject({ connected: true, created: true, provider: 'servicenow', id: 'abc', key: 'INC0001' });
  });

  it('picks a ticketing-capable provider over a non-ticketing one and strips trailing slash', async () => {
    const c = connectors(['slack', 'jira'], { key: 'OPS-1' });
    const res = await node().execute(makeCtx({ config: { baseUrl: 'https://acme.atlassian.net/', project: 'OPS', summary: 'X' }, connectors: c.surface }));
    expect(c.calls[0].url).toBe('https://acme.atlassian.net/rest/api/3/issue'); // no double slash
    expect(outputsOf(res)).toMatchObject({ connected: true, provider: 'jira' });
  });

  it('degrades to connected:false — no provider / no baseUrl / no summary (no egress)', async () => {
    const none = connectors(null, null);
    expect(outputsOf(await node().execute(makeCtx({ config: { baseUrl: 'https://x', summary: 'Y' }, connectors: none.surface })))).toMatchObject({ connected: false, created: false });
    expect(none.calls.length).toBe(0);
    const noBase = connectors('jira', null);
    expect(outputsOf(await node().execute(makeCtx({ config: { summary: 'Y' }, connectors: noBase.surface })))).toMatchObject({ connected: false });
    const noSummary = connectors('jira', null);
    expect(outputsOf(await node().execute(makeCtx({ config: { baseUrl: 'https://x' }, connectors: noSummary.surface })))).toMatchObject({ connected: false });
    expect(noSummary.calls.length).toBe(0);
  });

  it('fails when the connector egress errors', async () => {
    const c = connectors('jira', null, false);
    expect((await node().execute(makeCtx({ config: { baseUrl: 'https://x', summary: 'Y' }, connectors: c.surface }))).status).toBe('failure');
  });

  it('fails closed with no host connectors surface', async () => {
    const res = await node().execute(makeCtx({}));
    expect(res.status).toBe('failure');
    if (res.status === 'failure') expect(res.error?.code).toBe('host_capability_missing');
  });
});

describe('ADR 0186 slice 2 — ticket-transition', () => {
  beforeAll(() => ensureNodesRegistered());
  const node = () => getNodeRegistry().get('core.openwop.connectors.ticket-transition')!;

  it('transitions a Jira issue via POST /transitions', async () => {
    const c = connectors('jira', {});
    const res = await node().execute(makeCtx({ config: { baseUrl: 'https://acme.atlassian.net', issueKey: 'OPS-42', transitionId: '31' }, connectors: c.surface }));
    expect(c.calls[0]).toMatchObject({ method: 'POST', url: 'https://acme.atlassian.net/rest/api/3/issue/OPS-42/transitions' });
    expect(JSON.parse(c.calls[0].body!)).toEqual({ transition: { id: '31' } });
    expect(outputsOf(res)).toMatchObject({ connected: true, transitioned: true, provider: 'jira' });
  });

  it('transitions a ServiceNow record via PATCH', async () => {
    const c = connectors('servicenow', {});
    const res = await node().execute(makeCtx({ config: { baseUrl: 'https://acme.service-now.com', sysId: 'abc', state: '7' }, connectors: c.surface }));
    expect(c.calls[0]).toMatchObject({ method: 'PATCH', url: 'https://acme.service-now.com/api/now/table/incident/abc' });
    expect(JSON.parse(c.calls[0].body!)).toEqual({ state: '7' });
    expect(outputsOf(res)).toMatchObject({ connected: true, transitioned: true, provider: 'servicenow' });
  });

  it('degrades to connected:false when no issue key/sysId is provided', async () => {
    const c = connectors('jira', {});
    expect(outputsOf(await node().execute(makeCtx({ config: { baseUrl: 'https://x' }, connectors: c.surface })))).toMatchObject({ connected: false, transitioned: false });
    expect(c.calls.length).toBe(0);
  });
});

describe('ADR 0186 slice 2 — ticket-create idempotency (fork/retry safe)', () => {
  beforeAll(async () => { await createApp({ port: 18994, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false }); ensureNodesRegistered(); });
  const node = () => getNodeRegistry().get('core.openwop.connectors.ticket-create')!;

  it('a repeat create for the same key is REUSED, never a second ticket', async () => {
    const cfg = { baseUrl: 'https://acme.atlassian.net', project: 'OPS', summary: 'Dup guard' };
    const c1 = connectors('jira', { id: '1', key: 'OPS-1' });
    expect(outputsOf(await node().execute(makeCtx({ tenantId: 'tt', config: cfg, connectors: c1.surface })))).toMatchObject({ created: true, reused: false, key: 'OPS-1' });
    // Same tenant + key on a fork/retry: the recorded ticket is reused; NO second create.
    const c2 = connectors('jira', { id: '2', key: 'OPS-2' });
    expect(outputsOf(await node().execute(makeCtx({ tenantId: 'tt', config: cfg, connectors: c2.surface })))).toMatchObject({ created: true, reused: true, key: 'OPS-1' });
    expect(c2.calls.length).toBe(0);
  });
});
