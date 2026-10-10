/**
 * ADR 0785 P5 — a chain step runs one task on the run owner's own Claude Code.
 *
 * A real run (the real executor, the app's own storage) reaches a
 * `claude-code.task` node; a paired device connected over its real socket
 * receives ONE task frame; the device posts its result over HTTP with its key;
 * the node resumes through `resolveAndResume` and the run completes with the
 * summary FENCED as untrusted. Plus the failure modes D8 promises:
 *   - no online device → `runner_unavailable`, and nothing was sent;
 *   - a re-executed node finds its claim and does NOT send again (at-most-once);
 *   - past its deadline → `maybe_executed`, never an automatic retry;
 *   - only the device the task went to may report it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ensurePersonalBoard } from '../src/host/kanbanService.js';
import { afterAll, beforeAll, describe, expect, it, beforeEach } from 'vitest';
import { WebSocket } from 'ws';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { attachRegisteredUpgradeHandlers } from '../src/host/upgradeRegistry.js';
import { executeRun } from '../src/executor/executor.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { getNodeRegistry } from '../src/executor/nodeRegistry.js';
import type { Storage } from '../src/storage/storage.js';
import type { RunRecord } from '../src/types.js';
import type { WorkflowDefinition, NodeContext } from '../src/executor/types.js';
import { CLAUDE_CODE_OPERATOR_ENV, consentHash } from '../src/features/claude-code/constants.js';
import { TASK_NODE_TYPE, sweepExpiredTasks, taskIdFor, __getTaskForTest } from '../src/features/claude-code/tasks.js';
import { __resetPairingRateLimitForTest } from '../src/features/claude-code/routes.js';

const CC = '/host/openwop-app/claude-code';
let BASE: string; let WS: string; let server: http.Server; let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env[CLAUDE_CODE_OPERATOR_ENV] = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { const p = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${p}`; WS = `ws://127.0.0.1:${p}`; res(); }); });
  attachRegisteredUpgradeHandlers(server);
  for (const id of ['users', 'claude-code']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { delete process.env[CLAUDE_CODE_OPERATOR_ENV]; server.closeAllConnections(); await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: any }
function client(bearer?: string) {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b) };
}
let n = 0;
async function owner(opts: { workflowTasks?: boolean } = {}) {
  const c = client();
  const tenantId = `org:cctask-${Date.now()}-${n}`;
  const r = await c.post('/host/openwop-app/test/login', { subject: `cctask-${Date.now()}-${n++}`, tenantId, email: `t${n}-${Date.now()}@a.test` });
  expect(r.status).toBe(201);
  const anon = client();
  const s = await anon.post(`${CC}/pair/device/start`, { label: 'runner box' });
  await c.post(`${CC}/pair/requests/${s.body.userCode}/approve`, { consentHash: consentHash() });
  const p = await anon.post(`${CC}/pair/device/poll`, { deviceCode: s.body.deviceCode });
  // ADR 0785 D7 — workflow tasks are a separate, per-device opt-in (default ON here so
  // the dispatch tests exercise dispatch; the consent tests below pass false).
  if (opts.workflowTasks !== false) {
    const on = await c.put(`${CC}/devices/${p.body.deviceId}/workflow-tasks`, { enabled: true });
    expect(on.status, JSON.stringify(on.body)).toBe(200);
  }
  return { c, tenantId, userId: r.body.user.userId as string, token: p.body.token as string, deviceId: p.body.deviceId as string };
}
function connectDevice(token: string) {
  const ws = new WebSocket(`${WS}/host/openwop-app/claude-code/device`, { headers: { authorization: `Bearer ${token}` } });
  const frames: any[] = [];
  ws.on('message', (d, bin) => { if (!bin) frames.push(JSON.parse(String(d))); });
  const ready = new Promise<void>((resolve) => { const t = setInterval(() => { if (frames.some((f) => f.type === 'hello')) { clearInterval(t); resolve(); } }, 10); });
  return { ws, frames, ready };
}
const until = async (pred: () => boolean | Promise<boolean>, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return; await new Promise((r) => setTimeout(r, 20)); }
  throw new Error('condition not met in time');
};

async function startTaskRun(tenantId: string, actingUserId: string | null, extraMeta: Record<string, unknown> = {}, node: Record<string, unknown> = { inputs: { prompt: 'Make the failing test pass' } }): Promise<{ run: RunRecord; def: WorkflowDefinition; result: Awaited<ReturnType<typeof executeRun>> }> {
  const def: WorkflowDefinition = {
    workflowId: `wf.cc-task.${randomUUID()}`,
    nodes: [{ nodeId: 'code', typeId: TASK_NODE_TYPE, ...node }],
    edges: [],
  } as unknown as WorkflowDefinition;
  // A chain step is always a REGISTERED workflow; the resume re-loads it from the catalog.
  registerWorkflow(def);
  const now = new Date().toISOString();
  const run: RunRecord = { runId: randomUUID(), workflowId: def.workflowId, tenantId, status: 'pending', inputs: {}, metadata: { ...(actingUserId ? { actingUserId } : {}), ...extraMeta }, configurable: {}, createdAt: now, updatedAt: now } as RunRecord;
  await insertRunWithStartContext(storage, run, { definition: def });
  const result = await executeRun(storage, run, def);
  return { run, def, result };
}

describe('ADR 0785 P5 — app-dispatched tasks', () => {
  // Each test pairs fresh devices; the per-IP pairing limit (10 / 10 min) is not under test here.
  beforeEach(() => { __resetPairingRateLimitForTest(); });
  it('dispatches ONE task to the owner\'s device, resumes on its result, and fences the summary', async () => {
    const o = await owner();
    const dev = connectDevice(o.token);
    await dev.ready;
    await until(async () => (await o.c.get(`${CC}/devices`)).body.devices[0]?.online === true);

    const { run } = await startTaskRun(o.tenantId, o.userId);
    await until(() => dev.frames.some((f) => f.type === 'task'));
    const task = dev.frames.find((f) => f.type === 'task');
    expect(task).toMatchObject({ runId: run.runId, stepId: 'code', kind: 'tool', tool: 'claude-code.task', inputs: { prompt: 'Make the failing test pass' } });
    expect(task.taskId).toBe(taskIdFor(run.runId, 'code'));

    const posted = await client(o.token).post(`${CC}/tasks/${task.taskId}/result`, { status: 'completed', isError: false, summary: 'Fixed: off-by-one in the parser.', numTurns: 4, costUsd: 0.12 });
    expect(posted.status, JSON.stringify(posted.body)).toBe(200);
    await until(async () => (await storage.getRun(run.runId))?.status === 'completed', 5000);
    const events = await storage.listEvents(run.runId);
    const done = events.find((e) => e.type === 'node.completed' && (e as { nodeId?: string }).nodeId === 'code') as { payload?: { outputs?: { summary?: string } } } | undefined;
    const summary = JSON.stringify(done ?? events.filter((e) => e.type === 'node.completed'));
    expect(summary).toContain('<UNTRUSTED source=\\"claude-code\\">');
    expect(summary).toContain('off-by-one');

    // A second report is idempotent, and a stranger's key cannot report at all.
    expect((await client(o.token).post(`${CC}/tasks/${task.taskId}/result`, { status: 'completed', summary: 'again' })).body.alreadyFinished).toBe(true);
    const other = await owner();
    expect((await client(other.token).post(`${CC}/tasks/${task.taskId}/result`, { status: 'completed', summary: 'x' })).status).toBe(404);
    dev.ws.close();
  });

  it('no online device → runner_unavailable, and NOTHING was claimed or sent', async () => {
    const o = await owner(); // never connects
    const { run, result } = await startTaskRun(o.tenantId, o.userId);
    expect(result.status).toBe('failed');
    const events = JSON.stringify(await storage.listEvents(run.runId));
    expect(events).toContain('runner_unavailable');
    expect(await __getTaskForTest(taskIdFor(run.runId, 'code'))).toBeNull();
  });

  it('D7: a paired, ONLINE device whose owner never opted in gets nothing — consent_required, no claim, no frame', async () => {
    const o = await owner({ workflowTasks: false });
    const dev = connectDevice(o.token);
    await dev.ready;
    await until(async () => (await o.c.get(`${CC}/devices`)).body.devices[0]?.online === true);
    const { run, result } = await startTaskRun(o.tenantId, o.userId);
    expect(result.status).toBe('failed');
    expect(JSON.stringify(await storage.listEvents(run.runId))).toContain('consent_required');
    expect(await __getTaskForTest(taskIdFor(run.runId, 'code'))).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(dev.frames.some((f) => f.type === 'task')).toBe(false);

    // Turning it on, then OFF again, leaves it refused: the switch is honoured both ways.
    expect((await o.c.put(`${CC}/devices/${o.deviceId}/workflow-tasks`, { enabled: true })).body.workflowTasks).toBeTruthy();
    expect((await o.c.put(`${CC}/devices/${o.deviceId}/workflow-tasks`, { enabled: false })).body.workflowTasks).toBeNull();
    const again = await startTaskRun(o.tenantId, o.userId);
    expect(JSON.stringify(await storage.listEvents(again.run.runId))).toContain('consent_required');
    dev.ws.close();
  });

  it('a prompt set in the builder form (node CONFIG) reaches the device; an upstream input would override it', async () => {
    const o = await owner();
    const dev = connectDevice(o.token);
    await dev.ready;
    await until(async () => (await o.c.get(`${CC}/devices`)).body.devices[0]?.online === true);
    const { run } = await startTaskRun(o.tenantId, o.userId, {}, { config: { prompt: 'Rename the helper', maxTurns: 5 } });
    await until(() => dev.frames.some((f) => f.type === 'task' && f.runId === run.runId));
    expect(dev.frames.find((f) => f.type === 'task' && f.runId === run.runId).inputs).toEqual({ prompt: 'Rename the helper', maxTurns: 5 });
    dev.ws.close();
  });

  it('D7: a device KEY cannot opt itself in, and nobody can opt in someone else\'s device', async () => {
    const o = await owner({ workflowTasks: false });
    expect((await client(o.token).put(`${CC}/devices/${o.deviceId}/workflow-tasks`, { enabled: true })).status).toBe(401);
    const stranger = await owner({ workflowTasks: false });
    expect((await stranger.c.put(`${CC}/devices/${o.deviceId}/workflow-tasks`, { enabled: true })).status).toBe(404);
    expect((await o.c.put(`${CC}/devices/${o.deviceId}/workflow-tasks`, { enabled: 'yes' })).status).toBe(400);
    const listed = (await o.c.get(`${CC}/devices`)).body.devices[0];
    expect(listed.workflowTasks).toBeUndefined();
  });

  it('past its deadline → maybe_executed (the sweep), never an automatic retry', async () => {
    const o = await owner();
    const dev = connectDevice(o.token);
    await dev.ready;
    await until(async () => (await o.c.get(`${CC}/devices`)).body.devices[0]?.online === true);
    const { run } = await startTaskRun(o.tenantId, o.userId);
    await until(() => dev.frames.some((f) => f.type === 'task'));
    expect(await sweepExpiredTasks(Date.now() + 3 * 60 * 60_000)).toBeGreaterThanOrEqual(1);
    await until(async () => (await storage.getRun(run.runId))?.status === 'failed', 5000);
    expect(JSON.stringify(await storage.listEvents(run.runId))).toContain('maybe_executed');
    expect(dev.frames.filter((f) => f.type === 'task')).toHaveLength(1);
    dev.ws.close();
  });

  it('AT-MOST-ONCE: a re-executed node finds its claim and does not send a second frame', async () => {
    const o = await owner();
    const dev = connectDevice(o.token);
    await dev.ready;
    await until(async () => (await o.c.get(`${CC}/devices`)).body.devices[0]?.online === true);
    const node = getNodeRegistry().get(TASK_NODE_TYPE);
    expect(node).toBeTruthy();
    const ctx = (runId: string) => ({
      runId, nodeId: 'code', tenantId: o.tenantId, actingUserId: o.userId, inputs: { prompt: 'p' },
      suspend: async () => ({ status: 'completed', isError: false, summary: 'ok' }),
    }) as unknown as NodeContext;
    const runId = randomUUID();
    await node!.execute(ctx(runId));
    await node!.execute(ctx(runId)); // the same node, executed again
    // …and two executions in the SAME tick (both read "no task yet"): only the
    // claim-before-send CAS can stop the second send here.
    const raced = randomUUID();
    await Promise.all([node!.execute(ctx(raced)), node!.execute(ctx(raced)), node!.execute(ctx(raced))]);
    await until(() => dev.frames.some((f) => f.type === 'task'));
    await new Promise((r) => setTimeout(r, 100));
    expect(dev.frames.filter((f) => f.type === 'task' && f.runId === runId)).toHaveLength(1);
    expect(dev.frames.filter((f) => f.type === 'task' && f.runId === raced)).toHaveLength(1);
    dev.ws.close();
  });

  it('the REAL companion TaskRunner runs the frame and its report completes the run (only `claude` is faked)', async () => {
    const o = await owner();
    const dev = connectDevice(o.token);
    await dev.ready;
    await until(async () => (await o.c.get(`${CC}/devices`)).body.devices[0]?.online === true);
    const { run } = await startTaskRun(o.tenantId, o.userId);
    await until(() => dev.frames.some((f) => f.type === 'task'));
    const frame = dev.frames.find((f) => f.type === 'task');

    const url = new URL('../../../clients/agent-host/src/taskRunner.js', import.meta.url).href;
    const { TaskRunner } = (await import(url)) as { TaskRunner: new (o: Record<string, unknown>) => { run(f: unknown): Promise<string> } };
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const spawnFn = () => {
      const child = new EventEmitter() as InstanceType<typeof EventEmitter> & { stdout: InstanceType<typeof EventEmitter>; stderr: InstanceType<typeof EventEmitter> };
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'result', is_error: false, result: 'Renamed the helper; tests pass.', num_turns: 2, total_cost_usd: 0.03 })}\n`));
        child.emit('close', 0);
      });
      return child;
    };
    const runner = new TaskRunner({ apiRoot: BASE, token: o.token, root: '/repo', home: mkdtempSync(join(tmpdir(), 'cc-tr-')), launch: () => ({}), spawnFn });
    expect(await runner.run(frame)).toBe('completed');
    await until(async () => (await storage.getRun(run.runId))?.status === 'completed', 5000);
    expect(JSON.stringify(await storage.listEvents(run.runId))).toContain('Renamed the helper');
    dev.ws.close();
  });

  it('a HEARTBEAT-started run (no acting user) reaches the device of the card board\'s owner', async () => {
    const o = await owner();
    const dev = connectDevice(o.token);
    await dev.ready;
    await until(async () => (await o.c.get(`${CC}/devices`)).body.devices[0]?.online === true);
    // The card's board is the owner's personal board — its owner is unambiguous.
    const board = await ensurePersonalBoard(`user:${o.userId}-personal`, o.userId);
    const { run } = await startTaskRun(o.tenantId, null, { heartbeat: { boardId: board.id, cardId: 'card-1', source: 'heartbeat' } });
    await until(() => dev.frames.some((f) => f.type === 'task' && f.runId === run.runId));
    dev.ws.close();
  });

  it('a heartbeat run whose board has NO human owner (an agent board) gets runner_unavailable, never a guess', async () => {
    const o = await owner();
    const dev = connectDevice(o.token);
    await dev.ready;
    const { run, result } = await startTaskRun(o.tenantId, null, { heartbeat: { boardId: 'board-agent-does-not-exist', source: 'heartbeat' } });
    expect(result.status).toBe('failed');
    expect(JSON.stringify(await storage.listEvents(run.runId))).toContain('runner_unavailable');
    expect(dev.frames.filter((f) => f.type === 'task' && f.runId === run.runId)).toHaveLength(0);
    dev.ws.close();
  });
});
