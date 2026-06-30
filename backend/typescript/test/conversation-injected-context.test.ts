/**
 * Conversation exchange injects the chat's ConversationMeta context into the
 * advisor prompt — keyed by the chat `sessionId` carried in the run metadata.
 *
 * Regression for the board-of-advisors "no Strategy context" bug: a board's
 * injected strategy context (ADR 0079 Phase 5) and a project/notebook's
 * `ownerSubject` grounding (ADR 0084) live on the ConversationMeta keyed by the
 * chat `sessionId`, but the exchange handler used to read meta by the run-derived
 * gate conversationId (`${runId}:gate:0`) — the keys never matched, so the block
 * was silently dropped. The fix threads `chatSessionId` into the run metadata and
 * resolves meta by it. This proves the snapshotted block reaches the system prompt.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { markAsBoardGroup } from '../src/host/conversationStore.js';
import { programMock, resetMockPrograms, lastReceivedMessages } from '../src/providers/dispatchMock.js';

let server: http.Server;
let BASE: string;
const TOKEN = 'dev-token';
const TENANT = '_anon';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => {
  delete process.env.OPENWOP_TEST_SEAM_ENABLED;
  await new Promise<void>((res) => server.close(() => res()));
});
beforeEach(() => resetMockPrograms());

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function waitForGate(runId: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const { body } = await api<{ status: string }>(`/v1/runs/${runId}`);
    if (body.status.startsWith('waiting')) return;
  }
  throw new Error('gate never opened');
}

describe('conversation exchange — injected context resolves by run.metadata.chatSessionId', () => {
  it("injects the board's snapshotted strategy block into the advisor prompt", async () => {
    const agentId = 'test.advisor.elon';
    getAgentRegistry().register({
      agentId,
      persona: 'Elon Trask',
      label: 'First-principles builder',
      modelClass: 'general',
      systemPrompt: 'You are a contrarian operator.',
      packName: 'test',
      packVersion: '0',
      toolAllowlist: [],
      confidence: { defaultThreshold: 0.5 },
    });

    // The board's injected context is snapshotted on the ConversationMeta keyed by
    // the CHAT sessionId (what the `@@` summon / attachBoard does in production).
    const sessionId = 'sess-board-ctx-1';
    const CONTEXT = 'COMPANY STRATEGY CONTEXT: Q3 priority is margin expansion.';
    await markAsBoardGroup(TENANT, sessionId, 'board-x', [`agent:${agentId}`], undefined, undefined, CONTEXT);

    // The conversation run carries the chat sessionId in its metadata — the link
    // that lets the exchange resolve the meta above.
    const { body: created } = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
      workflowId: 'openwop-app.conversation',
      inputs: { provider: 'mock', model: 'mock-1' },
      tenantId: TENANT,
      metadata: { chatSessionId: sessionId },
    }) });
    const runId = created.runId;
    await waitForGate(runId);

    programMock('', [{ content: 'Acknowledged.' }]);
    await api(`/v1/runs/${runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({
      resumeValue: { operation: 'exchange', turn: { content: "what's our priority?", to: agentId } },
    }) });

    const msgs = lastReceivedMessages('');
    expect(msgs).not.toBeNull();
    const system = msgs!.find((m) => m.role === 'system')?.content ?? '';
    // The advisor's persona scaffold AND the snapshotted strategy block reach the prompt.
    expect(system).toContain('contrarian operator');
    expect(system).toContain(CONTEXT);
  });

  it('omits the block when the run carries no chatSessionId (additive fallback, no regression)', async () => {
    const agentId = 'test.advisor.noctx';
    getAgentRegistry().register({
      agentId, persona: 'Plain', modelClass: 'general', systemPrompt: 'Be plain.',
      packName: 'test', packVersion: '0', toolAllowlist: [], confidence: { defaultThreshold: 0.5 },
    });
    const { body: created } = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
      workflowId: 'openwop-app.conversation', inputs: { provider: 'mock', model: 'mock-1' }, tenantId: TENANT,
    }) });
    await waitForGate(created.runId);
    programMock('', [{ content: 'ok' }]);
    await api(`/v1/runs/${created.runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({
      resumeValue: { operation: 'exchange', turn: { content: 'hi', to: agentId } },
    }) });
    const system = lastReceivedMessages('')!.find((m) => m.role === 'system')?.content ?? '';
    expect(system).toContain('Be plain.');
    expect(system).not.toContain('COMPANY STRATEGY CONTEXT');
  });
});
