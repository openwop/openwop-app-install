/**
 * `core.flow.wait` through the REAL executor and the REAL timer sweep (J955WF-7).
 *
 * `ctx.suspend` throws to park the run and, on resume, RETURNS the resolution value (the
 * sweep's `{ elapsed: true, reason: 'timer' }`). `waitNode` returned that value bare, so the
 * pack adapter read it as a non-success outcome and every run failed the moment its wait
 * ended — the campaign-journeys welcome series among them. Nothing caught it because no test
 * resumed a `core.flow.wait` through the sweep; the ADR 0778 C1 witness uses a clarify gate.
 *
 * Sabotage witnessed: `waitNode` returning `ctx.suspend(...)` bare (the pre-fix code) reds
 * "completes" with `pack_node_error` on the wait node.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { sweepDueTimers } from '../src/executor/timerResume.js';
import { timerResumeContinuation } from '../src/routes/interrupts.js';
import { bareRunId } from './support/bareRunId.js';
import type { WorkflowDefinition } from '../src/executor/types.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let hostSuite: HostAdapterSuite;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage; hostSuite = app.locals.hostSuite;
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

describe('core.flow.wait — recorded timestamp input', () => {
  const deadline = '2026-10-25T04:00:00.000Z';
  const fallback = '2026-10-25T05:00:00.000Z';
  it.each([
    { name: 'wired input without config timestamp', inputs: { timestamp: deadline }, config: { mode: 'until' }, expected: deadline },
    { name: 'wired input takes precedence', inputs: { timestamp: deadline }, config: { mode: 'until', timestamp: fallback }, expected: deadline },
    { name: 'legacy config fallback', inputs: {}, config: { mode: 'until', timestamp: fallback }, expected: fallback },
  ])('$name', async ({ inputs, config, expected }) => {
    const pack = await import(new URL('../../../packs/core.openwop.flow/index.mjs', import.meta.url).href) as { waitNode: (context: { inputs: { timestamp?: string }; config: { mode: string; timestamp?: string }; suspend: (data: unknown) => Promise<unknown> }) => Promise<unknown> };
    const suspend = vi.fn().mockResolvedValue({ elapsed: true });
    expect(await pack.waitNode({ inputs, config, suspend })).toEqual({ status: 'success', outputs: { resumed: true, payload: { elapsed: true } } });
    expect(suspend).toHaveBeenCalledExactlyOnceWith({ kind: 'until', timestamp: expected });
  });
  it.each(['not-a-timestamp', '2026', '', null])('rejects invalid wired deadline %j before creating an interrupt', async (timestamp) => {
    const pack = await import(new URL('../../../packs/core.openwop.flow/index.mjs', import.meta.url).href) as { waitNode: (context: { inputs: { timestamp: unknown }; config: { mode: string }; suspend: (data: unknown) => Promise<unknown> }) => Promise<unknown> };
    const suspend = vi.fn().mockResolvedValue({ elapsed: true });
    await expect(pack.waitNode({ inputs: { timestamp }, config: { mode: 'until' }, suspend })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(suspend).not.toHaveBeenCalled();
  });
});

function client(): (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }> {
  let cookie = '';
  return async (method, path, body) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
}

describe('core.flow.wait — a timed wait resumes and the run goes on', () => {
  it('completes after the sweep fires its timer, with the declared output shape', async () => {
    const workflowId = `wf.flow-wait.${randomBytes(3).toString('hex')}`;
    const def: WorkflowDefinition = {
      workflowId,
      name: 'wait then finish',
      nodes: [
        { nodeId: 'wait', typeId: 'core.flow.wait', config: { mode: 'duration', seconds: 60 } },
        { nodeId: 'after', typeId: 'core.flow.noop' },
      ],
      edges: [{ from: 'wait', to: 'after' }],
    } as unknown as WorkflowDefinition;
    registerWorkflow(def);
    const call = client();
    expect((await call('POST', '/host/openwop-app/test/login', { email: `fw-${randomBytes(3).toString('hex')}@acme.test`, tenantId: `org:fw-${randomBytes(3).toString('hex')}` })).status).toBe(201);
    const create = await call('POST', '/runs', { workflowId, inputs: {} });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const runId = String(create.body.runId);
    const settle = async (): Promise<Record<string, unknown>> => {
      for (let i = 0; i < 120; i++) {
        const b = (await call('GET', `/runs/${runId}`)).body;
        const s = String(b.status);
        if (s.startsWith('waiting') || ['completed', 'failed', 'cancelled'].includes(s)) return b;
        await new Promise((r) => setTimeout(r, 25));
      }
      return { status: 'timeout' };
    };
    const parked = await settle(); expect(String(parked.status), JSON.stringify(parked)).toMatch(/^waiting/);

    const later = Date.now() + 61_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(later);
      expect(await sweepDueTimers(storage, timerResumeContinuation(storage, hostSuite), later)).toBe(1);
    } finally { vi.useRealTimers(); }
    const end = await settle();
    expect(end.status, JSON.stringify(end)).toBe('completed');

    const bundle = (await call('GET', `/host/openwop-app/runs/${bareRunId(runId)}/debug-bundle`)).body;
    const waited = ((bundle.events ?? []) as Array<{ type?: string; nodeId?: string; payload?: { outputs?: unknown } }>)
      .find((e) => e.type === 'node.completed' && e.nodeId === 'wait');
    expect(waited?.payload?.outputs).toEqual({ resumed: true, payload: { elapsed: true, reason: 'timer' } });
  });
});
