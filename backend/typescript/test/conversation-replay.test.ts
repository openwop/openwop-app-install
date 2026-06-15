/**
 * core.conversationGate — replay-determinism (RFC 0005 §G).
 *
 * Mirrors the conformance `conversationReplayDeterminism` contract: a self-driving
 * conversation (mockAutoResume) runs to completion, then `:fork` (mode: replay)
 * yields a child whose `conversation` channel projection is BYTE-EQUAL to the
 * source's — even though the child has a different runId. Proven by making every
 * channel id + timestamp runId-independent.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { createApp } from '../src/index.js';

let server: http.Server;
const PORT = 18266;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'dev-token';
const TENANT = '_anon';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: PORT, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(PORT, res); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}
async function pollTerminal(runId: string): Promise<string> {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const s = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (['completed', 'failed', 'cancelled'].includes(s)) return s;
  }
  return 'pending';
}

describe('core.conversationGate — replay-fork determinism', () => {
  it('a self-driving conversation forks (mode: replay) to a byte-equal conversation channel', async () => {
    const workflowId = 'openwop-app.conversation.replay-test';
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId,
      nodes: [{ nodeId: 'convo', typeId: 'core.conversationGate', config: { lifecycle: 'open-exchange-close', mockAutoResume: true, turnCount: 3 } }],
      edges: [],
    }) });

    const create = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({ workflowId, inputs: {}, tenantId: TENANT }) });
    expect(create.status).toBe(201);
    const sourceRunId = create.body.runId;
    expect(await pollTerminal(sourceRunId)).toBe('completed');

    const sourceConv = (await api<{ channels?: Record<string, unknown> }>(`/v1/runs/${sourceRunId}`)).body.channels;
    expect(sourceConv).toBeTruthy();
    // 3 turns → open + 3×(user+agent) + close = 8 channel messages.
    expect((sourceConv as { conversation?: unknown[] }).conversation).toHaveLength(8);

    const fork = await api<{ runId: string }>(`/v1/runs/${sourceRunId}:fork`, { method: 'POST', body: JSON.stringify({ mode: 'replay' }) });
    expect([200, 201]).toContain(fork.status);
    const forkedRunId = fork.body.runId;
    expect(await pollTerminal(forkedRunId)).toBe('completed');

    const forkedConv = (await api<{ channels?: Record<string, unknown> }>(`/v1/runs/${forkedRunId}`)).body.channels;
    // §G: the forked conversation channel is byte-equal to the source's.
    expect(JSON.stringify(forkedConv)).toBe(JSON.stringify(sourceConv));
  });
});
