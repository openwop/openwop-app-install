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
 * resolves meta by it. This proves the board block reaches the system prompt.
 *
 * CORRECTED by ADVB-1 (2026-08-19). This test used to assert that the PERSISTED
 * `injectedContextBlock` snapshot reaches the prompt — i.e. it pinned the defect
 * as the expected behaviour. That snapshot is written once, by whichever curator
 * opened a SHARED boardroom, out of sources whose readability differs per user,
 * so serving it to every later reader leaked. The invariant is now: the block is
 * RE-RESOLVED per caller through the board seam, and the persisted snapshot is a
 * provenance record that must NOT reach a model. Both halves are asserted, so
 * this still witnesses the original `chatSessionId` link (without the meta, the
 * `boardId` is unknown and no resolve happens at all).
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { markAsBoardGroup } from '../src/host/conversationStore.js';
import { registerBoardContextResolver } from '../src/host/boardContextResolver.js';
import { resolveBoardStrategyContext } from '../src/features/advisory-board/service.js';
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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
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
  it("injects the board's LIVE per-caller strategy block — never the persisted snapshot", async () => {
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
    const STALE = 'COMPANY STRATEGY CONTEXT: Q3 priority is margin expansion.';
    const LIVE = 'COMPANY STRATEGY CONTEXT: resolved for THIS caller.';
    await markAsBoardGroup(TENANT, sessionId, 'board-x', [`agent:${agentId}`], undefined, undefined, STALE);
    registerBoardContextResolver(async (_t, boardId) => (boardId === 'board-x' ? LIVE : null));
    let system = '';
    try {
      // The conversation run carries the chat sessionId in its metadata — the link
      // that lets the exchange resolve the meta above.
      const { body: created } = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
        workflowId: 'openwop-app.conversation',
        // ADR 0315: byok + non-tool-calling provider pins the INLINE path (the managed
        // default now takes the tool loop); this test covers the inline prompt injection.
        inputs: { provider: 'mock', model: 'mock-1', credentialRef: 'byok:mock' },
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
      system = msgs!.find((m) => m.role === 'system')?.content ?? '';
    } finally {
      // L4 — restore inside `finally`. A failing assertion above used to leak this
      // stub resolver into every later test in the file.
      registerBoardContextResolver(resolveBoardStrategyContext);
    }
    // The advisor's persona scaffold AND the snapshotted strategy block reach the prompt.
    expect(system).toContain('contrarian operator');
    expect(system).toContain(LIVE);
    // ADVB-1 — the persisted snapshot is provenance, never grounding.
    expect(system, 'the persisted snapshot must never reach a model').not.toContain(STALE);
  });

  it('WF-BOA-4 — a FAILED board-context resolve reaches the model as a grounding notice', async () => {
    // The defect: `composeChatContext` computed a degradation ledger and the text
    // exchange never read it, so an advisor whose planning context silently failed
    // spoke ATTRIBUTED and the moderator synthesised over it. The room looked
    // healthy. Here the resolver THROWS and the model must be told.
    const agentId = 'test.advisor.degraded';
    getAgentRegistry().register({
      agentId, persona: 'Ada', label: 'Advisor', modelClass: 'general',
      systemPrompt: 'You are an advisor.', packName: 'test', packVersion: '0',
      toolAllowlist: [], confidence: { defaultThreshold: 0.5 },
    });
    const sessionId = 'sess-board-degraded-1';
    await markAsBoardGroup(TENANT, sessionId, 'board-degraded', [`agent:${agentId}`], undefined, undefined, undefined);
    registerBoardContextResolver(async () => { throw new Error('strategy store unavailable'); });
    try {
      const { body: created } = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
        workflowId: 'openwop-app.conversation',
        inputs: { provider: 'mock', model: 'mock-1', credentialRef: 'byok:mock' },
        tenantId: TENANT, metadata: { chatSessionId: sessionId },
      }) });
      await waitForGate(created.runId);
      programMock('', [{ content: 'Acknowledged.' }]);
      await api(`/v1/runs/${created.runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({
        resumeValue: { operation: 'exchange', turn: { content: 'what should we do?', to: agentId } },
      }) });
      const system = lastReceivedMessages('')!.find((m) => m.role === 'system')?.content ?? '';
      expect(system).toContain('GROUNDING NOTICE');
      expect(system).toContain('planning context');
    } finally {
      registerBoardContextResolver(resolveBoardStrategyContext);
    }
  });

  it('a healthy turn carries NO grounding notice (the anti-rot arm)', async () => {
    // Without this, "always warn" would pass the assertion above while making the
    // notice meaningless — and a model told it is missing something on every turn
    // learns to ignore the line.
    const agentId = 'test.advisor.healthy';
    getAgentRegistry().register({
      agentId, persona: 'Grace', label: 'Advisor', modelClass: 'general',
      systemPrompt: 'You are an advisor.', packName: 'test', packVersion: '0',
      toolAllowlist: [], confidence: { defaultThreshold: 0.5 },
    });
    const sessionId = 'sess-board-healthy-1';
    const LIVE = 'COMPANY STRATEGY CONTEXT: healthy.';
    await markAsBoardGroup(TENANT, sessionId, 'board-healthy', [`agent:${agentId}`], undefined, undefined, undefined);
    registerBoardContextResolver(async () => LIVE);
    try {
      const { body: created } = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
        workflowId: 'openwop-app.conversation',
        inputs: { provider: 'mock', model: 'mock-1', credentialRef: 'byok:mock' },
        tenantId: TENANT, metadata: { chatSessionId: sessionId },
      }) });
      await waitForGate(created.runId);
      programMock('', [{ content: 'Acknowledged.' }]);
      await api(`/v1/runs/${created.runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({
        resumeValue: { operation: 'exchange', turn: { content: 'what should we do?', to: agentId } },
      }) });
      const system = lastReceivedMessages('')!.find((m) => m.role === 'system')?.content ?? '';
      expect(system).toContain(LIVE);
      expect(system, 'a healthy turn must not be warned').not.toContain('GROUNDING NOTICE');
    } finally {
      registerBoardContextResolver(resolveBoardStrategyContext);
    }
  });

  it('omits the block when the run carries no chatSessionId (additive fallback, no regression)', async () => {
    const agentId = 'test.advisor.noctx';
    getAgentRegistry().register({
      agentId, persona: 'Plain', modelClass: 'general', systemPrompt: 'Be plain.',
      packName: 'test', packVersion: '0', toolAllowlist: [], confidence: { defaultThreshold: 0.5 },
    });
    const { body: created } = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
      workflowId: 'openwop-app.conversation', // ADR 0315: byok + non-tool-calling provider pins the INLINE path (the managed
      // default now takes the tool loop); this test covers the inline prompt injection.
      inputs: { provider: 'mock', model: 'mock-1', credentialRef: 'byok:mock' }, tenantId: TENANT,
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

/**
 * H1 (2026-08-20 review) — THE ALREADY-OPEN ROOM.
 *
 * ADR 0588 D5 put the likeness gate on `POST …/advisors/boards/:id/chat` and on
 * the `@@` cohort attach. Both are room-CREATION lanes. Nothing on the TURN path
 * checked it, so the population `clearFabricatedLivingAcks` exists for — every
 * tenant that opened Titans BEFORE the ack was un-fabricated, which they could do
 * precisely *because* the seed fabricated it — kept a fully seated `type:'group'`
 * conversation one click away in the sidebar, composing turns normally. The ADR's
 * "Those boards become unconvenable" and `service.ts`'s "Fail-closed on BOTH
 * convene lanes" were false for exactly them.
 *
 * This walks the reviewer's probe: open the room while the ack is in place, strip
 * the ack the way the migration does, then take a turn.
 */
describe('H1 / ADR 0588 D5 — the likeness gate on the TURN, not just on room-open', () => {
  const BOARD_ORG = 'org-h1';
  const SEED_ACTOR = 'demo:advisory-seed';
  const OWNER = 'user:h1-owner';

  async function seatedUnacknowledgedRoom(slug: string): Promise<{ boardId: string; sessionId: string; agentId: string }> {
    const { createRosterEntry } = await import('../src/host/rosterService.js');
    const { createBoard, clearFabricatedLivingAcks } = await import('../src/features/advisory-board/service.js');
    const agentId = `test.advisor.${slug}`;
    getAgentRegistry().register({
      agentId, persona: 'Elon Trask', label: 'Advisor', modelClass: 'general',
      systemPrompt: 'You are a simulated advisor.', packName: 'test', packVersion: '0',
      toolAllowlist: [], confidence: { defaultThreshold: 0.5 },
    });
    const entry = await createRosterEntry({ tenantId: TENANT, persona: `Elon ${slug}`, agentRef: { kind: 'host' } as never });
    // The production row: seed-owned, `living`, ack fabricated by the seeder.
    const board = await createBoard(TENANT, BOARD_ORG, SEED_ACTOR, {
      name: `Titans ${slug}`, advisors: [entry.rosterId], personaKind: 'living',
      livingPersonaAck: true, visibility: 'shared',
    });
    // The room is OPENED while the fabricated ack still admits it — the whole
    // point: this state is reachable today and cannot be un-created.
    const sessionId = `sess-h1-${slug}`;
    await markAsBoardGroup(TENANT, sessionId, board.boardId, [`agent:${agentId}`], undefined, undefined, undefined);
    // …and now the migration strips the ack out from under the live room.
    expect(await clearFabricatedLivingAcks(TENANT)).toBeGreaterThan(0);
    return { boardId: board.boardId, sessionId, agentId };
  }

  async function takeTurn(sessionId: string, agentId: string): Promise<{ status: number; body: { message?: string; details?: { field?: string } } }> {
    const { body: created } = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
      workflowId: 'openwop-app.conversation',
      inputs: { provider: 'mock', model: 'mock-1', credentialRef: 'byok:mock' },
      tenantId: TENANT, metadata: { chatSessionId: sessionId },
    }) });
    await waitForGate(created.runId);
    programMock('', [{ content: 'Here is my advice.' }]);
    return api(`/v1/runs/${created.runId}/interrupts/gate`, { method: 'POST', body: JSON.stringify({
      resumeValue: { operation: 'exchange', turn: { content: 'what should we do?', to: agentId } },
    }) });
  }

  it('REFUSES the turn in a room that was already open when the ack was stripped', async () => {
    const { sessionId, agentId } = await seatedUnacknowledgedRoom('blocked');
    const res = await takeTurn(sessionId, agentId);
    expect(res.status, 'the seated room must not be able to speak').toBe(422);
    expect(res.body.details?.field).toBe('livingPersonaAck');
    expect(res.body.message).toMatch(/acknowledge/i);
    // The load-bearing half: the model was never asked. A refusal that still
    // dispatches is a simulated living person having spoken.
    expect(lastReceivedMessages(''), 'no advisor turn may reach the provider').toBeNull();
  });

  it('and lets it speak again once the owner acknowledges (the exit the refusal names)', async () => {
    // The anti-rot arm. Without it, "always refuse on a board conversation" would
    // pass the arm above while removing the feature — and the refusal's own
    // message would be naming an exit that does not work.
    const { boardId, sessionId, agentId } = await seatedUnacknowledgedRoom('exit');
    const { updateBoard } = await import('../src/features/advisory-board/service.js');
    await updateBoard(TENANT, OWNER, boardId, { livingPersonaAck: true });
    const res = await takeTurn(sessionId, agentId);
    expect(res.status).toBe(200);
    expect(lastReceivedMessages('')).not.toBeNull();
  });
});
