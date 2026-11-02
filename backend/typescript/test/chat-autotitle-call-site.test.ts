/**
 * ADR 1019 D1/D3 — the exchange call site hands the autotitler the facts its gates
 * decide on. The binding tests inject `firstExchange`, `served` and `credentialRef`,
 * so they cannot see the call site lie about them; this drives two REAL exchanges
 * through the interrupts route (`handleConversationResolve` → `finishExchange` →
 * `autotitleAfterExchange`) and records what reached the binding.
 *
 * Pins: the first exchange is `firstExchange: true`, the second `false`; both carry
 * the run's `credentialRef` and the `served` record of the provider that answered;
 * the chat session id is the run's.
 * Cost: boots the whole app (`createApp`) to witness three fields — deliberate, since the
 * point is the REAL route → exchange → binding path, which no lighter seam reaches.
 * Sabotage (2026-10-31): hard-code `firstExchange: true` at the call site → the second
 * exchange reds; drop `served` from `autotitleAfterExchange` → both red; read
 * `credentialRef` from `run.metadata` → both red.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';

const seen = vi.hoisted(() => [] as Array<Record<string, unknown>>);
vi.mock('../src/features/chat-autotitle/binding.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/features/chat-autotitle/binding.js')>();
  return {
    ...actual,
    maybeAutotitleOnFirstExchange: vi.fn((p: Record<string, unknown>) => {
      const { storage: _s, onTitled: _o, ...rest } = p;
      seen.push(rest);
    }),
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

describe('ADR 1019 — the exchange call site feeds the autotitle gates', () => {
  it('first exchange true, second false; served + credentialRef + session id threaded', async () => {
    const sessionId = 'cs-autotitle-call-site';
    const created = await api('/host/openwop-app/chat/sessions', { method: 'POST', body: JSON.stringify({ sessionId, title: 'plan a trip' }) });
    expect(created.status).toBe(201);
    const workflowId = 'adr1019.call-site';
    await api('/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({ workflowId, nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'x' } }], edges: [] }) });
    const runId = (await api<{ runId: string }>('/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: { provider: 'mock', model: 'mock-1', credentialRef: 'mock' }, metadata: { chatSessionId: sessionId }, tenantId: '_anon' }) })).body.runId;
    await vi.waitFor(async () => {
      const s = (await api<{ status: string }>(`/runs/${runId}`)).body.status;
      if (!s.startsWith('waiting')) throw new Error(`run ${runId} not suspended yet (${s})`);
    }, { timeout: 3000, interval: 20 });

    for (const content of ['plan a trip', 'and a hotel']) {
      const ex = await api(`/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({ resumeValue: { operation: 'exchange', turn: { content } } }) });
      expect(ex.status).toBe(200);
    }
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.map((p) => p['firstExchange'])).toEqual([true, false]);
    for (const p of seen) {
      expect(p['chatSessionId']).toBe(sessionId);
      expect(p['credentialRef']).toBe('mock');
      expect(p['served']).toMatchObject({ provider: 'mock' });
    }
    expect(seen[0]!['userText']).toBe('plan a trip');
  });
});
