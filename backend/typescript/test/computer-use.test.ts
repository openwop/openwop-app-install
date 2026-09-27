/**
 * ADR 0418 P1 — the computer-use control loop invariants (mock provider):
 *  submit-once CAS (no double session/charge), risk-tiered auto vs halt,
 *  human decide (approve resumes / deny ends), fail-closed origin allowlist,
 *  step ceiling, daily budget, validation, and node-pack honest-off.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { makeMockAdapter, tierOf, type CuAction } from '../src/features/computer-use/adapter.js';
import { startTask, decide, sessionStatus, parseAllowedOrigins } from '../src/features/computer-use/computerUseService.js';

let server: http.Server;
const T = 'tenant-cu-1';

const act = (actionId: string, kind: CuAction['kind'], url?: string): CuAction =>
  ({ actionId, kind, description: `${kind} ${url ?? ''}`.trim(), ...(url ? { url } : {}) });

const mockTask = (actions: CuAction[], resultSummary = 'done'): string =>
  `mock:${JSON.stringify({ actions, resultSummary })}`;

const BASE_INPUT = {
  tenantId: T, orgId: 'org-1', createdBy: 'u1',
  startUrl: 'https://app.example.com/login',
  allowedOrigins: ['https://app.example.com'],
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { void (server.address() as AddressInfo); res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });
beforeEach(() => { delete process.env.OPENWOP_COMPUTER_USE_DAILY_SESSIONS; });

describe('tiering (closed world)', () => {
  it('classifies every action kind', () => {
    expect(tierOf(act('a', 'screenshot'))).toBe('observe');
    expect(tierOf(act('a', 'scroll'))).toBe('observe');
    expect(tierOf(act('a', 'click'))).toBe('interact');
    expect(tierOf(act('a', 'type'))).toBe('interact');
    for (const kind of ['navigate', 'download', 'submit', 'credential'] as const) {
      expect(tierOf(act('a', kind))).toBe('commit');
    }
  });
});

describe('validation (fail-closed)', () => {
  it('rejects an empty allowlist, non-https origins, and an off-list startUrl', async () => {
    expect(() => parseAllowedOrigins([])).toThrowError(/non-empty/);
    expect(() => parseAllowedOrigins(['http://insecure.example.com'])).toThrowError(/https/);
    await expect(startTask(makeMockAdapter(), { ...BASE_INPUT, task: 'x', startUrl: 'https://other.example.com/' }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });
});

describe('the control loop', () => {
  it('auto-advances observe/interact steps and completes; identical inputs never re-submit', async () => {
    const adapter = makeMockAdapter();
    const task = mockTask([
      act('a1', 'screenshot'),
      act('a2', 'click', 'https://app.example.com/button'),
      act('a3', 'type'),
    ], 'logged in');
    const first = await startTask(adapter, { ...BASE_INPUT, task });
    expect(first.status).toBe('completed');
    expect(first.steps).toBe(3);
    expect(first.resultSummary).toBe('logged in');
    expect(adapter.calls.start).toBe(1);
    // Re-run with identical inputs: resolved from the store, zero provider calls.
    const before = adapter.calls.start + adapter.calls.poll + adapter.calls.decide;
    const again = await startTask(adapter, { ...BASE_INPUT, task });
    expect(again.sessionId).toBe(first.sessionId);
    expect(again.status).toBe('completed');
    expect(adapter.calls.start + adapter.calls.poll + adapter.calls.decide).toBe(before);
  });

  it('halts awaiting_approval on a commit-tier action; approve resumes, recording the human step', async () => {
    const adapter = makeMockAdapter();
    const task = mockTask([
      act('b1', 'screenshot'),
      act('b2', 'submit', 'https://app.example.com/checkout'),
      act('b3', 'screenshot'),
    ], 'purchased');
    const halted = await startTask(adapter, { ...BASE_INPUT, task });
    expect(halted.status).toBe('awaiting_approval');
    expect(halted.pendingAction?.actionId).toBe('b2');
    expect(halted.steps).toBe(1); // only the observe step recorded so far
    const resumed = await decide(adapter, T, halted.sessionId, true);
    expect(resumed.status).toBe('completed');
    expect(resumed.steps).toBe(3); // + the human-decided commit + trailing observe
    expect(resumed.resultSummary).toBe('purchased');
  });

  it('deny ends the session (denied) and a second decide conflicts', async () => {
    const adapter = makeMockAdapter();
    const task = mockTask([act('c1', 'download', 'https://app.example.com/report.pdf')]);
    const halted = await startTask(adapter, { ...BASE_INPUT, task });
    expect(halted.status).toBe('awaiting_approval');
    const denied = await decide(adapter, T, halted.sessionId, false);
    expect(denied.status).toBe('denied');
    await expect(decide(adapter, T, halted.sessionId, true)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('an off-allowlist provider URL fails the session closed — even at observe/interact tier', async () => {
    const adapter = makeMockAdapter();
    const task = mockTask([act('d1', 'click', 'https://evil.example.net/phish')]);
    const out = await startTask(adapter, { ...BASE_INPUT, task });
    expect(out.status).toBe('failed');
    expect(out.error).toContain('origin_denied');
  });

  it('enforces the step ceiling (runaway backstop)', async () => {
    const adapter = makeMockAdapter();
    const actions = Array.from({ length: 60 }, (_, i) => act(`s${i}`, 'screenshot'));
    let v = await startTask(adapter, { ...BASE_INPUT, task: mockTask(actions) });
    // The loop yields every 10 auto-steps; re-invoke (same inputs) resumes it.
    for (let i = 0; i < 10 && v.status === 'running'; i += 1) {
      v = await startTask(adapter, { ...BASE_INPUT, task: mockTask(actions) });
    }
    expect(v.status).toBe('failed');
    expect(v.error).toBe('step_ceiling_reached');
    expect(v.steps).toBeLessThanOrEqual(40);
  });

  it('enforces the daily session budget (typed 429; sessions remain startable after)', async () => {
    process.env.OPENWOP_COMPUTER_USE_DAILY_SESSIONS = '1';
    const adapter = makeMockAdapter();
    const t2 = 'tenant-cu-budget';
    const one = await startTask(adapter, { ...BASE_INPUT, tenantId: t2, task: mockTask([act('e1', 'screenshot')]) });
    expect(one.status).toBe('completed');
    await expect(startTask(adapter, { ...BASE_INPUT, tenantId: t2, task: mockTask([act('e2', 'screenshot')]) }))
      .rejects.toMatchObject({ code: 'rate_limited' });
  });

  it('status is a tenant-guarded read', async () => {
    const adapter = makeMockAdapter();
    const v = await startTask(adapter, { ...BASE_INPUT, task: mockTask([act('f1', 'screenshot')]) });
    expect((await sessionStatus(T, v.sessionId))?.status).toBe('completed');
    expect(await sessionStatus('tenant-other', v.sessionId)).toBeNull();
  });
});

describe('node pack (honest-off)', () => {
  it('task/decide/status fail with host_capability_missing without the surface', async () => {
    // @ts-expect-error — .mjs pack module has no type declarations (pure-JS node pack).
    const { nodes } = await import('../../../packs/feature.computer-use.nodes/index.mjs');
    for (const id of ['task', 'decide', 'status']) {
      await expect(nodes[`feature.computer-use.nodes.${id}`]({ inputs: {}, features: {} }))
        .rejects.toMatchObject({ code: 'host_capability_missing' });
    }
  });

  it('task wraps the surface end-to-end', async () => {
    const { buildComputerUseSurface, __resetMockAdapter } = await import('../src/features/computer-use/feature.js');
    __resetMockAdapter();
    // @ts-expect-error — .mjs pack module has no type declarations (pure-JS node pack).
    const { nodes } = await import('../../../packs/feature.computer-use.nodes/index.mjs');
    const ctx = {
      inputs: { orgId: 'org-1', task: mockTask([act('g1', 'screenshot')]), startUrl: BASE_INPUT.startUrl, allowedOrigins: BASE_INPUT.allowedOrigins },
      features: { 'computer-use': buildComputerUseSurface({ tenantId: 'tenant-cu-node', runId: 'run-1' }) },
    };
    const out = await nodes['feature.computer-use.nodes.task'](ctx);
    expect(out.status).toBe('success');
    expect(out.outputs.session.status).toBe('completed');
  });
});
