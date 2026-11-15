/**
 * ADR 1120 (Book AI P53) — `decide: 'signed-in'`: an approval gate decided only by a
 * signed-in person. The witnesses bookai-c4 asked for:
 *  - a leaked resolve-intent token gets `403 interrupt_requires_session` on every token
 *    door (`POST /interrupts/{token}`, the email confirm form's POST, and its GET, which
 *    renders no decide form), and the run stays waiting;
 *  - the run-scoped door still decides it;
 *  - a replay fork keeps `'signed-in'` (the refusal is keyed on the recorded data);
 *  - `'link'` (the default) is unchanged: the token decides, the form renders, and the
 *    email lane gets the token and no review path;
 *  - under `'signed-in'` the email lane gets no token, only the person's Review link.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

const mailed = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('../src/host/emailApprovalDelivery.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/host/emailApprovalDelivery.js')>();
  return { ...real, deliverApprovalEmail: async (_s: unknown, input: Record<string, unknown>) => { mailed.calls.push(input); } };
});

import { createApp } from '../src/index.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { validateWorkflowDefinition } from '../src/host/workflowDefinitionValidation.js';
import { bareRunId } from './support/bareRunId.js';
import { readApprovalGateDecide, gateRequiresSession } from '../src/host/approvalGateDecide.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { ensureNotificationEmitterInstalled } from '../src/bootstrap/notifications.js';
import { emitInterruptNotification } from '../src/notifications/notify.js';
import type { InterruptRecord, RunRecord } from '../src/types.js';

describe('ADR 1120 — the decide config', () => {
  it('reads closed-world: link and absent write nothing, signed-in writes the key, anything else fails', () => {
    expect(readApprovalGateDecide('t', {})).toEqual({});
    expect(readApprovalGateDecide('t', { decide: 'link' })).toEqual({});
    expect(readApprovalGateDecide('t', { decide: 'signed-in' })).toEqual({ decide: 'signed-in' });
    expect(readApprovalGateDecide('t', { decide: 'signedin' })).toMatchObject({ status: 'failure', error: { code: 'invalid_config' } });
    expect(gateRequiresSession({ decide: 'signed-in' })).toBe(true);
    expect(gateRequiresSession({ decide: 'link' })).toBe(false);
    expect(gateRequiresSession(null)).toBe(false);
  });
});

const { approvalGate } = (await import(
  /* @vite-ignore */ new URL('../../../packs/vendor.myndhyve.chat/index.mjs', import.meta.url).href
)) as { approvalGate: (ctx: Record<string, unknown>) => Promise<unknown> };

describe('ADR 1120 — core.chat.approvalGate forwards decide', () => {
  async function suspendOf(config: Record<string, unknown>): Promise<{ payload?: Record<string, unknown>; result: unknown }> {
    let payload: Record<string, unknown> | undefined;
    const result = await approvalGate({
      runId: 'r', nodeId: 'gate', config, inputs: {},
      variables: { get: () => undefined, set: () => undefined },
      suspend: async (p: Record<string, unknown>) => { payload = p; return { action: 'accept' }; },
    });
    return { ...(payload ? { payload } : {}), result };
  }
  it('signed-in reaches interrupt.data; link and absent add nothing; an unknown value fails typed', async () => {
    expect((await suspendOf({ decide: 'signed-in' })).payload?.decide).toBe('signed-in');
    expect('decide' in ((await suspendOf({ decide: 'link' })).payload ?? {})).toBe(false);
    expect('decide' in ((await suspendOf({})).payload ?? {})).toBe(false);
    const bad = await suspendOf({ decide: 'always' });
    expect(bad.payload, 'no suspension on a bad config').toBeUndefined();
    expect(bad.result).toMatchObject({ status: 'failure', error: { code: 'invalid_config' } });
  });
});

describe('ADR 1120 — the email lane', () => {
  const now = new Date().toISOString();
  const run = (runId: string): RunRecord => ({
    runId, tenantId: 't-1120', workflowId: 'wf.1120', status: 'running', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
  });
  const interrupt = (runId: string, data: Record<string, unknown>): InterruptRecord => ({
    interruptId: `int-${runId}`, runId, nodeId: 'gate', kind: 'approval', token: 'resolve-token', data, createdAt: now,
  });
  async function mailFor(runId: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    mailed.calls.length = 0;
    const storage = openSqliteStorage(':memory:');
    ensureNotificationEmitterInstalled(storage);
    await storage.insertRun(run(runId));
    await emitInterruptNotification(storage, interrupt(runId, data));
    const [n] = await storage.listNotifications({ tenantId: 't-1120' });
    await storage.close();
    expect(mailed.calls).toHaveLength(1);
    return { ...mailed.calls[0]!, notificationId: n!.notificationId, mailedId: mailed.calls[0]!.notificationId };
  }

  it("'link' (the default) mails the resolve token and no review path, exactly as before", async () => {
    const m = await mailFor('r-link', { prompt: 'Approve?', actions: ['approve', 'reject'], approverRefs: ['u-ana'] });
    expect(m.interruptToken).toBe('resolve-token');
    expect('reviewPath' in m).toBe(false);
  });

  it("'signed-in' mails NO token, only the Review link to that person's own row", async () => {
    const m = await mailFor('r-signed', { prompt: 'Approve?', actions: ['approve', 'reject'], approverRefs: ['u-ana'], decide: 'signed-in' });
    expect('interruptToken' in m).toBe(false);
    expect(m.reviewPath).toBe(`/inbox?notification=${encodeURIComponent(String(m.mailedId))}`);
  });
});

let server: http.Server;
let BASE = '';
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };
const gateDef = (workflowId: string, gateConfig: Record<string, unknown>): unknown => ({
  workflowId,
  nodes: [{ nodeId: 'gate', typeId: 'core.approvalGate', config: { title: 'Review the change', actions: ['approve', 'reject'], ...gateConfig } }],
  edges: [],
});

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  registerWorkflow(validateWorkflowDefinition(gateDef('wf.adr1120.signed-in', { decide: 'signed-in' })) as never);
  registerWorkflow(validateWorkflowDefinition(gateDef('wf.adr1120.link', {})) as never);
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

type Json = Record<string, unknown>;
type Ev = { sequence: number; type: string; nodeId?: string };
async function api<T = Json>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T; text: string }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  let body: T;
  try { body = (text ? JSON.parse(text) : {}) as T; } catch { body = {} as T; }
  return { status: res.status, body, text };
}
const status = async (runId: string): Promise<string> => (await api<{ status: string }>(`/runs/${runId}`)).body.status;
async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  let v = await read();
  for (let i = 0; i < 300 && !ok(v); i++) { await new Promise((r) => setTimeout(r, 20)); v = await read(); }
  return v;
}
async function startWaiting(workflowId: string): Promise<string> {
  const r = await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId }) });
  expect(r.status, r.text).toBe(201);
  expect(await waitFor(() => status(r.body.runId), (s) => s === 'waiting-approval')).toBe('waiting-approval');
  return r.body.runId;
}
async function tokenOf(runId: string): Promise<string> {
  const list = (await api<{ interrupts: Array<{ token: string }> }>(`/host/openwop-app/runs/${bareRunId(runId)}/interrupts`)).body.interrupts ?? [];
  expect(list.length, `run ${runId} must have an open gate`).toBeGreaterThan(0);
  return list[0]!.token;
}
const form = (fields: Record<string, string>): RequestInit => ({
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(),
});

describe("ADR 1120 — a 'signed-in' gate on the token doors", () => {
  it('a leaked resolve token is refused 403 on all three doors, and the run-scoped door still decides', async () => {
    const runId = await startWaiting('wf.adr1120.signed-in');
    const token = await tokenOf(runId);

    const byToken = await api(`/interrupts/${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'approve' } }) });
    expect(byToken.status, byToken.text).toBe(403);
    expect(byToken.text).toContain('interrupt_requires_session');

    const confirmPost = await api('/host/openwop-app/interrupt-action', form({ token, action: 'approve' }));
    expect(confirmPost.status, confirmPost.text).toBe(403);
    expect(confirmPost.text).toContain('Sign in to decide');

    const confirmGet = await api(`/host/openwop-app/interrupt-action?token=${encodeURIComponent(token)}&action=approve`);
    expect(confirmGet.status).toBe(403);
    expect(confirmGet.text).not.toContain('<form');

    expect(await status(runId), 'nothing was decided').toBe('waiting-approval');

    const byRun = await api(`/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'approve' } }) });
    expect(byRun.status, byRun.text).toBeLessThan(300);
    expect(await waitFor(() => status(runId), (s) => s === 'completed' || s === 'failed')).toBe('completed');
  });

  it('a replay fork keeps signed-in: the fork\'s own token is refused too', async () => {
    const src = await startWaiting('wf.adr1120.signed-in');
    const evs = (await api<{ events: Ev[] }>(`/runs/${src}/events/poll?fromSeq=-1&limit=1000`)).body.events ?? [];
    const requested = evs.find((e) => e.type === 'interrupt.requested' && e.nodeId === 'gate');
    expect(requested, 'the gate raised its request').toBeTruthy();
    const f = await api<{ runId: string }>(`/runs/${src}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay', fromSeq: requested!.sequence }) });
    expect(f.status, f.text).toBe(201);
    const fork = f.body.runId;
    expect(await waitFor(() => status(fork), (s) => s.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(s))).toBe('waiting-approval');
    const r = await api(`/interrupts/${encodeURIComponent(await tokenOf(fork))}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'approve' } }) });
    expect(r.status, r.text).toBe(403);
    expect(r.text).toContain('interrupt_requires_session');
  });
});

describe("ADR 1120 — 'link' (the default) is unchanged", () => {
  it('the token decides and the confirm page renders its form', async () => {
    const runId = await startWaiting('wf.adr1120.link');
    const token = await tokenOf(runId);
    const page = await api(`/host/openwop-app/interrupt-action?token=${encodeURIComponent(token)}&action=approve`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('<form');
    const r = await api(`/interrupts/${encodeURIComponent(token)}`, { method: 'POST', body: JSON.stringify({ resumeValue: { action: 'approve' } }) });
    expect(r.status, r.text).toBeLessThan(300);
    expect(await waitFor(() => status(runId), (s) => s === 'completed' || s === 'failed')).toBe('completed');
  });
});
