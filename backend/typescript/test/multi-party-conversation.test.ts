/**
 * Multi-party group conversation — RFC 0101 / ADR 0040 Phase 6.
 *
 * Makes the Board of Advisors council CROSS-HOST OBSERVABLE on the existing RFC
 * 0005 conversation wire (NOT a parallel runtime — ADR 0040 § Correction):
 *
 *   1. PARTICIPANT ROSTER on `conversation.opened` — when the gate is opened with
 *      a declared cohort, the opened payload carries `participants: AgentRef[]`.
 *   2. PER-TURN `speakerId` — every `role:'agent'` turn carries an explicit
 *      `speakerId` (the agent INSTANCE id), and a board-group conversation's
 *      advisor/moderator turns are each spoken by a roster participant.
 *   3. NON-PARTICIPANT REJECTION — a board-group conversation (a declared roster)
 *      MUST reject a turn whose speaker is not a participant (defense-in-depth).
 *   4. CAPABILITY — `multiPartyConversation: { supported, maxParticipants }` is
 *      advertised at /.well-known/openwop (honest only because (2)+(3) hold).
 *
 * The board's roster lives as the `agent:<id>` members of the chat's
 * ConversationMeta (stamped by `markAsBoardGroup` at `@@`-summon), exactly as
 * production does — this test stamps it the same way.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { createApp } from '../src/index.js';
import { getAgentRegistry } from '../src/executor/agentRegistry.js';
import { markAsBoardGroup, getConversationMeta } from '../src/host/conversationStore.js';
import { programMock, resetMockPrograms } from '../src/providers/dispatchMock.js';
import { participantRosterOf, isParticipant, MAX_MULTI_PARTY_PARTICIPANTS } from '../src/host/multiPartyConversation.js';
import type { ConversationMeta } from '../src/host/conversationStore.js';

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
  const res = await fetch(`${BASE}${path}`, { method: 'GET', ...init, headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as T };
}

interface Ev { type?: string; payload?: Record<string, unknown> }
async function poll(runId: string): Promise<{ status: string; events: Ev[] }> {
  let status = 'pending';
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 20));
    status = (await api<{ status: string }>(`/v1/runs/${runId}`)).body.status;
    if (['completed', 'failed', 'cancelled'].includes(status) || status.startsWith('waiting')) break;
  }
  const events = (await api<{ events?: Ev[] }>(`/v1/runs/${runId}/debug-bundle`)).body.events ?? [];
  return { status, events };
}
const ofType = (events: Ev[], type: string): Ev[] => events.filter((e) => e.type === type);

function registerAgent(agentId: string, persona: string, label: string): void {
  getAgentRegistry().register({
    agentId, persona, label, modelClass: 'general',
    systemPrompt: `You are ${persona}.`, packName: 'test', packVersion: '0',
    toolAllowlist: [], confidence: { defaultThreshold: 0.5 },
  });
}

describe('RFC 0101 — multiPartyConversation capability', () => {
  it('advertises multiPartyConversation { supported, maxParticipants } at /.well-known/openwop', async () => {
    const wk = await api<{ capabilities?: { multiPartyConversation?: { supported?: boolean; maxParticipants?: number } } }>('/.well-known/openwop');
    expect(wk.body.capabilities?.multiPartyConversation?.supported).toBe(true);
    expect(wk.body.capabilities?.multiPartyConversation?.maxParticipants).toBe(MAX_MULTI_PARTY_PARTICIPANTS);
  });
});

describe('RFC 0101 — participant roster + speaker attribution (helper)', () => {
  it('derives the agent roster from a board-group meta, and ignores non-board chats', () => {
    const base: Omit<ConversationMeta, 'type' | 'boardId' | 'participants'> = {
      conversationId: 'c', tenantId: TENANT, createdAt: '', updatedAt: '',
    };
    const boardMeta: ConversationMeta = {
      ...base, type: 'group', boardId: 'board-x',
      participants: [
        { subjectRef: 'user:u1', role: 'owner', addedAt: '' },
        { subjectRef: 'agent:a1', role: 'member', addedAt: '' },
        { subjectRef: 'agent:a2', role: 'member', addedAt: '' },
      ],
    };
    const roster = participantRosterOf(boardMeta);
    expect(roster).toEqual([{ agentId: 'a1' }, { agentId: 'a2' }]);
    expect(isParticipant(roster!, 'a1')).toBe(true);
    expect(isParticipant(roster!, 'stranger')).toBe(false);
    // A 1:1 / ungrouped chat declares NO roster — the speaker rule does not apply.
    expect(participantRosterOf({ ...base, type: 'agent', participants: [] } as ConversationMeta)).toBeNull();
    expect(participantRosterOf(null)).toBeNull();
  });
});

describe('RFC 0101 — multi-party council on the conversation wire (ADR 0040 Phase 6)', () => {
  it('carries a participants roster on conversation.opened; advisor + moderator turns are attributed; a non-participant turn is rejected', async () => {
    const chair = 'test.mp.moderator';     // the moderator / chair
    const elon = 'test.mp.elon';           // advisor 1
    const ben = 'test.mp.ben';             // advisor 2
    const stranger = 'test.mp.stranger';   // NOT in the cohort
    registerAgent(chair, 'Moderator', 'Chair');
    registerAgent(elon, 'Elon Trask', 'Builder');
    registerAgent(ben, 'Ben Franklan', 'Statesman');
    registerAgent(stranger, 'Uninvited', 'Outsider');

    // The board cohort (chair + 2 advisors) is stamped on the chat's
    // ConversationMeta exactly as the `@@`-summon does in production.
    const sessionId = 'sess-mp-council-1';
    const cohort = [chair, elon, ben];
    await markAsBoardGroup(TENANT, sessionId, 'board-council', cohort.map((a) => `agent:${a}`));

    // Open the conversation via a gate that declares the cohort as participants at
    // OPEN time → the roster lands on `conversation.opened` (RFC 0101 (1)).
    const workflowId = `openwop-app.conversation.mp-${Date.now()}`;
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId,
      nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'Council convened.', participants: cohort.map((a) => ({ agentId: a })) } }],
      edges: [],
    }) });
    const { body: run2 } = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
      workflowId, inputs: { provider: 'mock', model: 'mock-1' }, tenantId: TENANT, metadata: { chatSessionId: sessionId },
    }) });
    const rid = run2.runId;
    const opened = await poll(rid);
    expect(opened.status.startsWith('waiting')).toBe(true);
    const openedEv = ofType(opened.events, 'conversation.opened');
    expect(openedEv).toHaveLength(1);
    // RFC 0101 (1) — the roster is on the opened payload, cross-host observable.
    expect(openedEv[0]!.payload!.participants).toEqual(cohort.map((a) => ({ agentId: a })));

    // Advisor turn (in-cohort) — attributed with a speakerId that IS a participant.
    programMock('', [{ content: 'First principles: simplify, then scale.' }]);
    const adv = await api(`/v1/runs/${rid}/interrupts/gate`, { method: 'POST', body: JSON.stringify({
      resumeValue: { operation: 'exchange', turn: { content: 'How should we grow?', to: elon } },
    }) });
    expect(adv.status).toBe(200);
    const afterAdv = await poll(rid);
    const advisorTurn = ofType(afterAdv.events, 'conversation.exchanged')
      .map((e) => e.payload!.turn as { role?: string; speakerId?: string })
      .find((t) => t.role === 'agent')!;
    expect(advisorTurn.speakerId).toBe(elon);
    // The advisor's speakerId IS a declared participant of the conversation roster.
    const liveRoster = participantRosterOf(await getConversationMeta(TENANT, sessionId));
    expect(liveRoster!.some((p) => p.agentId === advisorTurn.speakerId)).toBe(true);

    // Moderator turn (the chair) — also attributed, also a participant.
    programMock('', [{ content: 'Agreements: scale. Dissent: pace. Decision: pilot first.' }]);
    await api(`/v1/runs/${rid}/interrupts/gate`, { method: 'POST', body: JSON.stringify({
      resumeValue: { operation: 'exchange', turn: { content: 'Synthesize the panel.', to: chair } },
    }) });
    const afterMod = await poll(rid);
    const modTurns = ofType(afterMod.events, 'conversation.exchanged')
      .map((e) => e.payload!.turn as { role?: string; speakerId?: string })
      .filter((t) => t.role === 'agent');
    expect(modTurns.some((t) => t.speakerId === chair)).toBe(true);
    expect(modTurns.every((t) => cohort.includes(t.speakerId!))).toBe(true);

    // RFC 0101 (3) — a turn from a NON-participant agent is rejected fail-closed.
    programMock('', [{ content: 'I was not invited.' }]);
    const denied = await api<{ error?: { code?: string } }>(`/v1/runs/${rid}/interrupts/gate`, { method: 'POST', body: JSON.stringify({
      resumeValue: { operation: 'exchange', turn: { content: 'Let me in.', to: stranger } },
    }) });
    expect(denied.status).toBe(422);
    // No agent turn was appended for the stranger.
    const afterDenied = await poll(rid);
    const speakers = ofType(afterDenied.events, 'conversation.exchanged')
      .map((e) => (e.payload!.turn as { role?: string; speakerId?: string }))
      .filter((t) => t.role === 'agent')
      .map((t) => t.speakerId);
    expect(speakers).not.toContain(stranger);
  });
});
