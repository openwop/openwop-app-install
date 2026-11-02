/**
 * ADR 1014 P0 — a channel pin never records a version this host cannot run.
 *
 * On the one-version-per-agent runtime, `resolveChannel` could return a stored
 * row's version that is no longer installed (a pack upgraded after the agent had
 * deployment rows), and `agent.invocation.started` then named a version other
 * than the code that ran. Now the pin seam asks the resolver whether the version
 * is available, for a fresh, a reused and an inherited pin alike, and fails the
 * node closed (`agent_version_unavailable`).
 *
 * Red when: a run whose `stable` names an uninstalled version completes, or
 * records that version as the one that ran; or a reused pin skips the check.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { enableToggle } from './planningHarness.js';
import { DurableCollection, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { pinAgentChannel, registerAgentChannelResolver } from '../src/host/agentChannelPin.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';

let server: http.Server;
let BASE = '';
let seq = 0;

interface Res { status: number; body: any }
function client() {
  let cookie = '';
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'openwop-version': '2', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined };
  };
}

/** Same shape the deployment store writes (features/agent-deployments/types.ts). */
const rows = new DurableCollection<Record<string, unknown> & { tenant: string; agentId: string; version: string }>(
  'agent-deployments', (r) => `${r.tenant}::${r.agentId}::${r.version}`, undefined, (r) => r.tenant,
);

async function owner() {
  const tenantId = `org:p0-${Date.now()}-${seq++}`;
  const call = client();
  const login = await call('POST', '/host/openwop-app/test/login', { email: `p0-${Date.now()}-${seq++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await call('POST', '/host/openwop-app/orgs', { name: 'P0' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const agent = await call('POST', '/host/openwop-app/agents', { persona: 'Versioned', modelClass: 'chat', systemPrompt: 'v' });
  expect(agent.status, JSON.stringify(agent.body)).toBe(201);
  return { tenantId, call, agentId: agent.body.agentId as string };
}

async function runBound(o: Awaited<ReturnType<typeof owner>>, typeId = 'core.identity', agent?: Record<string, unknown>, inputs: Record<string, unknown> = {}): Promise<{ status: string; reason?: unknown; code?: unknown; started: Array<Record<string, unknown>>; outputs?: unknown }> {
  const workflowId = `adr1014.p0.${randomUUID().slice(0, 8)}`;
  const reg = await o.call('POST', '/host/openwop-app/workflows', {
    workflowId, name: 'bound', version: '1.0',
    nodes: [{ nodeId: 'a', typeId, name: 'a', position: { x: 0, y: 0 }, config: {}, inputs, agent: agent ?? { agentId: o.agentId, channel: 'stable' } }],
    edges: [], triggers: [{ id: 'manual', type: 'manual', enabled: true }], variables: [],
  });
  expect([200, 201], JSON.stringify(reg.body)).toContain(reg.status);
  const run = await o.call('POST', '/runs', { workflowId });
  expect([201, 202], JSON.stringify(run.body)).toContain(run.status);
  const runId = run.body.runId as string;
  let r: Res = { status: 0, body: undefined };
  for (let i = 0; i < 400; i += 1) {
    r = await o.call('GET', `/runs/${encodeURIComponent(runId)}`);
    if (['completed', 'failed', 'cancelled'].includes(String(r.body?.status))) break;
    await new Promise((res) => setTimeout(res, 25));
  }
  const ev = await o.call('GET', `/runs/${encodeURIComponent(runId)}/events/poll?fromSeq=-1&limit=500`);
  const events = (ev.body?.events ?? []) as Array<{ type: string; payload: Record<string, unknown> }>;
  const failed = events.find((e) => e.type === 'node.failed');
  const completed = events.find((e) => e.type === 'node.completed');
  return {
    code: (failed?.payload?.error as { code?: unknown } | undefined)?.code,
    outputs: completed?.payload?.outputs,
    status: String(r.body?.status),
    reason: (failed?.payload?.error as { details?: { reason?: unknown } } | undefined)?.details?.reason,
    started: events.filter((e) => e.type === 'agent.invocation.started' || e.type === 'agent.invocation-started').map((e) => e.payload),
  };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_AGENT_DEPLOYMENT = 'on';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  await enableToggle('users', 'on');
  // ADR 1014 D3 — a node that reports the version it was handed.
  getNodeRegistry().register({ typeId: 'test.adr1014.echo-version', version: '1.0.0', async execute(ctx) { return { status: 'success', outputs: { agentVersion: ctx.agentVersion ?? null } }; } });
}, 60_000);
afterAll(async () => {
  delete process.env.OPENWOP_AGENT_DEPLOYMENT;
  await new Promise<void>((res) => server.close(() => res()));
});

describe('ADR 1014 P0 — the pin names only a version this host can run', () => {
  it('the installed version resolves, runs, and is the version recorded', async () => {
    const o = await owner();
    const r = await runBound(o);
    expect(r.status).toBe('completed');
    expect(r.started.map((p) => p.resolvedAgentVersion)).toEqual(['0']);
  });

  it('a stable row naming an uninstalled version fails the node closed and records nothing as run', async () => {
    const o = await owner();
    const now = new Date().toISOString();
    await rows.put({ tenant: o.tenantId, agentId: o.agentId, version: '9.9.9', state: 'active', channels: ['stable'], activatedAt: now, revision: 1, updatedAt: now });
    const r = await runBound(o);
    expect(r.status).toBe('failed');
    expect(r.reason).toBe('agent_version_unavailable');
    expect(r.started.some((p) => p.resolvedAgentVersion === '9.9.9')).toBe(false);
  });
});

describe('ADR 1014 P2 — the node is handed the version its pin recorded', () => {
  it('ctx.agentVersion is the resolved version', async () => {
    const o = await owner();
    const r = await runBound(o, 'test.adr1014.echo-version');
    expect(r.status).toBe('completed');
    expect(r.started.map((p) => p.resolvedAgentVersion)).toEqual(['0']);
    expect(JSON.stringify(r.outputs)).toContain('"agentVersion":"0"');
  });

  it('the agent runner dispatches exactly a node\u2019s pinned version: one that is not installed fails typed, never the head', async () => {
    const o = await owner();
    const r = await runBound(o, 'local.openwop-app.agent-runner', { agentId: o.agentId, version: '9.9.9' }, { task: 'hello' });
    expect(r.status).toBe('failed');
    expect(String(r.code)).toMatch(/(^|\.)agent_version_unavailable$/); // the v2 read vendor-prefixes a host code
  });
});

describe('ADR 1014 P0 — a reused pin is checked too', () => {
  it('a replay or fork of a run pinned to X runs X, even after the channel moved to Y', async () => {
    const storage = hostExtStorage();
    const runId = randomUUID();
    const now = new Date().toISOString();
    await storage.insertRun({ runId, workflowId: 'adr1014.p0.replay', tenantId: 't-replay', status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now });
    await getEventLog().append({ runId, nodeId: 'a', type: 'agent.invocation.started', payload: { invocationId: `${runId}:a:0`, agentId: 'ag', source: 'workflow-node', resolvedChannel: 'stable', resolvedAgentVersion: '1.0.0' } });
    registerAgentChannelResolver({ resolve: async () => ({ ok: true, version: '2.0.0' }), available: async () => true });
    try {
      const run = (await storage.getRun(runId))!;
      const out = await pinAgentChannel({ storage, run, nodeId: 'a', agent: { agentId: 'ag', channel: 'stable' }, execution: 1 });
      expect(out?.ok && out.pin.version).toBe('1.0.0');
    } finally {
      registerAgentChannelResolver(undefined);
    }
  });

  it('a pin already in the run log that is no longer available fails closed', async () => {
    const storage = hostExtStorage();
    const runId = randomUUID();
    const now = new Date().toISOString();
    await storage.insertRun({ runId, workflowId: 'adr1014.p0.reuse', tenantId: 't-reuse', status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now });
    await getEventLog().append({ runId, nodeId: 'a', type: 'agent.invocation.started', payload: { invocationId: `${runId}:a:0`, agentId: 'ag', source: 'workflow-node', resolvedChannel: 'stable', resolvedAgentVersion: '1.0.0' } });
    registerAgentChannelResolver({
      resolve: async () => ({ ok: true, version: '2.0.0' }),
      available: async (_t, _a, v) => v !== '1.0.0',
    });
    try {
      const run = (await storage.getRun(runId))!;
      const out = await pinAgentChannel({ storage, run, nodeId: 'a', agent: { agentId: 'ag', channel: 'stable' }, execution: 1 });
      expect(out?.ok).toBe(false);
      expect(out && !out.ok ? out.error.details.reason : undefined).toBe('agent_version_unavailable');
    } finally {
      // Restore the feature's resolver for any later file in this worker.
      registerAgentChannelResolver(undefined);
    }
  });
});
