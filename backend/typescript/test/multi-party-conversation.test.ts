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
import { markAsBoardGroup, getConversationMeta, ensureConversationMeta } from '../src/host/conversationStore.js';
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
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
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

  // ADR 0608 D6 (`CPWF-1` / `CPWF-10`) — BORN RED before the predicate stopped
  // keying on `meta.boardId`. `grep -ci project` over this file and its seam twin
  // returned 0/0: the RFC 0101 lane was tested exclusively against board metas, and
  // the negative case was asserted with a `type:'agent'` meta — which is true, and
  // silently left `type:'group'` WITHOUT `boardId` (the PROJECT shape) untested in
  // BOTH directions. The test did not pin the defect; it could not see it.
  it('derives the roster for a PROJECT group chat — `type:group` + ownerSubject, NO boardId', () => {
    const base: Omit<ConversationMeta, 'type' | 'boardId' | 'participants'> = {
      conversationId: 'c', tenantId: TENANT, createdAt: '', updatedAt: '',
    };
    const projectMeta = {
      ...base, type: 'group', ownerSubject: { kind: 'project', id: 'project-1' },
      participants: [
        { subjectRef: 'user:u1', role: 'owner', addedAt: '' },
        { subjectRef: 'agent:a1', role: 'member', addedAt: '' },
        { subjectRef: 'agent:a2', role: 'member', addedAt: '' },
      ],
    } as unknown as ConversationMeta;
    expect(projectMeta.boardId).toBeUndefined(); // the point of the case
    const roster = participantRosterOf(projectMeta);
    expect(roster).toEqual([{ agentId: 'a1' }, { agentId: 'a2' }]);
    // BOTH directions, per `CPWF-10`.
    expect(isParticipant(roster!, 'a2')).toBe(true);
    expect(isParticipant(roster!, 'not-a-member')).toBe(false);
  });

  // ADR 0608 R2 (M3 fold-in) — the predicate's blast radius NAMES notebooks.
  // A notebook chat room is `ensureConversationMeta(type:'group', ownerSubject:
  // projectSubject(nb.id), participants:[agentRef(RESEARCHER_AGENT_ID)])`
  // (`features/notebooks/routes.ts:551-555`) — no `boardId`, exactly ONE `agent:`
  // seat. So after D6 `participantRosterOf` derives a single-participant roster
  // for it, and the RFC 0101 speaker rule at `conversationExchange.ts:333` now
  // fires on notebook turns. This case proves the ENFORCEMENT posture the review
  // asked to confirm: the SEATED researcher IS in the roster (so a normal
  // researcher-addressed turn does NOT 422), and only a turn addressed to a
  // DIFFERENT agent would 422 — correct per RFC 0101, the one behaviour change
  // outside projects (ADR 0608 D6 Residual). The transform/tool persist path
  // (`notebooks/agentTools.ts:122` `persistExchangedPair`, `:313`
  // `appendWorkflowRunTurn`) BYPASSES `conversationExchange` entirely — it writes
  // the turn through the persistence primitives directly — so the widening is
  // INERT there; no roster check runs on that path.
  it('derives a single-participant roster for a NOTEBOOK chat room — the seated researcher does not 422', () => {
    const RESEARCHER = 'feature.notebooks.agents.researcher';
    const base: Omit<ConversationMeta, 'type' | 'boardId' | 'participants'> = {
      conversationId: 'c', tenantId: TENANT, createdAt: '', updatedAt: '',
    };
    const notebookMeta = {
      ...base, type: 'group', ownerSubject: { kind: 'project', id: 'notebook-1' },
      participants: [{ subjectRef: `agent:${RESEARCHER}`, role: 'member', addedAt: '' }],
    } as unknown as ConversationMeta;
    expect(notebookMeta.boardId).toBeUndefined();
    const roster = participantRosterOf(notebookMeta);
    expect(roster).toEqual([{ agentId: RESEARCHER }]);
    // The seated researcher is a participant ⇒ its turn is NOT rejected.
    expect(isParticipant(roster!, RESEARCHER)).toBe(true);
    // A non-researcher agent would be ⇒ the latent 422 (correct per RFC 0101).
    expect(isParticipant(roster!, 'some-other-agent')).toBe(false);
  });

  it('a non-board group that seats NO agents still declares no roster — a missing guard must not become a wedge', () => {
    const base: Omit<ConversationMeta, 'type' | 'boardId' | 'participants'> = {
      conversationId: 'c', tenantId: TENANT, createdAt: '', updatedAt: '',
    };
    // e.g. a kicktodo accountability circle (`circleService.ts:106`) seats no
    // agents at create. Returning `[]` here would mean "no agent may speak" and
    // 422 every turn in those rooms.
    expect(participantRosterOf({ ...base, type: 'group', participants: [{ subjectRef: 'user:u1', role: 'owner', addedAt: '' }] } as unknown as ConversationMeta)).toBeNull();
    // A BOARD group keeps the stricter declared-but-empty semantics, unchanged.
    expect(participantRosterOf({ ...base, type: 'group', boardId: 'b1', participants: [{ subjectRef: 'user:u1', role: 'owner', addedAt: '' }] } as unknown as ConversationMeta)).toEqual([]);
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
      // ADR 0315: byok + non-tool-calling provider keeps these council turns on the
      // inline completion path the test programs via the dispatch mock.
      workflowId, inputs: { provider: 'mock', model: 'mock-1', credentialRef: 'byok:mock' }, tenantId: TENANT, metadata: { chatSessionId: sessionId },
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

  /**
   * ADR 0608 D6 (`CPWF-1` / `CPWF-10`) — the ROUTE-level half. The unit case above
   * proves the DERIVATION; only an exchange proves the ENFORCEMENT (the
   * mechanism-vs-wiring lesson: 9605 green tests once missed exactly this seam).
   * Born red: before the predicate stopped keying on `boardId` the outsider's turn
   * returned 200 and was appended to the transcript.
   *
   * SCOPE, stated honestly: this exercises the GENERIC non-board group producer
   * (`routes/chatSessions.ts:1072` — `type:'group'`, agent participants, no
   * `boardId`), which is the second live member of the `CPWF-1` class. It does NOT
   * stamp `ownerSubject: project:<id>`, and that omission is deliberate rather than
   * incidental: an owned conversation is gated by `isVisibleToAsync`, which
   * resolves a project subject that does not exist to `'none'` and masks the whole
   * exchange as 404, so the speaker rule is never reached. Building a REAL project
   * here needs cookie auth + org membership, which this bearer/anon harness has no
   * path to. `participantRosterOf` does not consult `ownerSubject` at all — the
   * project-shaped meta is covered by the unit case above — so the pair covers both
   * halves, but neither is a full end-to-end project convene. That remains unrun.
   */
  it('a NON-BOARD group chat rejects a non-participant agent turn 422 and appends nothing', async () => {
    const inRoom = 'test.mp.proj.member';
    const outsider = 'test.mp.proj.outsider';
    registerAgent(inRoom, 'Seated Agent', 'Member');
    registerAgent(outsider, 'Outsider', 'Not a participant');

    // A group meta that seats an agent and carries NO boardId — the shape the old
    // `!meta.boardId` clause declared to be "single-agent / ungrouped".
    const sessionId = `sess-mp-project-${Date.now()}`;
    const meta = await ensureConversationMeta(TENANT, sessionId, {
      type: 'group',
      participants: [`agent:${inRoom}`],
    } as Parameters<typeof ensureConversationMeta>[2]);
    expect(meta.boardId).toBeUndefined();
    expect(participantRosterOf(meta)).toEqual([{ agentId: inRoom }]);

    const workflowId = `openwop-app.conversation.mp-proj-${Date.now()}`;
    await api('/v1/host/openwop-app/workflows', { method: 'POST', body: JSON.stringify({
      workflowId,
      nodes: [{ nodeId: 'gate', typeId: 'core.conversationGate', config: { prompt: 'Project room.' } }],
      edges: [],
    }) });
    const { body: run } = await api<{ runId: string }>('/v1/runs', { method: 'POST', body: JSON.stringify({
      workflowId, inputs: { provider: 'mock', model: 'mock-1', credentialRef: 'byok:mock' }, tenantId: TENANT, metadata: { chatSessionId: sessionId },
    }) });
    const rid = run.runId;
    expect((await poll(rid)).status.startsWith('waiting')).toBe(true);

    // POSITIVE CONTROL FIRST — a seated agent still speaks. Without this the 422
    // below would pass equally well against a room where nobody can speak at all.
    programMock('', [{ content: 'Status: on track.' }]);
    const ok = await api(`/v1/runs/${rid}/interrupts/gate`, { method: 'POST', body: JSON.stringify({
      resumeValue: { operation: 'exchange', turn: { content: 'Where are we?', to: inRoom } },
    }) });
    expect(ok.status).toBe(200);
    const afterOk = await poll(rid);
    expect(ofType(afterOk.events, 'conversation.exchanged')
      .map((e) => e.payload!.turn as { role?: string; speakerId?: string })
      .some((t) => t.role === 'agent' && t.speakerId === inRoom)).toBe(true);

    // The enforcement: a NON-member agent is refused fail-closed.
    programMock('', [{ content: 'I am not in this project.' }]);
    const denied = await api(`/v1/runs/${rid}/interrupts/gate`, { method: 'POST', body: JSON.stringify({
      resumeValue: { operation: 'exchange', turn: { content: 'Let me in.', to: outsider } },
    }) });
    expect(denied.status).toBe(422);
    const afterDenied = await poll(rid);
    expect(ofType(afterDenied.events, 'conversation.exchanged')
      .map((e) => (e.payload!.turn as { role?: string; speakerId?: string }))
      .filter((t) => t.role === 'agent')
      .map((t) => t.speakerId)).not.toContain(outsider);
  });
});
