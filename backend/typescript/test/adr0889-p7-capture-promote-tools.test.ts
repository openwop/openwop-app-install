/**
 * ADR 0889 P7 — opt-in tool-boundary capture (D9), promote-a-run-to-a-case,
 * and the three agent-eval chat tools (D8).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { AGENT_SUITE_KIND } from '../src/host/evals/agentEvalRun.js';
import type { RunRecord } from '../src/types.js';
import { maybeCaptureExecuteTool, listRunBoundary, MAX_CALLS_PER_RUN } from '../src/host/evals/toolBoundary.js';
import { buildTaskFromRun } from '../src/host/evals/promoteRun.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { putEvalSuite, validateEvalSuite } from '../src/host/evals/suiteStore.js';

let server: Server; let base = '';
const V2 = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };
const AGENT = 'eval.capture-agent';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // EVD-5 — the capture switch now 404s for an agent the tenant cannot resolve.
  for (const agentId of [AGENT, 'vendor.openwop-app.evals.agents.spelling']) {
    getAgentRegistry().register({
      agentId, persona: 'Capture subject', modelClass: 'general', systemPrompt: 'Answer.',
      packName: 'test', packVersion: '0', toolAllowlist: [], confidence: { defaultThreshold: 0.1 },
    });
  }
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

async function send(method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown>; text: string }> {
  const res = await fetch(`${base}${path}`, { method, headers: V2, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* asserted */ }
  return { status: res.status, json, text };
}

describe('ADR 0889 D9 — opt-in tool-boundary capture', () => {
  it('a switch flipped under one agent-id spelling captures under the other (ADR 0763)', async () => {
    // The workspace sends the roster's legacy `feature.*` id; the lanes resolve
    // the canonical `vendor.openwop-app.*` one. Both must hit the same setting.
    expect((await send('PUT', '/host/openwop-app/agent-evals/capture/feature.evals.agents.spelling', { enabled: true })).status).toBe(200);
    let n = 0;
    const inner = async () => { n += 1; return { content: '{"ok":true}' }; };
    const wrapped = await maybeCaptureExecuteTool(inner, { tenantId: 'default', runId: 'r-spelling', agentId: 'vendor.openwop-app.evals.agents.spelling' });
    expect(wrapped).not.toBe(inner);
    await wrapped({ id: 'c1', name: 'crm.lookup', input: { id: 'A1' } } as Parameters<typeof wrapped>[0]);
    expect(n).toBe(1);
    const capture = await send('GET', '/host/openwop-app/agent-evals/capture/feature.evals.agents.spelling');
    expect((capture.json['runs'] as Array<{ runId: string; calls: number }>).find((r) => r.runId === 'r-spelling')?.calls).toBe(1);
  });

  it('is OFF by default: the lane executor is returned unchanged and nothing is recorded', async () => {
    const inner = async () => ({ content: 'x' });
    const wrapped = await maybeCaptureExecuteTool(inner, { tenantId: 'default', runId: 'r-off', agentId: AGENT });
    expect(wrapped).toBe(inner);
  });

  it('ON: records each call (secrets stripped, capped per run) and the run promotes into a deterministic task', async () => {
    expect((await send('PUT', `/host/openwop-app/agent-evals/capture/${AGENT}`, { enabled: true })).status).toBe(200);
    const created = await send('POST', '/runs', { workflowId: 'conformance-noop', inputs: { q: 'refund o-1' } });
    expect(created.status, created.text.slice(0, 200)).toBe(201);
    const runId = String(created.json['runId']);
    // The lanes capture under the STORED run id; the v2 wire spells it `<tenant>/<id>`.
    const storedId = runId.includes('/') ? runId.slice(runId.indexOf('/') + 1) : runId;

    const exec = await maybeCaptureExecuteTool(async (call) => ({ content: JSON.stringify({ echoed: call.input }) }), { tenantId: 'default', runId: storedId, agentId: AGENT });
    await exec({ name: 'crm:lookup', input: { orderId: 'o-1', apiKey: 'sk-ant-api03-SECRETSECRETSECRETSECRET' } });
    await exec({ name: 'billing:refund', input: { orderId: 'o-1', amountMinor: 4200 } });
    const rows = await listRunBoundary('default', storedId);
    expect(rows.map((r) => r.tool)).toEqual(['crm:lookup', 'billing:refund']);
    expect(JSON.stringify(rows)).not.toContain('SECRETSECRET');

    const capture = await send('GET', `/host/openwop-app/agent-evals/capture/${AGENT}`);
    expect(capture.json).toMatchObject({ enabled: true });
    expect((capture.json['runs'] as Array<{ runId: string; calls: number }>).find((r) => r.runId === storedId)?.calls).toBe(2);

    const put = await send('PUT', '/host/openwop-app/agent-evals/suites/test.acme.evals.promoted@1.0.0', {
      suiteId: 'test.acme.evals.promoted', version: '1.0.0', modes: ['golden'],
      tasks: [{ taskId: 'seed', input: {}, expected: { kind: 'golden', match: { strategy: 'contains', value: 'x' } } }],
    });
    expect(put.status, put.text.slice(0, 200)).toBe(200);
    const promoted = await send('POST', '/host/openwop-app/agent-evals/suites/test.acme.evals.promoted@1.0.0/tasks', { fromRunId: runId, taskId: 'refund-path', expectedContains: 'refunded' });
    expect(promoted.status, promoted.text.slice(0, 300)).toBe(201);
    const task = ((promoted.json['suite'] as { tasks: Array<Record<string, unknown>> }).tasks).find((t) => t['taskId'] === 'refund-path')!;
    expect(task['input']).toEqual({ q: 'refund o-1' });
    expect(task['expected']).toMatchObject({ kind: 'golden', trajectory: { match: 'in-order', calls: [{ tool: 'crm:lookup' }, { tool: 'billing:refund' }] } });
    expect(task['fixtures']).toMatchObject({ onMiss: 'fail' });
    expect(((task['fixtures'] as { toolResponses: unknown[] }).toolResponses)).toHaveLength(2);
  });

  it('caps the calls recorded per run', async () => {
    expect((await send('PUT', `/host/openwop-app/agent-evals/capture/${AGENT}`, { enabled: true })).status).toBe(200);
    const exec = await maybeCaptureExecuteTool(async () => ({ content: '{}' }), { tenantId: 'default', runId: 'r-cap', agentId: AGENT });
    for (let i = 0; i < MAX_CALLS_PER_RUN + 5; i += 1) await exec({ name: 't', input: { i } });
    expect(await listRunBoundary('default', 'r-cap')).toHaveLength(MAX_CALLS_PER_RUN);
  });

  it('a run with nothing captured cannot be promoted (typed 400)', async () => {
    const created = await send('POST', '/runs', { workflowId: 'conformance-noop', inputs: {} });
    const r = await send('POST', '/host/openwop-app/agent-evals/suites/test.acme.evals.promoted@1.0.0/tasks', { fromRunId: String(created.json['runId']) });
    expect(r.status).toBe(400);
    expect((r.json['details'] as Record<string, unknown>)['reason']).toBe('nothing_captured');
  });

  it('buildTaskFromRun without expectedContains is a trajectory-only task', () => {
    const t = buildTaskFromRun({ taskId: 'x', input: {}, boundary: [{ tool: 'a', input: {}, result: '{"ok":1}', isError: false }] });
    expect(t.expected).toEqual({ kind: 'trajectory', trajectory: { match: 'in-order', calls: [{ tool: 'a', argsMatch: 'ignore' }] } });
    expect(t.fixtures?.toolResponses?.[0]).toMatchObject({ tool: 'a', argsMatch: 'exact', response: { ok: 1 } });
  });
});

describe('ADR 0889 D8 — agent-eval chat tools', () => {
  it('are registered, and fail empty/closed without an acting user', async () => {
    const list = builtinAgentTool('openwop:agent-evals.list-suites')!;
    const run = builtinAgentTool('openwop:agent-evals.run')!;
    const summary = builtinAgentTool('openwop:agent-evals.get-summary')!;
    expect(list && run && summary).toBeTruthy();
    expect(run.safeModeApproval).toBeTruthy();
    expect(JSON.parse((await list.run({}, { tenantId: 'default' } as never)).content)).toEqual({ items: [] });
    expect((await run.run({ suiteRef: 'x', agentId: 'y' }, { tenantId: 'default' } as never)).isError).toBe(true);
    expect((await summary.run({ runId: 'nope' }, { tenantId: 'default' } as never)).isError).toBe(true);
  });

  it('list-suites reads the same store the route does, under the route\'s predicate (review M3)', async () => {
    const list = builtinAgentTool('openwop:agent-evals.list-suites')!;
    // The personal-workspace owner holds workspace:read (the route's gate) …
    await putEvalSuite('user:u-1', validateEvalSuite({
      suiteId: 'test.acme.evals.mine', version: '1.0.0', modes: ['golden'],
      tasks: [{ taskId: 't', input: {}, expected: { kind: 'golden', match: { strategy: 'contains', value: 'x' } } }],
    }), 'user:u-1');
    const own = JSON.parse((await list.run({}, { tenantId: 'user:u-1', actingUserId: 'u-1', personalTenant: 'user:u-1' } as never)).content) as { items: Array<{ ref: string }> };
    expect(own.items.map((i) => i.ref)).toContain('test.acme.evals.mine@1.0.0');
    // … a non-member of the workspace does not, so the tool fails EMPTY like the route refuses.
    const outsider = JSON.parse((await list.run({}, { tenantId: 'default', actingUserId: 'u-1' } as never)).content) as { items: unknown[] };
    expect(outsider.items).toEqual([]);
  });

  it('get-summary never reveals another tenant\'s run (M10: the tenant check is the deciding guard)', async () => {
    const summary = builtinAgentTool('openwop:agent-evals.get-summary')!;
    // A real EVAL run in tenant A, read by a caller who passes the gate in tenant B
    // (owner of their personal workspace): only the tenant check can refuse it.
    const now = new Date().toISOString();
    const evalRun = (runId: string, tenantId: string): RunRecord => ({
      runId, workflowId: 'eval:test.acme.evals.m10@1.0.0', tenantId, status: 'completed', inputs: {},
      metadata: { mode: 'eval', eval: { kind: AGENT_SUITE_KIND, suiteRef: 'test.acme.evals.m10@1.0.0', suiteSource: 'tenant', agentId: AGENT }, evalSummary: { passed: true } },
      configurable: {}, createdAt: now, updatedAt: now,
    });
    await hostExtStorage().insertRun(evalRun('m10-tenant-a', 'default'));
    await hostExtStorage().insertRun(evalRun('m10-tenant-b', 'user:u-9'));
    const scopeB = { tenantId: 'user:u-9', actingUserId: 'u-9', personalTenant: 'user:u-9' } as never;
    // Positive control: the same caller reads its own tenant's eval run.
    const own = await summary.run({ runId: 'm10-tenant-b' }, scopeB);
    expect(own.isError, own.content).toBeFalsy();
    expect(JSON.parse(own.content)).toMatchObject({ runId: 'm10-tenant-b', summary: { passed: true } });
    const r = await summary.run({ runId: 'm10-tenant-a' }, scopeB);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content)).toMatchObject({ error: 'not_found' });
  });
});
