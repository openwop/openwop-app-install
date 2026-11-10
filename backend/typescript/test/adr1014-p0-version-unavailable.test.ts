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
 * records that version as the one that ran; a reused pin (this run's, or the one
 * a fork inherits from its parent) is re-resolved instead of reused, or skips the
 * availability check; the node is not handed the pinned version; or the agent
 * runner dispatches the head for a version it cannot load.
 *
 * The reused-pin cases run against the REAL feature resolver (nothing is
 * registered or unregistered here, so no case depends on another's order).
 *
 * Sabotage-witnessed (grade-tests w83): dropping the seam's `available` check
 * or the feature's archive/revision lookup, re-resolving instead of reusing this
 * run's pin, ignoring the parent's pin on a fork, dropping `ctx.agentVersion`,
 * and the runner neither forwarding the version nor mapping the typed error.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { getSetCookies } from './headerCookies.js';
import { enableToggle } from './planningHarness.js';
import { DurableCollection, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { getEventLog } from '../src/executor/eventLog.js';
import { pinAgentChannel } from '../src/host/agentChannelPin.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { StoredDeployment } from '../src/features/agent-deployments/types.js';

let server: http.Server;
let BASE = '';
let seq = 0;

interface Res<T = unknown> { status: number; body: T }
interface RunEvent { type: string; payload: Record<string, unknown> }
function client() {
  let cookie = '';
  return async <T = unknown>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'openwop-version': '2', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
  };
}

/** The deployment store's collection (features/agent-deployments/service.ts `rows`: same name, key and partition). */
const rows = new DurableCollection<StoredDeployment>(
  'agent-deployments', (r) => `${r.tenant}::${r.agentId}::${r.version}`, undefined, (r) => r.tenant,
);

async function owner() {
  const tenantId = `org:p0-${Date.now()}-${seq++}`;
  const call = client();
  const login = await call('POST', '/host/openwop-app/test/login', { email: `p0-${Date.now()}-${seq++}@acme.test`, tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const org = await call('POST', '/host/openwop-app/orgs', { name: 'P0' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const agent = await call<{ agentId: string }>('POST', '/host/openwop-app/agents', { persona: 'Versioned', modelClass: 'chat', systemPrompt: 'v' });
  expect(agent.status, JSON.stringify(agent.body)).toBe(201);
  return { tenantId, call, agentId: agent.body.agentId };
}

async function runBound(o: Awaited<ReturnType<typeof owner>>, typeId = 'core.identity', agent?: Record<string, unknown>, inputs: Record<string, unknown> = {}): Promise<{ status: string; reason?: unknown; code?: unknown; started: Array<Record<string, unknown>>; outputs?: unknown }> {
  const workflowId = `adr1014.p0.${randomUUID().slice(0, 8)}`;
  const reg = await o.call<unknown>('POST', '/host/openwop-app/workflows', {
    workflowId, name: 'bound', version: '1.0',
    nodes: [{ nodeId: 'a', typeId, name: 'a', position: { x: 0, y: 0 }, config: {}, inputs, agent: agent ?? { agentId: o.agentId, channel: 'stable' } }],
    edges: [], triggers: [{ id: 'manual', type: 'manual', enabled: true }], variables: [],
  });
  expect(reg.status, JSON.stringify(reg.body)).toBe(201);
  const run = await o.call<{ runId: string }>('POST', '/runs', { workflowId });
  expect(run.status, JSON.stringify(run.body)).toBe(201);
  const runId = run.body.runId;
  let status = '';
  await vi.waitFor(async () => {
    status = String((await o.call<{ status?: string }>('GET', `/runs/${encodeURIComponent(runId)}`)).body?.status);
    if (!['completed', 'failed', 'cancelled'].includes(status)) throw new Error(`run ${runId} not settled (${status})`);
  }, { timeout: 15_000, interval: 25 });
  const ev = await o.call<{ events?: RunEvent[] }>('GET', `/runs/${encodeURIComponent(runId)}/events/poll?fromSeq=-1&limit=500`);
  const events = ev.body?.events ?? [];
  const failed = events.find((e) => e.type === 'node.failed');
  const completed = events.find((e) => e.type === 'node.completed');
  return {
    code: (failed?.payload?.error as { code?: unknown } | undefined)?.code,
    outputs: completed?.payload?.outputs,
    status,
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
    expect(r.outputs).toMatchObject({ agentVersion: '0' });
  });

  it('the agent runner dispatches exactly a node\u2019s pinned version: one that is not installed fails typed, never the head', async () => {
    const o = await owner();
    const r = await runBound(o, 'local.openwop-app.agent-runner', { agentId: o.agentId, version: '9.9.9' }, { task: 'hello' });
    expect(r.status).toBe('failed');
    expect(String(r.code)).toMatch(/(^|\.)agent_version_unavailable$/); // the v2 read vendor-prefixes a host code
  });
});

describe('ADR 1014 P0 — a reused pin is checked too', () => {
  /** A run in `o`'s tenant; its log holds a `stable` pin on `version` (none when null). */
  async function pinnedRun(o: Awaited<ReturnType<typeof owner>>, version: string | null, parentRunId?: string) {
    const storage = hostExtStorage();
    const runId = randomUUID();
    const now = new Date().toISOString();
    await storage.insertRun({
      runId, workflowId: 'adr1014.p0.reuse', tenantId: o.tenantId, status: 'running', inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
      ...(parentRunId ? { parentRunId, forkMode: 'replay' as const } : {}),
    });
    if (version !== null) {
      await getEventLog().append({ runId, nodeId: 'a', type: 'agent.invocation.started', payload: { invocationId: `${runId}:a:0`, agentId: o.agentId, source: 'workflow-node', resolvedChannel: 'stable', resolvedAgentVersion: version } });
    }
    return (await storage.getRun(runId))!;
  }
  const pin = (o: Awaited<ReturnType<typeof owner>>, run: Awaited<ReturnType<typeof pinnedRun>>) =>
    pinAgentChannel({ storage: hostExtStorage(), run, nodeId: 'a', agent: { agentId: o.agentId, channel: 'stable' }, execution: 1 });

  it('a replay or fork of a run pinned to X runs X, even after the channel moved to Y', async () => {
    const o = await owner();
    const edit = await o.call<{ packVersion: string }>('PATCH', `/host/openwop-app/agents/${encodeURIComponent(o.agentId)}`, { systemPrompt: 'v2' });
    expect(edit.status, JSON.stringify(edit.body)).toBe(200);
    expect(edit.body.packVersion, 'stable now resolves to Y = 1 (the head, no stored rows)').toBe('1');
    // Positive control: a run with no pin resolves Y.
    const fresh = await pin(o, await pinnedRun(o, null));
    expect(fresh?.ok && fresh.pin.version).toBe('1');
    // This run's own pin on X = 0 (revision 0, still loadable) is reused.
    const parent = await pinnedRun(o, '0');
    const out = await pin(o, parent);
    expect(out?.ok && out.pin.version).toBe('0');
    // A fork with an empty log of its own inherits the parent's pin.
    const forked = await pin(o, await pinnedRun(o, null, parent.runId));
    expect(forked?.ok && forked.pin.version, 'the fork reads its parent\u2019s pin').toBe('0');
  });

  it('a pin already in the run log that is no longer available fails closed', async () => {
    const o = await owner();
    const out = await pin(o, await pinnedRun(o, '9.9.9'));
    expect(out?.ok).toBe(false);
    expect(out && !out.ok ? out.error.details.reason : undefined).toBe('agent_version_unavailable');
    expect(out && !out.ok ? out.error.details.version : undefined).toBe('9.9.9');
  });
});
