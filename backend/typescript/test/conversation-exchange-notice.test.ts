/**
 * ADR 0178 / ADR 0327 P1 characterization fix — the interrupts route THREADS
 * the handler's BYOK soft-warning `notice` onto the exchange ack.
 *
 * The route previously serialized only `{runId, nodeId, status, conversation}`
 * and silently dropped `result.notice`, so the FE's `conversationClient`
 * (which narrows `body.notice`) never saw the ADR 0178 warning. The handler
 * is mocked here so the test pins EXACTLY the route's serialization: whatever
 * the handler returns as `notice` must reach the ack body verbatim (and stay
 * absent when the handler returns none).
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

const NOTICE = { code: 'byok_budget_warning' as const, usedPct: 85, cap: 1000 };
let nextNotice: typeof NOTICE | undefined;

vi.mock('../src/host/conversationExchange.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/conversationExchange.js')>();
  return {
    ...actual,
    handleConversationResolve: vi.fn(async (_s: unknown, interrupt: { runId: string; nodeId: string }) => ({
      operation: 'exchange' as const,
      conversationId: `${interrupt.runId}:${interrupt.nodeId}:0`,
      turns: [],
      ...(nextNotice ? { notice: nextNotice } : {}),
    })),
  };
});

import { createApp } from '../src/index.js';

let server: http.Server;
let BASE: string;
const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token' };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
});

async function api<T = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function openGateRun(workflowId: string): Promise<string> {
  await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'x' } }], edges: [] }) });
  const runId = (await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: '_anon' }) })).body.runId;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const s = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (s.startsWith('waiting')) break;
  }
  return runId;
}

describe('exchange ack notice threading (ADR 0178)', () => {
  it('a handler notice reaches the ack body verbatim', async () => {
    nextNotice = NOTICE;
    const runId = await openGateRun('adr0178.notice-on');
    const ex = await api<{ notice?: { code: string; usedPct: number; cap: number } }>(
      `/v1/runs/${runId}/interrupts/gate`,
      { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'hi' } } }) },
    );
    expect(ex.status).toBe(200);
    expect(ex.body.notice).toEqual(NOTICE);
  });

  it('no handler notice → no notice field on the ack', async () => {
    nextNotice = undefined;
    const runId = await openGateRun('adr0178.notice-off');
    const ex = await api<{ notice?: unknown }>(
      `/v1/runs/${runId}/interrupts/gate`,
      { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content: 'hi' } } }) },
    );
    expect(ex.status).toBe(200);
    expect('notice' in ex.body).toBe(false);
  });
});
