/**
 * Persistent conversations (ADR 0043) — ROUTE harness over the generalized chat
 * surface. Proves the conversation META sidecar turns a chat_session into a
 * typed, owned, multi-participant conversation WITHOUT a parallel store:
 *   - create with `type` + `participants` → owner + members persisted
 *   - list/get enrich with type + participants; a legacy session → `agent` + []
 *   - open-or-resume a 1:1 is idempotent via the canonical dmKey (no fork)
 *   - participants add/remove (owner not removable) — replaces the FE-only panel
 *   - read-state marks the owner's lastReadAt
 *   - delete cascades the meta (a re-open creates fresh)
 *
 * Tracker TST-CQA-2 (w68). Sabotage-witnessed (round-1 probes): red when
 * `requireOwner` never refuses, when `requireVisibleAsync` never refuses, when
 * the dmKey lookup misses, when removeParticipant may drop the owner, when an
 * unresolvable board is stamped, when the conversation-run bind skips the
 * other-session / wrong-workflow checks, and when a non-author edit skips
 * `requireManageAsync`.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { ensureAssistantAgent } from '../src/features/assistant/capability.js';
import { bareRunId } from './support/bareRunId.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  // ADR 0892: advisory-board is opt-in; the board-attach case creates a real board.
  { const d = getToggleDefault('advisory-board'); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Participant { subjectRef: string; role: string; lastReadAt?: string }
/** The conversation projection the chat-session routes return (and every field this file reads). */
interface Conversation {
  sessionId: string; title?: string; type: string; participants: Participant[]; boardId?: string;
  conversationRunId?: string; sessions: Conversation[]; messages: Array<{ messageId: string; content: string }>;
  feedback: Record<string, string>;
  /** The ErrorEnvelope on a refusal (middleware/errorEnvelope.ts). */
  error?: string; message?: string;
  user: { userId: string }; orgId: string; rosterId: string; agentRef: { agentId: string };
  runId: string;
}
interface Res { status: number; body: Conversation }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    // JSON.parse is the typing boundary: every route here answers JSON (or 204 with no body).
    const text = await res.text();
    const out: Conversation = JSON.parse(text === '' ? '{}' : text);
    return { status: res.status, body: out };
  };
  return { get: (p: string) => call('GET', p), post: (p: string, b?: unknown) => call('POST', p, b), put: (p: string, b?: unknown) => call('PUT', p, b), patch: (p: string, b?: unknown) => call('PATCH', p, b), del: (p: string) => call('DELETE', p) };
}
async function owner() {
  const c = client();
  const r = await c.post('/host/openwop-app/test/login', { email: `conv-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { c, userId: r.body.user.userId };
}
const OWNER_ONLY = 'Only the conversation owner may change its participants.';

const S = '/host/openwop-app/chat/sessions';

describe('conversations — typed model + participants', () => {
  it('creates a typed conversation with participants (owner + members)', async () => {
    const { c, userId } = await owner();
    const r = await c.post(S, { title: 'Ask Felix', type: 'agent', participants: ['agent:user.t.felix'] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.type).toBe('agent');
    const refs = r.body.participants;
    expect(refs.find((p) => p.subjectRef === `user:${userId}`)?.role).toBe('owner');
    expect(refs.some((p) => p.subjectRef === 'agent:user.t.felix' && p.role === 'member')).toBe(true);
  });

  it('list + get enrich with type + participants; a legacy (untyped) session reads as agent/[]', async () => {
    const { c } = await owner();
    await c.post(S, { title: 'Council', type: 'group', participants: ['agent:a', 'agent:b'] });
    const legacy = await c.post(S, { title: 'Plain' }); // no type → default agent, no meta participants
    const list = await c.get(S);
    const group = list.body.sessions.find((s) => s.title === 'Council');
    expect(group?.type).toBe('group');
    expect(group?.participants.length).toBe(3); // owner + 2
    const got = await c.get(`${S}/${encodeURIComponent(legacy.body.sessionId)}`);
    expect(got.body.type).toBe('agent');
  });

  it('open-or-resume a 1:1 is idempotent (same dmKey → same conversation)', async () => {
    const { c } = await owner();
    const first = await c.post('/host/openwop-app/chat/conversations/open', { type: 'agent', subjectRef: 'agent:user.t.ada' });
    expect(first.status).toBe(201);
    const again = await c.post('/host/openwop-app/chat/conversations/open', { type: 'agent', subjectRef: 'agent:user.t.ada' });
    expect(again.status).toBe(200); // resumed, not created
    expect(again.body.sessionId).toBe(first.body.sessionId);
  });

  it('adds + removes participants; the owner cannot be removed', async () => {
    const { c, userId } = await owner();
    const conv = await c.post(S, { type: 'group', participants: ['agent:a'] });
    const id = conv.body.sessionId;
    const added = await c.put(`${S}/${id}/participants`, { subjectRef: 'agent:b' });
    expect(added.body.participants.some((p) => p.subjectRef === 'agent:b')).toBe(true);
    const removed = await c.del(`${S}/${id}/participants/${encodeURIComponent('agent:a')}`);
    expect(removed.body.participants.some((p) => p.subjectRef === 'agent:a')).toBe(false);
    // Owner survives a removal attempt.
    const ownerGone = await c.del(`${S}/${id}/participants/${encodeURIComponent(`user:${userId}`)}`);
    expect(ownerGone.body.participants.some((p) => p.subjectRef === `user:${userId}` && p.role === 'owner')).toBe(true);
  });

  it('attaches a board → promotes the conversation to a group linked to the board (idempotent)', async () => {
    // CORRECTED by WF-BOA-3 (ADR 0588 D3, 2026-08-19). This used to attach the
    // string `'board-titans'` — a board that does not exist — and assert 200,
    // pinning the defect: the handler validated `boardId` as a STRING and never
    // read the board, so any caller could stamp fabricated board provenance and
    // a client-chosen RFC 0101 speak-set onto a durable conversation. The lane
    // now gates on the board and DERIVES the speak-set from its cohort, so the
    // test needs a real board — and the participants it asserts are the ones the
    // SERVER chose, not the ones the body asked for.
    const { c } = await owner();
    const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
    const advisor = await c.post('/host/openwop-app/roster', { persona: 'Ada Lovelace', agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
    expect(advisor.status, JSON.stringify(advisor.body)).toBe(201);
    const board = await c.post('/host/openwop-app/advisors/boards', {
      orgId: org.body.orgId, name: 'Titans', advisors: [advisor.body.rosterId],
      personaKind: 'historical', visibility: 'shared',
    });
    expect(board.status, JSON.stringify(board.body)).toBe(201);
    const boardId = board.body.boardId ?? '';
    const cohortRef = `agent:${advisor.body.agentRef.agentId}`;

    const conv = await c.post(S, { title: 'chat' }); // default `agent`
    const id = conv.body.sessionId;
    const r = await c.post(`${S}/${id}/board`, { boardId });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.type).toBe('group');
    expect(r.body.boardId).toBe(boardId);
    const refs = r.body.participants.map((p) => p.subjectRef);
    expect(refs).toContain(cohortRef);
    // Re-summoning the same board doesn't duplicate the cohort.
    const again = await c.post(`${S}/${id}/board`, { boardId });
    expect(again.body.participants.filter((p) => p.subjectRef === cohortRef).length).toBe(1);
    // It now lists under groups with its board link intact.
    const got = await c.get(`${S}/${id}`);
    expect(got.body.type).toBe('group');
    expect(got.body.boardId).toBe(boardId);
  });

  it('WF-BOA-3 — a boardId that does not resolve is a 404, not a stamp', async () => {
    // The arm the corrected test above can no longer carry: an unreadable /
    // non-existent board must leave NO board provenance on the conversation.
    const { c } = await owner();
    const conv = await c.post(S, { title: 'chat' });
    const id = conv.body.sessionId;
    const r = await c.post(`${S}/${id}/board`, { boardId: 'board-titans' });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(r.body.error).toBe('not_found');
    expect(r.body.message).toBe('board "board-titans" not found.');
    expect((await c.get(`${S}/${id}`)).body.boardId).toBeUndefined();
  });

  it('rename preserves the conversation type + participants in the response', async () => {
    const { c } = await owner();
    const conv = await c.post(S, { title: 'Before', type: 'group', participants: ['agent:a', 'agent:b'] });
    const renamed = await c.patch(`${S}/${conv.body.sessionId}`, { title: 'After' });
    expect(renamed.body.title).toBe('After');
    expect(renamed.body.type).toBe('group');
    expect(renamed.body.participants.length).toBe(3); // owner + 2 survive the rename
  });

  it('read-state marks the owner lastReadAt; delete cascades the meta', async () => {
    const { c, userId } = await owner();
    const conv = await c.post(S, { type: 'agent', participants: ['agent:x'] });
    const id = conv.body.sessionId;
    expect((await c.post(`${S}/${id}/read`)).status).toBe(204);
    const parts = await c.get(`${S}/${id}/participants`);
    expect(parts.body.participants.find((p) => p.subjectRef === `user:${userId}`)?.lastReadAt).toBeTruthy();
    expect((await c.del(`${S}/${id}`)).status).toBe(204);
    expect((await c.get(`${S}/${id}`)).status).toBe(404);
  });

  it('a read marker and a participant add sent together both persist (separate stores)', async () => {
    const { c, userId } = await owner();
    const conv = await c.post(S, { type: 'group', participants: ['agent:a'] });
    const id = conv.body.sessionId;
    // Read-state and membership live in separate stores, so marking read and
    // adding a participant cannot clobber each other. The two requests are NOT
    // forced to interleave (in-process handlers run one after the other), so
    // this asserts that both writes land, not that a race was exercised.
    await Promise.all([
      c.post(`${S}/${id}/read`),
      c.put(`${S}/${id}/participants`, { subjectRef: 'agent:b' }),
    ]);
    const got = await c.get(`${S}/${id}`);
    const parts = got.body.participants;
    expect(parts.some((p) => p.subjectRef === 'agent:b'), 'the participant add persisted').toBe(true);
    expect(parts.find((p) => p.subjectRef === `user:${userId}`)?.lastReadAt, 'the read marker persisted').toBeTruthy();
  });

  it('participant-scoped visibility (404 for non-members) layered with owner-gated mutation (403)', async () => {
    // Two distinct users in the SAME tenant (explicit tenantId + subject).
    const tenantId = `acme-${Date.now()}-${n++}`;
    const a = client();
    const ra = await a.post('/host/openwop-app/test/login', { email: `owner-${n}@acme.test`, tenantId, subject: `oidc:owner-${n}` });
    expect(ra.status).toBe(201);
    const b = client();
    const rb = await b.post('/host/openwop-app/test/login', { email: `other-${n}@acme.test`, tenantId, subject: `oidc:other-${n}` });
    expect(rb.status).toBe(201);
    const bId = rb.body.user.userId;

    // A owns a group conversation B is NOT part of.
    const conv = await a.post(S, { type: 'group', participants: ['agent:a'] });
    const id = conv.body.sessionId;

    // Visibility (ADR 0043 Phase 6): a co-tenant NON-participant can't even see
    // it — every by-id route is 404 (no existence leak), and it's absent from
    // B's list.
    // The id itself is redacted from the message (high-entropy sanitiser), so the shape is asserted.
    const notFound = /^chat_session ".+" not found\.$/;
    for (const [label, r] of [
      ['read non-participant', await b.get(`${S}/${id}`)],
      ['messages non-participant', await b.get(`${S}/${id}/messages`)],
      ['add non-participant', await b.put(`${S}/${id}/participants`, { subjectRef: 'agent:x' })],
      ['remove non-participant', await b.del(`${S}/${id}/participants/${encodeURIComponent('agent:a')}`)],
      ['board non-participant', await b.post(`${S}/${id}/board`, { boardId: 'bd', participants: [] })],
    ] as const) {
      expect(r.status, label).toBe(404);
      expect(r.body.error, label).toBe('not_found');
      expect(r.body.message, label).toMatch(notFound);
    }
    const bList = await b.get(S);
    expect(bList.body.sessions.some((s) => s.sessionId === id), 'absent from B list').toBe(false);

    // A (owner) adds B as a participant.
    expect((await a.put(`${S}/${id}/participants`, { subjectRef: `user:${bId}` })).status).toBe(200);

    // Now B can READ it (visible) — but RBAC still blocks membership mutation
    // (visible, not owner → 403, not 404).
    expect((await b.get(`${S}/${id}`)).status, 'read participant').toBe(200);
    expect((await b.get(S)).body.sessions.some((s) => s.sessionId === id), 'present in B list').toBe(true);
    const addDenied = await b.put(`${S}/${id}/participants`, { subjectRef: 'agent:x' });
    expect(addDenied.status, 'add as participant-non-owner').toBe(403);
    expect(addDenied.body.error).toBe('forbidden');
    expect(addDenied.body.message).toBe(OWNER_ONLY);
    const boardDenied = await b.post(`${S}/${id}/board`, { boardId: 'bd', participants: [] });
    expect(boardDenied.status, 'board as participant-non-owner').toBe(403);
    expect(boardDenied.body.error).toBe('forbidden');
    // The denied add never landed.
    expect((await a.get(`${S}/${id}`)).body.participants.some((p) => p.subjectRef === 'agent:x')).toBe(false);

    // A (the owner) succeeds at mutation.
    const ok = await a.put(`${S}/${id}/participants`, { subjectRef: 'agent:x' });
    expect(ok.status).toBe(200);
    expect(ok.body.participants.some((p) => p.subjectRef === 'agent:x')).toBe(true);
  });

  const WS = '/host/openwop-app/assistant/workspace-conversation';

  it('workspace conversation: 404 with no assistant; open-or-resume (dedup) once one exists (ADR 0043 Phase 6 / W-A)', async () => {
    const tenantId = `ws-${Date.now()}-${n++}`;
    const c = client();
    const r = await c.post('/host/openwop-app/test/login', { email: `ws-${n}@acme.test`, tenantId, subject: `oidc:ws-${n}` });
    expect(r.status).toBe(201);

    // No workspace assistant yet → 404 (no orphan workspace chat created).
    expect((await c.post(WS)).status, 'no assistant').toBe(404);

    // Seed the tenant's assistant-capability agent, then open-or-resume.
    const assistant = await ensureAssistantAgent(tenantId);
    const agentId = assistant.agentRef.agentId;

    const first = await c.post(WS);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.type).toBe('workspace');
    expect(first.body.participants.some((p) => p.subjectRef === `agent:${agentId}`), 'routes to the assistant agent').toBe(true);

    // Idempotent: a second open resolves to the SAME conversation (one per user).
    const again = await c.post(WS);
    expect(again.status, 'resumed not forked').toBe(200);
    expect(again.body.sessionId).toBe(first.body.sessionId);

    // Resume joins the owner's read marker into the header (no spurious-unread flash).
    expect((await c.post(`${S}/${first.body.sessionId}/read`)).status).toBe(204);
    const resumed = await c.post(WS);
    const ownerPart = resumed.body.participants.find((p) => p.role === 'owner');
    expect(ownerPart?.lastReadAt, 'read marker joined on resume').toBeTruthy();
  });

  it('persists + returns the conversation run id, and validates it (ADR 0067 continuity)', async () => {
    const { c } = await owner();
    const conv = await c.post(S, { title: 'Continuity', type: 'agent' });
    const id = conv.body.sessionId;

    // Before any run is recorded, the messages page omits it.
    const before = await c.get(`${S}/${id}/messages?limit=50`);
    expect(before.status).toBe(200);
    expect(before.body.conversationRunId).toBeUndefined();

    // ADR 0764 D5 — the bind must name a REAL conversation run of this session.
    const startRun = async (workflowId: string, chatSessionId?: string): Promise<string> => {
      const r = await c.post('/runs', { workflowId, inputs: { provider: 'mock', model: 'mock-1' }, ...(chatSessionId ? { metadata: { chatSessionId } } : {}) });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      // The BARE id, as the SPA persists it (client/v2Wire.ts unbinds every v2 id). A bound
      // id fails the bind's id grammar with 400, which would make the D5 negatives below vacuous.
      return bareRunId(r.body.runId);
    };
    const runId = await startRun('openwop-app.conversation', id);

    // Record it → 204; the messages page (paged AND full) now returns it.
    expect((await c.put(`${S}/${id}/conversation-run`, { conversationRunId: runId })).status).toBe(204);
    expect((await c.get(`${S}/${id}/messages?limit=50`)).body.conversationRunId).toBe(runId);
    expect((await c.get(`${S}/${id}/messages`)).body.conversationRunId).toBe(runId);

    // Idempotent re-PUT; invalid id rejected; unknown session 404s.
    expect((await c.put(`${S}/${id}/conversation-run`, { conversationRunId: runId })).status).toBe(204);
    const badId = await c.put(`${S}/${id}/conversation-run`, { conversationRunId: 'has:colons' });
    expect(badId.status).toBe(400);
    expect(badId.body.error).toBe('validation_error');
    const noSession = await c.put(`${S}/does-not-exist/conversation-run`, { conversationRunId: 'run-x' });
    expect(noSession.status).toBe(404);
    expect(noSession.body.message).toBe('chat_session "does-not-exist" not found.');

    // ADR 0764 D5 — an id that merely LOOKS like a run is refused: absent → the
    // uniform 404; another session's conversation run → 400; a non-conversation
    // run → 400. None of them moves the recorded binding.
    const absent = await c.put(`${S}/${id}/conversation-run`, { conversationRunId: 'run-abc-123' });
    expect(absent.status).toBe(404);
    expect(absent.body.message).toBe('run run-abc-123 not found');
    const other = await c.post(S, { title: 'Other', type: 'agent' });
    const foreignConv = await startRun('openwop-app.conversation', other.body.sessionId);
    const foreign = await c.put(`${S}/${id}/conversation-run`, { conversationRunId: foreignConv });
    expect(foreign.status).toBe(400);
    expect(foreign.body.message).toBe('conversationRunId belongs to a different chat session.');
    const notAConversation = await startRun('openwop-app.uppercase');
    const wrongWf = await c.put(`${S}/${id}/conversation-run`, { conversationRunId: notAConversation });
    expect(wrongWf.status).toBe(400);
    expect(wrongWf.body.message).toMatch(/^conversationRunId MUST name an /);
    expect((await c.get(`${S}/${id}/messages`)).body.conversationRunId).toBe(runId);
  });

  it('updates a message in place (ADR 0067 — run-backed workflow_run re-save)', async () => {
    const { c } = await owner();
    const conv = await c.post(S, { title: 'Updatable', type: 'agent' });
    const id = conv.body.sessionId;

    // Append the initial (running) snapshot, then UPDATE it with the suspended
    // state (more cards + the HITL interrupt) — the messageId is unique, so this
    // must be an update, not a second append.
    expect((await c.post(`${S}/${id}/messages`, { messageId: 'wf_1', role: 'workflow_run', content: JSON.stringify({ status: 'running' }) })).status).toBe(201);
    const upd = await c.put(`${S}/${id}/messages/wf_1`, { content: JSON.stringify({ status: 'suspended', activeInterrupts: [{ nodeId: 'gate_1' }] }) });
    expect(upd.status, JSON.stringify(upd.body)).toBe(200);

    // The thread reflects the UPDATED content (one message, not two), and the
    // count didn't double — an update is not a new message.
    const page = await c.get(`${S}/${id}/messages`);
    const wf = page.body.messages.filter((m) => m.messageId === 'wf_1');
    expect(wf.length).toBe(1);
    expect(wf[0]!.content).toContain('gate_1');

    // Updating a non-existent message 404s (the client then falls back to append).
    expect((await c.put(`${S}/${id}/messages/nope`, { content: '{}' })).status).toBe(404);
  });

  it('UPDATE is gated to the message author or the session owner (ADR 0102 Phase 2)', async () => {
    // Two humans in the SAME workspace tenant (a real shared-chat scenario).
    const tenantId = `ws-${Date.now()}-${n++}`;
    const ca = client();
    const ra = await ca.post('/host/openwop-app/test/login', { email: `a-${n}@acme.test`, tenantId, subject: `oidc:a-${n}` });
    expect(ra.status).toBe(201);
    const cb = client();
    const rb = await cb.post('/host/openwop-app/test/login', { email: `b-${n}@acme.test`, tenantId, subject: `oidc:b-${n}` });
    expect(rb.status).toBe(201);
    const bUserId = rb.body.user.userId;

    const conv = await ca.post(S, { title: 'Shared', type: 'agent' });
    expect(conv.status, JSON.stringify(conv.body)).toBe(201);
    const id = conv.body.sessionId;
    // Owner A authors m_a.
    expect((await ca.post(`${S}/${id}/messages`, { messageId: 'm_a', role: 'user', content: '{"role":"user"}' })).status).toBe(201);

    // Add member B as a participant (only the owner can), so B can see + write.
    expect((await ca.put(`${S}/${id}/participants`, { subjectRef: `user:${bUserId}` })).status).toBe(200);
    // B authors m_b.
    expect((await cb.post(`${S}/${id}/messages`, { messageId: 'm_b', role: 'user', content: '{"role":"user"}' })).status).toBe(201);

    // B CANNOT overwrite A's message (not author, not owner) → 403, no tamper.
    const tamper = await cb.put(`${S}/${id}/messages/m_a`, { content: '{"role":"user","content":"hax"}' });
    expect(tamper.status).toBe(403);
    expect(tamper.body.error).toBe('forbidden');
    // …and m_a still holds its author's words (read back, not inferred from the status).
    const thread = await ca.get(`${S}/${id}/messages`);
    expect(thread.body.messages.find((m) => m.messageId === 'm_a')?.content).toBe('{"role":"user"}');
    // B CAN edit its OWN message (author) → 200.
    expect((await cb.put(`${S}/${id}/messages/m_b`, { content: '{"role":"user","content":"edit"}' })).status).toBe(200);
    // Owner A CAN moderate B's message (owner) → 200.
    expect((await ca.put(`${S}/${id}/messages/m_b`, { content: '{"role":"user","content":"mod"}' })).status).toBe(200);
  });

  it('returns the caller feedback across a session in one batch (ADR 0102 Phase 3)', async () => {
    const { c } = await owner();
    const conv = await c.post(S, { title: 'FB', type: 'agent' });
    const id = conv.body.sessionId;
    await c.post(`${S}/${id}/messages`, { messageId: 'm1', role: 'assistant', content: '{}' });
    await c.post(`${S}/${id}/messages`, { messageId: 'm2', role: 'assistant', content: '{}' });
    // Rate m1 👍 (m2 left unrated).
    expect((await c.post(`/host/openwop-app/chat/messages/m1/feedback`, { conversationId: id, rating: 'up' })).status).toBe(200);

    const fb = await c.get(`${S}/${id}/feedback`);
    expect(fb.status, JSON.stringify(fb.body)).toBe(200);
    expect(fb.body.feedback.m1).toBe('up');
    expect(fb.body.feedback.m2).toBeUndefined(); // unrated → absent
  });
});
